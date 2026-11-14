/**
 * Behavioural tests for the multi-account foundation: the selection pure
 * functions and the two documents the account pool persists.
 *
 * These are written at the seams fixed in `.scratch/TDD-SEAMS.md`:
 *   ① the pure selectors exported by `measurements.js`
 *   ② the document IO + the one-time takeover of an older install, observed in a
 *      throwaway `$DSH_HOME` (never through internals)
 *
 * Two rules this file keeps on purpose:
 *
 * - **Expected values are literals.** Nothing here recomputes an expectation
 *   with the same rule the implementation uses; a tautological assertion can
 *   never disagree with the code.
 * - **Nothing is allowed to leak into the real state directory.** `CreditEngine`
 *   and `CheckinScheduler` fall back to `pluginPaths()` when they are not handed
 *   a `paths` object (`as.js:187`, `checkin.js:86`), so any test that touches
 *   them injects `accountPaths()` and asserts the artefact landed inside the
 *   temporary directory. "It did not throw" is not evidence of isolation.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  accountsFile,
  accountPaths,
  ensureAccountDirs,
  ensureStateDirs,
  isInside,
  measurementsFile,
  pluginPaths,
} from '../paths.js'
import {
  exclusionOf,
  loadAccounts,
  loadMeasurements,
  nextActiveId,
  normalizeAccount,
  pickBestAccount,
  pruneActiveId,
  saveAccounts,
  writeMeasurementsProbes,
} from '../measurements.js'
import { AccountPool } from '../account-runtime.js'

/**
 * A throwaway data root; every test builds its own.
 *
 * Pass the test's `t` and the directory is removed when that test finishes. A
 * suite that only creates temp dirs leaks one per run — this file alone would
 * leave a thousand of them behind in a day of red/green cycles, and a leak that
 * large makes `tmpdir()` unpleasant to inspect for the next person.
 *
 * @param {import('node:test').TestContext} [t]
 */
function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'asp-measurements-'))
  t?.after?.(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const ID_C = 'cccccccccccccccccccccccc'

/** A well-formed account, so a test only spells out the field it is about. */
function account(id, extra = {}) {
  return { id, label: `acc-${id.slice(0, 4)}`, enabled: true, createdAt: 1731400000000, ...extra }
}

// ---------------------------------------------------------------------------
// ① Selection
// ---------------------------------------------------------------------------

test('pickBestAccount picks the healthy account holding the most credits', () => {
  const accounts = [account(ID_A), account(ID_B), account(ID_C)]
  const probes = {
    [ID_A]: { outcome: 'ok', atMs: 10, retryAtMs: 0, credits: 120 },
    [ID_B]: { outcome: 'ok', atMs: 10, retryAtMs: 0, credits: 900 },
    [ID_C]: { outcome: 'ok', atMs: 10, retryAtMs: 0, credits: 40 },
  }

  const picked = pickBestAccount({ accounts, probes, activeId: ID_A, thresholdPct: 20, nowMs: 1000 })

  // 900 is the largest credit figure in the fixture; the active account (120)
  // is below 20% of it, so a switch is worth making.
  assert.equal(picked.id, ID_B)
})

test('normalizeAccount rejects ids that could escape the vault directory', () => {
  // Anything that is not 24 hex digits would become a path segment, so a
  // traversal attempt must be refused rather than joined.
  for (const id of ['../../etc/passwd', 'ZZZZZZZZZZZZZZZZZZZZZZZZ', 'abc', '', 'a1b2c3d4e5f6a7b8c9d0e1f2x']) {
    assert.equal(normalizeAccount(account(id)), null, `${JSON.stringify(id)} must be rejected`)
  }
})

test('normalizeAccount trims and caps the label', () => {
  const normalized = normalizeAccount(account(ID_A, { label: '   备用账号   ' }))
  assert.equal(normalized.label, '备用账号')

  const long = normalizeAccount(account(ID_B, { label: 'x'.repeat(80) }))
  // 30 is the panel's maxLength; the document must not carry a longer label.
  assert.equal(long.label.length, 30)
})

test('normalizeAccount drops dirty fields instead of persisting them', () => {
  const normalized = normalizeAccount({
    id: ID_C,
    label: 'ok',
    enabled: 'yes',
    createdAt: 'not-a-number',
    legacy: 'true',
    disabledReason: 'because-i-said-so',
    accessToken: 'leaked-token',
    refreshToken: 'leaked-refresh',
  })
  assert.deepEqual(normalized, {
    id: ID_C,
    label: 'ok',
    enabled: true,
    createdAt: 0,
  })
})

test('normalizeAccount refuses any id that is not 24 lowercase hex digits', () => {
  // No reserved word: every account, including one taken over from an older
  // install, is an ordinary account with a hash-shaped id.
  assert.equal(normalizeAccount(account('default')), null, 'a reserved "default" id is not allowed')
  assert.equal(normalizeAccount({ id: 'default', label: '账号', legacy: true }), null,
    'a "legacy" flag cannot smuggle in a reserved id')
  assert.equal(normalizeAccount({ id: ID_A, label: '账号', legacy: true }).legacy, undefined,
    'a "legacy" field is dropped, never persisted')
})

test('normalizeAccount keeps the two disabled reasons and nothing else', () => {
  assert.equal(normalizeAccount(account(ID_A, { enabled: false, disabledReason: 'manual' })).disabledReason, 'manual')
  // `manual` is a HUMAN decision, so an enabled account carrying it is a
  // hand-edited document and the marker is not believed.
  assert.equal(normalizeAccount(account(ID_C, { disabledReason: 'manual' })).disabledReason, undefined,
    'an enabled account cannot claim a manual disable')
  // `expired` is a PLATFORM observation and coexists with `enabled: true`: the
  // account stays usable, automatic selection just skips it. This is the whole
  // point of the change — dropping the marker here would put a dead token back
  // into automatic selection after every restart.
  const expiredEnabled = normalizeAccount(account(ID_C, { enabled: true, disabledReason: 'expired' }))
  assert.equal(expiredEnabled.disabledReason, 'expired')
  assert.equal(expiredEnabled.enabled, true)
  assert.equal(normalizeAccount(account(ID_A, { disabledReason: 'nonsense' })).disabledReason, undefined,
    'an unknown reason is dropped, not repaired')
})

test('an account expired before the upgrade is re-enabled on load', () => {
  // Documents written by the previous rule stored an automatically expired
  // account as `enabled: false`. Re-enabling it is what makes the `sk-as-…` key
  // it still holds usable again; `start()` skips expired accounts, so nothing
  // begins polling the dead token. A `manual` disable is never touched.
  const migrated = normalizeAccount(account(ID_A, { enabled: false, disabledReason: 'expired' }))
  assert.equal(migrated.enabled, true, 'an expired account must come back enabled')
  assert.equal(migrated.disabledReason, 'expired', 'the marker survives so automatic selection still skips it')

  const manual = normalizeAccount(account(ID_B, { enabled: false, disabledReason: 'manual' }))
  assert.equal(manual.enabled, false, 'a manual disable must never be re-enabled by the migration')
  assert.equal(manual.disabledReason, 'manual')
})

test('nextActiveId makes the first account active', () => {
  assert.equal(nextActiveId({ accounts: [account(ID_A)], activeId: null }), ID_A)
  assert.equal(nextActiveId({ accounts: [], activeId: null }), null)
})

test('nextActiveId does not let a refresh displace the active account', () => {
  // Same id seen again (a re-login or a settings save): the active choice stands.
  assert.equal(nextActiveId({ accounts: [account(ID_A), account(ID_B)], activeId: ID_B }), ID_B)
})

test('nextActiveId only switches when the caller explicitly activates', () => {
  const accounts = [account(ID_A), account(ID_B)]
  // A plain add must not steal the billing account from A.
  assert.equal(nextActiveId({ accounts, activeId: ID_A, added: account(ID_B) }), ID_A)
  // The explicit activate path is the only way to move it.
  assert.equal(nextActiveId({ accounts, activeId: ID_A, added: account(ID_B), activate: ID_B }), ID_B)
})

test('pruneActiveId falls back to the first enabled account when the id dangles', () => {
  const accounts = [account(ID_A, { enabled: false }), account(ID_B), account(ID_C)]
  // ID_A is disabled, so the fallback skips it and lands on ID_B.
  assert.equal(pruneActiveId({ accounts, activeId: ID_A }), ID_B)
  // An id that is in no document at all (hand-edited file, deleted account).
  assert.equal(pruneActiveId({ accounts, activeId: 'ffffffffffffffffffffffff' }), ID_B)
  // A healthy active id is left alone.
  assert.equal(pruneActiveId({ accounts, activeId: ID_C }), ID_C)
  // Nothing enabled: no billing account rather than a disabled one.
  assert.equal(pruneActiveId({ accounts: [account(ID_A, { enabled: false })], activeId: null }), null)
})

test('exclusionOf lets a cooldown expire on its own', () => {
  const probe = { outcome: 'network', atMs: 1000, retryAtMs: 5000, credits: 300 }
  // Still inside the back-off window.
  assert.deepEqual(exclusionOf({ account: account(ID_A), probe, nowMs: 4000 }), { reason: 'cooldown', untilMs: 5000 })
  // The same document, read one millisecond after the deadline: selectable again.
  assert.equal(exclusionOf({ account: account(ID_A), probe, nowMs: 5001 }), null)
})

test('exclusionOf treats an ok probe as clearing the back-off', () => {
  // A successful probe is positive evidence; a retryAtMs left over from the
  // previous failure must not keep the account out.
  const probe = { outcome: 'ok', atMs: 6000, retryAtMs: 9999999, credits: 12 }
  assert.equal(exclusionOf({ account: account(ID_A), probe, nowMs: 6100 }), null)
})

test('exclusionOf separates a disabled account from an unknown credit figure', () => {
  assert.deepEqual(exclusionOf({ account: account(ID_A, { enabled: false }), nowMs: 0 }), { reason: 'disabled' })
  assert.deepEqual(exclusionOf({ account: account(ID_B, { disabledReason: 'expired' }), nowMs: 0 }), { reason: 'expired' })
  // No credits recorded yet is its own reason, not a credential failure.
  assert.deepEqual(exclusionOf({ account: account(ID_C), probe: { outcome: 'ok' }, nowMs: 0 }), { reason: 'unknown-credits' })
})

test('pickBestAccount never selects a disabled, expired or unmeasured account', () => {
  const accounts = [
    account(ID_A, { enabled: false }),
    account(ID_B, { disabledReason: 'expired' }),
    account(ID_C),
  ]
  const probes = {
    // The richest figures belong to the two accounts that must not be used.
    [ID_A]: { outcome: 'ok', credits: 9000 },
    [ID_B]: { outcome: 'ok', credits: 8000 },
    [ID_C]: { outcome: 'ok', credits: 10 },
  }
  assert.equal(pickBestAccount({ accounts, probes, activeId: null, nowMs: 0 }).id, ID_C)

  // Nothing selectable at all is a null answer, not a disabled account.
  assert.equal(pickBestAccount({ accounts: accounts.slice(0, 2), probes, activeId: null, nowMs: 0 }), null)
})

test('pickBestAccount keeps the active account while it holds enough credits', () => {
  const accounts = [account(ID_A), account(ID_B)]
  // A holds 90 of B's 100: well above the 20% threshold, so no switch.
  const probes = {
    [ID_A]: { outcome: 'ok', credits: 90 },
    [ID_B]: { outcome: 'ok', credits: 100 },
  }
  assert.equal(pickBestAccount({ accounts, probes, activeId: ID_A, thresholdPct: 20, nowMs: 0 }).id, ID_A)
})

test('pickBestAccount is deterministic for identical inputs', () => {
  const accounts = [account(ID_A), account(ID_B), account(ID_C)]
  const probes = {
    [ID_A]: { outcome: 'ok', credits: 500 },
    [ID_B]: { outcome: 'ok', credits: 500 },
    [ID_C]: { outcome: 'ok', credits: 500 },
  }
  const input = { accounts, probes, activeId: ID_A, thresholdPct: 20, nowMs: 1234 }
  // Equal credits: document order decides, every time — no rotation cursor, no
  // randomness, no clock read.
  assert.equal(pickBestAccount(input).id, ID_A)
  assert.equal(pickBestAccount(input).id, ID_A)
  assert.equal(pickBestAccount({ ...input, nowMs: 999999 }).id, ID_A)
})

// ---------------------------------------------------------------------------
// ② Document IO and the one-time legacy migration
// ---------------------------------------------------------------------------

/** Build the state directory of a single-account install, and return its root. */
function singleAccountHome(t) {
  const home = tempHome(t)
  const stateDir = join(home, 'data', 'connect-agentscope-platform')
  mkdirSync(join(stateDir, 'vault'), { recursive: true, mode: 0o700 })
  writeFileSync(join(stateDir, 'vault', 'login.json'), JSON.stringify({ accessToken: 'root-access', refreshToken: 'root-refresh' }))
  writeFileSync(join(stateDir, 'vault', 'model-key.json'), JSON.stringify({ key: 'sk-as-root' }))
  return home
}

test('accountPaths keeps one directory per account and shares the global files', () => {
  const base = pluginPaths({ dshHome: '/srv/dsh' })
  const first = accountPaths(base, ID_A)
  const second = accountPaths(base, ID_B)

  // Same shape as pluginPaths(): every global key is still present.
  assert.deepEqual(Object.keys(first).sort(), Object.keys(base).sort())

  const accountDir = '/srv/dsh/data/connect-agentscope-platform/vault/accounts/' + ID_A
  assert.equal(first.login, accountDir + '/login.json')
  assert.equal(first.modelKey, accountDir + '/model-key.json')
  assert.equal(first.log, accountDir + '/log.json')
  assert.equal(first.checkin, accountDir + '/checkin.json')

  // Two ids never share a directory.
  assert.notEqual(first.login, second.login)

  // Global documents stay global: one settings file for the whole install.
  assert.equal(first.settings, base.settings)
  assert.equal(first.metaCache, base.metaCache)
})

test('accountPaths refuses an id that is not a path segment', () => {
  const base = pluginPaths({ dshHome: '/srv/dsh' })
  for (const id of ['../evil', 'a/b', '', 'x'.repeat(24)]) {
    assert.throws(() => accountPaths(base, id), /account id/i, `${JSON.stringify(id)} must be refused`)
  }
})

test('ensureStateDirs also creates the per-account vault root', t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })
  ensureStateDirs(paths)
  assert.ok(existsSync(paths.vaultDir))
  assert.ok(existsSync(join(paths.vaultDir, 'accounts')))
  // 0700: the directory holds every account's credentials.
  assert.equal(statSync(join(paths.vaultDir, 'accounts')).mode & 0o777, 0o700)
})

