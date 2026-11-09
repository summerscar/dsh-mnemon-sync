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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

test('package identity and workspace location', () => {
  assert.equal(manifest.name, '@summerscar/dsh-mnemon-sync')
  assert.equal(manifest.version, '0.1.11')
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
