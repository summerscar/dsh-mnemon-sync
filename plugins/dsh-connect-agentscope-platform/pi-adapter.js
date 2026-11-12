/**
 * AgentScope Platform — the pi-ai backed adapter (the only path).
 *
 * WHY THIS EXISTS. dsh-connect-workbuddy and dsh-connect-sensenova-token-plan
 * both register their provider by importing `PiAiAdapter` from
 * `@deepseek-ai/dsh-llm-pi-ai` — a Host-shipped peer — rather than implementing
 * `LlmAdapter` by hand. That is the supported route: the base class supplies
 * `imageRequestPricing` / `imageRequestTarget` / `providerInfo` /
 * `providerRetryPolicy` and the whole SSE-to-StreamChunk translation. A hand
 * written duck-typed adapter had to rediscover every one of those methods, and
 * missing just `imageRequestPricing` broke context compaction on model switch
 * (MODEL_SWITCH_COMPACTION_FAILED) — that is why it was removed rather than kept
 * as a no-peer fallback.
 *
 * The peer is declared in peerDependencies (open lower bound, optional) per
 * plugins/AGENTS.md, and the version floor is the first Host that ships it. This
 * module is still loaded LAZILY so a Host without the peer boots the rest of the
 * plugin (credits, check-in, usage) and logs the missing route instead of failing
 * to start at all.
 *
 * CATALOG SNAPSHOT. `PiAiAdapter` memoizes its `profiles()` result by identity,
 * so a catalog edit must REPLACE the registered adapter (a fresh instance), not
 * mutate the old one. `buildAgentScopeAdapter` therefore returns a new adapter
 * every call, and index.js's `invalidate()` re-registers it.
 *
 * @module dsh-connect-agentscope-platform/pi-adapter
 */

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createProvider } from '@earendil-works/pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'

import { DEFAULT_BASE_URL, PROVIDER_DISPLAY_NAME, PROVIDER_ID } from './models.js'

/** pi-ai's idle guard for one stream read, at the peer's own default. */
const STREAM_IDLE_TIMEOUT_MS = 120_000

/**
 * A credential plane that never manufactures a key.
 *
 * The `sk-as-…` key lives in this plugin's own vault. pi-ai must not read the
 * environment or a credentials store — it would either find nothing or, worse,
 * send the wrong key. `resolveApiKey` below is the ONLY source.
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return [] },
    async modify() {},
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false },
  },
}

/**
 * Conservative floors used ONLY when the remote table has no figure at all.
 *
 * `PiAiAdapter` requires both fields to be positive integers — `resolveRouteModels`
 * rejects a missing one outright, and `resolveModel()` always returns
 * `context: { contextWindow }`. "Leave blank = do not send the parameter" is
 * therefore not representable on this path. Instead a blank field takes the
 * MINIMUM of the remote reference range (the most conservative of the values
 * providers actually publish), and only an id with no remote data at all falls
 * back to these floors. A value the user typed always wins, unchanged.
 */
const FALLBACK_CONTEXT_WINDOW = 128_000
const FALLBACK_MAX_TOKENS = 8_192

/** A positive safe integer, or undefined. */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Resolve one capacity: user value → remote range minimum → conservative floor. */
function resolveCapacity(own, range) {
  const typed = positiveInteger(own)
  if (typed !== undefined) return typed
  const remoteMin = positiveInteger(range?.min)
  if (remoteMin !== undefined) return remoteMin
  return undefined
}

/**
 * Convert one of our catalog rows into a pi-ai model descriptor.
 *
 * Both capacities are ALWAYS positive integers (see above): pi-ai needs them,
 * and the reference range's minimum is the least presumptuous available value.
 * Input modalities follow the row's `input` list (text + image by default).
 */
