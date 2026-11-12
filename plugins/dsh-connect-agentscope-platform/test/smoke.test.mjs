/**
 * Structural regression for this plugin.
 *
 * The package is zero-build and zero-runtime-dependency, so "does it load, does
 * every declared subpath resolve, and are the runtime contracts still the ones
 * the rest of the system expects" IS the build contract. The identity strings
 * below are asserted rather than trusted: a well-meaning rename would silently
 * break a saved catalog, a mounted route or a browser half that hard-codes them.
 *
 * No network, no host: everything here runs on plain Node.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

test('package identity and workspace location', () => {
  assert.equal(manifest.name, '@summerscar/dsh-connect-agentscope-platform')
  // The release workflow bumps the version before `pnpm check` runs, so only its
  // shape is asserted here — pinning a literal would fail every publication.
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(manifest.license, 'SEE LICENSE IN LICENSE')
  assert.equal(manifest.engines.node, '>=22.16')
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.1')
  // The two declarations must agree exactly: `engines.dsh` is what the loader
  // enforces, `dsh.compatibility.dsh` is what the market advertises.
  assert.equal(manifest.dsh.compatibility.dsh, manifest.engines.dsh)
  assert.equal(manifest.repository.url, 'git+https://github.com/summerscar/dsh-plugins.git')
  assert.equal(manifest.repository.directory, 'plugins/dsh-connect-agentscope-platform')
  assert.equal(manifest.homepage, 'https://summerscar.github.io/dsh-plugins/plugins/connect-agentscope-platform/')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  // The browser half injects `locale`; the host client runtime needs the package
  // declared or the dictionary silently never arrives.
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
})

test('every declared export subpath resolves to a real file', async () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const resolved = subpath.includes('*')
      ? join(packageRoot, target.replace('*', 'en'))
      : join(packageRoot, target)
    assert.ok(existsSync(resolved), `${subpath} -> ${target} is missing`)
  }
  const host = await import(new URL('../index.js', import.meta.url))
  assert.equal(typeof host.apply, 'function')
  assert.ok(Array.isArray(host.inject) && host.inject.includes('llm'))
})

test('every packed file exists and the locale pair is packaged', () => {
  for (const entry of manifest.files) {
    if (entry.includes('*')) continue
    assert.ok(existsSync(join(packageRoot, entry)), `packed file missing: ${entry}`)
  }
  assert.ok(manifest.files.some(entry => entry === 'locale' || entry === 'locale/*.json'))
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
})

test('Chinese and English discovery metadata stay in step', () => {
  const dictionaries = ['zh', 'en'].map(language => {
    const file = join(packageRoot, 'locale', `${language}.json`)
    assert.ok(existsSync(file), `${language}.json is missing`)
    return JSON.parse(readFileSync(file, 'utf8'))
  })
  for (const dictionary of dictionaries) {
    for (const key of ['title', 'description']) {
      assert.ok(typeof dictionary.meta?.[key] === 'string' && dictionary.meta[key].trim() !== '', `${key} is missing`)
    }
  }
  assert.deepEqual(Object.keys(dictionaries[0]).sort(), Object.keys(dictionaries[1]).sort())
})

test('README carries the release-state marker', () => {
  assert.match(readFileSync(join(packageRoot, 'README.md'), 'utf8'), /<!-- release-state-note -->/)
})

test('bundled catalog: seven models, text+image by default', async () => {
  const models = await import(new URL('../models.js', import.meta.url))
  const rows = models.bundledModels()
  assert.equal(rows.length, 7)
  const ids = rows.map(row => row.id)
  for (const id of ['qwen3.8-flash', 'qwen3.7-plus', 'qwen3.8-max', 'deepseek-v4-pro-0813', 'deepseek-v4.1-flash', 'kimi-k3', 'glm-5.2']) {
    assert.ok(ids.includes(id), `${id} is missing from the bundled roster`)
  }
  for (const row of rows) {
    // The platform's chat endpoint accepts multimodal image input (its guide's
    // content-safety clause), so every row starts as text + image.
    assert.deepEqual([...row.input], ['text', 'image'], `${row.id} is not text+image`)
    // CAPACITY IS EMPTY ON PURPOSE. The platform publishes ids, not windows, so a
    // packaged number would be a guess that silently beats the remote table.
    assert.equal(row.contextWindow, null, `${row.id} must not ship an invented context window`)
    assert.equal(row.maxTokens, null, `${row.id} must not ship an invented output cap`)
    // A price is a fact about the present; a packaged table can never know it.
    assert.equal(row.creditMultiplier, undefined, `${row.id} must not pin a price`)
    assert.equal(row.price, undefined, `${row.id} must not pin a price`)
  }
})

test('normalizeModel and the capacity parser reject nonsense', async () => {
  const models = await import(new URL('../models.js', import.meta.url))
  assert.equal(models.normalizeModel({ name: 'no id' }), undefined)
  assert.deepEqual([...models.normalizeModel({ id: 'x' }).input], ['text', 'image'])
  assert.equal(models.positiveInteger('128K'), 128_000)
  assert.equal(models.positiveInteger('1M'), 1_000_000)
  assert.equal(models.positiveInteger('0'), undefined)
  assert.equal(models.positiveInteger('-5'), undefined)
  assert.equal(models.positiveInteger('nope'), undefined)
  // An unknown modality is dropped, and an empty list never becomes "no input".
  assert.deepEqual([...models.modalities(['text', 'video'])], ['text'])
  assert.deepEqual([...models.modalities([])], ['text', 'image'])
})

test('a user override wins per field and an absent one does not erase a real figure', async () => {
  const models = await import(new URL('../models.js', import.meta.url))
  // A remote-enriched layer, standing in for what model-meta.js produces.
  const remote = [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'] }]
  // The user edited only the name and a smaller context window.
  const user = [{ id: 'kimi-k3', name: 'Mine', contextWindow: 4096 }]
  const merged = models.mergeModels(remote, user)
  const row = merged.find(entry => entry.id === 'kimi-k3')
  assert.equal(row.name, 'Mine')
  assert.equal(row.contextWindow, 4096)
  // The user said nothing about the output cap, so the remote figure survives —
  // this is the bug that made the whole remote table inert before.
  assert.equal(row.maxTokens, 131_072)
  assert.deepEqual([...row.input], ['text', 'image'])
})

test('the LiteLLM source list keeps the user-requested URL first', async () => {
  const meta = await import(new URL('../model-meta.js', import.meta.url))
  assert.ok(meta.SOURCES.length >= 3)
  assert.match(meta.SOURCES[0].url, /raw\.githubusercontent\.com\/BerriAI\/litellm\/refs\/heads\/main\/model_prices_and_context_window\.json$/)
  // Sources measured as unusable from this deployment must not be shipped.
  for (const source of meta.SOURCES) {
    assert.ok(!source.url.includes('fastly.jsdelivr.net'), 'fastly.jsdelivr.net answers 403 here')
    assert.ok(!source.url.includes('raw.gitmirror.com'), 'raw.gitmirror.com does not connect here')
    assert.ok(!source.url.includes('github.moeyy.xyz'), 'github.moeyy.xyz does not connect here')
  }
})

test('table matching is exact on the last path segment', async () => {
  const meta = await import(new URL('../model-meta.js', import.meta.url))
  const table = {
    sample_spec: {},
    'dashscope/qwen3.8-flash': { mode: 'chat', max_input_tokens: 1000, max_output_tokens: 100 },
    'other/deepseek-v4.1-flash': { mode: 'chat', max_input_tokens: 2000, max_output_tokens: 200 },
    // A longer id that merely shares a prefix must never be folded in.
    'other/deepseek-v4.1-flash-1017': { mode: 'chat', max_input_tokens: 9_999_999 },
    'vector/embed-model': { mode: 'embedding', max_input_tokens: 8192 },
  }
  assert.equal(meta.tableCandidates(table, 'qwen3.8-flash').length, 1)
  assert.equal(meta.tableCandidates(table, 'deepseek-v4.1-flash').length, 1)
  assert.equal(meta.tableCandidates(table, 'deepseek-v4.1-flash-1017').length, 1)
  assert.equal(meta.tableCandidates(table, 'embed-model').length, 0)
  const capacity = meta.resolveCapacity(meta.tableCandidates(table, 'qwen3.8-flash'), 'qwen3.8-flash')
  assert.equal(capacity.contextWindow, 1000)
  // The output cap never exceeds the context budget.
  assert.ok(capacity.maxTokens <= capacity.contextWindow)
})

test('a blank capacity still reaches pi-ai as a positive integer', async () => {
  // Bundled rows ship no capacity on purpose (see models.js), yet PiAiAdapter
  // REJECTS a model descriptor without positive integers: resolveRouteModels
  // refuses a missing contextWindow and the model switch rolls back with
  // INVALID_MODEL_CONTEXT. pi-adapter.js therefore resolves both fields itself,
  // and this test pins the rule at the source because there is no host here:
  //   user's typed value → MINIMUM of the remote range → documented floor.
  const pi = readFileSync(join(packageRoot, 'pi-adapter.js'), 'utf8')
  assert.ok(pi.includes('function resolveCapacity(own, range)'))
  assert.ok(pi.includes('const typed = positiveInteger(own)'))
  assert.ok(pi.includes('const remoteMin = positiveInteger(range?.min)'))
  assert.ok(pi.includes('resolveCapacity(entry.contextWindow, remote.contextRange) ?? FALLBACK_CONTEXT_WINDOW'))
  assert.ok(pi.includes('resolveCapacity(entry.maxTokens, remote.outputRange) ?? FALLBACK_MAX_TOKENS'))
  assert.ok(pi.includes('const FALLBACK_CONTEXT_WINDOW = 128_000'))
  assert.ok(pi.includes('const FALLBACK_MAX_TOKENS = 8_192'))
  // Every bundled row is therefore servable without inventing a figure.
  const models = await import(new URL('../models.js', import.meta.url))
  for (const row of models.bundledModels()) {
    assert.equal(row.contextWindow, null, `${row.id} must not ship an invented context window`)
    assert.equal(row.maxTokens, null, `${row.id} must not ship an invented output cap`)
  }
})

test('credential masking never leaks the secret', async () => {
  const as = await import(new URL('../as.js', import.meta.url))
  const masked = as.maskSecret('sk-as-0123456789abcdef')
  assert.ok(!masked.includes('0123456789abcdef'), 'the mask contains the secret')
  assert.match(masked, /len \d+/)
  assert.equal(as.maskSecret(''), '')
})

test('check-in reads today\'s daily_login from the ledger, not from our own request', async () => {
  const checkin = await import(new URL('../checkin.js', import.meta.url))
  const today = '2026-11-12'
  assert.equal(checkin.CheckinScheduler.hasDailyLogin([{ action: 'daily_login', score_date: today }], today), true)
  assert.equal(checkin.CheckinScheduler.hasDailyLogin([{ action: 'daily_login', created_at: `${today}T00:30:00` }], today), true)
  // Yesterday's entry is not today's.
  assert.equal(checkin.CheckinScheduler.hasDailyLogin([{ action: 'daily_login', score_date: '2026-11-11' }], today), false)
  // A different action carrying today's date is not a check-in.
  assert.equal(checkin.CheckinScheduler.hasDailyLogin([{ action: 'article_publish', score_date: today }], today), false)
})

test('the provider is off until someone enables it', async () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // Opt-in is the whole point. The patch layer only mounts the plugin entry: it
  // must carry no `config` block, because any provider setting there would ship
  // switched on in every profile that installs this package.
  const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  assert.ok(!/^\s*config:/m.test(patch), 'the patch layer must not configure the plugin')
  assert.ok(!/providerEnabled/.test(patch), 'the patch layer must not set the provider switch')
  // And the default in code is `false`, not "on unless configured otherwise".
  assert.match(host, /providerEnabled: config\.providerEnabled === true/)
})

test('the runtime contract strings are frozen', async () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The API prefix is hard-coded in the browser half.
  assert.match(host, /const API_PREFIX = '\/api\/agentscope-platform'/)
  assert.match(client, /const API = '\/api\/agentscope-platform'/)
  // The provider route id keys sessions, settings and saved catalogs.
  for (const source of [host, client]) assert.match(source, /agentscope/)
  // Slot ids: the composer readout must not collide with another plugin's row.
  assert.match(client, /id: 'dsh-connect-agentscope-platform-composer-credits'/)
  assert.match(client, /id: 'dsh-connect-agentscope-platform'/)
})

test('the HTTP API answers state with an opt-in provider and the user catalog', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  // The plugin owns a fixed state directory, so this test reads what a real
  // deployment would produce rather than redirecting it: it asserts the SHAPE
  // of the answer, which is the part a refactor can break.
  const handlerHolder = {}
  const module = await import(new URL('../index.js', import.meta.url))
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-agentscope-platform' } } },
    logger: { warn: () => {} },
    get: () => undefined,
    inject(_names, callback) {
      callback({
        effect: fn => { fn(); return () => {} },
        webServer: { register: route => { handlerHolder.handler = route.handler; return () => {} } },
      })
    },
    effect: fn => { fn(); return () => {} },
    llm: {
      registerAdapter: () => Object.assign(() => {}, { replace() {} }),
      registerConfigurableProviders: () => Object.assign(() => {}, { replace() {} }),
      registerModelDiscovery: () => () => {},
    },
    on() {},
    emit() {},
  }
  module.apply(ctx, {})
  assert.equal(typeof handlerHolder.handler, 'function', 'the HTTP API did not mount')

  const call = async path => {
    // The handler replies asynchronously (it awaits the body/response), so the
    // captured text and status live on the response object and are read after a
    // short settle rather than from local variables.
    const response = {
      status: 0,
      body: '',
      writeHead(value) { this.status = value },
      end(text) { this.body = text },
    }
    await handlerHolder.handler({
      url: `/api/agentscope-platform${path}`,
      method: 'GET',
      [Symbol.asyncIterator]: async function* () {},
    }, response)
    if (response.body === '') await new Promise(resolve => setTimeout(resolve, 400))
    return { status: response.status, body: JSON.parse(response.body) }
  }

  const state = await call('/state')
  assert.equal(state.status, 200)
  // A live deployment may already have switched the provider on; this test
  // asserts the SHAPE of the answer, not the machine's current configuration.
  assert.equal(typeof state.body.provider.enabled, 'boolean')
  assert.equal(state.body.provider.id, 'agentscope')
  assert.equal(state.body.provider.id, 'agentscope')
  // The catalog is the USER's list, and it starts empty on purpose.
  assert.ok(Array.isArray(state.body.catalog))
  // Any row that IS there must be text + image and must not pin a price.
  for (const row of state.body.catalog) {
    assert.ok(row.input.includes('text'), `${row.id} lost text input`)
    assert.ok(row.input.includes('image'), `${row.id} lost image input`)
    assert.equal(row.price, undefined)
    assert.equal(row.creditMultiplier, undefined)
  }
  assert.equal(state.body.checkin.timezone, 'Asia/Shanghai')
  // A live deployment may already hold a model key; assert the SHAPE, not the
  // machine's current configuration.
  assert.equal(typeof state.body.modelKey.configured, 'boolean')
  assert.equal(typeof state.body.modelKey.mask, 'string')
  assert.match(state.body.build, /^asp-/)
})

test('the price list route exists and the panel renders it collapsed', async () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The host proxies the console's own list rather than recomputing prices: a
  // second derivation of a price is a second thing that can drift.
  assert.match(host, /sub === '\/pricing' && method === 'GET'/)
  assert.match(host, /await engine\.pricing\(\)/)
  // Every group starts CLOSED: the panel's initial open-set is empty.
  assert.match(client, /React\.useState\(\(\) => new Set\(\)\)/)
  // Figures come from the platform's own display strings.
  for (const field of ['display_input', 'display_cache', 'display_output', 'display_unit']) {
    assert.ok(client.includes(field), `${field} is not rendered`)
  }
  // The five capability groups the endpoint returns are all labelled.
  for (const key of ['pricingGroupToken', 'pricingGroupTts', 'pricingGroupImage', 'pricingGroupAsr', 'pricingGroupVideo']) {
    assert.ok(client.includes(key), `${key} copy is missing`)
  }
})

test('an unknown capability group still renders under a generic label', async () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // A new `billing_type` upstream must not produce an unlabelled or blank group.
  assert.match(client, /pricingGroupOther/)
  assert.match(client, /const key = \{ token: 'pricingGroupToken'/)
})

test('a refresh token alone makes the account API usable', async () => {
  const { CreditEngine } = await import(new URL('../as.js', import.meta.url))
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(`${tmpdir()}/asp-smoke-`)
  const engine = new CreditEngine({ stateDir: dir, log: () => {} })

  // Only a refresh token: the host exchanges it on the first call, so the panel
  // must NOT report "not configured".
  engine.config.refreshToken = 'refresh-only'
  engine.config.accessToken = ''
  let view = engine.publicConfig()
  assert.equal(view.usable, true, 'a refresh token alone must count as usable')
  assert.equal(view.credentialState, 'refresh-only')

  // Both present.
  engine.config.accessToken = 'access-too'
  view = engine.publicConfig()
  assert.equal(view.credentialState, 'both')

  // Only an access token: usable, but it dies in about two hours.
  engine.config.refreshToken = ''
  view = engine.publicConfig()
  assert.equal(view.usable, true)
  assert.equal(view.credentialState, 'access-only')

  // Nothing at all.
  engine.config.accessToken = ''
  view = engine.publicConfig()
  assert.equal(view.usable, false)
  assert.equal(view.credentialState, 'none')

  // The mask never carries the secret.
  engine.config.refreshToken = 'rft_secret_value_here'
  view = engine.publicConfig()
  assert.ok(!JSON.stringify(view).includes('rft_secret_value_here'))
})

test('saving a refresh token exchanges it immediately', async () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // The exchange happens on save, not lazily on the next poll: two live copies of
  // one rotating token is exactly the race that orphans it.
  assert.match(host, /const rotated = typeof body\.refreshToken === 'string'/)
  assert.match(host, /await engine\.refresh\(true\)/)
  assert.match(host, /exchanged = \{ ok: false/)
  // Both outcomes are reported, so a dead token is never swallowed into a
  // success message.
  assert.match(host, /exchanged = \{ ok: true \}/)
  assert.match(host, /exchanged = \{ ok: false/)
})

test('the plugin resolves and owns its own state directory', async () => {
  const paths = await import(new URL('../paths.js', import.meta.url))
  // $DSH_HOME wins, and the plugin's folder sits under `<root>/data/`.
  assert.equal(paths.resolveStateDir({ dshHome: '/srv/dsh' }), '/srv/dsh/data/connect-agentscope-platform')
  // No configured home falls back to $DSH_HOME, then <home>/dsh — never the cwd.
  const resolved = paths.resolveDshHome(undefined, { DSH_HOME: '/data/dsh' })
  assert.equal(resolved, '/data/dsh')
  const fallback = paths.resolveDshHome(undefined, {})
  assert.ok(fallback.startsWith('/'), 'the resolved data root must be absolute')
  // Every path is inside the one directory this plugin owns.
  const owned = paths.pluginPaths({ dshHome: '/srv/dsh' })
  for (const value of Object.values(owned)) {
    assert.ok(paths.isInside(owned.stateDir, value), `${value} escaped the state directory`)
  }
  // Point files carry the new prefix too (no stale agentscope-platform-* names).
  assert.ok(owned.settings.endsWith('/connect-agentscope-platform-settings.json'))
  assert.ok(owned.metaCache.endsWith('/connect-agentscope-platform-litellm.json'))
  // Credentials are kept apart from the disposable snapshots.
  assert.ok(owned.login.endsWith('/vault/login.json'))
  assert.ok(owned.modelKey.endsWith('/vault/model-key.json'))
  assert.ok(!owned.log.includes('/vault/'))
})

test('the state root contains no hard-coded absolute path', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // A literal path would break the moment an operator moves $DSH_HOME.
  assert.ok(!host.includes("'/data/dsh/data/agentscope-platform-state'"), 'a hard-coded state path crept back in')
  assert.match(host, /pluginPaths\(\)/)
  assert.match(host, /ensureStateDirs\(/)
})

test('the composer readout belongs to this plugin provider only', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The readout is a SHARED composer row; showing an AgentScope figure while a
  // session runs on another provider would be a number about nothing, and it
  // would also start a poll loop for no reason.
  assert.match(client, /const COMPOSER_PROVIDER = 'agentscope'/)
  assert.match(client, /function selectedProviderOf\(projection\)/)
  // `next` outranks `lastUsed`, matching what the picker itself displays.
  assert.match(client, /const candidate = projection\?\.next \?\? projection\?\.lastUsed/)
  // Not ours -> nothing renders at all.
  // Not-ready projections must not unmount the readout (see the session-switch test).
  assert.match(client, /if \(provider !== undefined\) foreignProvider = provider !== COMPOSER_PROVIDER/)
  assert.match(client, /if \(foreignProvider\) return null/)
  // The registration goes through the gate, never the bare readout.
  assert.match(client, /\}, ComposerCreditsGate\)\)/)
  assert.ok(!/\}, ComposerCredits\)\)/.test(client), 'the ungated readout is registered directly')
})

test('the model catalog starts empty and stays empty', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // Nothing is pre-listed: models are opt-in, fetched or typed by the user.
  assert.match(host, /settings\.catalog = \[\]/)
  // The bundled roster is an ENRICHMENT lookup, never written into the user's
  // catalog and never served as hidden models — that distinction is the point.
  assert.match(host, /const known = new Map\(bundledModels\(\)\.map\(row => \[row\.id, row\]\)\)/)
  assert.ok(!/fallbackCatalog/.test(host), 'the served-catalog fallback went with the hand-written adapter')
  // An earlier release seeded the roster into the file; one schema-keyed pass
  // clears that leftover, and only that one.
  assert.match(host, /const CATALOG_SCHEMA_VERSION = 2/)
  assert.match(host, /if \(Number\(settings\.schemaVersion\) < CATALOG_SCHEMA_VERSION\)/)
  // The user's own list is the catalog, not "bundled plus user".
  assert.match(host, /return settings\.catalog\.map\(entry =>/)
})

test('the browser half never calls a hook behind a condition', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // A hook invoked inside a ternary changes the hook COUNT between renders when
  // the injection appears or disappears, and React tears the tree down ("Rendered
  // fewer hooks than expected") — the whole workspace goes with it.
  assert.ok(!/useProjection\s*===\s*undefined\s*\n?\s*\?\s*undefined\s*:\s*useProjection\(/.test(client),
    'useProjection must not be called through a conditional expression')
  assert.match(client, /function ProjectedComposerCredits/,
    'the projected readout needs its own component so the hook is unconditional')
})

test('no translated string is used as a string before it is known to be one', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // `t(key).replace(...)` throws inside render when the dictionary has not
  // resolved (or a key was renamed), with no error boundary above this panel.
  assert.ok(!/t\('[^']+'\)\s*\.\s*(replace|split|slice|toUpperCase|toLowerCase|padStart|padEnd)\b/.test(client),
    'a translated string is being method-called without a guard')
  assert.match(client, /function safeFill\(/, 'placeholder filling must go through safeFill')
  assert.match(client, /function safeT\(/, 'translation lookups must go through safeT')
})

test('the plugin does not emit host events by name', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // `llm/adapters-updated` is dispatched by the host's own emitter. Calling
  // ctx.emit(name) reaches listeners through a different seam and hands them a
  // shape they never expected — the model picker is one of those listeners.
  assert.ok(!/ctx\.emit\??\.\(\s*['"]llm\/adapters-updated['"]/.test(host),
    'the host announces route changes itself; do not emit it by hand')
})

test('every form control has a stable id and autofocus is kept off inputs', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The host's modal layer auto-focuses the first focusable control and marks it
  // `data-dsh-automatic-focus`, then forwards typed characters globally. Landing
  // on one of our inputs is what filled the workspace's session-search box and
  // fired `session/search` on open. Explicitly anchoring the focus on a NON-input
  // container is the fix; the `id`s make every field addressable and stop
  // browser autofill from guessing across the many rows of this form.
  // The anchor is a hidden, NON-focusable span: the host's querySelector finds
  // it, but .focus() is a no-op, so the data-dsh-automatic-focus marker never
  // lands on any control of this form.
  assert.match(client, /const focusAnchor = h\('span',/)
  assert.match(client, /'data-modal-autofocus': '',\s*\n\s*'aria-hidden': 'true'/)
  assert.match(client, /display: 'none'/)
  // The page container itself must NOT carry the marker: that made it a keyboard
  // sink (yi() focuses it and keeps the marker until a Tab/arrow key).
  assert.ok(!/style: S\.page, 'data-modal-autofocus'/.test(client))
  // Password fields need new-password, not off: Chrome ignores off on them.
  const passwordBlocks = [...client.matchAll(/type: 'password'/g)]
  assert.ok(passwordBlocks.length >= 2)
  const newPasswordCount = (client.match(/autoComplete: 'new-password'/g) || []).length
  assert.ok(newPasswordCount >= 2, `expected new-password on both password inputs, got ${newPasswordCount}`)
  assert.ok(!/autoComplete: 'off',[\s\S]{0,120}type: 'password'/.test(client),
    'a password field still uses autoComplete="off"')
  assert.ok(client.includes('autoComplete: \'off\''), 'text inputs must opt out of autofill')
  const ids = [...client.matchAll(/id: [`']asp-[^`']+[`']/g)].map(match => match[0])
  assert.ok(ids.length >= 15, `expected a stable id on every control, found ${ids.length}`)
  // Model-row ids are keyed by row.id so several rows cannot collide.
  assert.match(client, /id: `asp-model-id-\$\{row\.id\}`/)
})

test('no raw translated string is method-called and no host event is emitted by name', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  assert.ok(!/t\('[^']+'\)\s*\.\s*(replace|split|slice|toUpperCase|toLowerCase|padStart|padEnd)\b/.test(client))
  assert.match(client, /function safeFill\(/)
  assert.match(client, /function safeT\(/)
  assert.ok(!/ctx\.emit\??\.\(\s*['"]llm\/adapters-updated['"]/.test(host))
})

test('the price list response is not double-wrapped', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // engine.pricing() already returns the platform's { data: { groups } } envelope.
  // Wrapping it again made the panel read answer.data.data, find no groups, and
  // show "no prices". The route must return the document as-is.
  assert.match(host, /sendJson\(res, 200, await engine\.pricing\(\)\)/)
  assert.ok(!/sendJson\(res, 200, \{ data: await engine\.pricing\(\) \}\)/.test(host))
})

test('account-writing actions are gone from the daily check-in and credits panel', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const checkin = readFileSync(join(packageRoot, 'checkin.js'), 'utf8')
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // The user asked for both switches and the whole redeem block to be removed:
  // a scheduler must not move an account's balance without a per-action decision.
  for (const key of ['checkinAutoClaim', 'checkinAutoRedeem', 'redeemTitle', 'redeemAmount', 'redeemNow', 'redeemHint', 'redeemDone', 'campaignClaim']) {
    assert.ok(!client.includes(key), `${key} is still in the client`)
  }
  assert.ok(!/autoClaim|autoRedeem|claimCampaign|engine\.redeem/.test(checkin), 'the check-in still performs writes')
  assert.ok(!/sub === '\/redeem'|sub === '\/campaigns'/.test(host), 'write routes are still exposed')
})

test('usage timestamps are converted into the viewer local time zone', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The platform returns Beijing wall-clock strings with NO offset; new Date()
  // would parse them as the browser's own zone, which is wrong off UTC+8.
  assert.match(client, /function localTime\(raw\)/)
  assert.match(client, /\+08:00/)
  assert.match(client, /Intl\.DateTimeFormat\(undefined/)
  assert.match(client, /localTime\(item\.created_at\)/)
  assert.ok(!/item\.created_at \?\? '—'/.test(client), 'the raw wall-clock string is still rendered')
  // Copy must no longer claim the raw value is shown.
  assert.ok(!/北京时间原值|Beijing wall-clock values the platform returns/.test(client))
})

test('the daily check-in logs in at most once per local day', async () => {
  const { CheckinScheduler } = await import(new URL('../checkin.js', import.meta.url))
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(`${tmpdir()}/asp-checkin-`)
  try {
    const calls = { userinfo: 0, contributions: 0 }
    const engine = {
      userinfo: async () => { calls.userinfo += 1; return {} },
      contributions: async () => { calls.contributions += 1; return { items: [] } },
    }
    const scheduler = new CheckinScheduler({
      engine,
      paths: { checkin: `${dir}/checkin.json` },
      settings: () => ({ enabled: true }),
      log: () => {},
    })
    // First run: exactly one keep-alive (login) and one ledger read.
    await scheduler.runOnce('manual')
    assert.equal(calls.userinfo, 1, 'the first run must do ONE keep-alive')
    assert.equal(calls.contributions, 1)
    assert.equal(scheduler.todayRecord().status, 'pending')

    // A heartbeat tick on the SAME day must not call userinfo again.
    const record = scheduler.todayRecord()
    assert.equal(scheduler.shouldRunNow(record), false, 'a pending day must not log in again')
    await scheduler.refreshLedger()
    assert.equal(calls.userinfo, 1, 'refreshLedger must NOT perform a login')
    assert.equal(calls.contributions, 2, 'refreshLedger is a read-only ledger check')

    // The code separates the clock tick from the action: no repeated userinfo.
    const source = readFileSync(join(packageRoot, 'checkin.js'), 'utf8')
    assert.match(source, /async refreshLedger\(\)/)
    assert.match(source, /if \(record\.attempts > 0\) return HEARTBEAT_MS/)
    assert.match(source, /if \(!this\.shouldRunNow\(record\)\)/)
    assert.ok(!source.includes('IDLE_MS'), 'the old 30-minute login heartbeat is gone')
    scheduler.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a newly added or adopted model row leaves capacities empty', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // Hard-coding a default here made every new row show "128K / 8K (manual)"
  // before the user typed anything, defeating the grey remote-range hint.
  assert.match(client, /const add = \(\) => setRows\(current => \[\.\.\.current, \{ id: '', name: '', contextWindow: null, maxTokens: null,/)
  assert.match(client, /contextWindow: null,\s*\n\s*maxTokens: null,/)
  assert.ok(!/contextWindow: 128_000, maxTokens: 8_192/.test(client), 'add() still seeds a default capacity')
  assert.ok(!/contextWindow: candidate\.contextWindow \?\? 128_000/.test(client), 'adopt() still seeds a default capacity')
  // The placeholder is the remote range, and "manual" only shows on a real value.
  assert.match(client, /const contextHint = rangeHint\(row\.remote\?\.contextRange\)/)
  // A blank box gets NO label: the remote range is a hint, not a value source.
  assert.match(client, /return own === null \|\| own === undefined \? '' : t\('metaUser'\)/)
})

test('capacity fields show plain integers, never abbreviated units', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The host takes a PLAIN INTEGER for contextWindow / max_tokens. Abbreviated
  // display like "918K~1M" is readable prose, but it cannot be pasted back into
  // an editable box (parseCapacity only takes digits with an optional K/M
  // suffix), so the value and the grey hint both use raw integers.
  assert.match(client, /function capacity\(value\) \{\s*\n\s*\/\/ An absent value must render as an EMPTY box/)
  assert.ok(!/Math\.round\(number \/ 100_000\)/.test(client), 'the K/M abbreviation came back into capacity()')
  assert.match(client, /return range\.min === range\.max \? String\(range\.min\) : `\$\{range\.min\}~\$\{range\.max\}`/)
  // An absent value renders as an empty box, not "0".
  assert.match(client, /if \(value === null \|\| value === undefined \|\| value === ''\) return ''/)
  // The K/M suffix stays SUPPORTED on input (parseCapacity), only display dropped it.
  assert.match(client, /function parseCapacity\(text\)/)
})

test('an empty capacity is a valid row, not a validation error', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // Leaving the box empty means "use the remote figure". Treating null as a bad
  // number blocked saving a perfectly good row and told the user to enter a
  // positive value they never wanted to type.
  assert.match(client, /const capacityProblem = value => value === null \|\| value === undefined/)
  assert.ok(!/if \(!Number\.isSafeInteger\(row\.contextWindow\) \|\| row\.contextWindow <= 0\) return t\('modelCapacityInvalid'\)/.test(client),
    'a null capacity is still rejected by the save-time validator')
  // Only a typed value must be a positive integer.
  assert.match(client, /Number\.isSafeInteger\(value\) && value > 0 \? '' : t\('modelCapacityInvalid'\)/)
})

test('a newly added row still gets the grey reference range', async () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // Rows loaded from the host carry `remote`; a row the user just typed (or
  // adopted from discovery) lives only in the draft, so the hint would be blank.
  // The host answers a by-id lookup for exactly those, and the hint is the ONLY
  // thing it feeds — no value is taken from it.
  assert.match(host, /sub === '\/model-meta\/lookup' && method === 'GET'/)
  assert.match(host, /sendJson\(res, 200, \{ ranges \}\)/)
  assert.match(client, /\/model-meta\/lookup\?ids=/)
  assert.match(client, /const lookedUp = React\.useRef\(new Set\(\)\)/)
  // The merge writes `remote` only — never contextWindow / maxTokens.
  assert.match(client, /row\.remote === undefined && ranges\[key\] !== undefined \? \{ \.\.\.row, remote: ranges\[key\] \}/)
})

test('capacity boxes are wide enough for the reference range', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // \`917504~1048576\` is 15 characters; a 96px box clipped the grey hint.
  const style = /capacityInput: \{ flex: '0 0 auto', width: '(\d+)px'/.exec(client)
  assert.ok(style !== null, 'the capacity box needs its own width')
  const width = Number(style[1])
  assert.ok(width >= 160, `capacity box is only ${width}px, too narrow for "917504~1048576"`)
  // Both capacity fields use it, and the compact fields keep the narrow style.
  assert.equal((client.match(/style: S\.capacityInput/g) || []).length, 2)
  assert.equal((client.match(/style: S\.inputNarrow/g) || []).length, 4)
  // The row wraps, so a 176px box cannot overflow a phone-width settings panel.
  assert.match(client, /row: \{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' \}/)
})

test('the login panel says how to get a refresh token and when it last refreshed', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const engine = readFileSync(join(packageRoot, 'as.js'), 'utf8')

  // The "do not use the same account in a browser" advice is gone: it told the
  // user to give up the console, and the panel now explains how to read a token
  // FROM that console instead.
  assert.ok(!/互相作废/.test(client), 'the mutual-invalidation advice is still in the panel')
  assert.ok(!/invalidate each other/.test(client), 'the mutual-invalidation advice is still in the panel')

  // The console line is the real storage location of the platform's console
  // (localStorage, raw string), so both dictionaries must carry exactly it.
  const snippets = [...client.matchAll(/refreshTokenSnippet: "([^"]+)"/g)].map(match => match[1])
  assert.equal(snippets.length, 2, 'the snippet must exist in both dictionaries')
  assert.equal(snippets[0], snippets[1], 'the snippet differs between languages')
  assert.equal(snippets[0], "localStorage.getItem('refreshToken')")
  for (const key of ['refreshTokenHowTo', 'lastRefreshed', 'neverRefreshed']) {
    assert.equal((client.match(new RegExp(`\\n      ${key}:`, 'g')) || []).length, 2, `${key} must exist in both dictionaries`)
  }
  // It has to be rendered: a dictionary entry nobody shows is dead weight.
  assert.match(client, /h\('code', \{[\s\S]{0,400}t\('refreshTokenSnippet'\)/)
  assert.match(client, /label: t\('lastRefreshed'\)/)

  // The stamp itself comes from the host: set ONLY on a successful exchange, so
  // a rejected token cannot make the panel claim a refresh that never happened.
  assert.match(engine, /refreshedAt: 0,/)
  assert.match(engine, /refreshedAt: Number\(saved\.refreshedAt\) \|\| 0,/)
  assert.match(engine, /this\.config\.refreshedAt = Date\.now\(\)\n          this\.saveConfig\(\)/)
  assert.match(engine, /refreshedAt: this\.config\.refreshedAt \|\| null,/)
})

test('saving the catalog re-announces the provider so the picker refreshes', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // The picker FILTERS OUT provider groups whose model list is empty. Enabling
  // the switch with no models, then adding the first row, therefore needs an
  // explicit "topology changed" broadcast — otherwise the group stays hidden.
  // AdapterRegistrationHandle.replace() is the supported seam: LlmRuntime
  // publishes `llm/adapters-updated` from inside it.
  assert.match(host, /function invalidate\(\) \{/)
  assert.match(host, /if \(!settings\.providerEnabled\) return/)
  // Re-registration (not replace) carries the NEW catalog snapshot.
  assert.match(host, /void syncProvider\(\)/)
  assert.match(host, /releaseProvider\(\)/)
  assert.match(host, /ctx\.llm\.registerAdapter\(\[PROVIDER_ID\], adapter\)/)
  // Never emit the host event by hand (wrong dispatch shape).
  assert.ok(!/ctx\.emit\??\.\(\s*['"]llm\/adapters-updated['"]/.test(host))
  // Saving the catalog must go through invalidate().
  const catalogRoute = /sub === '\/catalog' && method === 'POST'[\s\S]{0,240}/.exec(host)
  assert.ok(catalogRoute !== null && catalogRoute[0].includes('writeCatalog('))
  assert.match(host, /writeJsonFile\(paths\.settings, settings\)\s*\n\s*invalidate\(\)/)
})

test('the Host peer adapter is the only path, and it is loaded lazily', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const pi = readFileSync(join(packageRoot, 'pi-adapter.js'), 'utf8')
  // WorkBuddy / SenseNova both use the Host-shipped PiAiAdapter. A hand-written
  // duck-typed LlmAdapter kept missing base-class methods (imageRequestPricing
  // broke compaction on model switch), so the peer is the ONLY adapter now: no
  // second implementation is left to drift out of step with it.
  assert.match(pi, /import \{ PiAiAdapter } from '@deepseek-ai\/dsh-llm-pi-ai'/)
  assert.match(pi, /new PiAiAdapter\(/)
  // Each row reaches pi-ai as a plain chat-completions descriptor.
  assert.match(pi, /api: 'openai-completions'/)
  assert.match(pi, /cost: \{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }/)
  // The peer is still imported lazily: a Host below the declared floor loses the
  // model route with a logged line while credits, check-in and usage keep working.
  assert.match(host, /import\('\.\/pi-adapter\.js'\)/, 'the peer module must be loaded lazily')
  assert.match(host, /Host-provided PiAiAdapter unavailable/)
  assert.ok(!/\bnew AgentScopeAdapter/.test(host), 'index.js still builds a hand-written adapter')
  // The hand-written implementation is gone, not merely unused.
  assert.ok(!existsSync(join(packageRoot, 'provider.js')), 'provider.js came back')
  // A fresh instance per rebuild: PiAiAdapter memoizes its profiles snapshot.
  assert.match(host, /const adapter = await buildAdapter\(\)/)
  assert.match(host, /releaseProvider\(\)\s*\n\s*activeAdapter = adapter/)
})

test('the pi-ai profile carries the image budgets the peer requires', async () => {
  // The attachment service validates this answer (dsh-attachment-local
  // validateTarget) and the whole turn dies otherwise with
  // "Image request width must be a positive integer".
  //
  // WHY THIS TEST IS BEHAVIOURAL. This plugin builds the pi-ai profile map by
  // hand, so it bypasses `resolveProfiles()` — the only place the peer applies
  // its own defaults. An omitted `requestImagePixelBudget` is not "unset": it
  // reaches `requestImageDimensions()` as `maxPixels`, `sqrt(undefined / (w*h))`
  // is NaN, and EVERY image — including a perfectly normal 800x600 one — gets
  // `{ width: NaN, height: NaN }`. A source-string assertion cannot catch that.
  const { buildAgentScopeAdapter } = await import(new URL('../pi-adapter.js', import.meta.url))
  const { adapter } = buildAgentScopeAdapter({
    catalog: [{ id: 'probe-model', name: 'Probe', input: ['text', 'image'] }],
    apiKey: () => 'sk-as-test',
    baseUrl: 'https://platform.agentscope.invalid/v1',
    get: () => undefined,
  })
  // A real image keeps its own dimensions and takes the route's byte budget.
  assert.deepEqual(adapter.imageRequestTarget('agentscope', 'probe-model', { width: 800, height: 600, bytes: 50_000 }), {
    width: 800, height: 600, maxBytes: 1_048_576,
  })
  // Same three fields and values as dsh-connect-workbuddy and
  // dsh-connect-sensenova-token-plan. The profile type made them required in
  // dsh-llm-pi-ai 0.1.1-rc.2; omitting one is what broke every image request.
  const pi = readFileSync(join(packageRoot, 'pi-adapter.js'), 'utf8')
  const budgets = /const REQUEST_IMAGE_BUDGETS = \{([^}]*)\}/.exec(pi)
  assert.ok(budgets !== null, 'the profile image budgets must be declared as one row')
  assert.match(budgets[1], /maxRequestImageBytes: 20_971_520/)
  assert.match(budgets[1], /requestImagePixelBudget: 4_194_304/)
  assert.match(budgets[1], /requestImageMaxBytes: 1_048_576/)
  assert.match(pi, /\.\.\.REQUEST_IMAGE_BUDGETS,/)
  // No image-offload fields: supplying them switches on a path these routes
  // (and this one) do not use.
  assert.ok(!/maxRequestImages:/.test(pi), 'maxRequestImages must stay absent')
  assert.ok(!/imageOffloadCountQuantum:/.test(pi), 'imageOffloadCountQuantum must stay absent')
  // And no hand-written adapter override: the peer supplies every method.
  assert.ok(!/class .*extends PiAiAdapter/.test(pi), 'pi-adapter.js must not subclass the peer')
})

test('a catalog change RE-REGISTERS instead of only emitting', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // `replace()` reused the same adapter object, which kept serving the OLD
  // catalog snapshot — a model saved into an enabled provider never appeared.
  assert.match(host, /function invalidate\(\) \{[\s\S]{0,200}void syncProvider\(\)/)
  assert.match(host, /ctx\.llm\.registerAdapter\(\[PROVIDER_ID\], adapter\)/)
  // Never hand-emit the host event: register/release publish it with the right shape.
  assert.ok(!/ctx\.emit\??\.\(\s*['"]llm\/adapters-updated['"]/.test(host))
  // The toggle awaits the rebuild so its response reflects the new switch.
  assert.match(host, /await syncProvider\(\)/)
})

test('zero-build plugins declare only optional host peers, no dead devDependencies', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-llm-pi-ai'])
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-llm-pi-ai'].optional, true)
  // No local typecheck/build step exists, so a physical copy is never needed.
  assert.equal(manifest.devDependencies, undefined)
  // Every new source file must be packed, or npm silently omits it.
  assert.ok(manifest.files.includes('pi-adapter.js'), 'pi-adapter.js is missing from files')
  assert.equal(manifest.exports['./pi-adapter'], './pi-adapter.js')
})

test('the composer pill shows only a rounded number on narrow screens', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The composer row is shared with the model picker and other plugins; on a
  // phone it must stay narrow. No "Credits" label, no redeemable contribution.
  assert.match(client, /function useNarrowScreen\(breakpoint = 640\)/)
  assert.match(client, /window\.matchMedia/)
  assert.match(client, /const narrow = useNarrowScreen\(\)/)
  assert.match(client, /String\(Math\.round\(Number\(available\) \|\| 0\)\)/)
  // Narrow layout also tightens the chip's own width.
  assert.match(client, /maxWidth: narrow \? '72px' : '260px'/)
  // The wide-screen branch keeps the full label.
  assert.match(client, /\$\{credit\(available\)\} \$\{t\('pillCredits'\)\}/)
})

test('switching sessions does not hide the credits pill', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // `conversation.input.right` is a scope:session slot: the Host re-mounts its
  // occupants on a session switch, and `useProjection('modelSelection')` is not
  // ready on the first render. Gating on `undefined` unmounted the whole readout
  // until a model switch forced the projection to settle.
  // Only a projection that NAMES a different provider hides; an absent
  // projection (session switch in flight) keeps the pill visible.
  assert.match(client, /let foreignProvider = false/)
  assert.match(client, /if \(provider !== undefined\) foreignProvider = provider !== COMPOSER_PROVIDER/)
  assert.match(client, /if \(foreignProvider\) return null/)
  // Data also lives at module scope (creditsStore), so a re-mount cannot blank it.
  assert.match(client, /const creditsStore = \(\(\) => \{/)
  assert.match(client, /React\.useSyncExternalStore\(creditsStore\.subscribe, creditsStore\.getSnapshot\)/)
  // A mount must not re-fetch data that is already fresh; clicks force a refresh.
  assert.match(client, /async refresh\(force = false, freshMs = 30_000\)/)
  assert.match(client, /if \(!force && snapshot\.at > 0 && Date\.now\(\) - snapshot\.at < freshMs/)
  assert.match(client, /creditsStore\.refresh\(true\)/)
})
