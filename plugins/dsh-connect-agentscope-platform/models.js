/**
 * AgentScope Platform — model catalog shapes and the built-in static roster.
 *
 * Three layers feed one catalog, and this module owns the bottom one:
 *
 *   1. BUNDLED_MODELS (here) — a small offline roster so the provider can be
 *      registered on the very first frame, before any network answer arrives.
 *      It carries ONLY what the platform itself publishes: the model id, a
 *      display name, and the input modalities.
 *
 *      ⚠️ IT CARRIES NO CAPACITY. Context window and output cap are numbers this
 *      plugin does not know: the platform publishes ids and prices, not windows,
 *      and anything written into a package can never learn what changed upstream.
 *      A hard-coded "128K" would be a guess wearing the clothes of a fact, and it
 *      would silently win over the real figures the remote table supplies. So the
 *      bundled rows leave both fields EMPTY (`null`), the remote table fills them
 *      with a RANGE (min~max across the providers that describe the model), and
 *      the user types a value when they want to override it. Empty is honest;
 *      a placeholder is not a claim.
 *
 *      The same reasoning is why no price is here: a rate is a fact about NOW.
 *      The reference implementation (dsh-connect-workbuddy, MIT) removed its own
 *      fallback price for exactly this reason (issue #214 there) — the offline
 *      placeholder must never assert a number that goes stale.
 *
 *   2. Remote enrichment (model-meta.js) — the LiteLLM model table, merged on top
 *      of layer 1 at runtime. It supplies `remote` ranges and the effective
 *      value used when the user typed nothing.
 *
 *   3. The user's own overrides (settings panel) — a value the user typed always
 *      wins, field by field. An unset field falls through to layer 2.
 *
 * INPUT MODALITIES DEFAULT TO TEXT + IMAGE. The platform's chat endpoint accepts
 * multimodal image input: its own model-calling guide states under 内容安全 that
 * "用户文本与多模态图片会经绿网审核" and that a refused image answers HTTP 400
 * with ASP.BIZ.CONTENT_SAFETY_VIOLATION. Image GENERATION is a different
 * endpoint (/api/v1/services/aigc/multimodal-generation/generation) and is out of
 * scope here — receiving an image in a chat turn is not the same feature.
 *
 * @module dsh-connect-agentscope-platform/models
 */

/** Provider route id this plugin owns. Kept stable: sessions and settings key on it. */
export const PROVIDER_ID = 'agentscope'

/** Display name offered to the model picker. */
export const PROVIDER_DISPLAY_NAME = 'AgentScope Platform'

/** OpenAI-compatible chat endpoint root; `/chat/completions` is appended by callers. */
export const DEFAULT_BASE_URL = 'https://platform.agentscope.io/v1'

/** One model's editable metadata, in the shape the settings table edits. */
export const MODEL_FIELDS = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts']

/** Input modalities the host understands today. */
export const MODALITIES = ['text', 'image']

/**
 * Reasoning tiers a user may enable per model.
 *
 * `off` means "send no reasoning field at all". The other ids are opaque
 * strings the host only compares for equality, so the vocabulary here is ours;
 * each enabled tier carries the upstream API value to write into the request
 * body (`reasoning_effort` by default), because the platform does not publish a
 * fixed one.
 */
export const REASONING_TIERS = ['off', 'low', 'medium', 'high']

/** Default upstream parameter name for a reasoning tier. */
export const DEFAULT_REASONING_PARAM = 'reasoning_effort'

/**
 * The floor used ONLY when neither the remote table nor the user supplies a
 * number.
 *
 * It is not a claim about any model: it is what the host needs so a request can
 * still be made and compacted. The settings table shows it as "unknown" rather
 * than presenting it as the model's real window, and any real figure from the
 * remote table or the user replaces it.
 */
export const FALLBACK_CAPACITY = Object.freeze({ contextWindow: 128_000, maxTokens: 8_192 })

/**
 * The offline roster: the seven text models the platform's first-phase guide
 * lists, with text+image input and NO capacity.
 *
 * `contextWindow` and `maxTokens` are `null` on purpose — see the module note.
 * A null means "this plugin does not know", which the panel renders as an empty
 * box with the remote range as a grey placeholder.
 */
