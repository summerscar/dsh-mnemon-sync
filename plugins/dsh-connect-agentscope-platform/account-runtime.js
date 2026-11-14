/**
 * AgentScope Platform — one account's runtime, and the pool that orders them.
 *
 * Two layers, and the split matters:
 *
 *   **AccountRuntime** owns everything that belongs to ONE account: its
 *   `CreditEngine` (credentials + rotating refresh token + credit history), its
 *   `CheckinScheduler`, and its `sk-as-…` model key document. Each of those three
 *   files lives under `vault/accounts/<id>/`, so two accounts can never write
 *   over each other.
 *
 *   **AccountPool** owns the *set*: which accounts exist, which one is billed to,
 *   and the one timer that re-selects an account by remaining credits. It holds
 *   no request state — there is no in-flight counter, by decision (Q13): a switch
 *   only moves what the next request reads, and a stream already running finishes
 *   on the key it took.
 *
 * WHY `paths` IS MANDATORY HERE (the single most important rule in this file).
 * `CreditEngine` falls back to `pluginPaths()` when it is not handed paths
 * (`as.js:187`), and `CheckinScheduler` does the same (`checkin.js:86`). Those
 * fallbacks were right when there was one account; with a pool they are a silent
 * data-loss bug — every runtime would read and write the same install-wide
 * `vault/login.json`, rotating one account's refresh token into another's file,
 * and a test that "passed" would have been writing into the user's live install
 * the whole time. So this module refuses to construct a runtime without explicit
 * paths, and additionally refuses paths that belong to a different account id.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO:
 *
 * - **No request-level failover.** A 401/429 on a model call is the host's
 *   business (`.scratch/adr/0001-no-request-level-failover.md`). Nothing here
 *   retries a request, swaps a key mid-stream or re-registers the provider.
 * - **No `activeRequestCount`.** Deleted by decision (Q13); the auto-switch runs
 *   on probe-cycle boundaries only and does not look at in-flight work.
 * - **No session binding.** One global active account is the whole model for a
 *   self-hosted single-user install.
 * - **Probe outcome and disabled reason are two different things** (Q10). A
 *   network blip writes a cooldown and never disables an account; only an
 *   `auth`-class failure writes `disabledReason = 'expired'`.
 *
 * @module dsh-connect-agentscope-platform/account-runtime
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { CreditEngine, badParam, errorKind, maskSecret } from './as.js'
import { CheckinScheduler } from './checkin.js'
import {
  ACCOUNT_ID_RE,
  MAX_LABEL_LENGTH,
  MAX_MESSAGE_LENGTH,
  credentialFileState,
  exclusionOf,
  loadAccounts,
  loadMeasurements,
  maskProbeMessage,
  nextActiveId,
  normalizeAccount,
  pickBestAccount,
  pruneActiveId,
  saveAccounts,
  writeMeasurementsProbes,
} from './measurements.js'
import {
  accountIdOf,
  accountPaths,
  ensureAccountDirs,
  ensureStateDirs,
  isInside,
} from './paths.js'

/**
 * How often the pool re-runs credit-aware selection.
 *
 * Five minutes: long enough that the platform sees a handful of cheap `credits`
 * reads an hour, short enough that an exhausted account is noticed within a
 * working session rather than a day later. Automatic selection is off until the
 * user switches it on, so this timer only exists after they ask for it.
 */
export const AUTO_SWITCH_INTERVAL_MS = 5 * 60 * 1000

/**
 * How long a transport failure keeps an account out of automatic selection.
 *
 * A network blip says nothing about the account, so the exclusion is short and
 * self-healing: the cooldown expires on its own (`exclusionOf`).
 */
export const NETWORK_COOLDOWN_MS = 5 * 60 * 1000

/**
 * How long a non-auth HTTP failure keeps an account out.
 *
 * Longer than a network blip because a 5xx/429 from the platform is a real
 * answer, but still a cooldown rather than a disable: the credential is intact
 * and the account is still the user's.
 */
export const HTTP_COOLDOWN_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Whether an account entry counts as billable. */
function isUsable(account) {
  return Boolean(account) && account.enabled !== false
}

/**
 * The available-credit figure inside a `credits` payload, or `null`.
 *
 * `null` means "not measured", never "zero": `pickBestAccount` treats a missing
 * figure as `unknown-credits` and refuses to select on it, which is the whole
 * reason this distinction is preserved rather than defaulted to 0.
 *
 * @param {unknown} credits
 * @returns {number | null}
 */
