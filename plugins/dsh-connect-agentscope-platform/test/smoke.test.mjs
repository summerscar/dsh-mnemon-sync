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
    // The Host's `connection` service gates the HTTP mount before dispatch.
    // A Host that admits is what a real deployment runs; fail-closed is
    // asserted structurally here and exercised in measurements.test.mjs.
    get: name => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
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

test('a refresh token alone makes the account API usable', async t => {
  const { CreditEngine } = await import(new URL('../as.js', import.meta.url))
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(`${tmpdir()}/asp-smoke-`)
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
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
  assert.match(client, /if \(foreignProvider\) return null/)
  // A projection that is PRESENT but names nothing is a brand-new session, not a
  // re-mount artefact: it resolves through the deployment default, which is what
  // the picker shows. Reading it as "not ready" kept an AgentScope balance under
  // another provider's session — the exact defect this gate exists to prevent.
  assert.match(client, /const defaultProvider = React\.useSyncExternalStore\(/)
  assert.match(client, /const effective = provider !== undefined/)
  assert.match(client, /\? defaultProvider\s*\n?\s*: undefined/)
  assert.match(client, /if \(effective !== undefined\) foreignProvider = effective !== COMPOSER_PROVIDER/)
  // The registration goes through the gate, never the bare readout.
  assert.match(client, /\}, ComposerCreditsGate\)\)/)
  assert.ok(!/\}, ComposerCredits\)\)/.test(client), 'the ungated readout is registered directly')
})

