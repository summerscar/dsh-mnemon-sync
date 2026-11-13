/**
 * AgentScope Platform — the multi-account foundation.
 *
 * Two things live here, both deliberately free of side effects at import time:
 *
 * 1. **Selection pure functions.** Which account should a *new* request use?
 *    The answer must be a function of the documents alone — no clock read, no
 *    randomness, no rotation cursor. `nowMs` is an argument, not `Date.now()`,
 *    so the same inputs always give the same answer and a test can pin it.
 * 2. **Document IO.** The account pool is one JSON document; measurements are
 *    another. They are separate files on purpose: a settings save must never
 *    overwrite what a probe cycle just wrote (the reference implementation
 *    records that exact incident in its own comments).
 *
 * Vocabulary follows `.scratch/GLOSSARY.md`: an **Account** is a credential
 * identity, the **Active account** is the single billed-to one, a **Probe** is
 * one availability measurement with its **Probe outcome**, and an **Exclusion**
 * is the reason an account is temporarily or permanently out of automatic
 * selection. Probe outcome and exclusion reason are two different things and are
 * never substituted for one another.
 *
 * This module imports nothing from the plugin's other modules except `paths.js`,
 * which is pure path arithmetic: the selectors are unit-testable on their own,
 * and a circular import with `as.js` would be a trap.
 *
 * @module dsh-connect-agentscope-platform/measurements
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { accountPaths, accountsFile, measurementsFile } from './paths.js'

/** The id shape: exactly 24 lowercase hex digits, with no reserved id beside it. */
export const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/

/** Longest label accepted, in characters (matches the panel's maxLength). */
export const MAX_LABEL_LENGTH = 30

/** Version written into both documents; bumped only by a migration. */
export const DOCUMENT_VERSION = 1

/** Disabled reasons an account may carry, per the Q10 decision. */
export const DISABLED_REASONS = ['manual', 'expired']

/** Probe outcomes, per the plan's measurements schema. */
export const PROBE_OUTCOMES = ['ok', 'expired', 'out-of-credit', 'network', 'unknown']

/** Longest probe message kept, after masking. */
export const MAX_MESSAGE_LENGTH = 200

/**
 * Clean one account entry read from the document, or `null` when it must be
 * dropped.
 *
 * The id doubles as a directory name under `vault/accounts/`, so a bad id is a
 * path-traversal risk and is refused rather than sanitised. Unknown fields are
 * dropped — a stray `accessToken` must never be copied forward into the
 * document, which is why credentials are only ever accepted by `saveCredentials`
 * and never by this function.
 *
 * @param {unknown} value - the raw entry
 * @returns {object | null} the normalised entry
 */
export function normalizeAccount(value) {
  if (!value || typeof value !== 'object') return null

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!ACCOUNT_ID_RE.test(id)) return null

  const label = typeof value.label === 'string' ? value.label.trim().slice(0, MAX_LABEL_LENGTH) : ''
  if (label === '') return null

  const enabled = value.enabled !== false
  const createdAt = Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : 0

  /** @type {Record<string, unknown>} */
  const account = { id, label, enabled, createdAt }

  // A disabled reason only describes a disabled account, and only the two
  // agreed reasons are meaningful (Q10). Anything else is dropped, not repaired.
  if (!enabled && DISABLED_REASONS.includes(value.disabledReason)) account.disabledReason = value.disabledReason

  return account
}

/**
 * Which account the pool should bill to after a mutation.
 *
 * Three cases, and the third is the one that keeps surprising people:
 *
 * 1. **No active account yet** (first account ever, or after the pool emptied):
 *    the first account becomes active, so a fresh install is usable at once.
 * 2. **The active account is still present**: it stays active. Adding an
 *    account, re-logging-in to the active one, or saving settings must not
 *    silently move billing to a different account.
 * 3. **An explicit activation** is the only thing that moves it. Passing
 *    `activate` names the account to bill to; when that id is unknown or
 *    disabled the current choice stands, so a stale button cannot disable
 *    billing by accident.
 *
 * @param {object} input
 * @param {object[]} [input.accounts]
 * @param {string | null} [input.activeId]
 * @param {object} [input.added] - the account just added (documentation of intent)
 * @param {string | null} [input.activate] - the account to switch to
 * @returns {string | null}
 */