export const BUNDLED_MODELS = Object.freeze([
  Object.freeze({ id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', contextWindow: null, maxTokens: null, input: Object.freeze(['text', 'image']) }),
  Object.freeze({ id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', contextWindow: null, maxTokens: null, input: Object.freeze(['text', 'image']) }),
  Object.freeze({ id: 'qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: null, maxTokens: null, input: Object.freeze(['text', 'image']) }),
  Object.freeze({ id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', contextWindow: null, maxTokens: null, input: Object.freeze(['text', 'image']) }),
  Object.freeze({ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: null, maxTokens: null, input: Object.freeze(['text', 'image']) }),
  Object.freeze({ id: 'kimi-k3', name: 'Kimi K3', contextWindow: null, maxTokens: null, input: Object.freeze(['text', 'image']) }),
  Object.freeze({ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: null, maxTokens: null, input: Object.freeze(['text', 'image']) }),
])

/** Modalities a brand-new row starts with: text and image, both ticked. */
export const DEFAULT_INPUT = Object.freeze(['text', 'image'])

/**
 * Coerce one arbitrary value into a model row, or `undefined` when it has no
 * usable id. Every field is optional in the input: a fetched candidate, a
 * hand-typed row and a saved override all arrive here.
 *
 * Capacity stays `null` when the source does not carry a usable number. That is
 * the whole point: "unknown" must be representable, or every caller ends up
 * inventing a default.
 *
 * @param {unknown} raw
 * @returns {{ id: string, name: string, contextWindow: number | null, maxTokens: number | null, input: string[], reasoningEfforts: object[] } | undefined}
 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = /** @type {Record<string, unknown>} */ (raw)
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  // No id, no row: an id is the only field the host routes on.
  if (id === '') return undefined
  const name = typeof source.name === 'string' && source.name.trim() !== '' ? source.name.trim() : id
  return {
    id,
    name,
    contextWindow: positiveInteger(source.contextWindow) ?? null,
    maxTokens: positiveInteger(source.maxTokens) ?? null,
    // A missing/empty list means "use the default", not "supports nothing": a
    // model with no declared modalities would be unusable in the picker, and
    // text+image is the platform's documented chat behaviour.
    input: modalities(source.input),
    reasoningEfforts: efforts(source.reasoningEfforts),
  }
}

/** A positive integer, or undefined. Accepts `"128000"`, `"128K"`, `"1M"`. */
export function positiveInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined
  if (typeof value !== 'string') return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM])?\s*$/.exec(value)
  if (match === null) return undefined
  const scale = match[2] === undefined ? 1 : /[kK]/.test(match[2]) ? 1_000 : 1_000_000
  const parsed = Math.round(Number(match[1]) * scale)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Normalize one input-modality list. Unknown entries are dropped; an empty
 * result falls back to the default (text + image) rather than to no input.
 */
export function modalities(value) {
  if (!Array.isArray(value)) return [...DEFAULT_INPUT]
  const kept = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim().toLowerCase()
    if (!MODALITIES.includes(id) || kept.includes(id)) continue
    kept.push(id)
  }
  // Never hand the host an empty list: [] is "supports no input at all".
  return kept.length === 0 ? [...DEFAULT_INPUT] : kept
}

/**
 * Normalize one reasoning-tier list.
 *
 * Each entry is `{ id, value? }`; `id` is `off` or a known tier, `value` is the
 * upstream parameter value. `off` never carries a value — it means "omit the
 * field". Duplicates and unknown ids are dropped; an empty result means "this
 * model declares no reasoning capability", which is the default.
 */
export function efforts(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const kept = []
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry.trim() : (entry && typeof entry === 'object' && typeof entry.id === 'string' ? entry.id.trim() : '')
    if (!REASONING_TIERS.includes(id) || seen.has(id)) continue
    seen.add(id)
    const raw = entry && typeof entry === 'object' && typeof entry.value === 'string' ? entry.value.trim() : ''
    kept.push(id === 'off' ? { id } : { id, value: raw === '' ? id : raw })
  }
  return kept
}

/** The bundled roster as plain mutable rows (fresh copies; never the frozen source). */
export function bundledModels() {
  return BUNDLED_MODELS.map(model => normalizeModel(model))
}

/**
 * Merge catalog layers. Later layers win per id; a row that only exists in an
 * earlier layer survives.
 *
 * Order is deliberate and is the plugin's single answer to "which value wins":
 * bundled → remote enrichment → the user's own rows.
 *
 * @param {Array<Array<object> | undefined>} layers
 * @returns {object[]}
 */
export function mergeModels(...layers) {
  const byId = new Map()
  for (const layer of layers) {
    if (!Array.isArray(layer)) continue
    for (const raw of layer) {
      const row = normalizeModel(raw)
      if (row === undefined) continue
      const previous = byId.get(row.id)
      if (previous === undefined) { byId.set(row.id, row); continue }
      // A LATER LAYER WINS FIELD BY FIELD, but only where it actually says
      // something. `null` capacity means "I have no figure", which must NOT erase
      // a real figure an earlier layer supplied — otherwise the user layer, which
      // is mostly empty, would blank out every remote range simply by existing.
      byId.set(row.id, {
        ...previous,
        ...row,
        contextWindow: row.contextWindow ?? previous.contextWindow,
        maxTokens: row.maxTokens ?? previous.maxTokens,
      })
    }
  }
  return [...byId.values()]
}