test('loadAccounts takes over a single-account install as one ordinary account', async t => {
  const home = singleAccountHome(t)
  const paths = pluginPaths({ dshHome: home })
  const before = {
    login: readFileSync(paths.login),
    modelKey: readFileSync(paths.modelKey),
  }

  const document = await loadAccounts({ paths, log: () => {}, nowMs: 1731400000000 })

  // Exactly one account, and nothing marks it as different from one the user
  // adds by hand: a hash-shaped id, a neutral label, no extra field.
  assert.equal(document.version, 1)
  assert.equal(document.accounts.length, 1)
  const adopted = document.accounts[0]
  assert.match(adopted.id, /^[0-9a-f]{24}$/, 'the adopted account needs a hash-shaped id')
  assert.equal(adopted.label, '账号 1')
  assert.equal(adopted.enabled, true)
  assert.equal(adopted.createdAt, 1731400000000)
  assert.equal(adopted.legacy, undefined, 'no account may carry a legacy marker')
  assert.equal(document.activeId, adopted.id, 'the only account must be the billed-to one')

  // The credentials were COPIED into the account's own directory, at 0600.
  const owned = accountPaths(paths, adopted.id)
  assert.deepEqual(readFileSync(owned.login), before.login, 'the credential bytes must survive the takeover')
  assert.deepEqual(readFileSync(owned.modelKey), before.modelKey)
  assert.equal(statSync(owned.login).mode & 0o777, 0o600)
  // The originals stay put: they are what makes a later rebuild land on the same
  // account instead of inventing a second one.
  assert.deepEqual(readFileSync(paths.login), before.login)

  // The document really is in the temporary home, not the real one.
  assert.ok(existsSync(accountsFile(paths)), 'the accounts document was never written')
  assert.ok(isInside(home, accountsFile(paths)), 'the accounts document escaped the temp home')
})

test('loadAccounts migration is idempotent and writes the version once', async t => {
  const home = singleAccountHome(t)
  const paths = pluginPaths({ dshHome: home })

  const first = await loadAccounts({ paths, log: () => {} })
  const firstBytes = readFileSync(accountsFile(paths), 'utf8')
  const second = await loadAccounts({ paths, log: () => {} })
  const secondBytes = readFileSync(accountsFile(paths), 'utf8')

  assert.deepEqual(second, first)
  assert.equal(secondBytes, firstBytes, 'a second load must not rewrite the document')
  // The version is written once by the migration, never bumped by a read.
  assert.equal(JSON.parse(secondBytes).version, 1)
})