export function nextActiveId({ accounts = [], activeId = null, activate = null } = {}) {
  const list = Array.isArray(accounts) ? accounts.filter(entry => entry && typeof entry === 'object') : []
  if (list.length === 0) return null

  const usable = id => list.some(entry => entry.id === id && entry.enabled !== false)

  if (typeof activate === 'string' && activate !== '') {
    if (usable(activate)) return activate
    if (usable(activeId)) return activeId
    return list.find(entry => entry.enabled !== false)?.id ?? null
  }

  if (usable(activeId)) return activeId
  return list.find(entry => entry.enabled !== false)?.id ?? null
}

/**
 * Repair a dangling `activeId`.
 *
 * A document can name an account that no longer exists: a hand-edited file, an
 * account removed by an older build, or a disabled account that must stop
 * billing. Rather than throw, fall back to the first enabled account, and to
 * `null` when nothing is enabled — "no billing account" is a state the caller
 * can render, an exception at startup is not.
 *
 * @param {object} input
 * @param {object[]} [input.accounts]
 * @param {string | null} [input.activeId]
 * @returns {string | null}
 */
export function pruneActiveId({ accounts = [], activeId = null } = {}) {
  const list = Array.isArray(accounts) ? accounts.filter(entry => entry && typeof entry === 'object') : []
  if (list.some(entry => entry.id === activeId && entry.enabled !== false)) return activeId
  return list.find(entry => entry.enabled !== false)?.id ?? null
}

/**
 * A credit figure, or `null` when the measurement did not record one.
 *
 * `Number(null)` and `Number('')` are both `0`, so a missing figure would
 * otherwise be stored as "this account has zero credits" — a fabricated
 * measurement that would then be used as evidence. An absent figure is
 * `null`, and `null` means unknown everywhere downstream.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function creditFigure(value) {
  if (value === null || value === undefined || value === '') return null
  const credits = Number(value)
  return Number.isFinite(credits) ? credits : null
}

/**
 * Why an account is out of automatic selection, or `null` when it is selectable.
 *
 * The cooldown self-heals: a `retryAtMs` in the past is simply no longer a
 * reason, and an `ok` outcome clears it outright — a successful probe is
 * positive evidence that overrides the previous failure's back-off.
 *
 * @param {{ account?: object, probe?: object, nowMs?: number }} input
 * @returns {{ reason: 'disabled' | 'expired' | 'cooldown' | 'unknown-credits', untilMs?: number } | null}
 */
export function exclusionOf({ account, probe, nowMs = 0 } = {}) {
  if (!account || typeof account !== 'object') return { reason: 'disabled' }
  if (account.enabled === false) return { reason: 'disabled' }
  if (account.disabledReason === 'expired') return { reason: 'expired' }

  const outcome = typeof probe?.outcome === 'string' ? probe.outcome : ''
  if (outcome === 'expired') return { reason: 'expired' }

  // An `ok` probe is authoritative: it clears any pending back-off.
  if (outcome !== 'ok') {
    const untilMs = Number(probe?.retryAtMs)
    if (Number.isFinite(untilMs) && untilMs > nowMs) return { reason: 'cooldown', untilMs }
  }

  if (creditFigure(probe?.credits) === null) return { reason: 'unknown-credits' }

  return null
}