test('the deployment default provider is asked for, not guessed', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // The browser cannot read `agentDefaultModel`; it must come from the Host over
  // the plugin's own prefix, behind the same auth gate as every other route.
  assert.match(host, /if \(sub === '\/provider\/default' && method === 'GET'\) \{/)
  assert.match(host, /sendJson\(res, 200, \{ provider: defaultProvider\(\) \}\)/)
  assert.match(host, /function defaultProvider\(\) \{/)
  assert.match(host, /ctx\.get\('agentDefaultModel'\)/)
  assert.match(host, /currentSelection\?\.\(\)/)
  // A Host without that service answers `''` rather than throwing into a request.
  assert.match(host, /catch \{\s*\n\s*return ''\s*\n\s*\}/)
  // Cached briefly, not forever: the default is editable in settings, and a
  // stale route would gate a fresh session on the wrong provider.
  assert.match(client, /const defaultProviderStore = \(\(\) => \{/)
  assert.match(client, /const FRESH_MS = 60_000/)
  assert.match(client, /if \(provider !== undefined && Date\.now\(\) - at < FRESH_MS\) return Promise\.resolve\(provider\)/)
  assert.match(client, /inflight \?\?= api\('\/provider\/default'\)/)
  assert.match(client, /\.catch\(\(\) => \{ provider = ''; at = Date\.now\(\); return provider \}\)/)
  // Only a new-session projection (present, naming nothing) triggers the fetch.
  assert.match(client, /if \(projection === undefined \|\| provider !== undefined\) return/)
  assert.match(client, /void defaultProviderStore\.load\(\)/)
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

test('every timestamp in the panel is stated in ONE zone', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The platform returns Beijing wall-clock strings with NO offset; new Date()
  // would parse them as the browser's own zone, which is wrong off UTC+8.
  assert.match(client, /function localTime\(raw\)/)
  assert.match(client, /\+08:00/)
  assert.match(client, /localTime\(item\.created_at\)/)
  assert.ok(!/item\.created_at \?\? '—'/.test(client), 'the raw wall-clock string is still rendered')

  // ...and the zone is FIXED, not the viewer's. This panel sits next to a
  // check-in block whose day boundary is Asia/Shanghai; formatting the stamps
  // beside it in the browser's zone made the panel contradict itself (a UTC+9
  // browser showed "today 2026-11-14" next to a 01:04 that Shanghai recorded
  // as 00:04). Both formatters now read one constant.
  assert.match(client, /const PANEL_ZONE = 'Asia\/Shanghai'/)
  assert.match(client, /timeZone: PANEL_ZONE/)
  const undefinedLocale = /Intl\.DateTimeFormat\(undefined/.test(client)
  assert.ok(!undefinedLocale, 'a formatter still follows the browser locale/zone')
  // No formatter may fall back to the machine's own clock.
  const usesGetHours = /pad\(date\.getHours\(\)\)/.test(client)
  assert.ok(!usesGetHours, 'a timestamp is formatted from the machine clock')
  // A fixed zone is labelled, so a viewer elsewhere does not read it as theirs.
  assert.match(client, /function stampZoneLabel\(\)/)
  assert.match(client, /stampZoneLabel\(\)/)
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
  for (const key of ['refreshTokenHowTo']) {
    assert.equal((client.match(new RegExp(`\\n      ${key}:`, 'g')) || []).length, 2, `${key} must exist in both dictionaries`)
  }
  // It has to be rendered: a dictionary entry nobody shows is dead weight. Both
  // live in the pool row's editor now that the separate credentials section is
  // gone — one account, one place to edit it.
  assert.match(client, /h\('code', \{[\s\S]{0,400}safeT\(t, 'refreshTokenSnippet'\)/)
  assert.match(client, /h\('span', \{ key: 'r', style: S\.kvKey \},\s*\n\s*`\$\{safeT\(t, 'accountLastRefreshed'\)\}/)
  // The "last refreshed" stamp per account, in both dictionaries.
  assert.equal((client.match(/\n      accountLastRefreshed:/g) || []).length, 2, 'accountLastRefreshed must exist in both dictionaries')

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

test('the pi-ai profile carries the image budgets the peer requires', async t => {
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
  // The workspace deliberately does NOT install host peers (pnpm-workspace.yaml
  // sets autoInstallPeers: false), so this half runs only where they resolve —
  // a DSH profile or a machine that installed them. The structural half below
  // is the part CI always gets, and it covers the failure that actually shipped:
  // a missing budget field.
  let buildAgentScopeAdapter
  try {
    ({ buildAgentScopeAdapter } = await import(new URL('../pi-adapter.js', import.meta.url)))
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    t.skip('@deepseek-ai/dsh-llm-pi-ai is not installed in this workspace')
    return
  }
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
  // Only a KNOWN provider decides; an absent projection (session switch in
  // flight) keeps the pill visible.
  assert.match(client, /let foreignProvider = false/)
  assert.match(client, /if \(effective !== undefined\) foreignProvider = effective !== COMPOSER_PROVIDER/)
  assert.match(client, /if \(foreignProvider\) return null/)
  // Data also lives at module scope (creditsStore), so a re-mount cannot blank it.
  assert.match(client, /const creditsStore = \(\(\) => \{/)
  assert.match(client, /React\.useSyncExternalStore\(creditsStore\.subscribe, creditsStore\.getSnapshot\)/)
  // A mount must not re-fetch data that is already fresh; clicks force a refresh.
  assert.match(client, /async refresh\(force = false, freshMs = 30_000\)/)
  assert.match(client, /if \(!force && snapshot\.at > 0 && Date\.now\(\) - snapshot\.at < freshMs/)
  assert.match(client, /creditsStore\.refresh\(true\)/)
})

// ---------------------------------------------------------------------------
// Account pool (multi-account) — structural nails, not red/green drivers.
//
// The behavioural half of the pool lives in test/measurements.test.mjs, where
// each seam was driven red before it was implemented. What belongs HERE is the
// set of things that must never drift: the frozen contract strings, the shape
// the browser half hard-codes, and the single decision (a live `apiKey` getter
// instead of re-registering the provider) that the whole switching story rests
// on. A well-meaning "fix" to any of them breaks a running install silently.
// ---------------------------------------------------------------------------

test('the pool adds three fields to /state and keeps every old one', async () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // The three fields the browser half reads off the aggregate state.
  assert.match(host, /\baccounts,/)
  assert.match(host, /\bactiveAccountId:/)
  assert.match(host, /\bpool: \{ autoSwitch:/)
  // Every field an earlier release served must still be present, BY NAME. The
  // count is deliberately NOT asserted: TDD-SEAMS §0 #4 found the plan's "9
  // groups" was a miscount of the eight keys the source actually returned, so a
  // literal count would fail for the wrong reason the moment a field is added.
  // Matched as `key:` OR as a shorthand property (`settingsNs,`), because
  // `settingsNs` is the one field the aggregate state passes by bare name.
  for (const key of ['build', 'provider', 'modelKey', 'catalog', 'meta', 'checkin', 'credits', 'settingsNs']) {
    assert.ok(new RegExp(`\\b${key}(?::|,)`).test(host), `fullState lost the ${key} field`)
  }
  // The build stamp moves forward with this release; the shape is what matters.
  assert.match(host, /const BUILD = 'asp-2026-11-12\.8'/)
})

test('switching an account does not re-register the provider', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // THE decision that makes switching free: the adapter holds a GETTER, so a new
  // request picks up the new key on its own. Re-registering instead would drop
  // the in-flight streams of every session, and it is the tempting "fix" when a
  // switched-to account appears not to be used.
  assert.match(host, /apiKey: \(\) => accountPool\.active\(\)\?\.modelKey\.key/,
    'the apiKey getter must read the ACTIVE account at call time')
  // The getter is the only way a key reaches the adapter.
  assert.ok(!/apiKey: \(\) => modelKey\.key/.test(host),
    'a stale closure over the single-account model key came back')
  // Discovery reads the same live key, not a captured copy.
  assert.match(host, /accountPool\.active\(\)/)
})

test('the pool endpoints sit behind the one auth gate', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // The gate sits at the MOUNT, not inside `handle()`: a request that fails it
  // never reaches routing, so a new endpoint cannot forget to call it. An
  // endpoint mounted on its own route would bypass it.
  assert.match(host, /handler: \(req, res\) => \{\s*\n\s*if \(rejected\(req, res\)\) return/,
    'the HTTP mount must reject before dispatch')
  // FAIL-CLOSED. A missing Host service is not permission to serve: the old
  // gate was passed as `undefined` in that case and the guard inside `handle()`
  // skipped itself, admitting the request. These routes read credentials and
  // reset the model key, so "no guard available" must mean 401.
  assert.ok(!/checkAuth/.test(host), 'the optional-gate plumbing came back')
  assert.match(host, /const rejected = \(req, res\) => \{/, 'the gate builder moved; re-anchor this nail')
  const gate = /const rejected = \(req, res\) => \{[\s\S]{0,1200}?\n  \}/.exec(host)
  assert.ok(gate !== null, 'the gate body moved; re-anchor this nail')
  assert.match(gate[0], /connection === undefined \|\| connection === null[\s\S]{0,120}?401/,
    'a missing connection service must answer 401')
  assert.match(gate[0], /requestRejection/, 'the current Host contract must be used')
  assert.match(gate[0], /authorizeIndex/, 'older Hosts exposing only authorizeIndex must still work')
  // Two distinct 401 exits: the missing service, and the neither-hook fallthrough.
  assert.equal((gate[0].match(/res\.statusCode = 401/g) ?? []).length, 2,
    'both "no Host service" and "no usable hook" must answer 401')
  for (const route of [
    "sub === '/accounts' && method === 'GET'",
    "sub === '/accounts' && method === 'POST'",
    "sub === '/accounts/remove'",
    "sub === '/accounts/rename'",
    "sub === '/accounts/enable'",
    "sub === '/accounts/switch'",
    "sub === '/accounts/test'",
    "sub === '/accounts/auto-switch'",
  ]) {
    assert.ok(host.includes(route), `missing pool endpoint: ${route}`)
  }
  // A second mount point would be a second place to forget the gate.
  const mounts = [...host.matchAll(/webServer\.register\(/g)]
  assert.equal(mounts.length, 1, 'the plugin must mount exactly one HTTP route')
})

test('an account projection never carries a credential', () => {
  const runtime = readFileSync(join(packageRoot, 'account-runtime.js'), 'utf8')
  // The browser half renders `list()`. A projection that leaked a token would
  // ship it to every open tab and into any screenshot of the panel.
  const projection = /projectAccount|function projectionOf|list\(\) \{[\s\S]{0,1400}?\n  \}/.exec(runtime)
  assert.ok(projection !== null, 'the projection builder moved; re-anchor this nail')
  for (const secret of ['refreshToken', 'accessToken']) {
    assert.ok(!new RegExp(`\\b${secret}\\b\\s*:`).test(projection[0]),
      `the projection exposes ${secret}`)
  }
})

test('the pool is torn down with the plugin, timers included', () => {
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // A hot reload that leaves a scheduler armed gives the user two schedulers,
  // two check-ins and two sets of notifications for one account.
  assert.match(host, /accountPool\.(dispose|stop)\(\)/)
})

test('the new modules are declared for packing and for import', () => {
  // Both must be listed or `npm pack` drops them from the published tarball, and
  // a subpath export that resolves to nothing breaks a consumer's import.
  assert.equal(manifest.exports['./measurements'], './measurements.js')
  assert.equal(manifest.exports['./account-runtime'], './account-runtime.js')
  assert.ok(manifest.files.includes('measurements.js'))
  assert.ok(manifest.files.includes('account-runtime.js'))
})

test('the pool wording reaches every surface that advertises the plugin', () => {
  // One summary changed means all of them change: the package description, the
  // market summary in both languages, and both READMEs. A surface left on the
  // old "one account" story contradicts the panel the user then opens.
  assert.match(manifest.description, /accounts/i)
  assert.match(manifest.dsh.catalog.summary.en, /accounts/i)
  assert.match(manifest.dsh.catalog.summary.zh, /账号/)
  const en = readFileSync(join(packageRoot, 'README.md'), 'utf8')
  const zh = readFileSync(join(packageRoot, 'docs/README.zh-CN.md'), 'utf8')
  assert.ok(!en.includes('One account per installation'), 'the English README still says one account')
  assert.ok(!zh.includes('一台机器一个账户'), 'the Chinese README still says one account')
  // The stated limit is the ADR's consequence: switching is not failover.
  assert.match(en, /new requests/i)
  assert.match(zh, /新发起|新请求/)
})

test('the long tail of the panel is collapsed, the daily surface is not', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // Measured before this change: the page was 3594 px against a 485 px viewport,
  // and the usage table alone was 1848 px of it — half the panel was a screen
  // most people open once a month. Sections that are set up once are collapsed
  // by default; the two a visit actually needs are not.
  assert.match(client, /function Section\(props\)/, 'Section lost its definition')
  assert.match(client, /const \{ collapsible = false, defaultOpen = true, summary = null \} = props/)
  assert.match(client, /const \[open, setOpen\] = React\.useState\(defaultOpen\)/)
  // A real disclosure control, not a clickable div.
  assert.match(client, /'aria-expanded': showing/)
  // Every collapsed section keeps a summary line, or collapsing would just hide
  // information behind a click with no way to tell what is inside.
  for (const key of ['catalogSummary', 'checkinSummary', 'usageSummary', 'pricingSummary']) {
    assert.match(client, new RegExp(`${key}:`), `${key} is missing from a dictionary`)
  }
  // The four one-off sections are the ones that collapse.
  for (const key of ['catalog', 'checkin', 'usage', 'pricing']) {
    const block = new RegExp(`key: '${key}',[\\s\\S]{0,400}?defaultOpen: false`)
    assert.match(client, block, `${key} should start collapsed`)
  }
  // The composer-adjacent surfaces — who pays, and how much is left — stay open.
  //
  // Anchored on the section's own `key:` and the NEXT section's, not on a fixed
  // character window: an explanatory comment above `children` used to be enough
  // to push the match out of range and fail a correct file.
  const sectionBody = key => {
    const start = client.indexOf(`key: '${key}',`)
    assert.ok(start >= 0, `section ${key} moved`)
    const end = client.indexOf('h(Section, {', start)
    return client.slice(start, end < 0 ? start + 1200 : end)
  }
  for (const key of ['accounts', 'credits']) {
    const body = sectionBody(key)
    assert.ok(!/defaultOpen: false/.test(body), `${key} must stay expanded`)
  }
})

test('an inert save chip says why instead of looking broken', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // Reported as "I clicked it and nothing happened". Both key saves are disabled
  // until something is typed — correct — but a disabled chip with no explanation
  // and no visual difference reads as a dead feature.
  assert.match(client, /title: editToken\.trim\(\) === '' \? safeT\(t, 'tokenPasteFirst'\) : safeT\(t, 'save'\)/)
  assert.match(client, /title: editModelKey\.trim\(\) === '' \? safeT\(t, 'modelKeyPasteFirst'\) : safeT\(t, 'save'\)/)
  // The reason is also stated in place, not only behind a hover.
  assert.match(client, /key: 'saveHint', style: S\.hint/)
  for (const key of ['tokenPasteFirst', 'modelKeyPasteFirst', 'tokenHowToToggle']) {
    const count = (client.match(new RegExp(`${key}:`, 'g')) || []).length
    assert.ok(count >= 2, `${key} is missing from one of the dictionaries`)
  }
  // The console recipe is a one-time read; leaving it expanded pushed the actual
  // controls below the fold inside an already tall edit panel.
  assert.match(client, /h\('details', \{ key: 'howto' \}/)
  assert.match(client, /h\('summary', \{ key: 's', style: S\.detailsSummary \}/)
})

test('every text style states its size instead of inheriting one', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // Reported as "the text in the model provider block is inconsistently
  // sized". Cause: `kvVal` carried only a colour, so a value beside a 12px label
  // rendered at the browser default; only the rows that happened to add an
  // inline `fontSize` looked right. The scale is now declared once.
  const block = /const S = \{([\s\S]*?)\n    \}/.exec(client)
  assert.ok(block !== null, 'the style object moved; re-anchor this nail')
  for (const key of ['kvVal', 'kvMono', 'kv', 'label', 'hint', 'sectionTitle', 'input', 'button']) {
    const entry = new RegExp(`${key}: \\{[^}]*fontSize`).exec(block[1])
    assert.ok(entry !== null, `S.${key} does not state a fontSize`)
  }
  // One monospace style for values; no row may patch a size onto S.mono again.
  assert.match(client, /kvMono: \{ fontFamily: 'ui-monospace/)
  const inlineMonoSize = (client.match(/\.\.\.S\.mono, fontSize/g) || []).length
  assert.equal(inlineMonoSize, 0, `an inline mono font size came back (${inlineMonoSize} sites)`)
})

test('the paying account row is distinguishable before reading it', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // Every row used to be drawn identically; the only cue that one of them pays
  // for new requests was a small "Current" word inside it.
  assert.match(client, /const isCurrent = account\.active === true/)
  assert.match(client, /style: isCurrent \? \{ \.\.\.rowStyle, \.\.\.S\.rowCurrent \} : rowStyle/)
  assert.match(client, /rowCurrent: \{/)
  assert.match(client, /borderLeft: '3px solid var\(--dsw-alias-accent-primary, #1F6FEB\)'/)
  // A rule that stops at the buttons reads as a clipped tick: the row needs a
  // bottom edge of its own, because the section supplies none.
  assert.match(client, /paddingBottom: '8px'/)
  // The header badge must not restate the current account (the picker below and
  // the highlighted row both already say it). It answers the other question.
  assert.match(client, /accountCount: '\{count\} 个账号'/)
  assert.match(client, /safeFill\(t, 'accountCount', \{ count: accounts\.length \}\)/)
  assert.ok(!/actions: \[h\('span', \{ key: 'p', style: S\.pill\(activeAccountId === ''/.test(client),
    'the section header still repeats the current account name')
})

test('the page header says what it is and links to the platform', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const zh = JSON.parse(readFileSync(join(packageRoot, 'locale/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(packageRoot, 'locale/en.json'), 'utf8'))
  // A section that opens on seven control groups with no sentence of context
  // makes the reader reverse-engineer its purpose from the controls.
  assert.match(client, /pageLead:/)
  assert.match(client, /h\('p', \{ key: 'lead', style: S\.sub \}, t\('pageLead'\)\)/)
  // The platform the account actually lives on, reachable from the header.
  assert.match(client, /const PLATFORM_URL = 'https:\/\/platform\.agentscope\.io\/'/)
  assert.match(client, /href: PLATFORM_URL/)
  // A settings panel sits inside a modal: the link must not replace it.
  assert.match(client, /target: '_blank'/)
  assert.match(client, /rel: 'noreferrer noopener'/)
  assert.match(client, /platformLink: 'platform\.agentscope\.io'/)
  // The catalogue description must name what the plugin actually does, in both
  // languages, instead of a generic "integrates with".
  for (const meta of [zh.meta, en.meta]) {
    assert.ok(typeof meta.description === 'string' && meta.description.length > 80,
      'the module description lost its detail')
    assert.match(meta.description, /Credits/, 'the description omits the credits readout')
    assert.match(meta.description, /catalog|模型目录/i, 'the description omits the model catalogue')
  }
})

test('a configured key shows its head and tail, not a blank box', async () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The edit panel used to be an empty password input with no statement about
  // what was already stored: a user could not tell a configured key from a
  // missing one, nor one key from another. The host answers every row with its
  // OWN `modelKey` projection, and the panel prints that row's mask.
  assert.match(client, /key: 'now', style: \{ \.\.\.S\.kv, justifyContent: 'flex-start', gap: '8px' \}/)
  // Monospace values now come from one shared style (S.kvMono) rather than an
  // inline `...S.mono, fontSize` patch per row.
  assert.match(client, /rowKey\.configured\s*\n?\s*\? h\('span', \{ key: 'v', style: S\.kvMono \}/)
  // PER ROW, never the billing account's: `state.modelKey` describes one
  // account, so rendering the list from it showed that account's mask in every
  // row and made an unconfigured row look configured.
  assert.match(client, /const rowKey = account\.modelKey \?\?/)
  assert.ok(!/modelKeyConfigured/.test(client), 'the install-wide modelKey props came back')
  // The route that produced the stored key is named, not guessed.
  assert.match(client, /function modelKeySourceLabel\(t, source\)/)
  assert.match(client, /if \(source === 'pasted'\) return safeT\(t, 'modelKeySourcePasted'\)/)
  assert.match(client, /if \(source === 'fetched'\) return safeT\(t, 'modelKeySourceFetched'\)/)
  // The mask itself keeps a recognisable head and tail; a secret must never be
  // rendered in full by either half.
  const { maskSecret } = await import(new URL('../as.js', import.meta.url))
  const masked = maskSecret('sk-as-NL0123456789abcdefghijklmnopqrstuvwxyz3Dy8')
  assert.ok(masked.startsWith('sk-as-NL'), `mask lost its head: ${masked}`)
  assert.ok(masked.endsWith('3Dy8 (len 48)'), `mask lost its tail: ${masked}`)
  assert.ok(!masked.includes('0123456789abcdefghijklmnopqrstuvwxyz'), 'the middle of the key leaked')
})

test('the destructive account action is separated from the routine ones', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // Five same-weight chips in a row put "Remove" one slip away from "Probe".
  // The destructive pair is pushed to the far end and coloured, and the variant
  // merge keeps a caller's style from replacing the whole button.
  assert.match(client, /h\('span', \{ key: 'gap', 'aria-hidden': 'true', style: \{ flex: '1 1 auto' \} \}\)/)
  assert.match(client, /buttonDanger: \{ border: '1px solid var\(--dsw-alias-border-l2\)', color: 'var\(--dsw-alias-state-error-primary\)' \}/)
  const dangerUses = (client.match(/style: S\.buttonDanger/g) || []).length
  assert.ok(dangerUses >= 2, `expected the remove chip in both states, found ${dangerUses}`)
  // `Button` merges style now; spreading `rest` last used to REPLACE the variant.
  assert.match(client, /const merged = style === undefined \? base : \{ \.\.\.base, \.\.\.style \}/)
  // A disabled chip must LOOK disabled: it used to be pixel-identical to an
  // enabled one, and every "this button does nothing" report started there.
  assert.match(client, /disabled === true \? \{ \.\.\.merged, opacity: 0\.5, cursor: 'not-allowed' \} : merged/)
})

test('the account pool UI keeps the composer readout untouched', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The pool section is additive. The composer pill is shared with every other
  // provider and keeps its own gate, store and narrow-screen rule.
  assert.match(client, /function AccountPoolSection\(/)
  assert.match(client, /const COMPOSER_PROVIDER = 'agentscope'/)
  assert.match(client, /const creditsStore = \(\(\) => \{/)
  // The auto-switch copy must state the limit instead of implying failover.
  assert.ok(!/自动故障切换/.test(client), 'the UI promises failover, which ADR 0001 rules out')
  assert.match(client, /accountAutoSwitchHint/)
  // The Chinese and English dictionaries stay the same size and the same keys.
  const zhBlock = /const zh = \{([\s\S]*?)\n    \}/.exec(client)
  const enBlock = /const en = \{([\s\S]*?)\n    \}/.exec(client)
  assert.ok(zhBlock !== null && enBlock !== null, 'the inline dictionaries moved; re-anchor this nail')
  const keysOf = block => [...block.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map(m => m[1]).sort()
  assert.deepEqual(keysOf(zhBlock[1]), keysOf(enBlock[1]), 'the two dictionaries diverged')
})

test('every credit reading on screen comes from ONE measurement', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // The pill, the credits section and the account row all describe the BILLING
  // account. They disagreed before because the pill read the platform live while
  // the row showed whatever the last probe recorded.
  // (a) Host: the pill's route goes THROUGH the pool's probe, so the read that
  //     renders the balance is also the read that records it.
  assert.match(host, /const measured = await accountPool\.probe\(accountId\)/)
  assert.ok(!/await runtime\.engine\.quickCredits\(\)[\s\S]{0,200}accountLabel/.test(host),
    'the pill went back to reading the engine directly, which writes no measurement')
  // (b) Host: the reported instant is the record's own, not a second clock read.
  assert.match(host, /const at = new Date\(measured\.probe\?\.atMs \?\? Date\.now\(\)\)\.toISOString\(\)/)
  // (c) Client: a new shared reading re-reads the aggregate state, so the account
  //     rows follow the pill instead of waiting for the panel to be reopened.
  assert.match(client, /const creditsAt = sharedCredits\.at/)
  assert.match(client, /if \(creditsAt === 0\) return\n\s*void load\(\)/)
  // (d) Client: a switch invalidates every reading — the cache belonged to the
  //     previous account, and the check-in block does not ride the pool answer.
  assert.match(client, /const switching = typeof answer\.activeAccountId === 'string'/)
  assert.match(client, /if \(switching\) \{/)
  assert.match(client, /void load\(\)\n\s*void creditsStore\.refresh\(true\)/)
})

test('credentials are edited inside the account row, not in a second section', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // One account, one place to edit it. A separate "Credentials and model key"
  // section edited whichever account the view picker pointed at, which made two
  // controls for one file and two ways for them to disagree — the panel now has
  // exactly one editor, and it belongs to the row you opened.
  assert.ok(!/sectionCredentials/.test(client), 'the separate credentials section came back')
  assert.ok(!/key: 'cred'/.test(client), 'the credentials section is still mounted')
  // No second notion of "the current account": the billed-to account is the one
  // every section reads, so there is nothing to reconcile.
  assert.ok(!/accountViewLabel|accountViewMismatch|viewedAccountId|accountIdForView/.test(client),
    'the viewed-account concept came back')
  assert.ok(!/key: 'view'/.test(client), 'the viewed-account picker is still mounted')
  // The per-row editor carries the credentials, keyed by the row's own id.
  for (const id of ['asp-account-edit-', 'asp-account-token-', 'asp-account-key-fetch-', 'asp-account-interval-']) {
    assert.ok(client.includes(id), `the row editor lost ${id}`)
  }
  // Every credential field still opts out of the password manager.
  const newPassword = (client.match(/autoComplete: 'new-password'/g) || []).length
  assert.ok(newPassword >= 3, `expected new-password on every secret field, got ${newPassword}`)
})

test('no account is marked as a leftover from an earlier build', () => {
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const host = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const runtime = readFileSync(join(packageRoot, 'account-runtime.js'), 'utf8')
  const measurements = readFileSync(join(packageRoot, 'measurements.js'), 'utf8')
  const paths = readFileSync(join(packageRoot, 'paths.js'), 'utf8')
  // Every account is ordinary: a hash-shaped id with no marker that would make
  // one row look special in the panel. Credentials adopted from an older install
  // are copied into an account directory and then treated like any other.
  for (const [name, source] of [['client.js', client], ['index.js', host], ['account-runtime.js', runtime],
    ['measurements.js', measurements], ['paths.js', paths]]) {
    assert.ok(!/legacy|LEGACY/.test(source), `${name} still carries the legacy concept`)
  }
  assert.ok(!/默认账号/.test(client), 'the panel still names one account as the old default')
  // The adoption path must still exist — dropping the concept must not mean
  // dropping the user's credentials.
  assert.match(measurements, /adoptSingleAccountInstall/)
})