test('saveAccounts writes atomically, owner-only, with no temporary left behind', async t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })
  const document = {
    version: 1,
    activeId: ID_A,
    accounts: [account(ID_A), account(ID_B)],
    autoSwitch: { enabled: false, thresholdPct: 20 },
  }

  assert.equal(await saveAccounts({ paths, document, log: () => {} }), true)

  const file = accountsFile(paths)
  assert.ok(isInside(home, file), 'the document escaped the temp home')
  // 0600: the document names accounts, so it is not world-readable.
  assert.equal(statSync(file).mode & 0o777, 0o600)
  // The `.tmp` file used for the rename is gone, not left lying around.
  assert.deepEqual(readdirSync(dirname(file)).filter(name => name.includes('.tmp')), [])

  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written.activeId, ID_A)
  assert.equal(written.accounts.length, 2)
})

test('saveAccounts refuses to persist a document whose accounts are all invalid', async t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })
  const saved = await saveAccounts({
    paths,
    document: { version: 1, activeId: null, accounts: [{ id: '../evil', label: 'x' }] },
    log: () => {},
  })
  // Nothing usable survived normalisation, so nothing is written over the
  // previous good document.
  assert.equal(saved, false)
  assert.ok(!existsSync(accountsFile(paths)))
})

test('writeMeasurementsProbes merges per account instead of replacing the log', async t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })

  await writeMeasurementsProbes({
    paths,
    log: () => {},
    probes: { [ID_A]: { outcome: 'ok', atMs: 100, credits: 700 } },
  })
  await writeMeasurementsProbes({
    paths,
    log: () => {},
    probes: { [ID_B]: { outcome: 'network', atMs: 200, retryAtMs: 5000, credits: 5 } },
  })

  const log = JSON.parse(readFileSync(measurementsFile(paths), 'utf8'))
  assert.equal(log.version, 1)
  // Both accounts are present: the second write merged, it did not replace.
  assert.deepEqual(Object.keys(log.probes).sort(), [ID_A, ID_B].sort())
  assert.equal(log.probes[ID_A].credits, 700)
  assert.equal(log.probes[ID_B].outcome, 'network')
  assert.equal(log.probes[ID_B].retryAtMs, 5000)
})

test('writeMeasurementsProbes clears the back-off after a successful probe', async t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })

  await writeMeasurementsProbes({
    paths, log: () => {},
    probes: { [ID_A]: { outcome: 'network', atMs: 100, retryAtMs: 9000, credits: 40 } },
  })
  await writeMeasurementsProbes({
    paths, log: () => {},
    probes: { [ID_A]: { outcome: 'ok', atMs: 300, credits: 900 } },
  })

  const log = JSON.parse(readFileSync(measurementsFile(paths), 'utf8'))
  assert.equal(log.probes[ID_A].outcome, 'ok')
  assert.equal(log.probes[ID_A].credits, 900)
  // `ok` is positive evidence: the previous failure's deadline must not linger.
  assert.equal(log.probes[ID_A].retryAtMs, 0)
})

test('writeMeasurementsProbes masks a secret in the message before truncating', async t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })

  await writeMeasurementsProbes({
    paths, log: () => {},
    probes: { [ID_A]: { outcome: 'expired', atMs: 100, message: `HTTP 401 for token sk-as-0123456789abcdef${'x'.repeat(400)}` } },
  })

  const log = JSON.parse(readFileSync(measurementsFile(paths), 'utf8'))
  const message = log.probes[ID_A].message
  assert.ok(!message.includes('sk-as-0123456789abcdef'), 'the token survived into the measurement log')
  assert.ok(message.length <= 200, `message was not truncated (${message.length} chars)`)
})

test('writeMeasurementsProbes swallows a write failure instead of throwing', async t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })
  // A file where the directory should be: every write below it must fail.
  writeFileSync(join(home, 'data'), 'not a directory')

  const written = await writeMeasurementsProbes({ paths, log: () => {}, probes: { [ID_A]: { outcome: 'ok', credits: 1 } } })
  assert.equal(written, false)
})

test('loadMeasurements degrades to an empty log when the file is corrupt', async t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })
  mkdirSync(dirname(measurementsFile(paths)), { recursive: true })
  writeFileSync(measurementsFile(paths), '{ this is not json')

  const log = await loadMeasurements({ paths, log: () => {} })
  assert.deepEqual(log, { version: 1, probes: {} })
})

test('an engine given accountPaths reads and writes inside that account directory', async t => {
  const home = tempHome(t)
  const base = pluginPaths({ dshHome: home })
  ensureStateDirs(base)
  const paths = ensureAccountDirs(accountPaths(base, ID_A))
  writeFileSync(paths.login, JSON.stringify({ accessToken: 'per-account-access', refreshToken: 'per-account-refresh' }), { mode: 0o600 })

  const { CreditEngine } = await import('../as.js')
  // `paths` is injected explicitly: without it the engine falls back to the
  // real plugin state directory and this test would pass while writing into
  // the user's live install (`as.js:187`).
  const engine = new CreditEngine({ paths, log: () => {} })

  assert.equal(engine.publicConfig().hasAccessToken, true, 'the per-account credential was not read')
  engine.config.accessToken = 'rotated-access'
  engine.saveConfig()

  // The artefact must be in the temporary home, under this account's directory.
  assert.ok(isInside(home, paths.login), 'the credential path escaped the temp home')
  assert.deepEqual(JSON.parse(readFileSync(paths.login, 'utf8')).accessToken, 'rotated-access')
  // ...and it must not have touched the install-wide vault.
  assert.ok(!existsSync(base.login), 'the engine wrote to the install-wide vault')
})

test('a check-in scheduler given accountPaths records today under that account', async t => {
  const home = tempHome(t)
  const base = pluginPaths({ dshHome: home })
  ensureStateDirs(base)
  const paths = ensureAccountDirs(accountPaths(base, ID_B))

  const { CheckinScheduler } = await import('../checkin.js')
  // Same red line as the engine above (`checkin.js:86`).
  const scheduler = new CheckinScheduler({ engine: {}, settings: () => ({ enabled: false }), paths, log: () => {} })
  scheduler.state.attempts = 3
  scheduler.save()

  assert.ok(isInside(home, paths.checkin), 'the check-in path escaped the temp home')
  assert.equal(JSON.parse(readFileSync(paths.checkin, 'utf8')).attempts, 3)
  assert.ok(!existsSync(base.checkin), 'the scheduler wrote to the install-wide check-in file')
})

test('ensureAccountDirs creates the per-account directory owner-only', t => {
  const home = tempHome(t)
  const base = pluginPaths({ dshHome: home })
  const paths = ensureAccountDirs(accountPaths(base, ID_C))

  assert.ok(existsSync(dirname(paths.login)))
  assert.equal(statSync(dirname(paths.login)).mode & 0o777, 0o700)
  // The install-wide vault still exists; the account directory sits beside it.
  assert.ok(existsSync(base.vaultDir))
})

test('loadAccounts rebuilds a corrupt pool document from the root credentials', async t => {
  const home = singleAccountHome(t)
  const paths = pluginPaths({ dshHome: home })
  mkdirSync(dirname(accountsFile(paths)), { recursive: true })
  writeFileSync(accountsFile(paths), '{ truncated')

  const document = await loadAccounts({ paths, log: () => {}, nowMs: 1731400000000 })

  // A malformed document must not cost the user their credentials: the rebuild
  // finds the root files and reproduces one ordinary account.
  assert.equal(document.accounts.length, 1)
  assert.match(document.accounts[0].id, /^[0-9a-f]{24}$/)
  assert.equal(document.accounts[0].legacy, undefined)
  assert.equal(document.activeId, document.accounts[0].id)
  // The repair is durable: the file on disk is valid again.
  assert.equal(JSON.parse(readFileSync(accountsFile(paths), 'utf8')).version, 1)
})

test('a probe that recorded no credit figure counts as unknown, not as zero', async t => {
  const home = tempHome(t)
  const paths = pluginPaths({ dshHome: home })
  // A probe with no `credits` is stored with `credits: null`; reading it back
  // must still mean "unknown", never "this account has 0 credits".
  await writeMeasurementsProbes({ paths, log: () => {}, probes: { [ID_A]: { outcome: 'ok', atMs: 10 } } })
  const log = await loadMeasurements({ paths, log: () => {} })

  assert.equal(log.probes[ID_A].credits, null)
  assert.deepEqual(
    exclusionOf({ account: account(ID_A), probe: log.probes[ID_A], nowMs: 100 }),
    { reason: 'unknown-credits' },
  )
})