/**
 * The best account for a new request, or `null` when none qualifies.
 *
 * Rule: among accounts that are enabled, credentialed and carry a known credit
 * figure, take the one holding the most credits. Switching only pays off when
 * the active account has fallen below `thresholdPct` percent of that best
 * figure; otherwise the active account is kept, so a trivial lead never causes
 * a switch on every probe cycle.
 *
 * Ties break on document order, then on id, so the result never depends on
 * enumeration accidents.
 *
 * @param {object} input
 * @param {object[]} [input.accounts]
 * @param {Record<string, object>} [input.probes]
 * @param {string | null} [input.activeId]
 * @param {number} [input.thresholdPct] - switch when active is under this share of the best
 * @param {number} [input.nowMs] - caller-supplied clock, never read here
 * @returns {object | null} the chosen account (the document's own object)
 */
export function pickBestAccount({ accounts = [], probes = {}, activeId = null, thresholdPct = 20, nowMs = 0 } = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null
  const probeOf = id => (probes && typeof probes === 'object' ? probes[id] : undefined)

  /** @type {{ account: object, credits: number }[]} */
  const candidates = []
  for (const account of accounts) {
    if (!account || typeof account !== 'object') continue
    if (exclusionOf({ account, probe: probeOf(account.id), nowMs })) continue
    candidates.push({ account, credits: creditFigure(probeOf(account.id)?.credits) })
  }
  if (candidates.length === 0) return null

  candidates.sort((left, right) => {
    if (right.credits !== left.credits) return right.credits - left.credits
    return accounts.indexOf(left.account) - accounts.indexOf(right.account)
  })

  const best = candidates[0]
  const threshold = Number(thresholdPct)
  if (activeId == null) return best.account

  const active = accounts.find(entry => entry?.id === activeId)
  if (!active) return best.account
  if (active === best.account) return best.account
  if (exclusionOf({ account: active, probe: probeOf(activeId), nowMs })) return best.account

  const activeCredits = creditFigure(probeOf(activeId)?.credits)
  // A best figure of zero means nothing to gain: stay put rather than churn.
  if (!(best.credits > 0)) return active
  if (!Number.isFinite(threshold) || threshold <= 0) return best.account

  const share = (activeCredits / best.credits) * 100
  return share < threshold ? best.account : active
}

// ---------------------------------------------------------------------------
// ② Documents
// ---------------------------------------------------------------------------

/**
 * The document a fresh install gets: no accounts, no billing account, automatic
 * selection off until the user asks for it.
 */
export function emptyAccountsDocument() {
  return { version: DOCUMENT_VERSION, activeId: null, accounts: [], autoSwitch: { enabled: false, thresholdPct: 20 } }
}

/**
 * Read a JSON file, or `undefined` when it is absent, empty or corrupt.
 *
 * A corrupt document is a normal condition here, not an exception: the caller
 * degrades to an empty pool and logs, because a plugin that refuses to start
 * over a malformed cache file is worse than one that starts empty.
 *
 * @param {string} file
 * @returns {unknown}
 */
function readJsonQuietly(file) {
  try {
    if (!existsSync(file)) return undefined
    const raw = readFileSync(file, 'utf8')
    if (raw.trim() === '') return undefined
    return JSON.parse(raw)
  } catch { return undefined }
}

/**
 * Whether a file's permissions are safe to read.
 *
 * Mirrors the reference implementation's three-state check, simplified to two:
 * a credential file that is readable by group or others is treated as unusable
 * so the user is told to fix the mode, but it never throws and never blocks
 * startup.
 *
 * @param {string} file
 * @returns {'absent' | 'usable' | 'unusable'}
 */
export function credentialFileState(file) {
  try {
    if (!existsSync(file)) return 'absent'
    return (statSync(file).mode & 0o077) === 0 ? 'usable' : 'unusable'
  } catch { return 'absent' }
}

/**
 * Whether a single-account install left its files at the state root.
 *
 * Deliberately checks the *files*, not the vault directory: an install that ran
 * once creates the directory but may never have logged in.
 *
 * @param {ReturnType<typeof pluginPaths>} paths
 */
function hasRootCredentials(paths) {
  return existsSync(paths.login) || existsSync(paths.modelKey)
}

