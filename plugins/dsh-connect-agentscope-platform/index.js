/**
 * AgentScope Platform — Host half.
 *
 * One plugin, three capabilities, and they are deliberately independent:
 *
 *   1. OPTIONAL MODEL PROVIDER. Off by default. Switching it on registers the
 *      `agentscope` route (adapter + configurable-provider entry + model
 *      discovery); switching it off withdraws that route without a restart, and
 *      `replace([])` is what does it. Everything else keeps working.
 *
 *   2. CREDIT ENGINE. Login JWT refresh, credits, contribution ledger, usage
 *      detail, campaign grants and contribution redemption. Credentials live only
 *      in this process and in 0600 files; the browser only ever receives masks.
 *
 *   3. DAILY CHECK-IN. Keep the login alive once a day and report what the
 *      platform's own contribution ledger says about today's `daily_login`. The
 *      platform has no check-in endpoint, and this plugin does not pretend it
 *      does — see checkin.js for the full reasoning.
 *
 * The browser half talks to `/api/agentscope-platform/*` on the same origin, so
 * no token ever crosses into the page.
 *
 * @module dsh-connect-agentscope-platform
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CreditEngine, badParam, listNotifyMethods, zonedParts } from './as.js'
import { AccountPool, accountIdFor } from './account-runtime.js'
import {
  DEFAULT_BASE_URL,
  DEFAULT_INPUT,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
  bundledModels,
  normalizeModel,
  positiveInteger,
} from './models.js'
import {
  DEFAULT_TTL_MS,
  enrichRow,
  fetchTable,
  isCompleteTable,
  metaCacheMtime,
  parseTable,
  readMetaCache,
  writeMetaCache,
} from './model-meta.js'
import { ensureDir, ensureStateDirs, pluginPaths } from './paths.js'

/** API prefix. Frozen: the browser half hard-codes it. */
const API_PREFIX = '/api/agentscope-platform'

/** Bumped when the on-disk shape changes in a way that needs a one-time fix. */
const CATALOG_SCHEMA_VERSION = 2

/** Which build of this module is actually loaded. Bump on every host-side change. */
const BUILD = 'asp-2026-11-12.8'

/** Largest reasoning tier list a row may carry; guards a hand-edited file. */
const MAX_REASONING_TIERS = 8

/**
 * What the panel sees for a per-account field when the pool holds no account.
 *
 * A zero-account install is a real state (a fresh profile, or every account
 * removed down to the last refusal), and the panel must render "nothing
 * configured" rather than an error. The shapes are the same ones `as.js` and
 * `checkin.js` produce for an empty account, so a reader cannot tell the
 * difference — which is the point: there is nothing else to tell it.
 */
const EMPTY_CHECKIN_VIEW = Object.freeze({
  enabled: false,
  day: '',
  status: 'idle',
  attempts: 0,
  lastAttemptAt: 0,
  detail: '',
  error: '',
  running: false,
  timerActive: false,
  timezone: 'Asia/Shanghai',
})

const EMPTY_CREDITS_VIEW = Object.freeze({
  config: Object.freeze({
    hasAccessToken: false,
    accessTokenMask: '',
    hasRefreshToken: false,
    refreshTokenMask: '',
    usable: false,
    credentialState: 'none',
    expiresAt: null,
    refreshedAt: null,
    expiresInSec: null,
    autoRefresh: true,
    enabled: false,
    intervalMin: 30,
    notify: Object.freeze({ enabled: false, method: 'auto', botId: '', targetId: '', to: '' }),
  }),
  notifyMethods: Object.freeze([]),
  latest: null,
  notifyLog: Object.freeze([]),
  log: Object.freeze([]),
  totalSnapshots: 0,
  timerActive: false,
})

export const inject = ['llm']

/**
 * Read a JSON file, or the fallback. Never throws: a missing or corrupt state
 * file must degrade to defaults rather than stop the plugin.
 * @param {string} file
 * @param {unknown} fallback
 */
function readJsonFile(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) ?? fallback
  } catch { return fallback }
}

/** Write JSON for one of this plugin's own state files, always 0600. */
function writeJsonFile(file, value) {
  try {
    writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
    return true
  } catch { return false }
}

/**
 * Move state from the pre-release flat directory into this plugin's own layout.
 *
 * One-time and purely additive: an existing file at the destination always wins,
 * and a missing source is not an error. Without it a redeploy would re-download
 * the four-megabyte model table and look like data was lost.
 *
 * @param {ReturnType<typeof pluginPaths>} paths
 * @param {{ logger?: { warn?: (message: string) => void } }} ctx
 */

/**
 * The plugin's own settings: the provider switch, the catalog overrides, the
 * check-in switches and the metadata refresh cadence.
 *
 * Kept in its own 0600 file rather than in the harness settings document: none of
 * it is a credential, but all of it is internal state that must survive a
 * restart even where a profile's settings document is read-only.
 */
function loadSettings(paths) {
  const saved = readJsonFile(paths.settings, {})
  const config = saved && typeof saved === 'object' ? saved : {}
  return {
    // Opt-in by design: an unconfigured profile must not grow a provider.
    providerEnabled: config.providerEnabled === true,
    baseUrl: typeof config.baseUrl === 'string' && config.baseUrl.trim() !== '' ? config.baseUrl.trim() : DEFAULT_BASE_URL,
    // Model rows the user built or edited (fetched, hand-added, hand-tuned).
    catalog: Array.isArray(config.catalog) ? config.catalog.map(row => normalizeModel(row)).filter(Boolean) : [],
    // Whether the bundled roster seeds the catalog. A user who deleted every row
    // on purpose must not have them come back on the next restart, so "the user
    // has an opinion" is recorded rather than inferred from an empty list.
    catalogSeeded: config.catalogSeeded === true,
    checkin: {
      enabled: config.checkin?.enabled === true,
    },
    metaRefreshHours: Math.min(168, Math.max(1, Number(config.metaRefreshHours) || 24)),
    schemaVersion: Number(config.schemaVersion) || 0,
  }
}

/**
 * Coerce the panel's model rows into what this plugin stores.
 *
 * Every field is validated here rather than trusted from the browser: a row is
 * what the adapter will advertise, and a negative context window would be
 * rejected by the host with an opaque error.
 * @param {unknown} rows
 * @returns {object[]}
 */