// ---------------------------------------------------------------------------
// ④ AccountPool orchestration (TDD-SEAMS §5: deliberately only two tests)
//
// Everything the other three seams already pin is left alone here — no selector
// re-testing, no HTTP shape, no measurement-file contents. What is tested is the
// two invariants that only exist once several accounts share one process:
//
//   1. two runtimes never write over each other's files, and
//   2. teardown really stops every timer.
//
// Nothing is asserted about the pool's internals: no Map size, no call counts,
// no mocked collaborators. Both tests read real files in a throwaway `$DSH_HOME`,
// which is also what makes them fail if the `paths` injection is ever dropped
// (`as.js:187` / `checkin.js:86` would silently point at the real install).
// ---------------------------------------------------------------------------

test('two accounts keep their credentials in two directories and never overwrite each other', async t => {
  const home = tempHome(t)
  const base = pluginPaths({ dshHome: home })
  const pool = new AccountPool({ paths: base, log: () => {}, nowMs: 1731400000000 })

  const first = await pool.add({ id: ID_A, label: '主账号' })
  const second = await pool.add({ id: ID_B, label: '备用账号' })

  // Each runtime wrote its own credential file: this is the property the whole
  // `accountPaths()` layer exists for, observed through the files themselves.
  first.runtime.engine.updateConfig({ accessToken: 'access-for-A', refreshToken: 'refresh-for-A' })
  second.runtime.engine.updateConfig({ accessToken: 'access-for-B', refreshToken: 'refresh-for-B' })

  const loginA = join(base.vaultDir, 'accounts', ID_A, 'login.json')
  const loginB = join(base.vaultDir, 'accounts', ID_B, 'login.json')
  assert.notEqual(loginA, loginB)
  assert.ok(isInside(home, loginA), 'account A wrote outside the temp home')
  assert.ok(isInside(home, loginB), 'account B wrote outside the temp home')

  assert.equal(JSON.parse(readFileSync(loginA, 'utf8')).refreshToken, 'refresh-for-A')
  assert.equal(JSON.parse(readFileSync(loginB, 'utf8')).refreshToken, 'refresh-for-B')

  // Neither account leaked into the install-wide vault, which is what a missing
  // `paths` would have caused for both of them at once.
  assert.ok(!existsSync(base.login), 'an account runtime wrote to the install-wide vault')

  // Check-in records follow the same rule: one file per account.
  first.runtime.checkin.state.attempts = 2
  first.runtime.checkin.save()
  second.runtime.checkin.state.attempts = 7
  second.runtime.checkin.save()
  assert.equal(JSON.parse(readFileSync(join(base.vaultDir, 'accounts', ID_A, 'checkin.json'), 'utf8')).attempts, 2)
  assert.equal(JSON.parse(readFileSync(join(base.vaultDir, 'accounts', ID_B, 'checkin.json'), 'utf8')).attempts, 7)
  assert.ok(!existsSync(base.checkin), 'a check-in scheduler wrote to the install-wide file')

  pool.dispose()
})

test('dispose stops every account scheduler and the auto-switch timer', async t => {
  const home = tempHome(t)
  const base = pluginPaths({ dshHome: home })
  // The check-in switch is ON, so each account's scheduler really does arm a
  // timer: a teardown test that never started a timer proves nothing.
  const pool = new AccountPool({ paths: base, log: () => {}, nowMs: 1731400000000, settings: () => ({ checkin: { enabled: true } }) })
  const first = await pool.add({ id: ID_A, label: '主账号' })
  const second = await pool.add({ id: ID_B, label: '备用账号' })

  // Arm the timers the way `index.js` does at startup: the credit-snapshot
  // interval on each account, the check-in scheduler, and the selection cycle.
  first.runtime.engine.config.enabled = true
  first.runtime.engine.config.accessToken = 'access-for-A'
  second.runtime.engine.config.enabled = true
  second.runtime.engine.config.accessToken = 'access-for-B'
  pool.start()
  await pool.setAutoSwitch({ enabled: true, thresholdPct: 20 })

  assert.notEqual(first.runtime.engine.runtime.timer, null, 'account A snapshot timer was never armed')
  assert.notEqual(second.runtime.engine.runtime.timer, null, 'account B snapshot timer was never armed')
  assert.notEqual(first.runtime.checkin.timer, null, 'account A check-in timer was never armed')
  assert.notEqual(second.runtime.checkin.timer, null, 'account B check-in timer was never armed')
  assert.equal(pool.autoSwitchRunning, true, 'the selection timer was never armed')

  // This is exactly what `ctx.effect` cleanup runs on a hot reload. Two live
  // scheduler sets would race one rotating refresh token.
  pool.dispose()

  assert.equal(first.runtime.engine.runtime.timer, null, 'account A snapshot timer survived teardown')
  assert.equal(second.runtime.engine.runtime.timer, null, 'account B snapshot timer survived teardown')
  assert.equal(first.runtime.checkin.timer, null, 'account A check-in timer survived teardown')
  assert.equal(second.runtime.checkin.timer, null, 'account B check-in timer survived teardown')
  assert.equal(pool.autoSwitchRunning, false, 'the selection timer survived teardown')
})

// ---------------------------------------------------------------------------
// ③ The HTTP API: `/api/agentscope-platform`
//
// The seam is the request/response pair — a status code and a JSON document.
// Nothing here imports a private function, counts a call or inspects the pool
// object; the only observation points are what a browser would receive.
//
// Three rules this section keeps on purpose (`.scratch/TDD-SEAMS.md` §4):
//
//   * **The mock context has no `connection` service**, exactly like the smoke
//     harness. `handle()` therefore takes its documented "no gate to run" branch
//     (`index.js:906-908`). These tests say nothing about authorization and must
//     not be read as proving it.
//   * **Expected field sets are written out by hand.** Re-serialising the answer
//     and comparing it to itself would agree with any implementation, including
//     one that leaks a token.
//   * **No test waits on the platform.** `fetch` is replaced at the network
//     boundary, which is also what keeps the four-megabyte metadata refresh out
//     of the suite.
// ---------------------------------------------------------------------------

const PLUGIN_URL = new URL('../index.js', import.meta.url)

/** The credential pair a single-account install would already have on disk. */
const ROOT_CREDENTIALS = {
  accessToken: 'access-token-for-tests',
  refreshToken: 'refresh-token-for-tests',
  // Already fresh: a read must not trigger the refresh retry ladder (which
  // sleeps between transport attempts and would make these tests take seconds).
  expiresAt: Date.now() + 3_600_000,
  autoRefresh: true,
}

/**
 * Mount the plugin's HTTP handler over a throwaway `$DSH_HOME`.
 *
 * `$DSH_HOME` is the documented seam the plugin resolves its own directory
 * through (`paths.js`), so pointing it at a temporary root is what keeps these
 * tests out of the live install — and the returned `home` lets a test assert
 * that what it wrote really landed there.
 *
 * @param {{ rootCredentials?: boolean, credentials?: object, accounts?: object[], activeId?: string, vault?: Record<string, object>, fetch?: Function, connection?: object|null }} [options]
 */
