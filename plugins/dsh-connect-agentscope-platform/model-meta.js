/**
 * AgentScope Platform — remote model-metadata refresh.
 *
 * The platform publishes model IDS and prices, but no capacity figures: the
 * chat guide lists seven ids with a one-line capability each, `GET /v1/models`
 * is the OpenAI shape (id/object/created/owned_by), and the account endpoints
 * describe pricing and type, not context windows. So capacities have to come
 * from somewhere else, and the table this plugin reads is LiteLLM's public
 * model map.
 *
 * That table lives on raw.githubusercontent.com, which is unreliable from some
 * networks. Two things follow, and both are in here:
 *
 *   - SEVERAL SOURCES, tried in order, each with its own timeout. A source that
 *     answers 403 or does not connect at all is simply skipped.
 *   - A LOCAL SNAPSHOT of the last good answer, plus the bundled roster, so a
 *     refresh failure never empties or blanks the catalog. Losing the network
 *     degrades the numbers; it does not remove the models.
 *
 * Nothing here blocks startup: `apply()` seeds the catalog from the bundled
 * roster and calls this asynchronously.
 *
 * @module dsh-connect-agentscope-platform/model-meta
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

/**
 * Download candidates, in the order they are tried.
 *
 * Measured 2026-11-12 (Asia/Shanghai) from this deployment:
 *   raw.githubusercontent.com (refs/heads) 200 · 5.86s
 *   cdn.jsdelivr.net                       200 · 0.75s · ETag, 304 works
 *   raw.githubusercontent.com (main)       200 · 1.08s
 *   gh-proxy.com                           200 · 0.85s
 *   ghproxy.net                            200 · 11.6s
 *   fastly.jsdelivr.net                    403 (not used)
 *   raw.gitmirror.com, github.moeyy.xyz    no connection (not used)
 *
 * The user's own preferred URL is first: it is the one they asked for, and a
 * jsDelivr mirror is a different (cached) copy of the same file.
 */
export const SOURCES = Object.freeze([
  Object.freeze({ label: 'raw.githubusercontent.com', url: 'https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/main/model_prices_and_context_window.json' }),
  Object.freeze({ label: 'cdn.jsdelivr.net', url: 'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json' }),
  Object.freeze({ label: 'gh-proxy.com', url: 'https://gh-proxy.com/https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' }),
  Object.freeze({ label: 'ghproxy.net', url: 'https://ghproxy.net/https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' }),
])

/** Per-source timeout. A slow mirror must not hold the whole refresh. */
const SOURCE_TIMEOUT_MS = 10_000
/** Refuse an answer that is clearly not the table (error page, truncated body). */
const MAX_BYTES = 8 * 1024 * 1024
/** A real table has thousands of entries; anything smaller is a bad answer. */
const MIN_ENTRIES = 1_000
/** Default refresh cadence; the settings panel can change it. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * One cached answer on disk.
 * @typedef {{ url: string, etag: string, fetchedAt: number, checkedAt: number, text: string }} MetaCache
 */

/**
 * Read the cached table.
 * @param {string} file
 * @returns {MetaCache | undefined}
 */
export function readMetaCache(file) {
  try {
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    if (typeof parsed.text !== 'string' || parsed.text.length === 0) return undefined
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      etag: typeof parsed.etag === 'string' ? parsed.etag : '',
      fetchedAt: Number(parsed.fetchedAt) || 0,
      checkedAt: Number(parsed.checkedAt) || 0,
      text: parsed.text,
    }
  } catch {
    return undefined
  }
}

/**
 * Persist the cached table. Never throws: a read-only state dir must not break
 * a refresh that otherwise succeeded.
 * @param {string} file
 * @param {MetaCache} cache
 */
export function writeMetaCache(file, cache) {
  try {
    writeFileSync(file, JSON.stringify(cache), { mode: 0o600 })
  } catch { /* best effort */ }
}

/** mtime of the cache file, used to notice an external writer. */
export function metaCacheMtime(file) {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

/**
 * Parse the table's text into an object keyed by model id.
 * @param {string} text
 * @returns {Record<string, unknown> | undefined}
 */
export function parseTable(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_BYTES) return undefined
  let parsed
  try { parsed = JSON.parse(text) } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  // `sample_spec` is documentation, not a model.
  if (typeof parsed.sample_spec !== 'object') return undefined
  return /** @type {Record<string, unknown>} */ (parsed)
}

/** Whether a parsed table looks complete enough to trust. */
export function isCompleteTable(table) {
  return table !== undefined && Object.keys(table).length >= MIN_ENTRIES
}