/**
 * The label the adopted account gets.
 *
 * A neutral, ordinal name. It is a data-layer default the user renames at will;
 * naming it after where it came from would make one ordinary account look
 * special in the panel, which is exactly the impression this module avoids.
 */
export const ADOPTED_ACCOUNT_LABEL = '账号 1'

/**
 * The id an adopted account gets, derived from the credential bytes themselves.
 *
 * Derived rather than random on purpose: the takeover can run again (the pool
 * document is lost, truncated, or hand-edited into nonsense) and it must land on
 * the *same* account instead of inventing a second one each time. The root
 * credential files are never rewritten after a takeover — only the account's own
 * copies rotate — so their bytes are a stable seed for that id.
 *
 * @param {ReturnType<typeof pluginPaths>} paths
 * @returns {string} 24 lowercase hex digits
 */
function adoptedAccountId(paths) {
  const hash = createHash('sha256')
  hash.update('agentscope-adopted\0')
  for (const file of [paths.login, paths.modelKey]) {
    hash.update(existsSync(file) ? readFileSync(file) : Buffer.alloc(0))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 24)
}

/**
 * Take over a single-account install's files as one ordinary account.
 *
 * WHAT IT DOES. Copies the four per-account files (credentials, credit history,
 * check-in record) into `vault/accounts/<id>/`, then returns a document with one
 * plain account in it. Nothing about the account is marked as adopted: the id is
 * 24 hex digits like every other id, the entry has no extra field, and every
 * later code path treats it exactly like an account the user added by hand.
 *
 * WHY COPY AND NOT MOVE. Two reasons, and both are about not losing data:
 *
 * 1. **A copy cannot lose the original.** A move that dies between files leaves
 *    the install with some files at the root and some in the new directory; a
 *    copy leaves the originals untouched until the takeover has fully succeeded,
 *    so the failure mode is "nothing changed", which the caller turns into an
 *    empty pool and retries on the next start.
 * 2. **The originals are what makes the takeover repeatable.** If the pool
 *    document is later lost, the same bytes produce the same id, so the rebuild
 *    reconnects to the same account directory instead of creating a duplicate.
 *    A move would destroy that seed.
 *
 * The cost is one stale copy of the credential files at the state root. They are
 * never read again (the runtime reads only the account's own paths) and they are
 * never rewritten, so the leftover holds a refresh token that rotation has
 * already superseded.
 *
 * THE DIRECTORY APPEARS ATOMICALLY: the files are staged under
 * `vault/accounts/<id>.adopting` and renamed into place, so a reader never sees a
 * half-filled account directory. A failed takeover removes its staging directory
 * and rethrows; the caller decides what a failed takeover means.
 *
 * @param {ReturnType<typeof pluginPaths>} paths
 * @param {number} nowMs - the `createdAt` recorded for the adopted account
 * @param {(message: string) => void} log
 * @returns {object} the pool document
 */
function adoptSingleAccountInstall(paths, nowMs, log) {
  const id = adoptedAccountId(paths)
  const owned = accountPaths(paths, id)
  const dir = dirname(owned.login)

  const pairs = [
    [paths.login, owned.login],
    [paths.modelKey, owned.modelKey],
    [paths.log, owned.log],
    [paths.checkin, owned.checkin],
  ]

  // A previous run already completed this takeover (a repair after the pool
  // document was lost): the account directory is authoritative, copy nothing.
  if (!existsSync(owned.login) && !existsSync(owned.modelKey)) {
    const staging = `${dir}.adopting`
    try {
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      for (const [from, to] of pairs) {
        if (!existsSync(from)) continue
        const staged = join(staging, basename(to))
        copyFileSync(from, staged)
        // The source may carry a looser mode; the copy is a credential file and
        // is tightened here rather than trusted to inherit.
        try { chmodSync(staged, 0o600) } catch { /* best effort */ }
      }
      mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
      try {
        renameSync(staging, dir)
      } catch (error) {
        // Another process finished the same takeover first; its directory wins.
        if (existsSync(owned.login) || existsSync(owned.modelKey)) {
          try { rmSync(staging, { recursive: true, force: true }) } catch { /* best effort */ }
        } else {
          throw error
        }
      }
    } catch (error) {
      try { rmSync(staging, { recursive: true, force: true }) } catch { /* best effort */ }
      throw error
    }
    log(`took over the credentials of this single-account install as account ${id}`)
  }

  return {
    version: DOCUMENT_VERSION,
    activeId: id,
    accounts: [{ id, label: ADOPTED_ACCOUNT_LABEL, enabled: true, createdAt: nowMs }],
    autoSwitch: { enabled: false, thresholdPct: 20 },
  }
}