async function mount(t, options = {}) {
  const home = tempHome(t)
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  const paths = pluginPaths({ dshHome: home })
  ensureStateDirs(paths)

  if (options.rootCredentials === true) {
    writeFileSync(paths.login, JSON.stringify(options.credentials ?? ROOT_CREDENTIALS), { mode: 0o600 })
    writeFileSync(paths.modelKey, JSON.stringify({ key: 'sk-as-root-for-tests', source: 'pasted', fetchedAt: 1 }), { mode: 0o600 })
  }
  if (Array.isArray(options.accounts)) {
    writeFileSync(accountsFile(paths), JSON.stringify({
      version: 1,
      activeId: options.activeId ?? options.accounts[0].id,
      accounts: options.accounts,
      autoSwitch: { enabled: false, thresholdPct: 20 },
    }), { mode: 0o600 })
  }
  for (const [id, credentials] of Object.entries(options.vault ?? {})) {
    const owned = ensureAccountDirs(accountPaths(paths, id))
    writeFileSync(owned.login, JSON.stringify(credentials), { mode: 0o600 })
  }

  globalThis.fetch = options.fetch ?? (async () => { throw new Error('fetch failed') })

  const handlerHolder = {}
  const cleanups = []
  // Host services this plugin reads through `ctx.get`. `agentDefaultModel` is the
  // one the composer gate asks for; a test supplies it to observe the answer, and
  // its absence is a Host too old to have the service (the failure path).
  const services = { ...(options.services ?? {}) }
  // The Host's `connection` service, which the HTTP mount asks before dispatch.
  // Default to one that admits: these tests exercise routing, not authentication.
  // A test asserting fail-closed passes `connection: null` or `{}` explicitly.
  services.connection = 'connection' in options
    ? options.connection
    : { requestRejection: () => undefined }
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-agentscope-platform' } } },
    logger: { warn: () => {} },
    get: name => services[name],
    inject(_names, callback) {
      callback({
        effect: fn => { fn(); return () => {} },
        webServer: { register: route => { handlerHolder.handler = route.handler; return () => {} } },
      })
    },
    // The cleanup a real context would run on unload, collected so a test can
    // tear the plugin down itself (that is the path that stops the schedulers).
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); return () => {} },
    llm: {
      registerAdapter: () => Object.assign(() => {}, { replace() {} }),
      registerConfigurableProviders: () => Object.assign(() => {}, { replace() {} }),
      registerModelDiscovery: () => () => {},
    },
    on() {},
    emit() {},
  }
  const module = await import(PLUGIN_URL)
  module.apply(ctx, {})

  /**
   * One request against the mounted handler.
   *
   * The route replies asynchronously (`void handle(...)`), so the answer is read
   * off the response object once `end()` has run — polling rather than sleeping
   * a fixed 400ms, so a slow machine does not turn into a flaky red.
   */
  const call = async (path, init = {}) => {
    const response = {
      status: 0,
      text: '',
      writeHead(value) { this.status = value },
      end(text) { this.text = text },
    }
    const payload = init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body), 'utf8')]
    await handlerHolder.handler({
      url: `/api/agentscope-platform${path}`,
      method: init.method ?? 'GET',
      [Symbol.asyncIterator]: async function* () { for (const chunk of payload) yield chunk },
    }, response)
    const deadline = Date.now() + 3_000
    while (response.text === '' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.notEqual(response.text, '', `no answer for ${init.method ?? 'GET'} ${path}`)
    return { status: response.status, body: JSON.parse(response.text) }
  }

  const cleanup = () => {
    for (const dispose of cleanups.reverse()) { try { dispose() } catch { /* already released */ } }
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  // `handler` is the raw mounted route: a test that asserts on the STATUS of a
  // rejected request cannot go through `call()`, which insists on a JSON body
  // and a non-zero status. Authentication tests use it directly.
  return { home, paths, call, cleanup, handler: (req, res) => handlerHolder.handler(req, res) }
}

/**
 * A response object for the RAW mounted route.
 *
 * `rejected()` writes `res.statusCode` and calls `res.end()`, the plain
 * node:http shape, whereas `call()`'s fake speaks `writeHead`. A test that
 * asserts a rejection uses this one so the status it reads is the one the gate
 * actually set.
 */
function rejectedResponse() {
  return {
    statusCode: 0,
    body: '',
    end(text = '') { this.body = text },
  }
}

/** A platform answer shaped like the refresh endpoint's own document. */
function refreshAnswer(accessToken, refreshToken) {
  const text = JSON.stringify({ data: { accessToken, refreshToken, expiresIn: 7200 } })
  return { ok: true, status: 200, headers: { get: () => '' }, text: async () => text }
}

/** A platform refusal: the credential is dead, not the network. */
function authRefusal() {
  return { ok: false, status: 401, headers: { get: () => '' }, text: async () => 'invalid refresh token' }
}

test('GET /accounts projects every account without a single token', async t => {
  const app = await mount(t, { rootCredentials: true })
  try {
    const answer = await app.call('/accounts')

    assert.equal(answer.status, 200)
    assert.equal(Array.isArray(answer.body.accounts), true)
    assert.equal(answer.body.accounts.length, 1)
    const [projection] = answer.body.accounts
    // The adopted account is the billed-to one and has no special standing.
    assert.match(projection.id, /^[0-9a-f]{24}$/)
    assert.equal(answer.body.activeAccountId, projection.id)
    assert.deepEqual(answer.body.autoSwitch, { enabled: false, thresholdPct: 20 })

    // The whitelist is spelled out: a field added to the projection has to be
    // added here too, which is exactly the review this test is for. `modelKey`
    // is this account's OWN key ({configured, source, mask}), not the billing
    // account's — the browser half renders each row from it.
    assert.deepEqual(Object.keys(projection).sort(), [
      'active', 'credentialState', 'credits', 'disabledReason', 'enabled',
      'excludedBy', 'id', 'label', 'lastRefreshedAt', 'modelKey', 'probe', 'usable',
    ])
    assert.equal(projection.active, true)
    assert.equal(projection.enabled, true)
    assert.equal(projection.credentialState, 'usable')
    // The key itself is never in the projection; the mask and where it came from
    // are, because the row's editor displays both.
    assert.deepEqual(Object.keys(projection.modelKey).sort(), ['configured', 'mask', 'source'])

    // Nothing resembling a credential survives into the answer — including the
    // model key, which lives in the same vault directory.
    const text = JSON.stringify(answer.body)
    for (const secret of ['access-token-for-tests', 'refresh-token-for-tests', 'sk-as-root-for-tests']) {
      assert.ok(!text.includes(secret), `${secret} leaked into GET /accounts`)
    }
  } finally { app.cleanup() }
})

test('GET /state keeps every old key and adds the pool fields', async t => {
  const app = await mount(t, { rootCredentials: true })
  try {
    const answer = await app.call('/state')

    assert.equal(answer.status, 200)
    // Every key the pre-pool build answered with is still here, plus the three
    // the pool added. Spelled out rather than counted.
    assert.deepEqual(Object.keys(answer.body).sort(), [
      'accounts', 'activeAccountId', 'build', 'catalog', 'checkin', 'credits',
      'meta', 'modelKey', 'pool', 'provider', 'settingsNs',
    ])
    assert.equal(Array.isArray(answer.body.accounts), true)
    assert.equal(answer.body.accounts.length, 1)
    assert.match(answer.body.activeAccountId, /^[0-9a-f]{24}$/)
    assert.equal(answer.body.activeAccountId, answer.body.accounts[0].id)
    assert.deepEqual(answer.body.pool, { autoSwitch: { enabled: false, thresholdPct: 20 }, count: 1 })

    // The old fields now describe the billing account, in their old shapes.
    // `credits.config` is the engine's own masked view, so the word here is the
    // credential-pair state ('both'), not the file-level state the projection uses.
    assert.equal(answer.body.credits.config.credentialState, 'both')
    assert.equal(answer.body.modelKey.configured, true)
    assert.equal(answer.body.checkin.timezone, 'Asia/Shanghai')

    // The build marker moved on, and still announces itself as this plugin's.
    assert.match(answer.body.build, /^asp-/)
    assert.notEqual(answer.body.build, 'asp-2026-11-12.6')
  } finally { app.cleanup() }
})

test('an empty pool still answers: no accounts, no billing account, no crash', async t => {
  const app = await mount(t, {})
  try {
    const pool = await app.call('/accounts')
    assert.equal(pool.status, 200)
    assert.deepEqual(pool.body, {
      accounts: [],
      activeAccountId: null,
      autoSwitch: { enabled: false, thresholdPct: 20 },
    })

    // The aggregate state must describe "nothing configured" rather than fail.
    const state = await app.call('/state')
    assert.equal(state.status, 200)
    assert.deepEqual(state.body.accounts, [])
    assert.equal(state.body.activeAccountId, null)
    assert.equal(state.body.pool.count, 0)
    assert.equal(state.body.credits.config.usable, false)
    assert.equal(state.body.modelKey.configured, false)
    assert.equal(state.body.checkin.status, 'idle')
  } finally { app.cleanup() }
})