/**
 * Download the table, trying each source in order.
 *
 * A conditional request is sent when a cached answer came from the same URL, so
 * the common case (nothing changed) costs a 304 instead of four megabytes.
 * A 304 reuses the cached text. Errors, non-JSON answers and implausibly small
 * tables all fall through to the next source; exhaustion returns the last
 * failure instead of throwing at the caller.
 *
 * @param {object} options
 * @param {MetaCache | undefined} [options.cache]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.force] - skip the conditional request
 * @param {(url: string, init: object) => Promise<Response>} [options.fetchImpl]
 * @returns {Promise<{ cache?: MetaCache, table?: Record<string, unknown>, source?: string, notModified: boolean, failures: Array<{ label: string, reason: string }> }>}
 */
export async function fetchTable(options = {}) {
  const failures = []
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  for (const source of SOURCES) {
    const headers = { accept: 'application/json' }
    const reused = options.cache !== undefined && options.cache.url === source.url && options.cache.etag !== ''
    if (reused && options.force !== true) headers['if-none-match'] = options.cache.etag
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS)
    try {
      const signal = options.signal === undefined
        ? controller.signal
        : (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, controller.signal]) : controller.signal)
      const response = await fetchImpl(source.url, { headers, signal })
      if (response.status === 304 && reused) {
        const table = parseTable(options.cache.text)
        if (isCompleteTable(table)) {
          return { table, cache: { ...options.cache, checkedAt: Date.now() }, source: source.label, notModified: true, failures }
        }
        failures.push({ label: source.label, reason: 'cached copy is not a usable table' })
        continue
      }
      if (!response.ok) {
        failures.push({ label: source.label, reason: `HTTP ${response.status}` })
        continue
      }
      const text = await response.text()
      const table = parseTable(text)
      if (!isCompleteTable(table)) {
        failures.push({ label: source.label, reason: `not a model table (${text.length} bytes)` })
        continue
      }
      const now = Date.now()
      return {
        table,
        cache: {
          url: source.url,
          // A source that sent no ETag simply never gets a conditional request.
          etag: typeof response.headers?.get === 'function' ? (response.headers.get('etag') ?? '') : '',
          fetchedAt: now,
          checkedAt: now,
          text,
        },
        source: source.label,
        notModified: false,
        failures,
      }
    } catch (error) {
      // An aborted fetch during plugin disposal is not a source failure worth
      // reporting, but it does end the loop.
      if (options.signal?.aborted === true) return { notModified: false, failures }
      failures.push({ label: source.label, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      clearTimeout(timer)
    }
  }
  return { notModified: false, failures }
}

/**
 * Every table entry describing this exact model id.
 *
 * The bundled ids are bare (`qwen3.8-flash`), while the table keys every row by
 * provider (`dashscope/qwen3.8-flash`, `tencent/kimi-k3`, …). So the match is on
 * the LAST path segment, and it is exact: `deepseek-v4.1-flash-1017` is a
 * different model and must not be folded into `deepseek-v4.1-flash`.
 *
 * @param {Record<string, unknown> | undefined} table
 * @param {string} id
 * @returns {Array<{ key: string, entry: Record<string, unknown> }>}
 */