export function sanitizeCatalogRows(rows) {
  if (!Array.isArray(rows)) return []
  const seen = new Set()
  const kept = []
  for (const raw of rows) {
    const row = normalizeModel(raw)
    if (row === undefined || seen.has(row.id)) continue
    seen.add(row.id)
    // Capacity stays NULL when the user did not type one. Storing a default here
    // would turn "leave it to the remote figure" into a permanent override.
    const maxTokens = row.maxTokens === null ? null : Math.min(row.maxTokens, row.contextWindow ?? row.maxTokens)
    kept.push({
      id: row.id,
      name: row.name,
      contextWindow: row.contextWindow,
      maxTokens,
      input: row.input,
      reasoningEfforts: row.reasoningEfforts.slice(0, MAX_REASONING_TIERS),
    })
  }
  return kept
}

/**
 * Wire the plugin into one Cordis context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [patchConfig] - the loader entry's config (unused today)
 */
export function apply(ctx, patchConfig = {}) {
  void patchConfig
  const log = message => { try { ctx.logger?.warn?.(`[agentscope-platform] ${message}`) } catch { /* no logger */ } }
  // The plugin owns one directory tree and resolves it the same way the
  // WorkBuddy connector does: $DSH_HOME, else <home>/dsh, then /data/<name>.
  const paths = ensureStateDirs(pluginPaths())
  const settings = loadSettings(paths)

  // The settings namespace the host serves this plugin under. A configurable
  // provider must name the loader entry id EXACTLY, or the model picker treats
  // the route as unconfigured.
  const settingsNs = (() => {
    const id = ctx.fiber?.entry?.options?.id
    return typeof id === 'string' && id !== '' ? id : 'dsh-connect-agentscope-platform'
  })()

  // -------------------------------------------------------------------------
  // The account pool: one CreditEngine + one CheckinScheduler PER ACCOUNT
  // -------------------------------------------------------------------------
  //
  // Every per-account document (login pair, model key, credit history, check-in
  // record) lives under `vault/accounts/<id>/`, so two accounts cannot write
  // over each other. The install-wide settings, the metadata cache and the two
  // pool documents stay at the state root: they describe the whole install.
  //
  // WHY THE POOL LOADS ASYNCHRONOUSLY. Reading the pool document may migrate a
  // single-account install, which is a file write, so `AccountPool` starts that
  // read in its constructor and exposes `ready()`. `apply()` is synchronous and
  // must stay so, hence this promise: every entry point that needs the pool
  // awaits it. `AccountPool`'s own methods await it too, so nothing can observe
  // a half-loaded pool.
  const accountPool = new AccountPool({ paths, settings: () => settings, log })
  const poolReady = accountPool.ready()

  /**
   * The billing account's runtime, or `null` when the pool holds nothing usable.
   *
   * Used where "no account configured" must render as a dash rather than an
   * error: the aggregate state and the composer readout.
   */
  function activeRuntime() {
    return accountPool.active()
  }

  // -------------------------------------------------------------------------
  // Catalog: bundled → remote enrichment → the user's own rows
  // -------------------------------------------------------------------------

  const metaCachePath = paths.metaCache
  let metaCache = readMetaCache(metaCachePath)
  let metaTable = metaCache === undefined ? undefined : parseTable(metaCache.text)
  /** @type {{ source: string, fetchedAt: number, checkedAt: number, modelCount: number, degraded: boolean, notModified: boolean, failures: Array<{ label: string, reason: string }> }} */
  let metaState = {
    source: metaTable === undefined ? 'bundled' : (metaCache?.url ?? 'cache'),
    fetchedAt: metaCache?.fetchedAt ?? 0,
    checkedAt: metaCache?.checkedAt ?? 0,
    modelCount: metaTable === undefined ? 0 : Object.keys(metaTable).length,
    degraded: metaTable === undefined,
    notModified: false,
    failures: [],
  }
  let metaTimer = null
  let metaRunning = false
  let metaGeneration = 0

  /**
   * The catalog as the adapter and the picker see it.
   *
   * THREE LAYERS, and the order is the whole design:
   *
   *   1. bundled  — id, name, input modalities. NO capacity (see models.js).
   *   2. remote   — the LiteLLM table's min~max range and median per model.
   *   3. the user's overrides — a value the user typed wins; a field they left
   *      empty falls through to layer 2.
   *
   * The row handed to the host therefore always carries CONCRETE capacity
   * (`effective*`), because the host needs a number to size compaction and to
   * fill `max_tokens`. But the row ALSO keeps the raw layers (`contextWindow` may
   * stay null, `remote` holds the range) so the panel can show an empty box with
   * a grey "128K~1M" placeholder instead of pretending a number was chosen.
   */
  function currentCatalog() {
    // THE USER'S LIST IS THE CATALOG. The bundled roster is NOT a silently
    // included extra layer: a user who fetches nothing and adds nothing gets an
    // empty picker, which is the honest answer to "what did I configure".
    //
    // The bundled rows still exist, but only as the enrichment lookup for a known
    // id: a hand-typed "kimi-k3" picks up the remote range without the user
    // hunting for it. They never enter the catalogue themselves.
    const known = new Map(bundledModels().map(row => [row.id, row]))
    return settings.catalog.map(entry => {
      const base = known.get(entry.id) ?? {
        id: entry.id,
        name: entry.name,
        contextWindow: null,
        maxTokens: null,
        input: entry.input,
        reasoningEfforts: entry.reasoningEfforts,
      }
      const enriched = isCompleteTable(metaTable)
        ? enrichRow({ ...base }, metaTable)
        : { ...base, remote: undefined, enrichment: { source: 'bundled' } }
      const remote = enriched.remote
      // A null the user left alone falls through to the remote figure; only when
      // both are absent does the floor apply, and the row says so.
      const userContext = entry.contextWindow ?? null
      const userOutput = entry.maxTokens ?? null
      return {
        ...enriched,
        name: entry.name,
        input: entry.input,
        reasoningEfforts: entry.reasoningEfforts,
        // THE USER'S VALUE IS THE ONLY VALUE. `null` means "do not send this
        // parameter at all" — it is NOT a request to fall back to anything.
        // `remote` rides along for the panel's grey reference hint only: it is
        // never substituted in, here or in the adapter.
        contextWindow: userContext,
        maxTokens: userOutput,
        remote,
        // Where the CURRENT value came from, for the row's little label:
        // 'user' when typed, 'unset' when the row sends nothing.
        capacitySource: userContext !== null || userOutput !== null ? 'user' : 'unset',
      }
    })
  }


  /** Persist a catalog edit. `rows` replaces the user layer entirely. */
  function writeCatalog(rows) {
    const sanitized = sanitizeCatalogRows(rows)
    settings.catalog = sanitized
    settings.catalogSeeded = true
    writeJsonFile(paths.settings, settings)
    invalidate()
    return sanitized
  }

  /** Persist any other settings change. */
  function writeSettings(patch) {
    if (patch && typeof patch === 'object') {
      if (patch.providerEnabled !== undefined) settings.providerEnabled = patch.providerEnabled === true
      if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim() !== '') settings.baseUrl = patch.baseUrl.trim()
      if (patch.metaRefreshHours !== undefined) {
        settings.metaRefreshHours = Math.min(168, Math.max(1, Number(patch.metaRefreshHours) || 24))
      }
      if (patch.checkin && typeof patch.checkin === 'object') {
        if (patch.checkin.enabled !== undefined) settings.checkin.enabled = patch.checkin.enabled === true

      }
    }
    writeJsonFile(paths.settings, settings)
  }

  /**
   * Persist one account's `sk-as-…` key. The value never leaves this process
   * except masked, and it is written under that account's own directory.
   *
   * @param {import('./account-runtime.js').AccountRuntime} runtime
   * @param {string} key
   * @param {'pasted' | 'fetched' | ''} source
   */
  function writeModelKey(runtime, key, source) {
    const value = typeof key === 'string' ? key : ''
    return runtime.setModelKey(value, value === '' ? '' : source)
  }

  // -------------------------------------------------------------------------
  // Metadata refresh
  // -------------------------------------------------------------------------

  /**
   * Refresh the LiteLLM table. Never throws, never blocks a caller that does not
   * await it, and never removes models: a failure leaves the previous table (or
   * the bundled roster) in place.
   * @param {boolean} [force]
   */
  async function refreshModelMeta(force = false) {
    if (metaRunning) return { skipped: true, reason: 'a refresh is already running' }
    metaRunning = true
    const generation = (metaGeneration += 1)
    try {
      // An external writer may have refreshed while we were idle.
      const mtime = metaCacheMtime(metaCachePath)
      if (metaCache !== undefined && mtime > (metaState.checkedAt || 0)) {
        const reread = readMetaCache(metaCachePath)
        if (reread !== undefined && reread.checkedAt >= (metaCache?.checkedAt ?? 0)) {
          metaCache = reread
          metaTable = parseTable(reread.text)
        }
      }
      const result = await fetchTable({ cache: metaCache, force })
      if (generation !== metaGeneration) return { skipped: true, reason: 'superseded' }
      if (result.cache !== undefined && result.table !== undefined) {
        metaCache = result.cache
        metaTable = result.table
        if (!result.notModified) writeMetaCache(metaCachePath, result.cache)
        metaState = {
          source: result.source ?? 'unknown',
          fetchedAt: result.cache.fetchedAt,
          checkedAt: result.cache.checkedAt,
          modelCount: Object.keys(result.table).length,
          degraded: false,
          notModified: result.notModified,
          failures: result.failures,
        }
        invalidate()
      } else {
        // Total failure: keep whatever table we had, and say so.
        metaState = {
          ...metaState,
          checkedAt: Date.now(),
          degraded: !isCompleteTable(metaTable),
          notModified: false,
          failures: result.failures,
        }
        log(`model metadata refresh failed (${result.failures.map(item => `${item.label}: ${item.reason}`).join('; ') || 'no source answered'}); keeping the previous catalog`)
      }
    } catch (error) {
      metaState = { ...metaState, degraded: true, failures: [{ label: 'internal', reason: error instanceof Error ? error.message : String(error) }] }
    } finally {
      metaRunning = false
    }
    armMetaRefresh()
    return { state: metaState }
  }

  /** Arm the next metadata refresh, honouring the configured cadence. */
  function armMetaRefresh() {
    if (metaTimer !== null) { clearTimeout(metaTimer); metaTimer = null }
    const hours = Math.max(1, settings.metaRefreshHours)
    const generation = (metaGeneration += 1)
    metaTimer = setTimeout(() => {
      if (metaGeneration !== generation) return
      metaTimer = null
      void refreshModelMeta(false)
    }, hours * 60 * 60 * 1000)
    metaTimer.unref?.()
  }

  // -------------------------------------------------------------------------
  // Provider registration (optional, reversible without a restart)
  // -------------------------------------------------------------------------

  /**
   * The provider an unselected Session runs on, or `''` when the Host cannot say.
   *
   * `agentDefaultModel` is the deployment's default route — the same value
   * `SessionController.agentOptions()` hands a Session that has recorded neither
   * a selection nor a request. It is read defensively: an older Host (or a
   * headless composition) may not mount the service, and a credits readout must
   * never take a request down over an absent default.
   *
   * @returns {string} a provider id, or `''` when unknown.
   */
  function defaultProvider() {
    try {
      const service = ctx.get('agentDefaultModel')
      const selection = service?.currentSelection?.()
      const provider = selection?.provider
      return typeof provider === 'string' ? provider : ''
    } catch {
      return ''
    }
  }

  /**
   * Build ONE adapter for the CURRENT catalog snapshot.
   *
   * The route is registered through the Host-shipped `PiAiAdapter`
   * (dsh-llm-pi-ai), exactly as dsh-connect-workbuddy and
   * dsh-connect-sensenova-token-plan do. That peer ships with the Host version
   * named by this plugin's floor, and it is imported LAZILY: a Host that cannot
   * resolve it loses only the model route, with a logged line, while credits,
   * the check-in and usage keep working.
   *
   * A NEW INSTANCE per rebuild is required: `PiAiAdapter` memoizes its profiles
   * snapshot by identity, so mutating the catalog under a live adapter would
   * never be observed. index.js therefore RE-REGISTERS on every catalog change
   * rather than trying to refresh in place.
   */
  let piFactoryPromise
  async function buildAdapter() {
    piFactoryPromise ??= import('./pi-adapter.js').then(mod => mod.buildAgentScopeAdapter)
    let factory
    try {
      factory = await piFactoryPromise
    } catch (error) {
      // Module resolution failed again would just replay the same rejection, so
      // clear the memo and let the next toggle retry with a fresh diagnostic.
      piFactoryPromise = undefined
      throw new Error(`Host-provided PiAiAdapter unavailable (is this Host older than the plugin's dsh floor?): ${error instanceof Error ? error.message : String(error)}`)
    }
    return factory({
      catalog: currentCatalog(),
      // THE ONE LINE THAT MAKES SWITCHING FREE.
      //
      // This getter is called for every request, and it reads the billing
      // account AT THAT MOMENT. Switching accounts therefore changes what the
      // next request sends without re-registering anything: no new adapter, no
      // `llm/adapters-updated` broadcast, and a stream already in flight keeps
      // running on the key it took (ADR 0001). Only a catalog / provider /
      // metadata change goes through `invalidate()`.
      apiKey: () => accountPool.active()?.modelKey.key,
      baseUrl: settings.baseUrl,
      get: service => ctx.get(service),
    }).adapter
  }

  /** The adapter currently registered (rebuilt on every catalog change). */
  let activeAdapter
  let adapterHandle
  let directoryHandle

  function directoryEntry() {
    return [{
      provider: PROVIDER_ID,
      displayName: PROVIDER_DISPLAY_NAME,
      settingsNs,
      settingsPath: [],
      declared: false,
    }]
  }

  /** Release both handles (and forget the adapter they belonged to). */
  function releaseProvider() {
    try { adapterHandle?.() } catch { /* already released */ }
    try { directoryHandle?.() } catch { /* already released */ }
    adapterHandle = undefined
    directoryHandle = undefined
    activeAdapter = undefined
  }

  /**
   * (Re)register the provider for the current switch + catalog snapshot.
   *
   * Async because the preferred adapter is a lazily imported Host peer. The
   * registration itself is synchronous once the adapter is built, so no request
   * can observe a half-applied state.
   */
  async function syncProvider() {
    if (!settings.providerEnabled) {
      releaseProvider()
      return
    }
    try {
      const adapter = await buildAdapter()
      // Always RELEASE then REGISTER. `PiAiAdapter` snapshots its profiles on
      // construction, so reusing `replace` with the same instance would keep
      // serving the OLD catalog — which is exactly why a newly added model did
      // not appear in the picker. A fresh register also emits
      // `llm/adapters-updated` on its own.
      releaseProvider()
      activeAdapter = adapter
      adapterHandle = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
      directoryHandle = ctx.llm.registerConfigurableProviders(directoryEntry())
    } catch (error) {
      log(`provider registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Announce a catalog change by REBUILDING the registration.
   *
   * This is the part that makes a model saved into an enabled provider appear in
   * the picker: the picker drops provider groups whose `listModels()` is empty,
   * and a new broadcast must come from a registration carrying the NEW catalog.
   * Calling `ctx.emit(name)` by hand is deliberately not used — the Host's own
   * register/release already publishes `llm/adapters-updated` with the shape its
   * listeners expect.
   */
  function invalidate() {
    if (!settings.providerEnabled) return
    void syncProvider()
  }

  // -------------------------------------------------------------------------
  // Model discovery
  // -------------------------------------------------------------------------

  /**
   * The models this route can offer.
   *
   * The platform's `GET /v1/models` needs the model key and returns the OpenAI
   * shape (ids only), so the live answer is used to ADD ids the catalog does not
   * know yet; it never removes a row the user built.
   */
  async function discoverModels() {
    const rows = currentCatalog()
    const discovered = new Map(rows.map(row => [row.id, row]))
    // The BILLING account's `sk-as-…` key, for the same reason the adapter's
    // getter reads it live: discovery must ask about the route requests will
    // actually use. (A probe is a different question — it uses the login JWT.)
    const key = accountPool.active()?.modelKey.key ?? ''
    if (key !== '') {
      try {
        const baseUrl = String(settings.baseUrl).replace(/\/+$/, '')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        try {
          const response = await fetch(`${baseUrl}/models`, {
            headers: { accept: 'application/json', authorization: `Bearer ${key}` },
            signal: controller.signal,
          })
          if (response.ok) {
            const parsed = await response.json()
            const entries = Array.isArray(parsed?.data) ? parsed.data : []
            for (const entry of entries) {
              const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
              if (id === '' || discovered.has(id)) continue
              discovered.set(id, normalizeModel({ id, name: id, input: DEFAULT_INPUT }))
            }
          }
        } finally { clearTimeout(timer) }
      } catch (error) {
        log(`model discovery fell back to the saved catalog: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return [...discovered.values()]
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  // THE CATALOG STARTS EMPTY. Nothing is pre-listed and nothing is pre-enabled:
  // the user decides which models this route offers, by fetching them or typing
  // them in. The bundled roster is an enrichment lookup, not content the user
  // gets for free — it is never written into the user's catalog.
  //
  // One write happens on the first run, and it records only "the user's list has
  // been initialised" so an intentionally empty catalog is never re-seeded.
  if (!settings.catalogSeeded) {
    settings.catalog = []
    settings.catalogSeeded = true
    writeJsonFile(paths.settings, settings)
  }
  // A release before this one SEEDED the bundled roster into the user's catalog
  // and marked the file "seeded", so the empty default never applied on a machine
  // that had already run it. Clear that leftover ONCE, keyed on a schema number
  // so a catalog the user builds afterwards is never touched again.
  if (Number(settings.schemaVersion) < CATALOG_SCHEMA_VERSION) {
    settings.catalog = []
    settings.schemaVersion = CATALOG_SCHEMA_VERSION
    writeJsonFile(paths.settings, settings)
    log('cleared a catalog seeded by an earlier release (models are opt-in)')
  }

  try {
    ctx.effect(() => () => {
      // ONE call stops every timer this plugin owns: each account's credit
      // snapshot interval, each account's check-in scheduler, and the automatic
      // selection cycle. A hot reload that missed any of them would leave the
      // previous instance racing the new one for the same rotating refresh
      // token — which permanently orphans it.
      accountPool.dispose()
      if (metaTimer !== null) clearTimeout(metaTimer)
    }, 'agentscope-platform: timers')
  } catch { /* effects are optional in a test harness */ }

  try {
    ctx.effect(() => () => {
      adapterHandle?.()
      directoryHandle?.()
    }, 'agentscope-platform: provider routes')
  } catch { /* effects are optional in a test harness */ }

  void syncProvider()
  // Timers start once the document has loaded, so an account added later is
  // already covered by the pool's own `start()` on `add()`.
  void poolReady.then(() => { accountPool.start() })
  // The metadata refresh is fire-and-forget: the bundled roster already answers
  // every picker query, so nothing waits on four megabytes.
  void refreshModelMeta(false)
  try {
    ctx.llm.registerModelDiscovery(settingsNs, async () => {
      if (!settings.providerEnabled) return []
      return discoverModels().then(rows => rows.map(row => ({
        id: row.id,
        name: row.name,
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
        inputModalities: row.input,
      })))
    })
  } catch (error) {
    log(`model discovery registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // -------------------------------------------------------------------------
  // HTTP API
  // -------------------------------------------------------------------------

  /** Minimal JSON reply helper. */
  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /** Read one JSON request body, bounded. */
  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_000_000) throw badParam('request body is too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw badParam('request body is not JSON') }
  }

  /**
   * The aggregated, browser-facing view of everything this plugin knows.
   *
   * TWO GENERATIONS OF KEYS LIVE HERE ON PURPOSE. `build / provider / modelKey /
   * catalog / meta / checkin / credits / settingsNs` are what the panel read
   * before the account pool existed, and they must keep answering in exactly
   * those shapes — a browser holding a cached bundle still reads them. The pool
   * adds `accounts / activeAccountId / pool`, and the three per-account old keys
   * (`modelKey`, `checkin`, `credits`) now describe the BILLING account.
   *
   * `pool` is aggregate STATE, not the runtime object: `{ autoSwitch, count }`.
   * The runtime instance is `accountPool`, and it never crosses this boundary.
   *
   * @param {import('./account-runtime.js').AccountRuntime | null} [runtime] -
   *   whose per-account fields to describe; the billing account by default. The
   *   panel asks for another account when the user pins one for VIEWING, which
   *   changes nothing about what gets billed.
   */
  function fullState(runtime = activeRuntime()) {
    const active = runtime
    // Listed once: the projection pass is not free, and `pool.count` must agree
    // with the array it is reported beside.
    const accounts = accountPool.list()
    return {
      build: BUILD,
      provider: {
        enabled: settings.providerEnabled,
        id: PROVIDER_ID,
        displayName: PROVIDER_DISPLAY_NAME,
        baseUrl: settings.baseUrl,
        registered: adapterHandle !== undefined,
      },
      modelKey: active === null
        ? { configured: false, mask: '', source: '', fetchedAt: 0 }
        : active.modelKeyView(),
      catalog: currentCatalog(),
      meta: { ...metaState },
      checkin: active === null ? EMPTY_CHECKIN_VIEW : active.checkin.view(),
      credits: active === null ? EMPTY_CREDITS_VIEW : active.engine.state(),
      settingsNs,
      // --- added by the account pool ---
      accounts,
      activeAccountId: accountPool.activeId,
      pool: { autoSwitch: accountPool.autoSwitch, count: accounts.length },
    }
  }

  /**
   * Exchange a refresh token against the platform, WITHOUT storing anything.
   *
   * This is what makes `POST /accounts` safe: an account joins the pool only
   * after its credential has been proven against the platform, so the list never
   * contains an entry that would be selected for a request and then fail it.
   *
   * The exchange runs through a throwaway engine pointed at a scratch directory
   * that is removed immediately — never at a real account's vault, because the
   * platform ROTATES the refresh token on every exchange: a probe that wrote its
   * answer to the wrong file would overwrite a live credential with a pair
   * belonging to a different account.
   *
   * @param {string} refreshToken
   * @returns {Promise<{ ok: true, accessToken: string, refreshToken: string } | { ok: false, error: string }>}
   */
  async function verifyRefreshToken(refreshToken) {
    const scratch = join(paths.stateDir, `.verify-${accountIdFor('verify', Date.now(), String(Math.random()))}`)
    try {
      ensureDir(scratch)
      const engine = new CreditEngine({ paths: { ...paths, login: join(scratch, 'login.json') }, log })
      engine.updateConfig({ refreshToken, autoRefresh: false })
      await engine.refresh(true)
      const accessToken = engine.config.accessToken
      const rotated = engine.config.refreshToken
      if (typeof accessToken !== 'string' || accessToken === '' || typeof rotated !== 'string' || rotated === '') {
        return { ok: false, error: 'the platform returned an unusable credential pair' }
      }
      return { ok: true, accessToken, refreshToken: rotated }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /**
   * One request. Every handler is reached through the same auth gate, so a new
   * endpoint cannot accidentally ship unauthenticated.
   *
   * ACCOUNT RESOLUTION HAPPENS HERE, ONCE PER REQUEST. Two generations of
   * callers hit this route and both must work:
   *
   *   * an OLD bundle sends no `accountId` — every per-account handler then
   *     falls back to the billing account, and the request behaves exactly as
   *     it did before the pool existed;
   *   * the current panel names an account (query for GET, body for POST), and
   *     an UNKNOWN id must answer 400 — `resolve()` throws `badParam`, which the
   *     catch below maps to 400 rather than letting it become a 500.
   */
  async function handle(req, res, checkAuth) {
    if (typeof checkAuth === 'function' && !checkAuth(req, res)) return
    let url
    try { url = new URL(req.url ?? '/', 'http://agentscope.invalid') } catch { sendJson(res, 400, { error: 'bad url' }); return }
    const sub = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    // The body is a stream and can be consumed once, so every read goes through
    // this memo: a handler may look at `accountId` and then at its own fields
    // without draining the request twice.
    let bodyPromise
    const payloadOf = () => (bodyPromise ??= readBody(req))

    /** The account id a request names, or `''` when it names none. */
    const namedAccountId = payload => {
      const fromBody = payload && typeof payload === 'object' && typeof payload.accountId === 'string'
        ? payload.accountId.trim()
        : ''
      if (fromBody !== '') return fromBody
      return (url.searchParams.get('accountId') ?? '').trim()
    }

    /**
     * The account a per-account handler must use, falling back to billing.
     *
     * Throws `badParam` for an explicitly named account that does not exist, and
     * for a request that names none while the pool is empty — both are caller
     * mistakes, not server faults.
     */
    const accountFor = payload => accountPool.resolve(namedAccountId(payload) || null)

    /**
     * The same, but "nothing configured" is an ANSWER rather than an error.
     *
     * `/state` and `/quick` are what the panel and the composer pill poll on a
     * fresh install: a zero-account profile must render dashes, not an error
     * banner. A named-but-unknown id is still a 400, because that is a caller
     * bug and silently substituting another account would be worse.
     */
    const accountForRead = payload => {
      const named = namedAccountId(payload)
      return named === '' ? activeRuntime() : accountPool.resolve(named)
    }

    try {
      // A first run migrates a single-account install, which is a file write.
      // Nothing below may observe a half-loaded pool.
      await poolReady

      // --- account pool ---
      //
      // All of these sit BEHIND the same `checkAuth` gate as everything else:
      // they are the newest surface, so a bypass here would be the easiest one
      // to miss.
      if (sub === '/accounts' && method === 'GET') { sendJson(res, 200, accountPool.view()); return }

      if (sub === '/accounts' && method === 'POST') {
        const payload = await payloadOf()
        const label = typeof payload?.label === 'string' ? payload.label.trim() : ''
        const refreshToken = typeof payload?.refreshToken === 'string' ? payload.refreshToken.trim() : ''
        if (label === '') throw badParam('an account needs a label')
        if (refreshToken === '') throw badParam('adding an account needs a refreshToken')

        // VERIFY, THEN WRITE.
        //
        // The refresh token is exchanged against the platform BEFORE anything is
        // stored, and an account that fails the exchange never joins the list.
        // A stored-but-dead account would be worse than no account: it would show
        // up as billable, get selected by automatic selection, and fail every
        // request it was chosen for. The pair that lands on disk is the one the
        // platform ROTATED to, not the one the user pasted.
        const exchanged = await verifyRefreshToken(refreshToken)
        if (exchanged.ok !== true) {
          // Reported exactly the way `/config` reports a refused token, and the
          // list comes back unchanged so the panel keeps rendering.
          sendJson(res, 200, { ...accountPool.view(), exchanged })
          return
        }

        const modelKey = typeof payload?.modelKey === 'string' ? payload.modelKey.trim() : ''
        await accountPool.add({
          label,
          activate: payload?.activate === true,
          refreshToken: exchanged.refreshToken,
          accessToken: exchanged.accessToken,
          ...(modelKey === '' ? {} : { modelKey }),
        })
        sendJson(res, 200, { ...accountPool.view(), exchanged: { ok: true } })
        return
      }

      if (sub === '/accounts/switch' && method === 'POST') {
        const payload = await payloadOf()
        const id = typeof payload?.accountId === 'string' ? payload.accountId.trim() : ''
        if (id === '') throw badParam('switching accounts needs an accountId')
        const result = await accountPool.switchTo(id)
        // NO RE-REGISTRATION HERE. The adapter's `apiKey` getter asks the pool on
        // every call, so the next request simply reads the new account's key and
        // a stream already in flight is untouched (ADR 0001). What IS checked is
        // the invariant the panel relies on: if the provider is switched on, a
        // route must actually be registered — a failed earlier attempt should not
        // leave the panel claiming a working provider.
        if (settings.providerEnabled && adapterHandle === undefined) await syncProvider()
        sendJson(res, 200, { accounts: result.accounts, activeAccountId: result.activeAccountId, autoSwitch: result.autoSwitch })
        return
      }

      if (sub === '/accounts/remove' && method === 'POST') {
        const payload = await payloadOf()
        const id = typeof payload?.accountId === 'string' ? payload.accountId.trim() : ''
        if (id === '') throw badParam('removing an account needs an accountId')
        // Both guards live in the pool, not here: "never remove the last usable
        // account" and "hand billing over via nextActiveId" are properties of the
        // document, and a second copy of them in the HTTP layer is a second thing
        // that can drift. A refusal arrives as `badParam` and becomes a 400.
        const result = await accountPool.remove(id)
        sendJson(res, 200, { accounts: result.accounts, activeAccountId: result.activeAccountId, autoSwitch: result.autoSwitch })
        return
      }

      if (sub === '/accounts/rename' && method === 'POST') {
        const payload = await payloadOf()
        const id = typeof payload?.accountId === 'string' ? payload.accountId.trim() : ''
        if (id === '') throw badParam('renaming an account needs an accountId')
        const result = await accountPool.rename(id, payload?.label)
        sendJson(res, 200, { accounts: result.accounts, activeAccountId: result.activeAccountId, autoSwitch: result.autoSwitch })
        return
      }

      if (sub === '/accounts/enable' && method === 'POST') {
        const payload = await payloadOf()
        const id = typeof payload?.accountId === 'string' ? payload.accountId.trim() : ''
        if (id === '') throw badParam('enabling or disabling an account needs an accountId')
        // Same reasoning as removal: "disabling the billing account hands billing
        // over" and "never disable the last usable account" belong to the pool.
        const result = await accountPool.setEnabled(id, payload?.enabled === true)
        sendJson(res, 200, { accounts: result.accounts, activeAccountId: result.activeAccountId, autoSwitch: result.autoSwitch })
        return
      }

      if (sub === '/accounts/test' && method === 'POST') {
        const payload = await payloadOf()
        const id = typeof payload?.accountId === 'string' ? payload.accountId.trim() : ''
        if (id === '') throw badParam('probing an account needs an accountId')
        // The probe answers with `{ account, probe, credentialState, credits }`.
        // It is deliberately NOT the pool projection: a probe can flip
        // `disabledReason` and move billing, and the panel re-reads `GET
        // /accounts` after patching the row it asked about. Q10 — which failure
        // writes `expired` and which only writes a cooldown — is decided inside
        // `probe()` and nowhere else.
        sendJson(res, 200, await accountPool.probe(id))
        return
      }

      if (sub === '/accounts/auto-switch' && method === 'POST') {
        const payload = await payloadOf()
        const result = await accountPool.setAutoSwitch({
          ...(payload?.enabled === undefined ? {} : { enabled: payload.enabled === true }),
          ...(payload?.thresholdPct === undefined ? {} : { thresholdPct: payload.thresholdPct }),
        })
        sendJson(res, 200, result)
        return
      }

      // --- aggregate state ---
      if (sub === '/state' && method === 'GET') { sendJson(res, 200, fullState(accountForRead(null))); return }

      // --- credit engine ---
      if (sub === '/config' && method === 'POST') {
        const body = await payloadOf().catch(() => ({}))
        const runtime = accountFor(body)
        const engine = runtime.engine
        const rotated = typeof body.refreshToken === 'string' && body.refreshToken.trim() !== ''
          && body.refreshToken.trim() !== '-'
        engine.updateConfig(body)
        // A freshly pasted refresh token is EXCHANGED IMMEDIATELY.
        //
        // The platform invalidates a refresh token the moment it mints a new one,
        // and the browser's own login will mint one too. Claiming it here — right
        // now, while the user is looking — means the plugin holds the only live
        // pair, and the browser tab is expected to go stale. Doing it lazily on
        // the next poll would leave two live-and-fighting copies in between.
        let exchanged = null
        if (rotated) {
          try {
            await engine.refresh(true)
            exchanged = { ok: true }
          } catch (error) {
            // The token may already have been rotated away by the browser. Report
            // it rather than pretending the save worked: the user needs to paste
            // a fresh one.
            exchanged = { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
        engine.startScheduler()
        sendJson(res, 200, { ...engine.state(), exchanged })
        return
      }
      if (sub === '/refresh' && method === 'POST') {
        // A POST names its account in the BODY (the panel's `post()` helper puts
        // it there); the query string is still honoured for a hand-made request.
        const payload = await payloadOf().catch(() => ({}))
        const runtime = accountFor(payload)
        await runtime.engine.refresh(true)
        sendJson(res, 200, runtime.engine.state())
        return
      }
      if (sub === '/fetch' && method === 'POST') {
        const payload = await payloadOf().catch(() => ({}))
        sendJson(res, 200, await accountFor(payload).engine.fetchSnapshot('manual'))
        return
      }
      if (sub === '/quick' && method === 'GET') {
        // The composer readout: credits only, no snapshot, no log entry.
        //
        // The account is named alongside the figure so a caller can tell whose
        // number it is. It always describes the BILLING account unless one is
        // explicitly named: the pill must show what the next request will spend.
        //
        // ONE WRITE POINT. This route goes through `accountPool.probe()` rather
        // than calling the engine directly, so the figure the pill renders and
        // the figure the account row shows are the SAME measurement. Two
        // independent reads used to disagree by whatever the two caches were
        // apart — the pill always live, the row stale since the last probe — and
        // the panel then displayed two different balances for one account.
        const runtime = accountForRead(null)
        if (runtime === null) {
          sendJson(res, 200, { at: new Date().toISOString(), credits: null, error: 'no account is configured yet', accountId: '', accountLabel: '' })
          return
        }
        const accountId = runtime.id
        const accountLabel = accountPool.list().find(row => row.id === accountId)?.label ?? ''
        const measured = await accountPool.probe(accountId)
        // `at` is the RECORD's own instant, not a second `new Date()`: the pill's
        // "last refreshed" and the account row's must be the same moment, or the
        // panel still reads as two sources that happen to agree on the number.
        const at = new Date(measured.probe?.atMs ?? Date.now()).toISOString()
        if (measured.creditsDocument !== null) {
          sendJson(res, 200, { at, credits: measured.creditsDocument, accountId, accountLabel })
          return
        }
        // A readout must not become an error banner in the composer: report the
        // failure as data and let the pill show a dash.
        sendJson(res, 200, {
          at,
          credits: null,
          error: measured.probe?.message || `could not read credits (${measured.probe?.outcome ?? 'unknown'})`,
          accountId,
          accountLabel,
        })
        return
      }
      if (sub === '/usage' && method === 'GET') {
        const params = url.searchParams
        const runtime = accountForRead(null)
        // A zero-account install reads as an empty page rather than an error: the
        // panel renders "no usage" either way, and a 500 here would surface as a
        // red banner on a screen that is simply waiting for its first account.
        if (runtime === null) {
          sendJson(res, 200, {
            type: params.get('type') ?? 'usage',
            items: [],
            total: 0,
            page: 1,
            pageSize: 20,
            pages: 1,
            sum: { credits: 0, inputTokens: 0, outputTokens: 0, count: 0 },
            query: {
              type: params.get('type') ?? 'usage',
              modelType: params.get('model_type') ?? '',
              modelId: params.get('model_id') ?? '',
              startDate: params.get('start_date') ?? '',
              endDate: params.get('end_date') ?? '',
            },
            at: new Date().toISOString(),
          })
          return
        }
        sendJson(res, 200, await runtime.engine.usage({
          // `as.js` defaults `type` with `?? 'usage'`, which an EMPTY STRING
          // slips past — and an empty string is exactly what a bare `/usage`
          // query yields. The result was a 400 for a request that named no
          // filter at all (the engine's enum check refused `''`). The default
          // belongs here, where the absent parameter is known to be absent.
          type: params.get('type') || 'usage',
          page: params.get('page'),
          pageSize: params.get('page_size') ?? params.get('pageSize'),
          modelType: params.get('model_type') ?? '',
          modelId: params.get('model_id') ?? '',
          startDate: params.get('start_date') ?? '',
          endDate: params.get('end_date') ?? '',
        }))
        return
      }
      if (sub === '/log' && method === 'GET') {
        const runtime = accountForRead(null)
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30))
        const snapshots = (runtime?.engine.runtime.log ?? []).filter(entry => entry.kind === 'snapshot')
        sendJson(res, 200, { log: snapshots.slice(0, limit), total: snapshots.length })
        return
      }
      if (sub === '/log' && method === 'DELETE') {
        const runtime = accountFor(null)
        sendJson(res, 200, runtime.engine.clearLog())
        return
      }
      if (sub === '/notify/test' && method === 'POST') {
        const payload = await payloadOf().catch(() => ({}))
        const engine = accountFor(payload).engine
        if (payload && payload.notify) engine.updateConfig({ notify: payload.notify })
        const zoned = zonedParts(new Date())
        const result = await engine.notify([
          '【AgentScope credits · notification test】',
          'This is a test message confirming the IM delivery target works.',
          `time: ${zoned.day} ${zoned.hm}`,
          '', '— from AgentScope Platform (DSH plugin)',
        ].join('\n'), 'as-test')
        sendJson(res, 200, { ...result, state: engine.state() })
        return
      }

      // --- provider switch + model key ---
      //
      // The provider switch and the catalog are INSTALL-WIDE: one route serves
      // every account, so these endpoints never name one.
      if (sub === '/provider/default' && method === 'GET') {
        // The provider an UNSELECTED Session runs on.
        //
        // A brand-new session's `modelSelection` projection is
        // `{ lastUsed: null, next: null }` — it names nothing, and the model
        // picker then displays the deployment default. The browser cannot tell
        // that apart from "the projection has not arrived yet" on its own, and
        // treating both as "not ours" or both as "ours" is wrong in one of the
        // two cases: the composer readout ended up showing an AgentScope balance
        // beside a session that was actually running on another provider.
        // Answering the default here lets the gate decide with evidence.
        sendJson(res, 200, { provider: defaultProvider() })
        return
      }
      if (sub === '/provider/toggle' && method === 'POST') {
        const payload = await payloadOf()
        writeSettings({ providerEnabled: payload?.enabled === true })
        // Await the rebuild so the state we return says "registered: true"
        // (or false) for the switch the user just set, not the previous one.
        await syncProvider()
        sendJson(res, 200, fullState())
        return
      }
      // The model key is PER ACCOUNT: each account has its own `sk-as-…` key, and
      // the billing account's is the one model calls use.
      if (sub === '/model-key' && method === 'GET') {
        sendJson(res, 200, fullState(accountForRead(null)).modelKey)
        return
      }
      if (sub === '/model-key' && method === 'POST') {
        const payload = await payloadOf()
        const runtime = accountFor(payload)
        const value = typeof payload?.key === 'string' ? payload.key.trim() : ''
        // `-` and an empty string both clear it, matching the other credential
        // fields in this plugin.
        if (value === '' || value === '-') writeModelKey(runtime, '', '')
        else writeModelKey(runtime, value, 'pasted')
        sendJson(res, 200, runtime.modelKeyView())
        return
      }
      if (sub === '/model-key/fetch' && method === 'POST') {
        // Ask the platform for the key using the login JWT. The platform hands the
        // full key back only at generate/reset time, so an empty answer is a real
        // possibility and is reported rather than treated as a failure.
        //
        // NOTE the two credentials are different questions: this endpoint uses
        // the LOGIN JWT to ask the account API for its `sk-as-…` key, whereas
        // `discoverModels()` uses an existing `sk-as-…` key against `/v1/models`.
        const payload = await payloadOf().catch(() => ({}))
        const runtime = accountFor(payload)
        const document = await runtime.engine.modelKeyDocument()
        const found = CreditEngine.modelKeyFrom(document)
        if (found === undefined) {
          sendJson(res, 200, { ...runtime.modelKeyView(), document })
          return
        }
        writeModelKey(runtime, found, 'fetched')
        sendJson(res, 200, runtime.modelKeyView())
        return
      }
      if (sub === '/model-key/reset' && method === 'POST') {
        // Rotation revokes the previous key immediately, so this is only ever the
        // user's explicit choice.
        const payload = await payloadOf().catch(() => ({}))
        const runtime = accountFor(payload)
        const document = await runtime.engine.resetModelKey()
        const found = CreditEngine.modelKeyFrom(document)
        if (found !== undefined) writeModelKey(runtime, found, 'fetched')
        sendJson(res, 200, { ...runtime.modelKeyView(), rotated: found !== undefined })
        return
      }

      // --- model catalog (install-wide) ---
      if (sub === '/models/discover' && method === 'GET') {
        sendJson(res, 200, { models: await discoverModels() })
        return
      }
      if (sub === '/catalog' && method === 'GET') { sendJson(res, 200, { models: currentCatalog(), meta: metaState }); return }
      if (sub === '/catalog' && method === 'POST') {
        const payload = await payloadOf()
        const stored = writeCatalog(payload?.models)
        sendJson(res, 200, { models: currentCatalog(), stored })
        return
      }
      if (sub === '/model-meta/state' && method === 'GET') { sendJson(res, 200, metaState); return }
      if (sub === '/model-meta/lookup' && method === 'GET') {
        // Reference ranges for arbitrary model ids.
        //
        // The panel needs these for rows that are NOT in the saved catalog yet —
        // a row the user just added, or a candidate adopted from discovery. Those
        // live only in the browser's draft, so they carry no `remote` from the
        // host and the grey hint would be blank. This endpoint answers the same
        // question `currentCatalog()` answers for saved rows, and NOTHING here is
        // applied to a value: it is a display hint only.
        const ids = String(url.searchParams.get('ids') ?? '')
          .split(',')
          .map(id => id.trim())
          .filter(id => id !== '')
          .slice(0, 50)
        const ranges = {}
        if (isCompleteTable(metaTable)) {
          for (const id of ids) {
            const enriched = enrichRow({ id, name: id, contextWindow: null, maxTokens: null, input: DEFAULT_INPUT, reasoningEfforts: [] }, metaTable)
            if (enriched.remote !== undefined) ranges[id] = enriched.remote
          }
        }
        sendJson(res, 200, { ranges })
        return
      }
      if (sub === '/model-meta/refresh' && method === 'POST') {
        const payload = await payloadOf().catch(() => ({}))
        sendJson(res, 200, await refreshModelMeta(payload?.force !== false))
        return
      }

      // --- pricing (the console's own reference price list) ---
      if (sub === '/pricing' && method === 'GET') {
        // `engine.pricing()` ALREADY returns the platform's `{ data: { groups,
        // active_promotion } }` envelope. Wrapping it in a second `{ data: ... }`
        // made the panel read `answer.data.data` as if it were the document, found
        // no `groups`, and showed "no prices". Return the document as-is.
        //
        // The price list is the platform's own, not an account's: any account
        // answers it identically, so the billing one is used for the credential
        // and an explicit `accountId` still picks a different login.
        const runtime = accountForRead(null)
        // With no account there is no credential to ask with, and an empty group
        // list is the honest answer — the panel shows its "load prices" hint.
        if (runtime === null) { sendJson(res, 200, { data: { groups: [], active_promotion: null } }); return }
        const engine = runtime.engine
        sendJson(res, 200, await engine.pricing())
        return
      }

      // Account-writing endpoints (campaign claims, contribution redemption)
      // are deliberately NOT exposed here. The panel removed those actions: a
      // daily scheduler must not move an account's money without an explicit,
      // per-action user decision. The CreditEngine still owns the methods so a
      // future, opt-in surface can call them without a protocol change.

      // --- check-in ---
      //
      // The ON/OFF SWITCH is install-wide (one setting), while the RECORD is per
      // account: each account keeps its own `checkin.json` and its own notify
      // target, so each scheduler reports only its own login.
      if (sub === '/checkin/state' && method === 'GET') {
        const runtime = accountForRead(null)
        sendJson(res, 200, runtime === null ? EMPTY_CHECKIN_VIEW : runtime.checkin.view())
        return
      }
      if (sub === '/config/checkin' && method === 'POST') {
        const payload = await payloadOf()
        const runtime = accountFor(payload)
        // Only the on/off switch remains. Claiming grants and redeeming
        // contribution were removed: both were account-writing opt-ins the user
        // did not ask this panel to perform on a schedule.
        writeSettings({ checkin: { enabled: payload?.enabled === true } })
        // Every account's scheduler reads the same switch, so they are all
        // re-evaluated — not just the one whose panel made the change.
        accountPool.start()
        sendJson(res, 200, runtime.checkin.view())
        return
      }
      if (sub === '/checkin/run' && method === 'POST') {
        const payload = await payloadOf().catch(() => ({}))
        sendJson(res, 200, await accountFor(payload).checkin.runOnce('manual'))
        return
      }

      sendJson(res, 404, { error: `unknown endpoint: ${method} ${sub}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, error && error.code === 'EBADPARAM' ? 400 : 500, { error: message })
    }
  }

  try {
    ctx.inject(['webServer'], child => {
      child.effect(() => child.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          const connection$ = ctx.get('connection')
          const checkAuth = connection$ !== undefined && typeof connection$.authorizeIndex === 'function'
            ? (request, response) => connection$.authorizeIndex(request, response)
            : undefined
          void handle(req, res, checkAuth)
        },
      }), 'agentscope-platform: http api')
    })
  } catch (error) {
    // A headless profile has no webServer; the provider and the scheduler still run.
    log(`web server unavailable, HTTP API not mounted: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Settings written elsewhere (the panel's provider switch, a manual edit) must
  // be picked up without a reload.
  try {
    ctx.on('loader/volatile-update', () => {
      void syncProvider()
      // The check-in switch is install-wide, so a change made elsewhere has to
      // reach EVERY account's scheduler: `start()` re-evaluates all of them
      // (arming the ones now enabled and leaving the disabled ones idle).
      accountPool.start()
    })
  } catch { /* older hosts */ }
}

export { listNotifyMethods }