export function availableCreditsOf(credits) {
  if (!credits || typeof credits !== 'object') return null
  for (const field of ['display_available_credits', 'available_credits']) {
    const value = credits[field]
    if (value === null || value === undefined || value === '') continue
    const figure = Number(value)
    if (Number.isFinite(figure)) return figure
  }
  return null
}

/** Read one account's model-key document, or an empty one. */
function readModelKeyDocument(file) {
  try {
    if (!existsSync(file)) return { key: '', source: '', fetchedAt: 0 }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const saved = parsed && typeof parsed === 'object' ? parsed : {}
    return {
      key: typeof saved.key === 'string' ? saved.key : '',
      source: saved.source === 'fetched' ? 'fetched' : saved.source === 'pasted' ? 'pasted' : '',
      fetchedAt: Number(saved.fetchedAt) || 0,
    }
  } catch { return { key: '', source: '', fetchedAt: 0 } }
}

/**
 * Derive a stable account id, the way the plan specifies: a hash of what makes
 * the account identifiable at creation time, truncated to 24 hex digits.
 *
 * The `salt` exists only so two accounts created with the same label in the same
 * millisecond cannot collide; it is never persisted.
 *
 * @param {string} label
 * @param {number} createdAt
 * @param {string} [salt]
 */
export function accountIdFor(label, createdAt, salt = '') {
  return createHash('sha256').update(`agentscope\0${label}\0${createdAt}\0${salt}`).digest('hex').slice(0, 24)
}

// ---------------------------------------------------------------------------
// AccountRuntime — everything that belongs to one account
// ---------------------------------------------------------------------------

/**
 * One account's engine, check-in scheduler and model key.
 *
 * Constructed only through {@link AccountPool} in production, but usable on its
 * own (and tested that way) because the isolation guarantee lives here: given
 * this account's paths, nothing it writes can reach another account's files.
 */
export class AccountRuntime {
  /**
   * @param {object} options
   * @param {string} options.id - a validated account id
   * @param {ReturnType<typeof import('./paths.js').pluginPaths>} options.paths -
   *   `accountPaths(base, id)` for this account; there is no install-wide form
   * @param {() => { enabled?: boolean }} [options.checkinSettings] - the global
   *   check-in switch, read on every scheduler decision
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    if (!options || typeof options !== 'object') throw new TypeError('AccountRuntime needs an options object')
    const { id, paths, log = () => {}, checkinSettings } = options

    if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) {
      throw new TypeError(`invalid account id: ${JSON.stringify(id)}`)
    }
    // The red line from `as.js:187` / `checkin.js:86`: no paths, no runtime.
    // There is intentionally no `dshHome` or `stateDir` escape hatch.
    if (!paths || typeof paths !== 'object') {
      throw new TypeError(
        'AccountRuntime needs options.paths from accountPaths(id): the install-wide fallback would make every account share one credential file',
      )
    }

    let owner
    try { owner = accountIdOf(paths) } catch {
      throw new TypeError(
        'AccountRuntime needs paths from accountPaths(id): the install-wide paths would make every account share one credential file',
      )
    }
    if (owner !== id) throw new TypeError(`these paths belong to account ${owner}, not ${id}`)

    this.id = id
    // Every account owns a directory, created before either class below is
    // constructed so a first save cannot fail on a missing parent.
    this.paths = ensureAccountDirs(paths)
    this.log = log
    this.disposed = false

    this.engine = new CreditEngine({ paths: this.paths, log })
    this.checkin = new CheckinScheduler({
      engine: this.engine,
      paths: this.paths,
      settings: () => {
        const value = typeof checkinSettings === 'function' ? checkinSettings() : undefined
        return value && typeof value === 'object' ? value : {}
      },
      log,
    })
    this.modelKey = readModelKeyDocument(this.paths.modelKey)
  }

  /**
   * The browser-facing model-key view, in the shape `fullState().modelKey` has
   * always had. The key itself never crosses this boundary.
   */
  modelKeyView() {
    return {
      configured: this.modelKey.key !== '',
      mask: maskSecret(this.modelKey.key),
      source: this.modelKey.source,
      fetchedAt: this.modelKey.fetchedAt,
    }
  }