/**
 * Clean a document read from disk, keeping only what `normalizeAccount` accepts.
 *
 * A document whose shape is unusable yields `null` so the caller can decide
 * between taking over a single-account install and starting empty — this
 * function never invents accounts.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeAccountsDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Array.isArray(raw.accounts)) return null

  const accounts = []
  for (const entry of raw.accounts) {
    const normalized = normalizeAccount(entry)
    if (normalized) accounts.push(normalized)
  }
  if (accounts.length === 0) return null

  const autoSwitch = raw.autoSwitch && typeof raw.autoSwitch === 'object' ? raw.autoSwitch : {}
  const thresholdPct = Number(autoSwitch.thresholdPct)
  return {
    version: DOCUMENT_VERSION,
    activeId: pruneActiveId({ accounts, activeId: typeof raw.activeId === 'string' ? raw.activeId : null }),
    accounts,
    autoSwitch: {
      enabled: autoSwitch.enabled === true,
      thresholdPct: Number.isFinite(thresholdPct) ? Math.min(100, Math.max(0, thresholdPct)) : 20,
    },
  }
}

/**
 * Read the account pool, taking over a single-account install on first use.
 *
 * The takeover runs at most once, and only when the pool document did not exist
 * (or was unusable). A second call reads the file the first one wrote and
 * returns the same thing, which is what makes it safe to call from several
 * entry points.
 *
 * FAILURE NEVER BLOCKS STARTUP: a takeover that cannot copy the files is logged
 * and degrades to an empty pool. The originals are still at the state root, so
 * the next start tries again — losing a session's convenience is recoverable,
 * refusing to load the plugin is not.
 *
 * @param {object} input
 * @param {ReturnType<typeof pluginPaths>} input.paths
 * @param {(message: string) => void} [input.log]
 * @param {number} [input.nowMs] - caller-supplied clock for the adopted `createdAt`
 * @returns {Promise<object>} the document (never throws)
 */
export async function loadAccounts({ paths, log = () => {}, nowMs = 0 } = {}) {
  if (!paths) throw new TypeError('loadAccounts needs paths from pluginPaths()')
  const file = accountsFile(paths)

  const raw = readJsonQuietly(file)
  if (raw !== undefined) {
    const normalized = normalizeAccountsDocument(raw)
    if (normalized) return normalized
    // Present but unusable. Do not throw and do not block startup: fall through
    // to the same rebuild the takeover uses, so an install whose pool document
    // got truncated still comes back with its old credentials rather than an
    // empty pool.
    log(`accounts document at ${file} is unusable; rebuilding it`)
  }

  if (credentialFileState(paths.login) === 'unusable' || credentialFileState(paths.modelKey) === 'unusable') {
    log(`credential files under ${paths.vaultDir} are readable by group or others; run: chmod 600 ${paths.login} ${paths.modelKey}`)
  }

  let document = emptyAccountsDocument()
  if (hasRootCredentials(paths)) {
    try {
      document = adoptSingleAccountInstall(paths, nowMs, log)
    } catch (error) {
      // The originals are untouched by a failed copy, so this is retryable on the
      // next start rather than a reason to fail the plugin.
      log(`could not take over the single-account credentials: ${error instanceof Error ? error.message : String(error)}`)
      document = emptyAccountsDocument()
    }
  }

  // Only a takeover (or a repair) writes here; a plain read of a good document
  // never does, which is what makes a second call byte-identical.
  await saveAccounts({ paths, document, log })
  return document
}

