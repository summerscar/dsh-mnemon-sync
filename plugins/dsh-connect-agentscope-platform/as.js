/**
 * AgentScope Platform — credentials, credits, contributions and usage detail.
 *
 * API contract (verified against the running account panel; the platform's own
 * model-calling guide documents the same split):
 *
 *   POST /api/v1/auth/refresh                      -> { data: { accessToken, refreshToken, expiresIn } }
 *   GET  /api/v1/auth/userinfo                     -> account info
 *   GET  /api/v1/users/me/credits                  -> balance / lifetime / redeemable scores
 *   GET  /api/v1/community/me/contribution/events  -> contribution ledger (daily_login among the actions)
 *   GET  /api/v1/users/me/credits/usage            -> usage / redemption detail, one page
 *   GET  /api/v1/models/supported                  -> model ids grouped by type
 *   GET  /api/v1/models/pricing                    -> reference prices
 *   GET  /api/v1/users/me/model-api-key            -> the `sk-as-…` model key (login JWT)
 *   POST /api/v1/users/me/model-api-key/reset      -> rotate that key (login JWT)
 *   GET  /api/v1/users/me/credits/campaigns        -> claimable credit grants
 *   POST /api/v1/users/me/credits/campaigns/{code}/claim
 *   POST /api/v1/users/me/credits/redeem           -> { amount } contribution -> credits
 *
 * TWO CREDENTIALS, NEVER MIXED. The login JWT (accessToken/refreshToken) drives
 * only `/api/v1/*`. Model calls use a separate `sk-as-…` key. The platform's
 * guide says so explicitly ("不要再带登录 JWT"), and mixing them fails.
 *
 * refreshToken ROTATES on every refresh: the server invalidates the old one the
 * moment it mints the new one, so the new pair must reach disk immediately or it
 * is lost forever. Everything in here is built around that fact.
 *
 * Credentials live only on the host. Every browser-facing value is masked.
 *
 * @module dsh-connect-agentscope-platform/as
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import path from 'node:path'

import { ensureStateDirs, pluginPaths } from './paths.js'

export const AS_BASE = 'https://platform.agentscope.io'
const AS_REFRESH_URL = `${AS_BASE}/api/v1/auth/refresh`
const AS_USERINFO_URL = `${AS_BASE}/api/v1/auth/userinfo`
const AS_CREDITS_URL = `${AS_BASE}/api/v1/users/me/credits`
const AS_EVENTS_URL = `${AS_BASE}/api/v1/community/me/contribution/events`
const AS_USAGE_URL = `${AS_BASE}/api/v1/users/me/credits/usage`
const AS_SUPPORTED_URL = `${AS_BASE}/api/v1/models/supported`
const AS_PRICING_URL = `${AS_BASE}/api/v1/models/pricing`
const AS_MODEL_KEY_URL = `${AS_BASE}/api/v1/users/me/model-api-key`
const AS_MODEL_KEY_RESET_URL = `${AS_BASE}/api/v1/users/me/model-api-key/reset`
const AS_CAMPAIGNS_URL = `${AS_BASE}/api/v1/users/me/credits/campaigns`
const AS_REDEEM_URL = `${AS_BASE}/api/v1/users/me/credits/redeem`
const AS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Usage-detail filters the endpoint accepts (mirrors model-calls?tab=usage). */
export const USAGE_TYPES = ['usage', 'redeem']
export const MODEL_TYPES = ['token', 'tts', 'image', 'asr', 'video']

const LOG_MAX = 200
const REQUEST_TIMEOUT_MS = 20_000
/**
 * Refresh this long before expiry.
 *
 * Must stay LARGER than the snapshot interval: a shorter margin means the tick
 * right after expiry still sees a stale token and skips the refresh for a whole
 * extra interval. Measured on the reference deployment, where a 10-minute margin
 * against a 30-minute poll left a 20-minute window that a restart could hit.
 */
const REFRESH_MARGIN_MS = 15 * 60 * 1000
const DEFAULT_INTERVAL_MIN = 30
const NOTIFY_DEFAULT_TO = 'shen.yus@163.com'

/** Local dsh-im delivery endpoint (same host WebServer, no auth). */
const DSH_IM_DELIVERY_URL = 'http://127.0.0.1:3080/api/dsh-im/delivery/messages'
/** Root of dsh-im channel configs, used to enumerate notification methods. */
const DSH_INTEGRATIONS_DIR = '/data/dsh/integrations'

/**
 * Classify an upstream/network failure.
 *
 * A network blip is not a credential problem and must never alert: the reference
 * deployment once mailed "your tokens are dead" every interval while a container
 * restart was all that was wrong.
 * @param {unknown} error
 * @returns {'auth'|'network'|'http'|'other'}
 */