test('the composer readout and the account row are ONE measurement', async t => {
  // The reported defect: the pill showed a live balance while the account row
  // showed whatever the last probe had recorded, so one account displayed two
  // different figures and a stale "last refreshed". `/quick` therefore goes
  // through the pool's probe, and the account projection reads the record it
  // wrote — same number, same timestamp, no second cache.
  const CREDITS = {
    lifetime_score: 73,
    redeemable_score: 73,
    balance_credits: 1191.15,
    display_available_credits: 1191.15,
    redeem_min: 10,
    redeem_max: 5000,
  }
  const app = await mount(t, {
    rootCredentials: true,
    fetch: async url => {
      if (!String(url).includes('credits')) throw new Error(`unexpected fetch ${String(url)}`)
      return {
        ok: true,
        status: 200,
        async json() { return { code: 0, data: CREDITS } },
        async text() { return JSON.stringify({ code: 0, data: CREDITS }) },
      }
    },
  })
  try {
    const quick = await app.call('/quick')
    assert.equal(quick.status, 200)
    assert.equal(quick.body.credits.display_available_credits, 1191.15)
    const quickAt = Date.parse(quick.body.at)
    assert.ok(Number.isFinite(quickAt))

    // The same reading is now the account's probe — no second request needed.
    const pool = await app.call('/accounts')
    const row = pool.body.accounts.find(entry => entry.id === quick.body.accountId)
    assert.ok(row !== undefined, 'the billed account vanished from the pool projection')
    assert.equal(row.credits, 1191.15)
    assert.equal(row.probe.credits, 1191.15)
    assert.equal(row.probe.outcome, 'ok')
    assert.equal(row.probe.lastRefreshedAt, row.lastRefreshedAt)

    // Same instant EXACTLY: `at` is the record's own timestamp, not a second
    // `new Date()` taken after the read — otherwise the two surfaces can still
    // disagree about when the number was measured.
    assert.equal(row.lastRefreshedAt, quickAt)
    assert.equal(row.probe.atMs, quickAt)
  } finally { app.cleanup() }
})

test('an existing endpoint without an accountId falls back to the billing account', async t => {
  const app = await mount(t, { rootCredentials: true })
  try {
    const answer = await app.call('/quick')

    // The composer readout keeps its old shape: a failure is reported as data,
    // never as an error banner, and the account it read is named alongside.
    assert.equal(answer.status, 200)
    assert.equal(typeof answer.body.at, 'string')
    assert.equal(typeof answer.body.error, 'string')
    assert.equal(answer.body.credits, null)
    assert.match(answer.body.accountId, /^[0-9a-f]{24}$/)
    assert.equal(answer.body.accountLabel, '账号 1')
  } finally { app.cleanup() }
})

test('the deployment default provider answers what an unselected session runs on', async t => {
  // A brand-new session's `modelSelection` projection is `{lastUsed: null,
  // next: null}`: it names no provider, and the picker then shows the deployment
  // default. The composer gate needs that same default, or it cannot tell a
  // fresh AgentScope session from a fresh session on another provider.
  const app = await mount(t, {
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }) } },
  })
  try {
    const answer = await app.call('/provider/default')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { provider: 'workbuddy' })
  } finally { app.cleanup() }
})

test('an unreadable default is an empty answer, never a failed request', async t => {
  // Two ways the Host cannot answer: the service is absent (older build,
  // headless composition), or it throws. Neither may take the request down —
  // this route is polled by a composer pill that must degrade to a dash.
  const absent = await mount(t, {})
  try {
    const answer = await absent.call('/provider/default')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { provider: '' })
  } finally { absent.cleanup() }

  const throwing = await mount(t, {
    services: { agentDefaultModel: { currentSelection: () => { throw new Error('no default configured') } } },
  })
  try {
    const answer = await throwing.call('/provider/default')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { provider: '' })
  } finally { throwing.cleanup() }
})

test('the HTTP mount rejects when the Host auth service is missing (fail-closed)', async t => {
  // These routes read credentials and rotate the model key, so "no guard
  // available" must mean 401 — not a pass. Before the fix the gate was handed
  // in as `undefined` and skipped itself, admitting every request.
  for (const [label, connection] of [
    ['service missing', null],
    ['service exposes no hook', {}],
  ]) {
    const app = await mount(t, { rootCredentials: true, connection })
    try {
      for (const [method, path] of [['GET', '/state'], ['POST', '/model-key/reset']]) {
        const response = rejectedResponse()
        await app.handler({
          url: `/api/agentscope-platform${path}`,
          method,
          [Symbol.asyncIterator]: async function* () {},
        }, response)
        assert.equal(response.statusCode, 401, `${label}: ${method} ${path} must be rejected`)
        assert.equal(response.body, '', `${label}: ${method} ${path} must not reach a handler`)
      }
    } finally { app.cleanup() }
  }
})

test('the HTTP mount admits a request the Host vouches for', async t => {
  // The other half of fail-closed: a real Host must still be served. This is
  // the path the panel polls, so a regression here breaks the whole UI.
  const app = await mount(t, { rootCredentials: true, connection: { requestRejection: () => undefined } })
  try {
    const answer = await app.call('/state')
    assert.equal(answer.status, 200)
  } finally { app.cleanup() }

  // And a Host that rejects must have its status forwarded, not flattened to 401.
  const denied = await mount(t, { rootCredentials: true, connection: { requestRejection: () => 403 } })
  try {
    const response = rejectedResponse()
    await denied.handler({
      url: '/api/agentscope-platform/state',
      method: 'GET',
      [Symbol.asyncIterator]: async function* () {},
    }, response)
    assert.equal(response.statusCode, 403, 'the Host status must be forwarded as-is')
  } finally { denied.cleanup() }
})

test('an unknown accountId is a 400, not a 500', async t => {
  const app = await mount(t, { rootCredentials: true })
  try {
    const unknown = 'ffffffffffffffffffffffff'

    const read = await app.call(`/model-key?accountId=${unknown}`)
    assert.equal(read.status, 400)
    assert.match(read.body.error, /unknown account/i)

    const write = await app.call('/config', { method: 'POST', body: { accountId: unknown, intervalMin: 30 } })
    assert.equal(write.status, 400)
    assert.match(write.body.error, /unknown account/i)

    // The billing account is untouched by a request that named a ghost.
    const state = await app.call('/state')
    assert.match(state.body.activeAccountId, /^[0-9a-f]{24}$/)
  } finally { app.cleanup() }
})

test('adding an account verifies the refresh token before it joins the list', async t => {
  const app = await mount(t, { rootCredentials: true, fetch: async () => authRefusal() })
  try {
    const dirsBefore = readdirSync(join(app.paths.vaultDir, 'accounts')).length
    const before = (await app.call('/accounts')).body.accounts.length
    const answer = await app.call('/accounts', {
      method: 'POST',
      body: { label: '备用账号', refreshToken: 'refresh-token-that-is-dead' },
    })

    assert.equal(answer.status, 200)
    assert.equal(answer.body.exchanged.ok, false)
    assert.match(answer.body.exchanged.error, /401|refresh/i)
    // The answer is still the projection, so the panel can render the refusal.
    assert.equal(Array.isArray(answer.body.accounts), true)
    assert.equal(answer.body.accounts.length, before)

    const after = await app.call('/accounts')
    assert.equal(after.body.accounts.length, before)
    assert.equal(after.body.accounts.some(row => row.label === '备用账号'), false, 'an unverified account reached the list')
    // Nor did it leave a credential file behind under a directory of its own.
    assert.equal(readdirSync(join(app.paths.vaultDir, 'accounts')).length, dirsBefore,
      'the refused account still got a directory')
  } finally { app.cleanup() }
})

test('adding an account stores the exchanged pair and never steals billing', async t => {
  const app = await mount(t, { rootCredentials: true, fetch: async () => refreshAnswer('at-rotated', 'rt-rotated') })
  try {
    const billedBefore = (await app.call('/accounts')).body.activeAccountId
    const answer = await app.call('/accounts', {
      method: 'POST',
      body: { label: '备用账号', refreshToken: 'rt-fresh' },
    })

    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.exchanged, { ok: true })
    assert.equal(answer.body.accounts.length, 2)
    assert.equal(answer.body.activeAccountId, billedBefore, 'a plain add must not move billing')

    const added = answer.body.accounts.find(row => row.label === '备用账号')
    assert.ok(added !== undefined, 'the verified account is missing from the list')
    assert.equal(added.active, false)
    assert.equal(added.credentialState, 'usable')

    // The pair that reached the disk is the one the platform ROTATED, not the
    // one the user pasted: that is what "exchange before write" means.
    const owned = join(app.paths.vaultDir, 'accounts', added.id, 'login.json')
    assert.ok(isInside(app.home, owned), 'the credential escaped the temp home')
    const stored = JSON.parse(readFileSync(owned, 'utf8'))
    assert.equal(stored.accessToken, 'at-rotated')
    assert.equal(stored.refreshToken, 'rt-rotated')

    // And switching is a plain choice of billing account.
    const switched = await app.call('/accounts/switch', { method: 'POST', body: { accountId: added.id } })
    assert.equal(switched.status, 200)
    assert.deepEqual(Object.keys(switched.body).sort(), ['accounts', 'activeAccountId', 'autoSwitch'])
    assert.equal(switched.body.activeAccountId, added.id)

    // No re-registration happened: the provider switch is still off, and a
    // switch must never move it (ADR 0001 — the key getter is what changes).
    const state = await app.call('/state')
    assert.equal(state.body.provider.enabled, false)
    assert.equal(state.body.provider.registered, false)
    assert.equal(state.body.activeAccountId, added.id)
  } finally { app.cleanup() }
})

