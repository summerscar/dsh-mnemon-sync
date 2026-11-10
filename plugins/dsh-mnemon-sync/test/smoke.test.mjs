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
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
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

test('archive paths resolve on Windows, where the separator is not "/"', async () => {
  // Regression: containment used to be `destination.startsWith(root + '/')`.
  // ZIP entry names always use '/', but resolve() returns the platform
  // separator, so on Windows that comparison was false for *every* entry and
  // the first file in the archive blocked the whole restore. Checking
  // containment through path.relative keeps it correct on both platforms.
  const { destinationFor } = await import(new URL('../index.js', import.meta.url))
  const home = resolve(tmpdir(), 'mnemon-home')

  // A normal payload file lands exactly where the component directory says.
  assert.equal(destinationFor(home, 'payload/data/default/mnemon.db'),
    resolve(home, 'data', 'default', 'mnemon.db'))
  assert.equal(destinationFor(home, 'payload/documents/index.json'),
    resolve(home, 'documents', 'index.json'))
  assert.equal(destinationFor(home, 'payload/runtime/USER.md'),
    resolve(home, 'runtime', 'USER.md'))

  // The skills data directory is a component of the home, so it restores
  // inside the home like every other one.
  assert.equal(destinationFor(home, 'payload/skills/ledger.json'),
    resolve(home, 'skills', 'ledger.json'))

  // Skill *files* live outside the home, under a root named by kind. Only the
  // two user-level roots are restorable: a project root belongs to a checkout
  // that git already carries, so an archive may not write into one.
  const roots = [
    { kind: 'user-dsh', path: resolve(tmpdir(), 'dsh-home', 'skills') },
    { kind: 'user-agents', path: resolve(tmpdir(), 'agents-home', 'skills') },
  ]
  assert.equal(destinationFor(home, 'payload/skill-files/user-dsh/foo/SKILL.md', roots),
    resolve(roots[0].path, 'foo', 'SKILL.md'))
  assert.equal(destinationFor(home, 'payload/skill-files/user-agents/bar/SKILL.md', roots),
    resolve(roots[1].path, 'bar', 'SKILL.md'))
  assert.equal(destinationFor(home, 'payload/skill-files/project-dsh/foo/SKILL.md', roots), undefined)
  assert.equal(destinationFor(home, 'payload/skill-files/unknown/foo/SKILL.md', roots), undefined)

  // Finder's junk file is a legitimate payload path: the restore must not treat
  // it as an escape. Whether it is written is a separate, higher-level decision.
  assert.notEqual(destinationFor(home, 'payload/data/.DS_Store'), undefined)

  // Escapes and non-component roots stay rejected.
  for (const bad of [
    'payload/data/../state/mnemon-sync.json',
    'payload/data/../../evil.txt',
    'payload/state/mnemon-sync.json',
    'payload/skills/../state/mnemon-sync.json',
    'payload/skill-files/user-dsh/../../etc/passwd',
    'payload/skill-files/user-dsh/..',
    'payload/data',
    'payload/data/',
    'manifest.json',
  ]) {
    assert.equal(destinationFor(home, bad, roots), undefined, `${bad} must be rejected`)
  }
})

test('a build constant lets a reload be observed from the API', async () => {
  // HMR reloads the Host module without restarting the container, so a working
  // page and a 200 from the API both stay true while the old module still runs.
  // The only way to tell "the new code is live" from "the old code happens to
  // answer" is a value only the new source can produce. This asserts one exists
  // and is exposed, so a future refactor cannot quietly drop it.
  const host = await import(new URL('../index.js', import.meta.url))
  assert.equal(typeof host.BUILD, 'string')
  assert.match(host.BUILD, /^mnemon-sync-\d{4}-\d{2}-\d{2}\.\d+$/u)
  const source = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  // Bumping the constant is pointless unless the status route reports it.
  assert.match(source, /build: BUILD/u)
})

test('skill roots are the two user-level ones, never a project root', async () => {
  // Project-level skills (<project>/.dsh/skills, <project>/.agents/skills) are
  // repository files that git already carries. Copying them into a memory
  // backup would duplicate a source of truth that already has one, and a
  // restore could silently overwrite a checkout — so they are out of scope and
  // this test exists to keep them out.
  const { skillRoots, SKILL_ROOT_KINDS, dshHome, agentsHome } =
    await import(new URL('../skills.js', import.meta.url))
  assert.deepEqual(SKILL_ROOT_KINDS, ['user-dsh', 'user-agents'])
  const roots = skillRoots()
  assert.deepEqual(roots.map((root) => root.kind), ['user-dsh', 'user-agents'])
  // Each root is exactly `<home>/skills`, not a guess anchored at the process
  // working directory: a project root would show up here as <cwd>/.dsh/skills.
  assert.equal(roots[0].path, join(dshHome(), 'skills'))
  assert.equal(roots[1].path, join(agentsHome(), 'skills'))
  for (const root of roots) {
    assert.ok(isAbsolute(root.path), 'a skill root must be absolute')
    // A project root would be <cwd>/.dsh/skills; nothing may live under the
    // process working directory, or a backup would depend on where DSH was
    // started from instead of on the user's own layer.
    assert.equal(root.path.startsWith(`${process.cwd()}${sep}`), false,
      'no skill root may be derived from the process working directory')
  }
})