export function errorKind(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/\bHTTP 401\b/.test(message) || /invalid refresh token/i.test(message)
    || /ASP\.AUTH\.[A-Z_]+/.test(message) || /SessionInvalid|SESSION_INVALID/i.test(message)) return 'auth'
  if (/fetch failed/i.test(message) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(message)
    || /aborted|AbortError|socket hang up|network/i.test(message)) return 'network'
  if (/\bHTTP \d{3}\b/.test(message)) return 'http'
  return 'other'
}

/** Mask a secret for display: a short prefix/suffix plus its length, never the value. */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value.length <= 14) return `${value.slice(0, 2)}****`
  return `${value.slice(0, 8)}…${value.slice(-4)} (len ${value.length})`
}

/** Read a JSON file, or the fallback. Never throws. */
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed ?? fallback
  } catch { return fallback }
}

/** Local wall-clock day and HH:MM for a zone (falls back to UTC if unknown). */
export function zonedParts(date = new Date(), timeZone = 'Asia/Shanghai') {
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date)
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date)
  }
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { day: `${map.year}-${map.month}-${map.day}`, hm: `${map.hour}:${map.minute}` }
}

/**
 * Enumerate the delivery targets this machine has configured, across the dsh-im
 * channel directories. Read-only: the configs are never modified.
 * @returns {Array<{ id: string, channel: string, botId: string, botName: string, targetId: string, targetName: string, address: string }>}
 */
export function listNotifyMethods() {
  const out = []
  let dirs = []
  try { dirs = readdirSync(DSH_INTEGRATIONS_DIR) } catch { return out }
  for (const dir of dirs) {
    if (!/^dsh-(email|telegram|feishu|dingtalk|wecom|qq|slack|discord|whatsapp|weixin)$/.test(dir)) continue
    const root = path.join(DSH_INTEGRATIONS_DIR, dir)
    let workspace
    try { workspace = JSON.parse(readFileSync(path.join(root, 'workspaces.json'), 'utf8')) } catch { continue }
    const targets = workspace && workspace.deliveryTargets
    if (!targets || typeof targets !== 'object') continue
    const botNames = {}
    try {
      const config = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'))
      for (const bot of config.bots || []) botNames[bot.botId] = bot.name || bot.username || bot.botId
    } catch { /* names are optional */ }
    for (const [botId, targetMap] of Object.entries(targets)) {
      if (!targetMap || typeof targetMap !== 'object') continue
      for (const [targetId, target] of Object.entries(targetMap)) {
        out.push({
          id: `${dir}:${botId}:${targetId}`,
          channel: dir.replace(/^dsh-/, ''),
          botId,
          botName: botNames[botId] ?? botId,
          targetId,
          targetName: target && typeof target === 'object' && typeof target.name === 'string' ? target.name : targetId,
          address: target && typeof target === 'object' && typeof target.address === 'string' ? target.address : '',
        })
      }
    }
  }
  return out
}

/**
 * The account/credit engine.
 *
 * All mutable state is anchored on a single runtime object so a hot reload
 * cannot leave two schedulers racing one rotating refreshToken — the failure the
 * reference deployment hit, where the older instance kept refreshing with a token
 * the newer one had already rotated away.
 */