test('removing the last usable account is refused with a reason', async t => {
  const app = await mount(t, { accounts: [account(ID_A)] })
  try {
    const answer = await app.call('/accounts/remove', { method: 'POST', body: { accountId: ID_A } })

    assert.equal(answer.status, 400)
    assert.match(answer.body.error, /last usable account/i)

    const list = await app.call('/accounts')
    assert.equal(list.body.accounts.length, 1, 'the refused removal changed the pool anyway')
  } finally { app.cleanup() }
})

test('an expired account keeps its own model key and stays switchable', async t => {
  // AC2 + AC3: the whole reason an expired credential must not disable the
  // account. A is billed to and holds a key; B has no key. Pruning A would move
  // model calls onto B and fail with MISSING_CREDENTIAL.
  const app = await mount(t, {
    accounts: [account(ID_A), account(ID_B)],
    activeId: ID_A,
    vault: { [ID_A]: ROOT_CREDENTIALS },
    fetch: async () => authRefusal(),
  })
  try {
    const owned = ensureAccountDirs(accountPaths(app.paths, ID_A))
    writeFileSync(owned.modelKey, JSON.stringify({ key: 'sk-as-for-A', source: 'pasted', fetchedAt: 7 }), { mode: 0o600 })

    await app.call('/accounts/test', { method: 'POST', body: { accountId: ID_A } })

    // Billing did NOT move: a manual choice outranks one failed probe.
    const after = await app.call('/accounts')
    assert.equal(after.body.activeAccountId, ID_A, 'an expired probe must not prune the active account')
    const rowA = after.body.accounts.find(row => row.id === ID_A)
    assert.equal(rowA.enabled, true)
    assert.equal(rowA.disabledReason, 'expired')
    // AC13/AC14: each row carries its OWN key, which is what lets the panel tell
    // a configured row from an unconfigured one.
    assert.equal(rowA.modelKey.configured, true)
    assert.equal(rowA.modelKey.source, 'pasted')
    const rowB = after.body.accounts.find(row => row.id === ID_B)
    assert.equal(rowB.modelKey.configured, false, 'B has no key and must not borrow A\'s')

    // AC3: switching by hand still works, and the billing key is still A's.
    const switched = await app.call('/accounts/switch', { method: 'POST', body: { accountId: ID_A } })
    assert.equal(switched.status, 200)
    assert.equal(switched.body.activeAccountId, ID_A)
  } finally { app.cleanup() }
})