function toPiModel(entry, provider, baseUrl) {
  const remote = entry.remote ?? {}
  const contextWindow = resolveCapacity(entry.contextWindow, remote.contextRange) ?? FALLBACK_CONTEXT_WINDOW
  const maxTokens = resolveCapacity(entry.maxTokens, remote.outputRange) ?? FALLBACK_MAX_TOKENS
  const input = Array.isArray(entry.input) && entry.input.length > 0 ? [...entry.input] : ['text']
  return {
    id: entry.id,
    name: entry.name,
    api: 'openai-completions',
    provider,
    baseUrl,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    // The platform's chat endpoint is OpenAI Chat Completions over SSE.
    compat: { supportsReasoningEffort: Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length > 0 },
  }
}

/**
 * Image-request budgets at the `dsh-llm-pi-ai` defaults.
 *
 * WHY THESE ARE SPELLED OUT. This plugin builds the profile map by hand, so it
 * never goes through `resolveProfiles()` — the only place the peer applies these
 * defaults. They are not optional: `imageRequestTarget()` passes
 * `requestImagePixelBudget` to `requestImageDimensions()` as `maxPixels`, so an
 * omitted one makes `sqrt(undefined / (w * h))` NaN and EVERY image — including a
 * normal 800x600 one — answers `{ width: NaN, height: NaN }`, which the attachment
 * service rejects with "Image request width must be a positive integer".
 *
 * Same three fields and the same values as dsh-connect-workbuddy and
 * dsh-connect-sensenova-token-plan: the profile type made them required in
 * dsh-llm-pi-ai 0.1.1-rc.2. Nothing beyond them is set — `maxRequestImages` and
 * `imageOffloadCountQuantum` stay absent on purpose, because supplying them
 * switches on an image-offload path those routes do not use.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/**
 * Assemble one `PiAiAdapter` for the current catalog snapshot.
 *
 * @param {object} options
 * @param {object[]} options.catalog - current rows (from currentCatalog())
 * @param {() => string | undefined} options.apiKey - resolves the live sk-as- key
 * @param {string} [options.baseUrl]
 * @param {(service: string) => unknown} [options.get] - Host service resolver
 * @returns {{ adapter: object, providerIds: string[] }}
 */
export function buildAgentScopeAdapter(options) {
  const { catalog, apiKey, get } = options
  const baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

  const models = catalog.map(entry => toPiModel(entry, PROVIDER_ID, baseUrl))
  const provider = createProvider({
    id: PROVIDER_ID,
    name: PROVIDER_DISPLAY_NAME,
    auth: {
      apiKey: {
        name: 'AgentScope model API key',
        async resolve({ credential } = {}) {
          const key = credential?.key
          return typeof key === 'string' && key !== '' ? { auth: { apiKey: key }, source: PROVIDER_DISPLAY_NAME } : undefined
        },
      },
    },
    models,
    api: openAICompletionsApi(),
  })

  // PiAiAdapter keys its profile map by the provider id. `piProvider` is what
  // actually lands in the registry, so it must claim PROVIDER_ID. The image
  // budgets are spread in as one row, so this profile lists exactly the fields
  // the two reference connectors list — see REQUEST_IMAGE_BUDGETS.
  const profiles = new Map([[PROVIDER_ID, {
    provider: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    ...REQUEST_IMAGE_BUDGETS,
    retryPolicy: resolveRetryPolicy(undefined, `${PROVIDER_ID}.retryPolicy`),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider: provider,
  }]])

  let cachedKey
  const resolveCredential = async () => {
    const key = apiKey()
    if (typeof key !== 'string' || key === '') {
      const error = new Error('AgentScope model API key is not configured; set it in the plugin settings')
      error.code = 'MISSING_CREDENTIAL'
      throw error
    }
    cachedKey = key
    return key
  }

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => resolveCredential(),
    resolveAttachments: () => get?.('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => get?.('fs')?.processPathFromHostPath?.(hostPath),
      ref,
    ),
  })

  void cachedKey
  return { adapter, providerIds: [PROVIDER_ID] }
}