export class CreditEngine {
  /**
   * @param {object} options
   * @param {string} options.stateDir - host-only directory for the JSON state files
   * @param {() => { notify?: object }} [options.notifyConfig]
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    // Paths come from the plugin's own resolver (paths.js) so this module never
    // hard-codes a directory: a test can point it at a temp dir, and an operator
    // can move $DSH_HOME without editing code.
    this.paths = options.paths ?? pluginPaths({ dshHome: options.dshHome })
    this.stateDir = this.paths.stateDir
    this.log = options.log ?? (message => console.warn(`[agentscope-platform] ${message}`))
    // The login pair lives in the vault, apart from the disposable snapshots.
    this.configFile = this.paths.login
    this.logFile = this.paths.log
    this.runtime = {
      timer: null,
      probe: null,
      refreshing: null,
      fetching: false,
      rotation: null,
      log: [],
      generation: 0,
    }
    this.config = this.#defaults()
    this.savedAt = 0
    this.selfGeneration = 0
    ensureStateDirs(this.paths)
    this.load()
  }

  #defaults() {
    return {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      // When the platform last minted a token pair for this plugin. 0 means the
      // refresh token has never been exchanged here yet.
      refreshedAt: 0,
      autoRefresh: true,
      enabled: false,
      intervalMin: DEFAULT_INTERVAL_MIN,
      notify: { enabled: false, method: 'auto', botId: '', targetId: '', to: NOTIFY_DEFAULT_TO },
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Load state from disk. Replaces the log's CONTENT in place, never its array. */
  load() {
    const saved = readJson(this.configFile, {})
    if (saved && typeof saved === 'object') {
      const notify = saved.notify && typeof saved.notify === 'object' ? saved.notify : {}
      this.config = {
        accessToken: typeof saved.accessToken === 'string' ? saved.accessToken : '',
        refreshToken: typeof saved.refreshToken === 'string' ? saved.refreshToken : '',
        expiresAt: Number(saved.expiresAt) || 0,
        refreshedAt: Number(saved.refreshedAt) || 0,
        autoRefresh: saved.autoRefresh !== false,
        enabled: saved.enabled === true,
        intervalMin: Math.min(1440, Math.max(5, Number(saved.intervalMin) || DEFAULT_INTERVAL_MIN)),
        notify: {
          enabled: notify.enabled === true,
          method: notify.method === 'custom' ? 'custom' : 'auto',
          botId: typeof notify.botId === 'string' ? notify.botId : '',
          targetId: typeof notify.targetId === 'string' ? notify.targetId : '',
          to: typeof notify.to === 'string' && notify.to !== '' ? notify.to : NOTIFY_DEFAULT_TO,
        },
      }
    }
    // A token-less config must never advertise a remaining lifetime.
    if (this.config.accessToken === '') this.config.expiresAt = 0
    // Installs that predate this stamp have no recorded exchange time. The
    // credential file is rewritten on every successful exchange, so its mtime is
    // the best evidence available; without it the panel would claim a working
    // login had never been refreshed.
    if (this.config.refreshedAt === 0 && (this.config.accessToken !== '' || this.config.refreshToken !== '')) {
      try { this.config.refreshedAt = Math.round(statSync(this.configFile).mtimeMs) } catch { /* keep 0 */ }
    }
    const diskLog = readJson(this.logFile, [])
    const loaded = Array.isArray(diskLog) ? diskLog : []
    this.runtime.log.length = 0
    for (const entry of loaded) this.runtime.log.push(entry)
  }

