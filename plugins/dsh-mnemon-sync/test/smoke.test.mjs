/**
 * Structural regression for the monorepo move.
 *
 * These checks deliberately import only the Host entry and the manifest: the
 * plugin is a zero-build, zero-runtime-dependency package, so "does it still
 * load and does every declared subpath resolve" is the whole build contract.
 * The runtime identity strings (API prefix, archive prefix, settings path,
 * source type id) are asserted here so a well-meaning rename during a future
 * refactor cannot silently make existing archives unrestorable.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

test('package identity and workspace location', () => {
  assert.equal(manifest.name, '@summerscar/dsh-mnemon-sync')
  // The release workflow bumps this version before `pnpm check` runs, so only
  // assert the shape here — pinning a literal would fail every publication.
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(manifest.license, 'SEE LICENSE IN LICENSE')
  assert.equal(manifest.engines.node, '>=22.16')
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.1')
  assert.equal(manifest.dsh.compatibility.dsh, '>=0.2.1-rc.1')
  assert.equal(manifest.repository.url, 'git+https://github.com/summerscar/dsh-plugins.git')
  assert.equal(manifest.repository.directory, 'plugins/dsh-mnemon-sync')
  assert.equal(manifest.bugs.url, 'https://github.com/summerscar/dsh-plugins/issues')
  assert.equal(manifest.homepage, 'https://summerscar.github.io/dsh-plugins/plugins/mnemon-sync/')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
})

test('every declared export subpath resolves to a real file', async () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const resolved = subpath.includes('*')
      ? join(packageRoot, target.replace('*', 'en'))
      : join(packageRoot, target)
    assert.ok(existsSync(resolved), `${subpath} -> ${target} is missing`)
  }
  // The Host entry must remain importable on its own.
  const host = await import(new URL('../index.js', import.meta.url))
  assert.equal(host.name, 'dsh-mnemon-sync')
  assert.ok(Array.isArray(host.inject) && host.inject.includes('webServer'))
  assert.equal(typeof host.apply, 'function')
})

test('every packed file exists', () => {
  for (const entry of manifest.files) {
    if (entry.includes('*')) continue // glob: check the directory instead
    assert.ok(existsSync(join(packageRoot, entry)), `packed file missing: ${entry}`)
  }
  assert.ok(existsSync(join(packageRoot, 'assets')))
  assert.ok(existsSync(join(packageRoot, 'locale')))
  assert.ok(existsSync(join(packageRoot, 'docs')))
})

test('runtime identity strings are unchanged', () => {
  // These strings are baked into existing archives, saved settings and the
  // dsh-mnemon page catalog. Changing any of them breaks restore/config/tabs.
  const index = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const source = readFileSync(join(packageRoot, 'source.js'), 'utf8')
  const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.match(index, /const API_PREFIX = '\/api\/mnemon-sync'/)
  assert.match(index, /const ARCHIVE_PREFIX = 'mnemon-sync-'/)
  assert.match(index, /mnemon-sync-work/)
  assert.match(index, /'mnemon-sync-snapshot'/)
  assert.match(index, /mnemon-sync\.json|settingsPath/)
  assert.equal(source.includes("SYNC_PACKAGE_NAME = '@summerscar/dsh-mnemon-sync'"), true)
  assert.equal(source.includes("SYNC_SOURCE_TYPE_ID = 'mnemon-sync'"), true)
  assert.equal(client.includes("id: '@summerscar/dsh-mnemon-sync'"), true)
  assert.equal(client.includes("const NS = 'mnemon-sync'"), true)
  const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch.includes("name: '@summerscar/dsh-mnemon-sync'"), true)
  assert.equal(patch.includes("name: '@summerscar/dsh-mnemon-sync/source'"), true)
})

test('pure helpers keep their documented behaviour', async () => {
  const host = await import(new URL('../index.js', import.meta.url))
  assert.equal(host.resolveDataRoot({ dataRoot: '/tmp/custom' }), '/tmp/custom')
  assert.equal(host.archiveKey(new Date('2026-11-09T01:20:27.875Z'), 'my-device'),
    'mnemon-sync-my-device-2026-11-09T01-20-27.875Z.zip')
  assert.match(host.deviceName('/tmp/definitely-not-a-mnemon-home'), /^[^\s/]+$/)
})

test('the default data root follows the OS home, not an unset HOME', async () => {
  // Windows defines USERPROFILE and leaves HOME unset. Reading HOME there used
  // to produce the *relative* path `.mnemon`, which resolve() then anchored at
  // the desktop app's working directory (<DSH_HOME>/profiles/desktop) — a
  // folder that never holds memory. The default must stay anchored at the OS
  // home directory on every platform.
  const host = await import(new URL('../index.js', import.meta.url))
  const savedHome = process.env.HOME
  const savedMnem = process.env.MNEMON_DATA_DIR
  try {
    delete process.env.HOME
    delete process.env.MNEMON_DATA_DIR
    assert.equal(host.resolveDataRoot({}), join(homedir(), '.mnemon', 'data'))
    assert.ok(isAbsolute(host.resolveDataRoot({})), 'default data root must be absolute')

    // `~/…` is the one shorthand dsh-mnemon expands, so it must expand here too.
    process.env.MNEMON_DATA_DIR = join('~', 'custom-mnemon')
    assert.equal(host.resolveDataRoot({}), join(homedir(), 'custom-mnemon', 'data'))

    // An absolute override is used as-is, and an explicit dataRoot wins outright.
    process.env.MNEMON_DATA_DIR = '/srv/mnemon'
    assert.equal(host.resolveDataRoot({}), '/srv/mnemon/data')
    assert.equal(host.resolveDataRoot({ dataRoot: '/tmp/explicit' }), '/tmp/explicit')
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedMnem === undefined) delete process.env.MNEMON_DATA_DIR
    else process.env.MNEMON_DATA_DIR = savedMnem
  }
})

test('an empty override follows the Host, a set one wins', async () => {
  // The page persists a custom Mnemon home because dsh-mnemon's real root can
  // be workspace/custom/workspaces and a third-party Source only ever receives
  // `{}` as configuration. Blank must mean "follow the Host" rather than pin
  // whatever this process resolved, or a later MNEMON_DATA_DIR change goes stale.
  const host = await import(new URL('../index.js', import.meta.url))
  const savedMnem = process.env.MNEMON_DATA_DIR
  try {
    process.env.MNEMON_DATA_DIR = '/srv/host-mnemon'
    assert.equal(host.resolveHome({}), '/srv/host-mnemon')

    // Blank, whitespace-only and missing all defer to the Host.
    for (const override of ['', '   ', undefined, null, 42]) {
      assert.equal(host.resolveEffectiveHome(override, {}), '/srv/host-mnemon')
    }

    // A real value wins, and `~` expands the same way the Host's rule does.
    assert.equal(host.resolveEffectiveHome('/data/other-mnemon', {}), '/data/other-mnemon')
    assert.equal(host.resolveEffectiveHome(join('~', 'workspace-mnemon'), {}),
      join(homedir(), 'workspace-mnemon'))
    assert.equal(host.resolveEffectiveHome('  /padded  ', {}), '/padded')
  } finally {
    if (savedMnem === undefined) delete process.env.MNEMON_DATA_DIR
    else process.env.MNEMON_DATA_DIR = savedMnem
  }
})

test('settings keep the override optional and the state root fixed', async () => {
  // `mnemonHome` is stored next to the target, so it must round-trip through
  // normalization untouched -- including collapsing blanks to '' -- and it must
  // never move the settings file itself, which lives under the Host home.
  const { normalizeSettings, readSettings, DEFAULT_SETTINGS } = await import(new URL('../store.js', import.meta.url))
  assert.equal(DEFAULT_SETTINGS.mnemonHome, '', 'the default must defer to the Host')
  assert.equal(normalizeSettings({}).mnemonHome, '')
  assert.equal(normalizeSettings({ mnemonHome: '  /x/y  ' }).mnemonHome, '/x/y')
  assert.equal(normalizeSettings({ mnemonHome: null }).mnemonHome, '')
  // Existing saved settings predate this field and must keep loading.
  assert.equal(readSettings('/tmp/definitely-not-a-mnemon-home').mnemonHome, '')
})

test('locale dictionaries and screenshots exist and are valid JSON', () => {
  for (const lang of ['en', 'zh']) {
    const dict = JSON.parse(readFileSync(join(packageRoot, 'locale', `${lang}.json`), 'utf8'))
    assert.equal(typeof dict.meta.title, 'string')
    assert.equal(typeof dict.meta.description, 'string')
  }
  const shots = JSON.parse(readFileSync(join(packageRoot, 'screenshots.json'), 'utf8'))
  assert.ok(Array.isArray(shots) && shots.length >= 1 && shots.length <= 8)
  for (const shot of shots) assert.ok(existsSync(join(packageRoot, shot)), `screenshot missing: ${shot}`)
})