/**
 * Serialise document writes.
 *
 * A refresh-token rotation and a settings save can both finish while the other
 * is between "read" and "write", and a plain read-modify-write would then lose
 * one of them. Every write path goes through one queue, so writes land in the
 * order they were requested and never interleave. Queueing (not rejecting) is
 * deliberate: dropping a credential write is worse than delaying it.
 */
const writeQueue = []
let writeInFlight = false

/** Run `task` after every previously queued task has settled. */
function enqueueWrite(task) {
  return new Promise((resolve, reject) => {
    writeQueue.push({ task, resolve, reject })
    pumpWriteQueue()
  })
}

function pumpWriteQueue() {
  if (writeInFlight) return
  const next = writeQueue.shift()
  if (!next) return
  writeInFlight = true
  Promise.resolve()
    .then(next.task)
    .then(next.resolve, next.reject)
    .finally(() => {
      writeInFlight = false
      pumpWriteQueue()
    })
}

/**
 * Write one document atomically: `<file>.tmp` then `rename`, owner-only.
 *
 * `rename` within one directory is atomic on POSIX, so a reader sees either the
 * previous document or the new one and never a half-written file. The temporary
 * name is derived from the target so two documents cannot collide.
 *
 * @param {string} file
 * @param {unknown} value
 */
function writeJsonAtomic(file, value) {
  const dir = dirname(file)
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* already there */ }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try { renameSync(tmp, file) } catch (error) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
  // `writeFileSync` honours the mode only when it creates the file; a renamed
  // temporary may carry a looser mode, so tighten it explicitly.
  try { if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600) } catch { /* best effort */ }
}

/**
 * Persist the account pool.
 *
 * Queued behind every other write, written atomically at 0600. Failures are
 * logged and swallowed: a failed save must not take down the panel that asked
 * for it, and the caller can read the document back to see what landed.
 *
 * @param {object} input
 * @param {ReturnType<typeof pluginPaths>} input.paths
 * @param {object} input.document
 * @param {(message: string) => void} [input.log]
 * @returns {Promise<boolean>} whether the document reached the disk
 */