  saveConfig() {
    try {
      writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), { mode: 0o600 })
      this.savedAt = Date.now()
    } catch { /* best effort */ }
  }

  saveLog() {
    try { writeFileSync(this.logFile, JSON.stringify(this.runtime.log, null, 2), { mode: 0o600 }) } catch { /* best effort */ }
  }

  /**
   * Adopt a config written by someone else (another module instance, a manual
   * edit) before using the token.
   *
   * Without this the in-memory copy keeps presenting a refreshToken that has
   * already been rotated away, and every scheduled run answers 401.
   * @returns {boolean} whether anything was adopted
   */
  syncFromDisk() {
    let stats
    try { stats = statSync(this.configFile) } catch { return false }
    if (this.savedAt !== 0 && stats.mtimeMs <= this.savedAt) return false
    let disk
    try { disk = JSON.parse(readFileSync(this.configFile, 'utf8')) } catch { return false }
    if (!disk || typeof disk !== 'object') return false
    const same = disk.accessToken === this.config.accessToken
      && disk.refreshToken === this.config.refreshToken
      && Number(disk.expiresAt) === Number(this.config.expiresAt)
    if (same) { this.savedAt = stats.mtimeMs; return false }
    this.config.accessToken = typeof disk.accessToken === 'string' ? disk.accessToken : this.config.accessToken
    this.config.refreshToken = typeof disk.refreshToken === 'string' ? disk.refreshToken : this.config.refreshToken
    this.config.expiresAt = Number(disk.expiresAt) || 0
    if (Number(disk.refreshedAt) > 0) this.config.refreshedAt = Number(disk.refreshedAt)
    if (disk.autoRefresh !== undefined) this.config.autoRefresh = disk.autoRefresh !== false
    if (disk.enabled !== undefined) this.config.enabled = disk.enabled === true
    if (disk.intervalMin !== undefined) this.config.intervalMin = Math.min(1440, Math.max(5, Number(disk.intervalMin) || DEFAULT_INTERVAL_MIN))
    if (disk.notify && typeof disk.notify === 'object') this.config.notify = { ...this.config.notify, ...disk.notify }
    this.savedAt = stats.mtimeMs
    return true
  }

  // -------------------------------------------------------------------------
  // Public (browser-facing) views — masked only
  // -------------------------------------------------------------------------

  publicConfig() {
    const hasAccessToken = this.config.accessToken !== ''
    const hasRefreshToken = this.config.refreshToken !== ''
    return {
      hasAccessToken,
      accessTokenMask: maskSecret(this.config.accessToken),
      hasRefreshToken,
      refreshTokenMask: maskSecret(this.config.refreshToken),
      /**
       * Whether the account API can be called right now.
       *
       * A refresh token is enough on its own: {@link refresh} exchanges it for a
       * working access token before the first request. The panel used to key this
       * off the access token alone, so a user who pasted only a refresh token was
       * told "not configured" while the host could in fact talk to the platform.
       */
      usable: hasAccessToken || hasRefreshToken,
      /** How the credentials are held, for the status chip. */
      credentialState: hasAccessToken && hasRefreshToken ? 'both'
        : hasRefreshToken ? 'refresh-only'
          : hasAccessToken ? 'access-only'
            : 'none',
      expiresAt: this.config.expiresAt || null,
      /** Epoch ms of the last successful exchange, or null if never. */
      refreshedAt: this.config.refreshedAt || null,
      expiresInSec: this.config.expiresAt ? Math.max(0, Math.round((this.config.expiresAt - Date.now()) / 1000)) : null,
      autoRefresh: this.config.autoRefresh,
      enabled: this.config.enabled,
      intervalMin: this.config.intervalMin,
      notify: { ...this.config.notify },
    }
  }

  state() {
    const snapshots = this.runtime.log.filter(entry => entry.kind === 'snapshot')
    return {
      config: this.publicConfig(),
      notifyMethods: listNotifyMethods(),
      latest: snapshots[0] ?? null,
      notifyLog: this.runtime.log.filter(entry => entry.kind !== 'snapshot').slice(0, 30),
      log: snapshots.slice(0, 30),
      totalSnapshots: snapshots.length,
      timerActive: this.runtime.timer !== null,
    }
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  #isStale() {
    return this.selfGeneration !== 0 && this.runtime.generation !== 0 && this.selfGeneration !== this.runtime.generation
  }

  /**
   * Refresh the access token with the rotating refresh token.
   *
   * Rotation makes this fragile: the server invalidates the old refresh token the
   * instant it mints a new one, so a lost RESPONSE permanently orphans the new
   * one. A container restart mid-request did exactly that on the reference
   * deployment. The mitigation is to retry TRANSPORT failures with the SAME
   * token: if the server never received the request the retry succeeds; if it did
   * receive it, the retry answers 401 and turns a silent loss into an explicit,
   * actionable error. A 401 is never retried — that token is truly dead.
   *
   * @param {boolean} [force]
   * @returns {Promise<true>}
   */
  async refresh(force = false) {
    if (this.#isStale()) throw new Error('plugin reloaded; this refresh was discarded')
    this.syncFromDisk()
    if (this.config.refreshToken === '') throw new Error('no refreshToken configured')
    if (this.runtime.refreshing !== null) return this.runtime.refreshing
    if (!force && this.config.expiresAt !== 0 && this.config.expiresAt - Date.now() > REFRESH_MARGIN_MS) return true
    this.runtime.refreshing = (async () => {
      const attempt = async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const response = await fetch(AS_REFRESH_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/plain, */*',
              'User-Agent': AS_USER_AGENT,
              Referer: `${AS_BASE}/model-calls`,
            },
            body: JSON.stringify({ refreshToken: this.config.refreshToken }),
            signal: controller.signal,
          })
          const text = await response.text()
          if (!response.ok) throw new Error(`refresh failed HTTP ${response.status}: ${text.slice(0, 160)}`)
          let parsed
          try { parsed = JSON.parse(text) } catch { throw new Error('refresh response was not JSON') }
          const data = parsed && parsed.data ? parsed.data : {}
          if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string'
            || data.accessToken === '' || data.refreshToken === '') {
            throw new Error('refresh response is missing accessToken/refreshToken')
          }
          return data
        } finally { clearTimeout(timer) }
      }
      let lastError
      for (let index = 0; index < 3; index += 1) {
        try {
          const data = await attempt()
          // Persist BOTH rotated values together, immediately: this is the only
          // copy of the new refresh token that will ever exist.
          this.config.accessToken = data.accessToken
          this.config.refreshToken = data.refreshToken
          this.config.expiresAt = Date.now() + (Number(data.expiresIn) || 7200) * 1000
          this.config.refreshedAt = Date.now()
          this.saveConfig()
          if (index > 0) this.log(`refresh succeeded on attempt ${index + 1} (earlier attempts were transport errors)`)
          return true
        } catch (error) {
          lastError = error
          // 401/4xx means the token is genuinely dead; retrying cannot help.
          const kind = errorKind(error)
          if (kind === 'auth' || kind === 'http') break
          if (index < 2) await new Promise(resolve => setTimeout(resolve, 1500 * (index + 1)))
        }
      }
      throw lastError
    })().finally(() => { this.runtime.refreshing = null })
    return this.runtime.refreshing
  }

  /**
   * One authenticated GET against the account API. A 401 forces a refresh and
   * one retry, so a rotated-but-not-yet-refreshed token does not surface as a
   * user-visible failure.
   * @param {string} url
   * @param {string} referer
   * @param {boolean} [retried]
   */
  async get(url, referer, retried = false) {
    if (this.config.autoRefresh) await this.refresh(false)
    if (this.config.accessToken === '') throw new Error('no accessToken configured')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8',
          authorization: `Bearer ${this.config.accessToken}`,
          priority: 'u=1, i',
          Referer: referer,
          'User-Agent': AS_USER_AGENT,
        },
        signal: controller.signal,
      })
      if (response.status === 401 && !retried && this.config.autoRefresh && this.config.refreshToken !== '') {
        await this.refresh(true)
        return this.get(url, referer, true)
      }
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`)
      try { return JSON.parse(text) } catch { throw new Error(`response was not JSON: ${text.slice(0, 120)}`) }
    } finally { clearTimeout(timer) }
  }

  /**
   * One authenticated POST with a JSON body.
   *
   * The write endpoints (claim / redeem) are the only ones that mutate an
   * account, so they share this one path and always go through the same retry
   * and masking rules.
   * @param {string} url
   * @param {object} body
   * @param {string} referer
   */
  async post(url, body, referer) {
    if (this.config.autoRefresh) await this.refresh(false)
    if (this.config.accessToken === '') throw new Error('no accessToken configured')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8',
          authorization: `Bearer ${this.config.accessToken}`,
          Referer: referer,
          'User-Agent': AS_USER_AGENT,
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        // Preserve the platform's machine code: the caller distinguishes an
        // already-claimed campaign from a real failure by it.
        let code = ''
        try {
          const parsed = JSON.parse(text)
          code = String(parsed?.error?.code ?? '')
        } catch { /* not JSON */ }
        throw new Error(`HTTP ${response.status}${code === '' ? '' : ` ${code}`}: ${text.slice(0, 200)}`)
      }
      try { return JSON.parse(text) } catch { throw new Error(`response was not JSON: ${text.slice(0, 120)}`) }
    } finally { clearTimeout(timer) }
  }

  // -------------------------------------------------------------------------
  // Account reads
  // -------------------------------------------------------------------------

  /** Credits, lifetime score, redeemable score, active promotion. */
  async credits() {
    const parsed = await this.get(AS_CREDITS_URL, `${AS_BASE}/model-calls`)
    return (parsed && parsed.data) ?? null
  }

  /** Account identity. */
  async userinfo() {
    const parsed = await this.get(AS_USERINFO_URL, `${AS_BASE}/model-calls`)
    return (parsed && parsed.data) ?? null
  }

  /** One page of the contribution ledger (newest first). */
  async contributions(page = 1, pageSize = 20) {
    const query = new URLSearchParams({ page: String(page), page_size: String(Math.min(100, Math.max(1, pageSize))) })
    const parsed = await this.get(`${AS_EVENTS_URL}?${query.toString()}`, `${AS_BASE}/community/contributions?section=details`)
    return (parsed && parsed.data) ?? null
  }

  /**
   * One page of the usage / redemption ledger.
   *
   * Query contract (verified against `/model-calls?tab=usage`):
   *   type=usage|redeem            (required by the endpoint)
   *   page / page_size             (page_size is capped upstream at 100)
   *   model_type=token|tts|image|asr|video
   *   model_id
   *   start_date / end_date        (YYYY-MM-DD, inclusive, both optional)
   *
   * The response dates are Asia/Shanghai wall-clock strings WITHOUT an offset, so
   * they are returned verbatim: round-tripping them through the browser's zone
   * would shift every row.
   *
   * @param {{ type?: string, page?: unknown, pageSize?: unknown, modelType?: string, modelId?: string, startDate?: string, endDate?: string }} query
   */
  async usage(query = {}) {
    const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))
    const type = String(query.type ?? 'usage')
    if (!USAGE_TYPES.includes(type)) throw badParam(`type accepts only ${USAGE_TYPES.join(' / ')}`)
    const page = Math.max(1, Math.trunc(Number(query.page) || 1))
    const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(query.pageSize) || 20)))
    const params = new URLSearchParams({ type, page: String(page), page_size: String(pageSize) })
    const modelType = String(query.modelType ?? '').trim()
    if (modelType !== '') {
      if (!MODEL_TYPES.includes(modelType)) throw badParam(`model_type accepts only ${MODEL_TYPES.join(' / ')}`)
      params.set('model_type', modelType)
    }
    const modelId = String(query.modelId ?? '').trim().slice(0, 120)
    if (modelId !== '') params.set('model_id', modelId)
    const startDate = String(query.startDate ?? '').trim()
    if (startDate !== '') {
      if (!isDate(startDate)) throw badParam('start_date must be YYYY-MM-DD')
      params.set('start_date', startDate)
    }
    const endDate = String(query.endDate ?? '').trim()
    if (endDate !== '') {
      if (!isDate(endDate)) throw badParam('end_date must be YYYY-MM-DD')
      params.set('end_date', endDate)
    }
    if (startDate !== '' && endDate !== '' && startDate > endDate) throw badParam('start_date is later than end_date')

    const parsed = await this.get(`${AS_USAGE_URL}?${params.toString()}`, `${AS_BASE}/model-calls?tab=usage`)
    const data = (parsed && parsed.data) ?? {}
    const items = Array.isArray(data.items) ? data.items : []
    const total = Math.max(0, Math.trunc(Number(data.total) || 0))
    const echoedPageSize = Math.trunc(Number(data.page_size) || pageSize) || pageSize
    // A page-local sum: the endpoint only ever returns one page, and "what did
    // this range cost" is the question a person actually asks.
    let credits = 0
    let inputTokens = 0
    let outputTokens = 0
    for (const item of items) {
      credits += Number(item && item.settled_credits) || 0
      inputTokens += (Number(item && item.input_tokens_uncached) || 0) + (Number(item && item.input_tokens_implicit_cached) || 0)
      outputTokens += Number(item && item.output_tokens) || 0
    }
    return {
      type: data.type ?? type,
      items,
      total,
      page: Math.trunc(Number(data.page) || 0),
      pageSize: echoedPageSize,
      pages: Math.max(1, Math.ceil(total / echoedPageSize)),
      sum: { credits: Math.round(credits * 100) / 100, inputTokens, outputTokens, count: items.length },
      query: { type, modelType, modelId, startDate, endDate },
      at: new Date().toISOString(),
    }
  }

  /** Model ids grouped by type (login JWT). */
  async supportedModels() {
    return this.get(AS_SUPPORTED_URL, `${AS_BASE}/model-calls`)
  }

  /** Reference prices grouped by capability (login JWT). */
  async pricing() {
    return this.get(AS_PRICING_URL, `${AS_BASE}/model-calls`)
  }

  /** Claimable credit grants. */
  async campaigns() {
    const parsed = await this.get(AS_CAMPAIGNS_URL, `${AS_BASE}/model-calls`)
    return (parsed && parsed.data) ?? null
  }

  /**
   * Claim one campaign grant. Idempotent in effect: an already-claimed code is
   * reported as such rather than failing the run.
   * @param {string} code
   */
  async claimCampaign(code) {
    const trimmed = String(code ?? '').trim()
    if (trimmed === '') throw badParam('campaign code is required')
    try {
      const parsed = await this.post(`${AS_CAMPAIGNS_URL}/${encodeURIComponent(trimmed)}/claim`, {}, `${AS_BASE}/model-calls`)
      return { claimed: true, data: (parsed && parsed.data) ?? null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/ALREADY_CLAIMED/i.test(message)) return { claimed: false, already: true, data: null }
      throw error
    }
  }

  /**
   * Redeem contribution into credits.
   *
   * Bounds are the platform's own: 10–5000 contribution per call, credits =
   * contribution × 10, and 5000 contribution per day in total. This method is the
   * SERVER side of that contract; the panel validates first for a friendly
   * message, but the numbers are checked here too because a hand-written request
   * must not be able to spend more than the platform allows.
   * @param {unknown} amount
   */
  async redeem(amount) {
    const parsed = Math.trunc(Number(amount))
    if (!Number.isFinite(parsed) || parsed < 10 || parsed > 5000) throw badParam('amount must be an integer from 10 to 5000')
    const result = await this.post(AS_REDEEM_URL, { amount: parsed }, `${AS_BASE}/model-calls`)
    return (result && result.data) ?? null
  }

  // -------------------------------------------------------------------------
  // Model API key (sk-as-…)
  // -------------------------------------------------------------------------

  /** Whether the platform returned the key material or only its metadata. */
  static modelKeyFrom(answer) {
    const data = (answer && answer.data) ?? answer ?? {}
    if (!data || typeof data !== 'object') return undefined
    for (const field of ['apiKey', 'api_key', 'key', 'token', 'modelApiKey']) {
      const value = data[field]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }

  /** Fetch the model key document (login JWT). May or may not carry the secret. */
  async modelKeyDocument() {
    return this.get(AS_MODEL_KEY_URL, `${AS_BASE}/model-calls`)
  }

  /** Rotate the model key (login JWT). The old key is revoked immediately. */
  async resetModelKey() {
    return this.post(AS_MODEL_KEY_RESET_URL, {}, `${AS_BASE}/model-calls`)
  }

  // -------------------------------------------------------------------------
  // Snapshots and notification
  // -------------------------------------------------------------------------

  /** Append one log entry, newest first, capped. */
  appendLog(entry) {
    this.runtime.log.unshift(entry)
    if (this.runtime.log.length > LOG_MAX) this.runtime.log.length = LOG_MAX
    this.saveLog()
  }

  /** Resolve the configured delivery route, or null when none is usable. */
  #notifyRoute() {
    const notify = this.config.notify
    if (notify.method === 'custom') {
      if (notify.botId === '' || notify.targetId === '') return null
      return { botId: notify.botId, targetId: notify.targetId, label: `${notify.botId} / ${notify.targetId}` }
    }
    const methods = listNotifyMethods()
    if (methods.length === 0) return null
    const selected = notify.botId !== '' && notify.targetId !== ''
      ? methods.find(method => method.botId === notify.botId && method.targetId === notify.targetId)
      : undefined
    const method = selected ?? methods[0]
    return {
      botId: method.botId,
      targetId: method.targetId,
      label: `${method.channel}: ${method.botName} → ${method.targetName}${method.address === '' ? '' : ` (${method.address})`}`,
    }
  }

  /**
   * Deliver one plain-text notification through this machine's dsh-im channel.
   * Never throws: a failed alert must not fail the run it is describing.
   * @param {string} text
   * @param {string} kind
   */
  async notify(text, kind) {
    const route = this.#notifyRoute()
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(), kind, sent: false, status: 0,
      route: route === null ? '' : route.label,
      preview: String(text).slice(0, 300),
      detail: '',
    }
    if (route === null) {
      record.detail = 'no usable IM delivery target is configured'
      this.appendLog(record)
      return record
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(DSH_IM_DELIVERY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: route.botId, targetId: route.targetId, text, format: 'plain' }),
        signal: controller.signal,
      })
      record.status = response.status
      const body = await response.text().catch(() => '')
      record.sent = response.ok
      try {
        const parsed = JSON.parse(body)
        if (parsed && parsed.sent === false) record.sent = false
      } catch { /* plain body */ }
      record.detail = record.sent ? `sent (${route.label})` : `delivery HTTP ${response.status}: ${body.slice(0, 160)}`
    } catch (error) {
      record.detail = error instanceof Error && error.name === 'AbortError'
        ? 'delivery timed out (15s)'
        : (error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      this.appendLog(record)
    }
    return record
  }

  /**
   * Full snapshot: userinfo + credits + contribution page, in parallel.
   * @param {'manual'|'schedule'|'startup'|'test'} [trigger]
   */
  async fetchSnapshot(trigger = 'manual') {
    if (this.#isStale()) return { skipped: true, reason: 'plugin reloaded' }
    this.syncFromDisk()
    if (this.runtime.fetching) return { skipped: true, reason: 'a fetch is already running' }
    this.runtime.fetching = true
    const started = Date.now()
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      kind: 'snapshot',
      trigger,
      ok: false,
      durationMs: 0,
      user: null,
      credits: null,
      events: [],
      error: '',
    }
    try {
      const [userinfo, credits, events] = await Promise.all([
        this.userinfo(),
        this.credits(),
        this.contributions(1, 20),
      ])
      entry.user = userinfo
      entry.credits = credits
      entry.events = events !== null && Array.isArray(events.items) ? events.items : []
      entry.ok = true
      entry.notify = '—'
    } catch (error) {
      entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      entry.errorKind = errorKind(error)
      if (this.config.notify.enabled && entry.errorKind !== 'network') {
        const zoned = zonedParts(new Date())
        const text = [
          '【AgentScope credits · fetch failed】',
          `time: ${zoned.day} ${zoned.hm}`,
          `trigger: ${trigger}`,
          `kind: ${entry.errorKind === 'auth' ? 'credentials rejected (sign in again)' : 'request failed'}`,
          `error: ${entry.error}`,
          '', '— from AgentScope Platform (DSH plugin)',
        ].join('\n')
        try {
          const result = await this.notify(text, 'as-failure')
          entry.notify = result.detail
        } catch (notifyError) {
          entry.notify = `notification threw: ${String(notifyError).slice(0, 120)}`
        }
      } else if (entry.errorKind === 'network') {
        entry.notify = 'network error, retried silently (no alert)'
      } else {
        entry.notify = 'disabled'
      }
    } finally {
      entry.durationMs = Date.now() - started
      this.appendLog(entry)
      this.runtime.fetching = false
    }
    return { result: entry, state: this.state() }
  }

  /**
   * Credits only — what the composer readout polls.
   *
   * Separate from {@link fetchSnapshot} on purpose: the readout refreshes every
   * few minutes and must not pay for the account document or a contribution page
   * on every tick, and it must not append a snapshot to the log either.
   */
  async quickCredits() {
    this.syncFromDisk()
    const credits = await this.credits()
    return {
      at: new Date().toISOString(),
      credits,
      user: null,
    }
  }

  // -------------------------------------------------------------------------
  // Config writes
  // -------------------------------------------------------------------------

  /**
   * Apply a partial config update. `-` or an empty string clears a credential;
   * anything else replaces it. Returns the fresh masked state.
   * @param {object} body
   */
  updateConfig(body) {
    const input = body && typeof body === 'object' ? body : {}
    if (input.accessToken !== undefined) {
      const value = String(input.accessToken).trim()
      if (value === '-' || value === '') { this.config.accessToken = ''; this.config.expiresAt = 0 }
      else this.config.accessToken = value
    }
    if (input.refreshToken !== undefined) {
      const value = String(input.refreshToken).trim()
      this.config.refreshToken = value === '-' || value === '' ? '' : value
    }
    if (input.expiresIn !== undefined) {
      this.config.expiresAt = Date.now() + (Number(input.expiresIn) || 7200) * 1000
    } else if (typeof input.accessToken === 'string' && input.accessToken.trim() !== '' && input.accessToken.trim() !== '-') {
      // A freshly pasted JWT carries its own expiry: read it rather than guess.
      try {
        const payload = JSON.parse(Buffer.from(String(input.accessToken).split('.')[1] ?? '', 'base64url').toString('utf8'))
        if (payload && typeof payload.exp === 'number') this.config.expiresAt = payload.exp * 1000
      } catch { /* keep the previous expiry */ }
    }
    if (input.autoRefresh !== undefined) this.config.autoRefresh = input.autoRefresh === true || input.autoRefresh === 'true'
    if (input.enabled !== undefined) this.config.enabled = input.enabled === true || input.enabled === 'true'
    if (input.intervalMin !== undefined) this.config.intervalMin = Math.min(1440, Math.max(5, Number(input.intervalMin) || DEFAULT_INTERVAL_MIN))
    if (input.notify !== undefined && input.notify && typeof input.notify === 'object') {
      const next = { ...this.config.notify }
      const incoming = input.notify
      if (incoming.enabled !== undefined) next.enabled = incoming.enabled === true || incoming.enabled === 'true'
      if (incoming.method !== undefined) next.method = incoming.method === 'custom' ? 'custom' : 'auto'
      if (incoming.botId !== undefined) next.botId = String(incoming.botId).trim().slice(0, 200)
      if (incoming.targetId !== undefined) next.targetId = String(incoming.targetId).trim().slice(0, 200)
      if (incoming.to !== undefined) next.to = String(incoming.to).trim() || NOTIFY_DEFAULT_TO
      this.config.notify = next
    }
    this.saveConfig()
    return this.state()
  }

  /** Clear the snapshot log in place, so every module instance sees the same array. */
  clearLog() {
    this.runtime.log.length = 0
    this.saveLog()
    return this.state()
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /**
   * (Re)arm the periodic snapshot.
   *
   * The generation counter is what makes a hot reload safe: an older instance's
   * timer notices it has been superseded and gives up instead of racing the new
   * one for the rotating refresh token.
   * @param {{ onTick?: () => void }} [options]
   */
  startScheduler(options = {}) {
    if (this.runtime.timer !== null) { clearInterval(this.runtime.timer); this.runtime.timer = null }
    this.runtime.generation = (this.runtime.generation || 0) + 1
    const generation = this.runtime.generation
    this.selfGeneration = generation
    if (!this.config.enabled || this.config.accessToken === '') return generation
    const interval = Math.max(5, this.config.intervalMin) * 60 * 1000
    this.runtime.timer = setInterval(() => {
      if (this.runtime.generation !== generation) return
      void this.fetchSnapshot('schedule')
    }, interval)
    this.runtime.timer.unref?.()

    // Startup probe: after a restart the in-memory timer is the only thing
    // watching the credentials, and waiting a full interval hid a dead token for
    // half an hour on the reference deployment. Probe once shortly after boot,
    // but only when the last snapshot is already older than one interval, so a
    // routine reload does not fire an extra request.
    const lastSnapshot = this.runtime.log.find(entry => entry.kind === 'snapshot')
    const lastAt = lastSnapshot ? Date.parse(lastSnapshot.at) || 0 : 0
    if (lastAt === 0 || Date.now() - lastAt > interval) {
      this.runtime.probe = setTimeout(() => {
        if (this.runtime.generation !== generation) return
        void this.fetchSnapshot('startup')
      }, 15_000)
      this.runtime.probe.unref?.()
    }
    if (typeof options.onTick === 'function') options.onTick()
    return generation
  }

  /** Stop both timers (used on plugin disposal). */
  stopScheduler() {
    if (this.runtime.timer !== null) { clearInterval(this.runtime.timer); this.runtime.timer = null }
    if (this.runtime.probe !== null) { clearTimeout(this.runtime.probe); this.runtime.probe = null }
  }
}

/** An error the HTTP layer answers with 400 instead of 500. */
export function badParam(message) {
  const error = new Error(message)
  error.code = 'EBADPARAM'
  return error
}