  /**
   * Replace this account's `sk-as-…` key and persist it under the account's own
   * directory. `''`/`'-'` clears it, matching the other credential fields.
   *
   * @param {unknown} key
   * @param {'pasted' | 'fetched' | ''} [source]
   */
  setModelKey(key, source = 'pasted') {
    const value = typeof key === 'string' ? key.trim() : ''
    const cleared = value === '' || value === '-'
    this.modelKey = {
      key: cleared ? '' : value,
      source: cleared ? '' : (source === 'fetched' ? 'fetched' : 'pasted'),
      fetchedAt: Date.now(),
    }
    try {
      writeFileSync(this.paths.modelKey, JSON.stringify(this.modelKey, null, 2), { mode: 0o600 })
    } catch (error) {
      this.log(`could not save the model key for account ${this.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.modelKeyView()
  }

  /** Re-read the model key from disk (a manual edit, or another instance). */
  reloadModelKey() {
    this.modelKey = readModelKeyDocument(this.paths.modelKey)
    return this.modelKeyView()
  }

  /** Whether this account's login file is present and safely permissioned. */
  credentialState() {
    return credentialFileState(this.paths.login)
  }

  /**
   * Arm this account's credit-snapshot timer and check-in scheduler.
   *
   * @param {object} [account] - the pool's record for this account. A runtime
   *   owns only an id and a set of paths, so the marker it must honour is the
   *   caller's live document entry, not a copy this object could have taken at
   *   construction time and then never see updated.
   */
  start(account) {
    if (this.disposed) return this
    // An account whose sign-in credential is expired keeps its model key but
    // must not run timers: every snapshot cycle against a dead token sends a
    // failure notification. It stays selectable by hand and still calls models;
    // automatic selection's own probe is what brings it back.
    if (account?.disabledReason === 'expired') return this
    this.engine.startScheduler()
    this.checkin.sync()
    return this
  }

  /** Stop this account's timers. Safe to call repeatedly. */
  stop() {
    this.engine.stopScheduler()
    this.checkin.stop()
    return this
  }

  /** Stop the timers and refuse to be restarted (plugin teardown). */
  dispose() {
    this.stop()
    this.disposed = true
    return this
  }
}

// ---------------------------------------------------------------------------
// AccountPool — the set of accounts
// ---------------------------------------------------------------------------

/**
 * The account pool: which accounts exist, which one is billed to, and when to
 * re-select one.
 *
 * PERSISTENCE MODEL. The in-memory document is the authority; every mutation
 * edits it synchronously and then hands the *whole* document to
 * `saveAccounts()`. There is deliberately no second write lock: `measurements.js`
 * already serialises every document write through one module-level queue, and
 * because each write is a complete snapshot rather than a read-modify-write of
 * the file, two saves cannot lose each other's fields. `mutationQueue` exposes
 * the tail of that chain so a caller can await the last save.
 */
export class AccountPool {
  /**
   * @param {object} options
   * @param {ReturnType<typeof import('./paths.js').pluginPaths>} options.paths -
   *   the install-wide paths from `pluginPaths()`; per-account paths are derived
   * @param {() => object} [options.settings] - the plugin's settings document
   *   (only `checkin.enabled` is read, per account)
   * @param {(message: string) => void} [options.log]
   * @param {number} [options.nowMs] - clock used for the migrated `createdAt`
   */
  constructor(options) {
    if (!options || typeof options !== 'object') throw new TypeError('AccountPool needs an options object')
    const { paths, settings, log = () => {}, nowMs } = options
    if (!paths || typeof paths !== 'object') {
      throw new TypeError('AccountPool needs options.paths from pluginPaths()')
    }

    /** @type {ReturnType<typeof import('./paths.js').pluginPaths>} */
    this.paths = paths
    this.log = log
    /** @type {() => object} */
    this.settings = typeof settings === 'function' ? settings : () => ({})
    this.nowMs = nowMs

    /** @type {Map<string, AccountRuntime>} */
    this.runtimes = new Map()
    /** @type {Record<string, object>} */
    this.probes = {}
    /** @type {object} */
    this.document = { version: 1, activeId: null, accounts: [], autoSwitch: { enabled: false, thresholdPct: 20 } }

    /** @type {ReturnType<typeof setInterval> | null} */
    this.autoSwitchTimer = null
    this.disposed = false
    /** @type {Promise<boolean> | null} */
    this.saving = null

    ensureStateDirs(this.paths)
    // The document read is asynchronous (it may migrate a single-account
    // install), but `apply()` in index.js is synchronous, so the load starts here
    // and every public async method awaits `ready()` first.
    this.initialising = this.#initialise()
  }

  /** Resolves once the pool document and measurement log are loaded. */
  async ready() {
    await this.initialising
    return this
  }

  /**
   * The tail of the persistence chain.
   *
   * Writes are serialised by `measurements.js`'s module queue; this only lets a
   * caller await the most recent one (a test, or a shutdown path).
   */
  get mutationQueue() {
    return this.saving
  }

  async #initialise() {
    try {
      this.document = await loadAccounts({ paths: this.paths, log: this.log, nowMs: this.nowMs })
    } catch (error) {
      // A document that cannot be read at all must not stop the plugin: an empty
      // pool is a state the panel renders, an exception at startup is not.
      this.log(`could not load the accounts document: ${error instanceof Error ? error.message : String(error)}`)
      this.document = { version: 1, activeId: null, accounts: [], autoSwitch: { enabled: false, thresholdPct: 20 } }
    }
    try {
      const measurements = await loadMeasurements({ paths: this.paths, log: this.log })
      this.probes = measurements.probes
    } catch (error) {
      this.log(`could not load the measurement log: ${error instanceof Error ? error.message : String(error)}`)
      this.probes = {}
    }

    for (const account of this.document.accounts) {
      try {
        this.runtimes.set(account.id, this.#createRuntime(account))
      } catch (error) {
        // One unreadable account must not cost the user the others.
        this.log(`could not build the runtime for account ${account.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The billed-to account id, or `null` when nothing is billable. */
  get activeId() {
    return this.document.activeId ?? null
  }

  /** The automatic-selection settings, as persisted. */
  get autoSwitch() {
    return { ...this.document.autoSwitch }
  }

  /**
   * Whether the selection timer is armed right now.
   *
   * Exposed because "is a timer running?" is the one thing a caller (and a
   * teardown test) cannot infer from the settings: the switch can be on while the
   * timer is stopped, and vice versa during a reload.
   */
  get autoSwitchRunning() {
    return this.autoSwitchTimer !== null
  }

  /** The billed-to runtime, or `null` when the pool has no usable account. */
  active() {
    const id = this.activeId
    return id === null ? null : this.runtimes.get(id) ?? null
  }

  /** One account's runtime, or `null`. */
  runtimeOf(id) {
    return this.runtimes.get(id) ?? null
  }

  /**
   * The runtime a request means: the named account, or the billed-to one when
   * the caller did not name one (the "old browser" path).
   *
   * @param {string | null | undefined} [id]
   * @returns {AccountRuntime}
   */
  resolve(id) {
    if (id === null || id === undefined || id === '') {
      const active = this.active()
      if (active === null) throw badParam('no account is configured yet')
      return active
    }
    const runtime = this.runtimes.get(String(id))
    if (!runtime) throw badParam(`unknown account: ${String(id)}`)
    return runtime
  }

  /** The browser-facing projection of every account, in document order. */
  list() {
    const nowMs = Date.now()
    return this.document.accounts.map(account => this.#project(account, nowMs))
  }

  /** Projections plus the billing choice: what `GET /accounts` returns. */
  view() {
    return {
      accounts: this.list(),
      activeAccountId: this.activeId,
      autoSwitch: this.autoSwitch,
    }
  }

  /**
   * One account's projection. Never contains a token: `credentialState` is a
   * three-state word, the masks come from `modelKeyView()`, and nothing here
   * copies the engine's config.
   */
  #project(account, nowMs) {
    const runtime = this.runtimes.get(account.id) ?? null
    const probe = this.probes[account.id] ?? null
    // Every account keeps its credentials in its own directory, without exception.
    const credentialFile = accountPaths(this.paths, account.id).login
    const credentialState = runtime ? runtime.credentialState() : credentialFileState(credentialFile)
    // THIS ACCOUNT'S key, not the billing account's. The browser half used to
    // render every row from `state.modelKey`, which describes only the billing
    // account — so a row with no key showed another account's mask and looked
    // configured. `mask` is included because the row's editor displays it, and
    // it is not new exposure: `GET /model-key?accountId=X` already answers it.
    const modelKey = runtime
      ? runtime.modelKeyView()
      : { configured: false, mask: '', source: '', fetchedAt: 0 }
    return {
      id: account.id,
      label: account.label,
      enabled: account.enabled !== false,
      active: account.id === this.activeId,
      credentialState,
      usable: account.enabled !== false && credentialState !== 'absent',
      // `null` means "not measured" and must stay null: `Number(null)` is 0 and
      // `Number.isFinite(0)` is true, so the obvious coercion turns "unknown"
      // into a confident zero — the panel would then show a balance of 0 for an
      // account whose credential simply could not be read.
      credits: probe && probe.credits !== null && probe.credits !== undefined && Number.isFinite(Number(probe.credits))
        ? Number(probe.credits)
        : null,
      lastRefreshedAt: probe && Number.isFinite(Number(probe.lastRefreshedAt)) ? Number(probe.lastRefreshedAt) : null,
      disabledReason: account.disabledReason ?? null,
      probe,
      excludedBy: exclusionOf({ account, probe: probe ?? undefined, nowMs }),
      modelKey: {
        configured: modelKey.configured,
        source: modelKey.source,
        mask: modelKey.mask,
      },
    }
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Add an account.
   *
   * The first account ever added becomes the billed-to one; otherwise the
   * billing choice only moves when `activate` says so, so adding a backup never
   * silently reroutes requests.
   *
   * @param {object} input
   * @param {string} [input.id] - a pre-computed id; derived from the label when absent
   * @param {string} input.label
   * @param {boolean} [input.activate]
   * @param {number} [input.createdAt]
   * @param {string} [input.refreshToken] - seeded into this account's login file
   * @param {string} [input.accessToken]
   * @param {string} [input.modelKey] - seeded into this account's model-key file
   * @returns {Promise<{ account: object, runtime: AccountRuntime, accounts: object[], activeAccountId: string | null, autoSwitch: object }>}
   */
  async add({ id, label, activate = false, createdAt, refreshToken, accessToken, modelKey } = {}) {
    await this.ready()
    const now = Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now()
    const text = typeof label === 'string' ? label.trim() : ''
    if (text === '') throw badParam('an account needs a label')
    if (this.runtimes.has(String(id ?? ''))) throw badParam(`account already exists: ${String(id)}`)

    // Reuse the document's own normaliser so `add` cannot accept an id or a
    // label that `loadAccounts` would drop on the next restart.
    const candidate = normalizeAccount(
      { id: id ?? accountIdFor(text, now), label: text, enabled: true, createdAt: now },
    )
    if (!candidate) throw badParam('that account id or label is not usable')
    if (this.document.accounts.some(entry => entry.id === candidate.id)) {
      throw badParam(`account already exists: ${candidate.id}`)
    }

    const runtime = this.#createRuntime(candidate)
    if (typeof refreshToken === 'string' && refreshToken.trim() !== '') {
      runtime.engine.updateConfig({ refreshToken: refreshToken.trim() })
    }
    if (typeof accessToken === 'string' && accessToken.trim() !== '') {
      runtime.engine.updateConfig({ accessToken: accessToken.trim() })
    }
    if (typeof modelKey === 'string' && modelKey.trim() !== '') {
      runtime.setModelKey(modelKey.trim(), 'pasted')
    }

    this.runtimes.set(candidate.id, runtime)
    this.document.accounts = [...this.document.accounts, candidate]
    this.document.activeId = nextActiveId({
      accounts: this.document.accounts,
      activeId: this.document.activeId,
      added: candidate,
      activate: activate === true ? candidate.id : null,
    })
    await this.#persist()
    runtime.start(candidate)
    return { ...this.view(), account: this.#project(candidate, Date.now()), runtime }
  }

  /**
   * Remove an account.
   *
   * Two guards, both hard: the pool never ends up with no billable account
   * because of a removal, and removing the billed-to account hands billing to
   * `nextActiveId`. The account's own directory is removed along with it.
   *
   * @param {string} id
   */
  async remove(id) {
    await this.ready()
    const account = this.#requireAccount(id)
    const remaining = this.document.accounts.filter(entry => entry.id !== account.id)
    if (isUsable(account) && !remaining.some(isUsable)) {
      throw badParam('cannot remove the last usable account')
    }

    const runtime = this.runtimes.get(account.id) ?? null
    runtime?.dispose()
    this.runtimes.delete(account.id)
    this.#removeAccountDirectory(account.id)

    this.document.accounts = remaining
    this.document.activeId = nextActiveId({ accounts: remaining, activeId: this.document.activeId })
    delete this.probes[account.id]
    await this.#persist()
    return { ...this.view(), account: null, runtime: null }
  }

  /**
   * Rename an account. Trimmed and capped at the panel's maxLength.
   *
   * @param {string} id
   * @param {unknown} label
   */
  async rename(id, label) {
    await this.ready()
    const account = this.#requireAccount(id)
    const text = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL_LENGTH) : ''
    if (text === '') throw badParam('an account needs a label')
    account.label = text
    await this.#persist()
    return { ...this.view(), account: this.#project(account, Date.now()), runtime: this.runtimes.get(account.id) ?? null }
  }

  /**
   * Enable or disable an account.
   *
   * Disabling writes `disabledReason = 'manual'` (an explicit human decision) and
   * refuses to leave the pool with nothing billable; disabling the billed-to
   * account hands billing over. Enabling clears whatever reason was recorded —
   * that is the user overriding a previous judgement, and a probe will re-mark
   * the account if the credential is still bad.
   *
   * @param {string} id
   * @param {boolean} enabled
   */
  async setEnabled(id, enabled) {
    await this.ready()
    const account = this.#requireAccount(id)
    const next = enabled === true

    if (next) {
      account.enabled = true
      delete account.disabledReason
    } else {
      const remaining = this.document.accounts.map(entry => (entry.id === account.id ? { ...entry, enabled: false } : entry))
      if (!remaining.some(isUsable)) throw badParam('cannot disable the last usable account')
      account.enabled = false
      account.disabledReason = 'manual'
      this.document.activeId = nextActiveId({ accounts: this.document.accounts, activeId: this.document.activeId })
    }

    const runtime = this.runtimes.get(account.id) ?? null
    if (next) runtime?.start(account)
    else runtime?.stop()
    await this.#persist()
    return { ...this.view(), account: this.#project(account, Date.now()), runtime }
  }

  /**
   * Make one account the billed-to account.
   *
   * Only what the next request reads changes: the adapter's `apiKey` getter asks
   * the pool again on every call, so no provider re-registration happens here and
   * a stream in flight is not interrupted (ADR 0001).
   *
   * @param {string} id
   */
  async switchTo(id) {
    await this.ready()
    const account = this.#requireAccount(id)
    if (!isUsable(account)) throw badParam(`account is disabled: ${account.id}`)
    this.document.activeId = account.id
    await this.#persist()
    return { ...this.view(), account: this.#project(account, Date.now()), runtime: this.runtimes.get(account.id) ?? null }
  }

  // -------------------------------------------------------------------------
  // Probe
  // -------------------------------------------------------------------------

  /**
   * Measure one account against the platform and record the result.
   *
   * Never throws for a failed probe — a measurement is telemetry, and a readout
   * that explodes instead of saying "expired" is worse than useless. An unknown
   * id is the one exception: that is a caller bug and becomes a 400 upstream.
   *
   * Q10 lives here, and this is the only place that decides it:
   *
   * - `auth` (401 / invalid refresh token) ⇒ `disabledReason = 'expired'`, which
   *   takes the account out of selection until something positive happens.
   * - `network` / `http` / `other` ⇒ **only** a probe outcome plus a cooldown.
   *   The credential is untouched: the reference deployment once mailed "your
   *   tokens are dead" every interval while a container restart was all that was
   *   wrong, and this branch is what prevents that.
   *
   * @param {string} id
   * @param {{ nowMs?: number }} [options]
   * @returns {Promise<{ account: object, probe: object, credentialState: string, credits: number | null }>}
   */
  async probe(id, options = {}) {
    await this.ready()
    const account = this.#requireAccount(id)
    const runtime = this.runtimes.get(account.id) ?? null
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()

    /** @type {{ outcome: string, atMs: number, retryAtMs: number, message: string, credits: number | null, lastRefreshedAt?: number }} */
    const record = { outcome: 'unknown', atMs: nowMs, retryAtMs: 0, message: '', credits: null }
    const credentialState = runtime ? runtime.credentialState() : 'absent'
    /**
     * The platform's FULL credits document for this read.
     *
     * Returned to the caller but deliberately NOT stored in the record: the
     * record is the measurement log (a few numbers that survive restarts), while
     * this is a live payload the composer pill renders once. Persisting it would
     * grow the log with data that is stale the moment it is written.
     */
    let creditsDocument = null

    if (runtime === null) {
      record.message = 'this account has no runtime'
    } else if (credentialState === 'absent') {
      // No point in a network round trip that can only fail: there is nothing to
      // authenticate with, and this is not a cooldown-worthy observation.
      record.message = 'no credential file for this account'
    } else {
      try {
        const answer = await runtime.engine.quickCredits()
        creditsDocument = answer?.credits ?? null
        record.outcome = 'ok'
        record.credits = availableCreditsOf(answer?.credits)
        record.lastRefreshedAt = nowMs
      } catch (error) {
        const kind = errorKind(error)
        const message = error instanceof Error ? error.message : String(error)
        record.message = maskProbeMessage(message).slice(0, MAX_MESSAGE_LENGTH)
        if (kind === 'auth') {
          record.outcome = 'expired'
        } else if (kind === 'network') {
          record.outcome = 'network'
          record.retryAtMs = nowMs + NETWORK_COOLDOWN_MS
        } else if (/out of credit|insufficient|quota|balance/i.test(message)) {
          record.outcome = 'out-of-credit'
          record.retryAtMs = nowMs + HTTP_COOLDOWN_MS
        } else {
          record.outcome = 'unknown'
          record.retryAtMs = nowMs + HTTP_COOLDOWN_MS
        }
      }
    }

    this.probes[account.id] = record
    await writeMeasurementsProbes({ paths: this.paths, probes: { [account.id]: record }, log: this.log })

    if (record.outcome === 'expired' && account.enabled !== false) {
      // Automatic marking: only ever written here, and only for an auth failure.
      //
      // IT DOES NOT DISABLE THE ACCOUNT. `enabled` answers "is this account still
      // yours", while an expired sign-in credential only answers "can the
      // management API still be read". Folding the two together used to disable
      // a `sk-as-…` model key that was still perfectly usable, because the
      // billing account was pruned away and the model call moved to an account
      // that had no key at all. The marker is what automatic selection excludes
      // on; the account itself stays selectable by hand.
      //
      // The timers still stop: an engine that keeps polling a dead token sends a
      // failure notification every cycle. `stop()` runs on EVERY expired probe,
      // not just the first one, because a path that re-arms the schedulers (a
      // new refresh token saved through `/config`) must not leave a dead token
      // on a timer. Automatic selection's probe still runs — `runAutoSwitchCycle`
      // only skips disabled accounts — and `probe()` goes through
      // `quickCredits()`, which never notifies, so self-healing still happens
      // within one cycle for anyone using automatic selection.
      runtime?.stop()
      // NO `pruneActiveId` HERE. A manual choice outranks one failed probe, and
      // pruning is exactly what re-created the missing-key failure.
      //
      // Persist only when the marker actually changed: the account stays enabled
      // now, so this branch is reached on every cycle it stays expired.
      if (account.disabledReason !== 'expired') {
        account.disabledReason = 'expired'
        await this.#persist()
      }
    } else if (record.outcome === 'ok' && account.disabledReason === 'expired') {
      // Self-healing, and strictly scoped: a successful probe clears the reason
      // an automatic marking wrote, and never a `manual` one.
      account.enabled = true
      delete account.disabledReason
      runtime?.start(account)
      this.document.activeId = nextActiveId({ accounts: this.document.accounts, activeId: this.document.activeId })
      await this.#persist()
    }

    return {
      account: this.#project(account, nowMs),
      probe: record,
      credentialState,
      credits: record.credits,
      // The live document behind `credits` (null when the read failed). A reader
      // that wants BOTH the figure and everything around it — the composer pill
      // shows promotion, redeemable and available together — gets it from the
      // same request that recorded the measurement, so the two never disagree.
      creditsDocument,
    }
  }

  // -------------------------------------------------------------------------
  // Automatic selection
  // -------------------------------------------------------------------------

  /**
   * Start the credit-aware selection timer.
   *
   * The cycle runs on a timer boundary, never inside a request: no failover, no
   * in-flight counting (ADR 0001, Q13).
   *
   * @param {{ intervalMs?: number, probeOnCycle?: boolean }} [options]
   * @param {boolean} [options.probeOnCycle] - probe every enabled account before
   *   selecting (the honest reading of "自动选优以实时探测为准"); `false` decides
   *   from the measurements already on disk
   */
  startAutoSwitchCycle(options = {}) {
    this.stopAutoSwitchCycle()
    if (this.disposed) return this
    const intervalMs = Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
      ? Number(options.intervalMs)
      : AUTO_SWITCH_INTERVAL_MS
    const probeOnCycle = options.probeOnCycle !== false
    this.autoSwitchTimer = setInterval(() => {
      void this.runAutoSwitchCycle({ probeOnCycle }).catch(error => {
        this.log(`auto-switch cycle failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, intervalMs)
    this.autoSwitchTimer.unref?.()
    return this
  }

  /** Stop the selection timer. Safe to call repeatedly. */
  stopAutoSwitchCycle() {
    if (this.autoSwitchTimer !== null) {
      clearInterval(this.autoSwitchTimer)
      this.autoSwitchTimer = null
    }
    return this
  }

  /**
   * Persist the automatic-selection settings and arm or disarm the timer.
   *
   * @param {{ enabled?: boolean, thresholdPct?: number }} [input]
   */
  async setAutoSwitch(input = {}) {
    await this.ready()
    const current = this.document.autoSwitch
    const enabled = input.enabled === undefined ? current.enabled === true : input.enabled === true
    const thresholdPct = input.thresholdPct === undefined
      ? current.thresholdPct
      : Math.min(100, Math.max(0, Number(input.thresholdPct) || 0))
    this.document.autoSwitch = { enabled, thresholdPct }
    await this.#persist()
    if (enabled) this.startAutoSwitchCycle()
    else this.stopAutoSwitchCycle()
    return this.view()
  }

  /**
   * Run one selection round.
   *
   * @param {{ probeOnCycle?: boolean, nowMs?: number, intervalMs?: number }} [options]
   * @returns {Promise<{ switched: boolean, from: string | null, to: string | null, probed: string[], skipped?: string }>}
   */
  async runAutoSwitchCycle(options = {}) {
    await this.ready()
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
    const from = this.activeId
    if (this.document.autoSwitch.enabled !== true) {
      return { switched: false, from, to: from, probed: [], skipped: 'automatic selection is off' }
    }

    const probed = []
    if (options.probeOnCycle !== false) {
      for (const account of this.document.accounts) {
        if (account.enabled === false) continue
        probed.push(account.id)
        // A probe never throws for a platform failure; the loop therefore cannot
        // be broken by one bad account.
        await this.probe(account.id, { nowMs })
      }
    }

    const picked = pickBestAccount({
      accounts: this.document.accounts,
      probes: this.probes,
      activeId: this.document.activeId,
      thresholdPct: this.document.autoSwitch.thresholdPct,
      nowMs,
    })
    const to = picked ? picked.id : null
    if (to !== null && to !== this.document.activeId) {
      this.document.activeId = to
      await this.#persist()
      this.log(`automatic selection moved billing from ${from ?? 'none'} to ${to}`)
    }
    return { switched: to !== null && to !== from, from, to: this.document.activeId, probed }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Arm every account's scheduler plus the selection timer (if enabled). */
  start() {
    if (this.disposed) return this
    // Each runtime is handed its own document entry: `start()` skips an account
    // whose sign-in credential is expired, and that marker lives on the entry.
    for (const [id, runtime] of this.runtimes) {
      runtime.start(this.document.accounts.find(entry => entry.id === id))
    }
    if (this.document.autoSwitch.enabled === true) this.startAutoSwitchCycle()
    return this
  }

  /**
   * Stop every timer this pool owns: each account's credit-snapshot interval,
   * its check-in scheduler, and the automatic-selection cycle.
   *
   * `index.js` calls this from `ctx.effect` cleanup. Without it a hot reload
   * leaves the previous instance's schedulers running beside the new ones, and
   * two schedulers race one rotating refresh token.
   */
  stop() {
    this.stopAutoSwitchCycle()
    for (const runtime of this.runtimes.values()) runtime.stop()
    return this
  }

  /** `stop()` and refuse to be restarted (plugin teardown). Idempotent. */
  dispose() {
    this.stop()
    this.disposed = true
    return this
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #createRuntime(account) {
    return new AccountRuntime({
      id: account.id,
      paths: accountPaths(this.paths, account.id),
      checkinSettings: () => {
        const document = this.settings()
        return document && typeof document === 'object' ? document.checkin ?? {} : {}
      },
      log: this.log,
    })
  }

  #requireAccount(id) {
    const key = typeof id === 'string' ? id : ''
    const account = this.document.accounts.find(entry => entry.id === key)
    if (!account) throw badParam(`unknown account: ${String(id)}`)
    return account
  }

  /**
   * Delete one account's own directory.
   *
   * Guarded so a path outside this install's `vault/accounts/` is never touched.
   */
  #removeAccountDirectory(id) {
    try {
      const dir = dirname(accountPaths(this.paths, id).login)
      if (!isInside(this.paths.vaultDir, dir)) return
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      this.log(`could not remove the directory for account ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Persist the whole document.
   *
   * Delegates serialisation to `saveAccounts()` — one queue for every document
   * write in the plugin — and remembers the tail so a caller can await it.
   */
  #persist() {
    const promise = saveAccounts({ paths: this.paths, document: this.document, log: this.log })
    this.saving = promise
    return promise
  }
}