export function saveAccounts({ paths, document, log = () => {} } = {}) {
  if (!paths) throw new TypeError('saveAccounts needs paths from pluginPaths()')
  return enqueueWrite(() => {
    try {
      const normalized = normalizeAccountsDocument(document)
      if (!normalized) return false
      writeJsonAtomic(accountsFile(paths), normalized)
      return true
    } catch (error) {
      log(`could not save the accounts document: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  })
}

/** The document a fresh install gets: no probes recorded yet. */
export function emptyMeasurementsDocument() {
  return { version: DOCUMENT_VERSION, probes: {} }
}

/**
 * Mask anything that looks like a credential before a message is persisted.
 *
 * A probe message quotes the upstream error, and upstream errors quote the
 * token that failed. The measurement log is a cache, not a vault, so the value
 * is masked first and truncated second — the other order would leave a partial
 * secret in place. This mirrors `maskSecret` in `as.js` rather than importing
 * it: that module drags in the whole credit engine, and the IO half of this
 * module is meant to stay importable on its own.
 *
 * @param {unknown} message
 * @returns {string}
 */
export function maskProbeMessage(message) {
  const text = typeof message === 'string' ? message : String(message ?? '')
  if (text === '') return ''
  const masked = text
    // `sk-as-…` model keys and generic bearer-style tokens.
    .replace(/sk-as-[A-Za-z0-9_-]{8,}/g, 'sk-as-****')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, 'jwt-****')
    .replace(/\b(Bearer|token|access_token|refresh_token)\s+[A-Za-z0-9._-]{8,}/gi, '$1 ****')
  return masked.slice(0, MAX_MESSAGE_LENGTH)
}

/**
 * Clean one probe record, keeping only the documented fields.
 *
 * @param {unknown} value
 * @returns {object | null}
 */
function normalizeProbe(value) {
  if (!value || typeof value !== 'object') return null

  const outcome = PROBE_OUTCOMES.includes(value.outcome) ? value.outcome : 'unknown'
  const atMs = Number.isFinite(Number(value.atMs)) ? Number(value.atMs) : 0
  const credits = creditFigure(value.credits)

  /** @type {Record<string, unknown>} */
  const probe = { outcome, atMs, retryAtMs: 0, message: maskProbeMessage(value.message), credits }
  // A successful probe clears the back-off: there is no deadline to wait for.
  if (outcome !== 'ok') {
    const retryAtMs = Number(value.retryAtMs)
    probe.retryAtMs = Number.isFinite(retryAtMs) && retryAtMs > 0 ? retryAtMs : 0
  }
  if (Number.isFinite(Number(value.lastRefreshedAt))) probe.lastRefreshedAt = Number(value.lastRefreshedAt)
  return probe
}

/**
 * Read the measurement log.
 *
 * Never throws: a corrupt or missing document reads as an empty log, because
 * measurements are a cache that a probe cycle can rebuild, and a plugin that
 * refuses to start over one is worse than one that starts with no history.
 *
 * @param {object} input
 * @param {ReturnType<typeof pluginPaths>} input.paths
 * @param {(message: string) => void} [input.log]
 * @returns {Promise<{ version: number, probes: Record<string, object> }>}
 */
export async function loadMeasurements({ paths, log = () => {} } = {}) {
  if (!paths) throw new TypeError('loadMeasurements needs paths from pluginPaths()')
  const file = measurementsFile(paths)
  const raw = readJsonQuietly(file)
  if (raw === undefined) return emptyMeasurementsDocument()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.probes !== 'object' || raw.probes === null) {
    log(`measurement log at ${file} is unusable; starting from an empty log`)
    return emptyMeasurementsDocument()
  }

  /** @type {Record<string, object>} */
  const probes = {}
  for (const [id, value] of Object.entries(raw.probes)) {
    if (!ACCOUNT_ID_RE.test(id)) continue
    const probe = normalizeProbe(value)
    if (probe) probes[id] = probe
  }
  return { version: DOCUMENT_VERSION, probes }
}

/**
 * Record probe results, merging them into the existing log.
 *
 * **Merge, not replace.** Two probe cycles for different accounts can overlap,
 * and the second must not erase what the first learned. Per account the newest
 * record wins outright, because a probe result is a whole observation rather
 * than a set of independent fields.
 *
 * A failure is logged and swallowed: a measurement is best-effort telemetry and
 * must never propagate into the request path that produced it.
 *
 * @param {object} input
 * @param {ReturnType<typeof pluginPaths>} input.paths
 * @param {Record<string, object>} input.probes - new records, keyed by account id
 * @param {(message: string) => void} [input.log]
 * @returns {Promise<boolean>} whether the log reached the disk
 */
export function writeMeasurementsProbes({ paths, probes = {}, log = () => {} } = {}) {
  if (!paths) throw new TypeError('writeMeasurementsProbes needs paths from pluginPaths()')
  const incoming = probes && typeof probes === 'object' ? probes : {}
  return enqueueWrite(async () => {
    try {
      const current = await loadMeasurements({ paths, log })
      const merged = { version: DOCUMENT_VERSION, probes: { ...current.probes } }
      for (const [id, value] of Object.entries(incoming)) {
        if (!ACCOUNT_ID_RE.test(id)) continue
        const probe = normalizeProbe(value)
        if (probe) merged.probes[id] = probe
      }
      writeJsonAtomic(measurementsFile(paths), merged)
      return true
    } catch (error) {
      log(`could not write the measurement log: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  })
}