test('an expired account does not arm its timers', async t => {
  // AC9/R4: without this, dropping `enabled: false` would leave the snapshot
  // timer polling a dead token and mailing a failure every cycle. Asserted on
  // the CLASS contract, because the pool's own runtimes are not reachable
  // through the HTTP surface a test is given.
  const { AccountRuntime } = await import(new URL('../account-runtime.js', import.meta.url))
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'asp-timers-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { pluginPaths } = await import(new URL('../paths.js', import.meta.url))
    const { accountPaths, ensureAccountDirs } = await import(new URL('../paths.js', import.meta.url))
    const paths = ensureAccountDirs(accountPaths(pluginPaths({ dshHome: home }), ID_A))
    // The engine only arms when it is switched on AND holds a credential, so the
    // "healthy still arms" half needs a real login file; otherwise both halves
    // would report `null` and the test would pass for the wrong reason.
    writeFileSync(paths.login, JSON.stringify({ ...ROOT_CREDENTIALS, enabled: true, autoRefresh: false }), { mode: 0o600 })
    const runtime = new AccountRuntime({ id: ID_A, paths, log: () => {} })
    try {
      runtime.engine.updateConfig({ enabled: true, accessToken: 'at-for-timers', autoRefresh: false })
      runtime.start({ id: ID_A, enabled: true, disabledReason: 'expired' })
      assert.equal(runtime.engine.runtime.timer, null, 'an expired account must not run the snapshot timer')

      // A healthy account still arms, or the skip would be a blanket outage.
      runtime.start({ id: ID_A, enabled: true })
      assert.notEqual(runtime.engine.runtime.timer, null, 'a healthy account must still arm its timer')
    } finally { runtime.dispose() }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('a probe reports an auth failure as an expired credential', async t => {
  const app = await mount(t, {
    accounts: [account(ID_A)],
    vault: { [ID_A]: ROOT_CREDENTIALS },
    fetch: async () => authRefusal(),
  })
  try {
    const answer = await app.call('/accounts/test', { method: 'POST', body: { accountId: ID_A } })

    assert.equal(answer.status, 200)
    // The three keys the panel reads, by name.
    for (const key of ['probe', 'credentialState', 'credits']) {
      assert.ok(Object.keys(answer.body).includes(key), `/accounts/test is missing ${key}`)
    }
    assert.equal(answer.body.probe.outcome, 'expired')
    assert.equal(answer.body.credentialState, 'usable')
    assert.equal(answer.body.credits, null)

    const list = await app.call('/accounts')
    const [projection] = list.body.accounts
    assert.equal(projection.disabledReason, 'expired')
    // AC1: an expired sign-in credential MARKS the account, it does not disable
    // it. The model key it still holds is the reason the account stays usable.
    assert.equal(projection.enabled, true)
    assert.equal(projection.usable, true)
    assert.equal(projection.credits, null)
    assert.equal(projection.excludedBy?.reason, 'expired')
  } finally { app.cleanup() }
})

test('a named account is described by /state without moving billing', async t => {
  // Two accounts with visibly different per-account documents: A has a model key
  // and a check-in record, B has neither.
  const app = await mount(t, { accounts: [account(ID_A), account(ID_B)], activeId: ID_A, vault: { [ID_A]: ROOT_CREDENTIALS } })
  try {
    const owned = ensureAccountDirs(accountPaths(app.paths, ID_A))
    writeFileSync(owned.modelKey, JSON.stringify({ key: 'sk-as-for-A', source: 'pasted', fetchedAt: 7 }), { mode: 0o600 })

    const billing = await app.call('/state')
    assert.equal(billing.body.modelKey.configured, true)
    assert.equal(billing.body.activeAccountId, ID_A)

    // The panel pins an account for VIEWING: the per-account fields follow it...
    const viewed = await app.call(`/state?accountId=${ID_B}`)
    assert.equal(viewed.status, 200)
    assert.equal(viewed.body.modelKey.configured, false)
    assert.equal(viewed.body.credits.config.credentialState, 'none')
    // ...while the pool and the billing choice stay install-wide and unchanged.
    assert.equal(viewed.body.activeAccountId, ID_A)
    assert.equal(viewed.body.pool.count, 2)
    assert.equal(viewed.body.accounts.length, 2)

    // Looking at an account is not a switch.
    const after = await app.call('/accounts')
    assert.equal(after.body.activeAccountId, ID_A)
  } finally { app.cleanup() }
})

test('a POST body names the account just as a query string does', async t => {
  const app = await mount(t, { accounts: [account(ID_A), account(ID_B)], activeId: ID_A, vault: { [ID_A]: ROOT_CREDENTIALS, [ID_B]: ROOT_CREDENTIALS } })
  try {
    // The panel's `post()` helper puts `accountId` in the JSON body, never in the
    // query string, so both routes to the same answer must work.
    const answer = await app.call('/model-key', { method: 'POST', body: { accountId: ID_B, key: 'sk-as-written-to-B' } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.configured, true)

    const forB = JSON.parse(readFileSync(join(app.paths.vaultDir, 'accounts', ID_B, 'model-key.json'), 'utf8'))
    assert.equal(forB.key, 'sk-as-written-to-B')
    // The other account's key file was not touched by a write aimed at B.
    assert.ok(!existsSync(join(app.paths.vaultDir, 'accounts', ID_A, 'model-key.json')))

    // Reading it back through the same seam agrees.
    const readBack = await app.call(`/model-key?accountId=${ID_B}`)
    assert.equal(readBack.body.configured, true)
    assert.equal(readBack.body.mask, maskForTest('sk-as-written-to-B'))
  } finally { app.cleanup() }
})

/** The mask `as.js` produces, spelled out here so the test is not self-referential. */
function maskForTest(value) {
  return `${value.slice(0, 8)}…${value.slice(-4)} (len ${value.length})`
}

test('a probe keeps a network failure out of the disabled reason', async t => {
  const app = await mount(t, {
    accounts: [account(ID_A)],
    vault: { [ID_A]: ROOT_CREDENTIALS },
    fetch: async () => { throw new Error('fetch failed') },
  })
  try {
    const answer = await app.call('/accounts/test', { method: 'POST', body: { accountId: ID_A } })

    assert.equal(answer.status, 200)
    assert.equal(answer.body.probe.outcome, 'network')
    assert.ok(answer.body.probe.retryAtMs > 0, 'a transport failure must start a cooldown')

    const list = await app.call('/accounts')
    const [projection] = list.body.accounts
    // Q10: a blip is a measurement, not a verdict about the credential.
    assert.equal(projection.disabledReason, null)
    assert.equal(projection.enabled, true)
    assert.equal(projection.excludedBy.reason, 'cooldown')
  } finally { app.cleanup() }
})

test('a bare /usage query means the usage ledger, not an error', async t => {
  // Regression. `as.js` defaults `type` with `?? 'usage'`, so an EMPTY STRING
  // slips past it into the engine's enum check and the route answered 400 for a
  // request that named no filter at all. The empty-pool test above could never
  // catch this: with no account the route short-circuits before the engine.
  // The client always sends `type=usage`, which is exactly why this survived.
  const app = await mount(t, {
    rootCredentials: true,
    fetch: async url => {
      const asked = String(url)
      if (!asked.includes('type=usage')) throw new Error(`usage was asked without a type: ${asked}`)
      return {
        ok: true,
        status: 200,
        async json() { return { code: 0, data: { items: [], total: 0, page: 1, page_size: 20 } } },
        async text() { return JSON.stringify({ code: 0, data: { items: [], total: 0, page: 1, page_size: 20 } }) },
      }
    },
  })
  try {
    const bare = await app.call('/usage')
    assert.equal(bare.status, 200)
    assert.equal(bare.body.type, 'usage')

    // An explicit redeem still reaches the engine as redeem.
    const redeem = await mount(t, {
      rootCredentials: true,
      fetch: async url => {
        if (!String(url).includes('type=redeem')) throw new Error(`redeem was not forwarded: ${String(url)}`)
        return {
          ok: true,
          status: 200,
          async json() { return { code: 0, data: { items: [], total: 0, page: 1, page_size: 20 } } },
          async text() { return JSON.stringify({ code: 0, data: { items: [], total: 0, page: 1, page_size: 20 } }) },
        }
      },
    })
    try {
      const answer = await redeem.call('/usage?type=redeem')
      assert.equal(answer.status, 200)
      assert.equal(answer.body.type, 'redeem')
    } finally { redeem.cleanup() }
  } finally { app.cleanup() }
})

test('an empty pool still answers every read endpoint instead of failing', async t => {
  const app = await mount(t, {})
  try {
    // Each of these is polled by the panel before an account exists. A 500 would
    // surface as a red banner on a screen that is simply waiting for its first
    // account, so they all answer 200 with an empty document.
    const usage = await app.call('/usage')
    assert.equal(usage.status, 200)
    assert.deepEqual(usage.body.items, [])
    assert.equal(usage.body.total, 0)
    assert.deepEqual(usage.body.sum, { credits: 0, inputTokens: 0, outputTokens: 0, count: 0 })

    const pricing = await app.call('/pricing')
    assert.equal(pricing.status, 200)
    assert.deepEqual(pricing.body, { data: { groups: [], active_promotion: null } })

    const checkin = await app.call('/checkin/state')
    assert.equal(checkin.status, 200)
    assert.equal(checkin.body.status, 'idle')
    assert.equal(checkin.body.timezone, 'Asia/Shanghai')

    const log = await app.call('/log')
    assert.equal(log.status, 200)
    assert.deepEqual(log.body, { log: [], total: 0 })

    const key = await app.call('/model-key')
    assert.equal(key.status, 200)
    assert.deepEqual(key.body, { configured: false, mask: '', source: '', fetchedAt: 0 })

    // A WRITE still needs an account to write to, and says so as a 400.
    const write = await app.call('/model-key', { method: 'POST', body: { key: 'sk-as-x' } })
    assert.equal(write.status, 400)
    assert.match(write.body.error, /no account/i)
  } finally { app.cleanup() }
})

test('the pool endpoints keep the guard rails the panel mirrors', async t => {
  const app = await mount(t, {
    accounts: [account(ID_A), account(ID_B, { enabled: false, disabledReason: 'manual' })],
    vault: { [ID_A]: ROOT_CREDENTIALS },
  })
  try {
    // The only ENABLED account cannot be disabled: the panel mirrors this rule,
    // and the host still has the final word.
    const disable = await app.call('/accounts/enable', { method: 'POST', body: { accountId: ID_A, enabled: false } })
    assert.equal(disable.status, 400)
    assert.match(disable.body.error, /last usable account/i)

    // A disabled account cannot be made the billing one.
    const switchToDisabled = await app.call('/accounts/switch', { method: 'POST', body: { accountId: ID_B } })
    assert.equal(switchToDisabled.status, 400)
    assert.match(switchToDisabled.body.error, /disabled/i)

    // Renaming is a plain edit and answers with the full projection.
    const renamed = await app.call('/accounts/rename', { method: 'POST', body: { accountId: ID_A, label: '  主账号  ' } })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.accounts.find(row => row.id === ID_A).label, '主账号')
    assert.equal(renamed.body.activeAccountId, ID_A)

    // A POST that names no account at all is a caller bug, not a default.
    const nameless = await app.call('/accounts/remove', { method: 'POST', body: {} })
    assert.equal(nameless.status, 400)
  } finally { app.cleanup() }
})

test('the automatic-selection preference is persisted and reported back', async t => {
  const app = await mount(t, { accounts: [account(ID_A)], vault: { [ID_A]: ROOT_CREDENTIALS } })
  try {
    const on = await app.call('/accounts/auto-switch', { method: 'POST', body: { enabled: true, thresholdPct: 35 } })
    assert.equal(on.status, 200)
    assert.deepEqual(on.body.autoSwitch, { enabled: true, thresholdPct: 35 })

    // The preference survives a restart: it is the pool document, not memory.
    const document = JSON.parse(readFileSync(accountsFile(app.paths), 'utf8'))
    assert.deepEqual(document.autoSwitch, { enabled: true, thresholdPct: 35 })

    // And `/state` reports it as aggregate state, never as the runtime object.
    const state = await app.call('/state')
    assert.deepEqual(state.body.pool.autoSwitch, { enabled: true, thresholdPct: 35 })

    const off = await app.call('/accounts/auto-switch', { method: 'POST', body: { enabled: false } })
    assert.equal(off.body.autoSwitch.enabled, false)
    // An omitted threshold keeps the stored one rather than resetting it.
    assert.equal(off.body.autoSwitch.thresholdPct, 35)
  } finally { app.cleanup() }
})

test('removing an account hands billing over and takes its directory with it', async t => {
  const app = await mount(t, {
    accounts: [account(ID_A), account(ID_B)],
    activeId: ID_A,
    vault: { [ID_A]: ROOT_CREDENTIALS, [ID_B]: ROOT_CREDENTIALS },
  })
  try {
    const removedDir = join(app.paths.vaultDir, 'accounts', ID_A)
    assert.ok(existsSync(removedDir), 'the fixture did not create the account directory')

    const answer = await app.call('/accounts/remove', { method: 'POST', body: { accountId: ID_A } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.accounts.length, 1)
    // Billing moved to the remaining usable account.
    assert.equal(answer.body.activeAccountId, ID_B)

    // Every account is an ordinary one, so its own directory goes with it. The
    // root credential files are untouched either way: they belong to the install,
    // not to any account.
    assert.equal(existsSync(removedDir), false, 'the removed account left its directory behind')

    // A removal is durable: it is gone from the document, not merely filtered.
    const document = JSON.parse(readFileSync(accountsFile(app.paths), 'utf8'))
    assert.deepEqual(document.accounts.map(row => row.id), [ID_B])
  } finally { app.cleanup() }
})

test('a removed non-legacy account takes its own directory with it', async t => {
  const app = await mount(t, { accounts: [account(ID_A), account(ID_B)], vault: { [ID_A]: ROOT_CREDENTIALS, [ID_B]: ROOT_CREDENTIALS } })
  try {
    const own = join(app.paths.vaultDir, 'accounts', ID_B)
    assert.ok(existsSync(own), 'the fixture did not create the account directory')

    const answer = await app.call('/accounts/remove', { method: 'POST', body: { accountId: ID_B } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.accounts.length, 1)
    assert.ok(!existsSync(own), 'a removed account left its vault behind')
  } finally { app.cleanup() }
})