test('an archive is described by what it holds, not by the backup scope', async () => {
  // Regression: the detail panel used to send the current backup scope to
  // /inspect-archive, and the handler filtered the plan by it. Unticking a
  // component in the scope then made a complete archive report that component
  // as missing and refuse to offer it for restore — the zip was fine, only the
  // question was wrong.
  const { planArchive } = await import(new URL('../index.js', import.meta.url))
  const files = new Map([
    ['manifest.json', Buffer.from('{}')],
    ['payload/data/default/mnemon.db', Buffer.from('db')],
    ['payload/documents/index.json', Buffer.from('{}')],
    ['payload/runtime/USER.md', Buffer.from('')],
    ['payload/skills/ledger.json', Buffer.from('{}')],
    ['payload/skill-files/user-dsh/a/SKILL.md', Buffer.from('# a')],
    ['payload/unknown/x.txt', Buffer.from('x')],
  ])
  const plan = planArchive(files)

  // Every component in the archive is described, with no scope involved.
  assert.deepEqual(
    [...new Set(plan.map((entry) => entry.component))].sort(),
    ['documents', 'memory-spaces', 'runtime', 'skill-files', 'skills'],
  )
  // The manifest is metadata, and foreign paths stay out of the plan.
  assert.equal(plan.some((entry) => entry.path === 'manifest.json'), false)
  assert.equal(plan.some((entry) => entry.path.startsWith('payload/unknown/')), false)
  // An empty file still counts: USER.md is legitimately 0 bytes.
  assert.equal(plan.find((entry) => entry.path === 'payload/runtime/USER.md').bytes, 0)
})

test('both skill components start unselected', async () => {
  // A first backup must not quietly carry a machine's skills: restoring a skill
  // component writes into the skill roots, which is a migration, not a routine
  // backup. The original three components stay the default.
  const { normalizeSettings, DEFAULT_SETTINGS } = await import(new URL('../store.js', import.meta.url))
  assert.deepEqual([...DEFAULT_SETTINGS.components], ['memory-spaces', 'documents', 'runtime'])
  assert.equal(normalizeSettings({}).components.includes('skills'), false)
  assert.equal(normalizeSettings({}).components.includes('skill-files'), false)

  // Changing the default must never rewrite a choice someone already saved:
  // a file that names the skill components keeps naming them.
  assert.deepEqual(normalizeSettings({ components: ['skill-files'] }).components, ['skill-files'])
  assert.deepEqual(
    normalizeSettings({ components: ['memory-spaces', 'runtime', 'skills', 'skill-files'] }).components,
    ['memory-spaces', 'runtime', 'skills', 'skill-files'],
  )
})

test('skill files are counted per skill, not per file', async () => {
  const { countSkills } = await import(new URL('../skills.js', import.meta.url))
  // A skill is a folder holding SKILL.md, plus its references; a lone SKILL.md
  // at the root counts as one skill of its own.
  assert.equal(countSkills([
    { relative: 'a/SKILL.md' },
    { relative: 'a/references/x.md' },
    { relative: 'b/SKILL.md' },
    { relative: 'SKILL.md' },
    { relative: 'notes.md' },
  ]), 3)
  assert.equal(countSkills([]), 0)
})

test('OS bookkeeping files never enter an archive and never block a restore', async () => {
  // `.DS_Store`, `Thumbs.db`, `._*` resource forks and editor swap files are
  // not Mnemon data. They are excluded when listing and collecting, so an
  // archive stays portable; archives made before that filter still carry them,
  // and the restore skips them instead of failing on Finder's cache.
  const { isSystemJunk } = await import(new URL('../snapshot.js', import.meta.url))
  for (const junk of ['.DS_Store', '.ds_store', 'Thumbs.db', 'desktop.ini',
    '.directory', '._resource', 'notes.md.swp', 'draft.md~']) {
    assert.equal(isSystemJunk(junk), true, `${junk} should be treated as junk`)
  }
  for (const real of ['mnemon.db', 'index.json', 'USER.md', 'MEMORY.md',
    'a-real-document.md', 'spaces.json']) {
    assert.equal(isSystemJunk(real), false, `${real} must not be filtered`)
  }
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