export function tableCandidates(table, id) {
  if (!table) return []
  const candidates = []
  for (const [key, value] of Object.entries(table)) {
    if (key === 'sample_spec' || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = /** @type {Record<string, unknown>} */ (value)
    const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    if (bare !== id) continue
    // Chat-shaped rows only: embedding/image_generation rows describe other
    // endpoints and would contribute nonsense capacities.
    const mode = typeof entry.mode === 'string' ? entry.mode : ''
    if (mode !== '' && mode !== 'chat' && mode !== 'responses') continue
    candidates.push({ key, entry })
  }
  return candidates
}

/** Provider prefixes preferred per model family, so a vendor's own row wins a tie. */
const PREFERRED_PROVIDERS = [
  { test: /^qwen/i, order: ['dashscope', 'qwen_ai_platform', 'qwencloud'] },
  { test: /^deepseek/i, order: ['deepseek', 'deepseek_ai', 'tencent', 'dashscope'] },
  { test: /^kimi/i, order: ['moonshot', 'tencent', 'dashscope'] },
  { test: /^glm/i, order: ['dashscope', 'zai', 'tencent'] },
]

/** Rank one candidate key for tie-breaking (lower is better). */
function rankOf(id, key) {
  const provider = key.includes('/') ? key.slice(0, key.indexOf('/')) : ''
  const family = PREFERRED_PROVIDERS.find(item => item.test.test(id))
  const index = family === undefined ? -1 : family.order.indexOf(provider)
  return index === -1 ? 1_000 : index
}

/**
 * Resolve one model's capacity from the table.
 *
 * Several providers describe the same model and they disagree (measured:
 * `max_input_tokens` 991808 vs 1000000 for one id, `max_output_tokens` 131072 /
 * 384000 / 1048576 for another). Taking the largest would inflate the budget
 * until the host's compaction never fires; taking the first is arbitrary. The
 * MEDIAN of the valid values is used instead, floored, with the preferred
 * provider breaking a tie — a single outlier cannot move the answer.
 *
 * @param {Array<{ key: string, entry: Record<string, unknown> }>} candidates
 * @param {string} id
 * @returns {{ contextWindow: number, maxTokens: number, supportsVision?: boolean, supportsReasoning?: boolean, keys: string[] } | undefined}
 */
export function resolveCapacity(candidates, id) {
  if (candidates.length === 0) return undefined
  const inputs = []
  const outputs = []
  const visions = []
  const reasonings = []
  for (const { entry } of candidates) {
    collectNumber(inputs, entry.max_input_tokens)
    collectNumber(outputs, entry.max_output_tokens)
    if (typeof entry.supports_vision === 'boolean') visions.push(entry.supports_vision)
    if (typeof entry.supports_reasoning === 'boolean') reasonings.push(entry.supports_reasoning)
  }
  const rank = key => rankOf(id, key)
  const preferred = [...candidates].sort((left, right) => rank(left.key) - rank(right.key))[0]
  // The RANGE is the honest answer: providers disagree about the same model
  // (measured: `max_input_tokens` 991808 vs 1000000 for one id, output caps
  // 131072 / 384000 / 1048576 for another). The panel shows min~max so the user
  // can see the disagreement; the EFFECTIVE value used when they type nothing is
  // the median, which a single outlier cannot drag.
  const contextRange = rangeOf(inputs)
  const outputRange = rangeOf(outputs)
  const contextWindow = median(inputs) ?? positiveOrUndefined(preferred?.entry.max_input_tokens)
  const maxOutput = median(outputs) ?? positiveOrUndefined(preferred?.entry.max_output_tokens)
  return {
    contextWindow: contextWindow ?? 0,
    // Never let the default output cap exceed the context: the host materializes
    // `maxTokens` into a request that ALSO carries the context budget.
    maxTokens: maxOutput !== undefined && contextWindow !== undefined ? Math.min(maxOutput, contextWindow) : (maxOutput ?? 0),
    // `{ min, max, median }` per field, for the grey placeholder hint. Absent
    // when no provider published a figure for that field.
    ...(contextRange === undefined ? {} : { contextRange }),
    ...(outputRange === undefined ? {} : { outputRange }),
    // A model is vision-capable only when a majority of the rows that say
    // anything say so. Rows that are silent abstain; they do not vote no.
    ...(visions.length === 0 ? {} : { supportsVision: visions.filter(Boolean).length / visions.length >= 0.6 }),
    ...(reasonings.length === 0 ? {} : { supportsReasoning: reasonings.filter(Boolean).length / reasonings.length >= 0.6 }),
    keys: candidates.map(candidate => candidate.key),
  }
}

/** `{ min, max, median }` for one field's candidate values, or undefined. */
function rangeOf(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  return { min: sorted[0], max: sorted[sorted.length - 1], median: median(values) }
}

function collectNumber(target, value) {
  const parsed = positiveOrUndefined(value)
  if (parsed !== undefined) target.push(parsed)
}

function positiveOrUndefined(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

/**
 * Enrich one catalog row with what the table knows.
 *
 * Only capacity and the two capability hints come from here. Input modalities
 * are NOT overridden: a table saying the model itself can see images does not
 * decide whether THIS plugin sends images, and the row's own `input` already
 * says what the user chose.
 *
 * @param {object} row - catalog row from models.js
 * @param {Record<string, unknown> | undefined} table
 * @returns {object} the row, with `enrichment` attached
 */
/**
 * Attach what the table knows to one catalog row.
 *
 * The row's OWN capacity is left untouched: the remote figures ride along as
 * `remote` (the effective median plus the min~max range), and the caller decides
 * whether to use them. That separation is what lets the settings panel show an
 * empty box with a grey "128K~1M" placeholder instead of pre-filling a number
 * nobody asked for.
 *
 * @param {object} row - catalog row from models.js (`contextWindow` may be null)
 * @param {Record<string, unknown> | undefined} table
 * @returns {object} the row, with `remote` and `enrichment` attached
 */
export function enrichRow(row, table) {
  const candidates = tableCandidates(table, row.id)
  const capacity = resolveCapacity(candidates, row.id)
  if (capacity === undefined) {
    return { ...row, remote: undefined, enrichment: { source: 'bundled' } }
  }
  return {
    ...row,
    remote: {
      contextWindow: capacity.contextWindow > 0 ? capacity.contextWindow : undefined,
      maxTokens: capacity.maxTokens > 0 ? capacity.maxTokens : undefined,
      contextRange: capacity.contextRange,
      outputRange: capacity.outputRange,
    },
    enrichment: {
      source: 'litellm',
      keys: capacity.keys,
      supportsVision: capacity.supportsVision,
      supportsReasoning: capacity.supportsReasoning,
    },
  }
}
