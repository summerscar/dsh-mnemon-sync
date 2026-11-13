/**
 * AgentScope Platform — where this plugin keeps its own state.
 *
 * The directory is OURS, and it is resolved the same way the WorkBuddy connector
 * resolves its own (MIT, Copyright (c) 2026 LaoDing): `$DSH_HOME` when the host
 * set it, otherwise `<home>/dsh`. Nothing else in the deployment is touched, no
 * other plugin's folder is reused, and an operator can move the whole plugin's
 * state by moving one directory.
 *
 * Layout, mirroring the connector's split between small "point files" and a
 * credential subdirectory:
 *
 *   <root>/
 *     connect-agentscope-platform-settings.json   browser/UI settings, provider switch, catalog
 *     connect-agentscope-platform-log.json        credit snapshot history
 *     connect-agentscope-platform-checkin.json    today's check-in record
 *     connect-agentscope-platform-litellm.json    cached model-metadata table (large)
 *     vault/
 *       login.json                        login token pair (0600)
 *       model-key.json                    the sk-as-… model key (0600)
 *
 * WHY THE CREDENTIALS LIVE IN A SUBDIRECTORY: they are the only files that must
 * never be copied, synced or printed by accident. Keeping them apart means a
 * backup rule or an `ls` of the state root does not even see them.
 *
 * WHY NOT the harness's own settings document: none of this is a credential in
 * the harness's sense, but all of it is plugin-internal state that must survive a
 * restart even where a profile's settings file is read-only.
 *
 * @module dsh-connect-agentscope-platform/paths
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'

/** The environment variable the host uses to relocate its data directory. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name under the user's home when `$DSH_HOME` is absent. */
export const DSH_HOME_DIR_NAME = 'dsh'

/** This plugin's own folder name under the data root. */
export const STATE_DIR_NAME = 'connect-agentscope-platform'

/** Prefix for the point files inside the state directory. */
export const FILE_PREFIX = 'connect-agentscope-platform'

/** The account-pool document: which accounts exist and which one is billed to. */
export const ACCOUNTS_FILE = 'connect-agentscope-platform-accounts.json'

/** The measurement log: probe outcomes and credit snapshots, per account. */
export const MEASUREMENTS_FILE = 'connect-agentscope-platform-measurements.json'

/**
 * Account ids are directory names under `vault/accounts/`, so the allowed shape
 * is also the traversal guard: exactly 24 lowercase hex digits, and nothing
 * else. Every account has that shape, so there is no reserved id and no second
 * form to special-case.
 */
export const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/

/** Expand a leading `~` (the host accepts an expanded path, not a shell string). */
function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the harness data root.
 *
 * A relative result would silently land next to the process's working directory,
 * which is never what a data directory means, so it is resolved to an absolute
 * path before use.
 *
 * @param {string | undefined} configured - an explicit override, when one exists
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env[DSH_HOME_ENV]
  const chosen = configured ?? (typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME))
  return resolve(expandHomePath(chosen))
}

/**
 * Resolve this plugin's state directory: `<data root>/data/<STATE_DIR_NAME>`.
 *
 * `data/` matches where the deployment already keeps other plugin working
 * directories, so an operator looking for them finds this one beside the rest.
 *
 * @param {{ dshHome?: string }} [options]
 * @returns {string} absolute path
 */
export function resolveStateDir(options = {}) {
  const root = resolveDshHome(options.dshHome)
  return resolve(root, 'data', STATE_DIR_NAME)
}

/** Create a directory (and its parents) with owner-only permissions. */
export function ensureDir(dir) {
  if (existsSync(dir)) {
    try {
      // A pre-existing directory may carry looser permissions; tighten it.
      if ((statSync(dir).mode & 0o077) !== 0) mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch { /* best effort */ }
    return dir
  }
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* best effort */ }
  return dir
}

/**
 * Every path this plugin owns, resolved once.
 *
 * Credentials live under `vault/`; everything else is a point file at the root.
 *
 * @param {{ dshHome?: string }} [options]
 */
export function pluginPaths(options = {}) {
  const stateDir = resolveStateDir(options)
  const vaultDir = join(stateDir, 'vault')
  return {
    stateDir,
    vaultDir,
    settings: join(stateDir, 'connect-agentscope-platform-settings.json'),
    log: join(stateDir, 'connect-agentscope-platform-log.json'),
    checkin: join(stateDir, 'connect-agentscope-platform-checkin.json'),
    metaCache: join(stateDir, 'connect-agentscope-platform-litellm.json'),
    login: join(vaultDir, 'login.json'),
    modelKey: join(vaultDir, 'model-key.json'),
  }
}

/**
 * Where the account-pool document lives.
 *
 * A helper rather than an extra key on {@link pluginPaths}: that object's key
 * set is what `CreditEngine` and `CheckinScheduler` destructure, and the
 * single-account layout it describes must keep meaning exactly what it meant
 * before the pool existed.
 *
 * @param {ReturnType<typeof pluginPaths>} paths
 */
export function accountsFile(paths) {
  return join(paths.stateDir, ACCOUNTS_FILE)
}

/** Where the measurement log lives (see {@link accountsFile} on why not a key). */
export function measurementsFile(paths) {
  return join(paths.stateDir, MEASUREMENTS_FILE)
}

/**
 * The paths one account owns, in the same shape as {@link pluginPaths}.
 *
 * Only the four per-account files move: credentials, the credit snapshot
 * history and the check-in record are per-account state, while the settings
 * document, the metadata cache and the two pool documents describe the whole
 * install and therefore stay at the state root. Returning the same key set as
 * `pluginPaths()` is what lets `CreditEngine` and `CheckinScheduler` accept this
 * object unchanged — they read `paths.login` / `paths.log` / `paths.checkin`
 * and never need to know which account they belong to.
 *
 * The id is validated here rather than trusted from a caller: it becomes a
 * directory name, and `..` in a directory name is how a plugin writes outside
 * its own state directory.
 *
 * @param {ReturnType<typeof pluginPaths>} base - the install-wide paths
 * @param {string} id - a validated account id
 * @returns {ReturnType<typeof pluginPaths>} that account's paths
 */
export function accountPaths(base, id) {
  if (!base || typeof base !== 'object') throw new TypeError('accountPaths needs the base paths from pluginPaths()')
  if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) throw new TypeError(`invalid account id: ${JSON.stringify(id)}`)
  if (!isInside(base.vaultDir, join(base.vaultDir, 'accounts', id))) throw new TypeError(`account id escapes the vault: ${JSON.stringify(id)}`)

  const dir = join(base.vaultDir, 'accounts', id)
  return {
    ...base,
    login: join(dir, 'login.json'),
    modelKey: join(dir, 'model-key.json'),
    log: join(dir, 'log.json'),
    checkin: join(dir, 'checkin.json'),
  }
}

/** The directory holding every account's own vault. */
export function accountsDir(base) {
  return join(base.vaultDir, 'accounts')
}

/** Create the state root, the vault, and the per-account vault root. */
export function ensureStateDirs(paths) {
  ensureDir(paths.stateDir)
  ensureDir(paths.vaultDir)
  // One directory per account holds credentials, so it is owner-only like the
  // vault itself and is created eagerly: a later `writeFileSync` must never be
  // the thing that creates a world-readable parent.
  ensureDir(join(paths.vaultDir, 'accounts'))
  return paths
}

/**
 * Create everything one account's paths need, then return them.
 *
 * `CreditEngine` and `CheckinScheduler` create the state root and the vault but
 * know nothing about per-account directories, and neither writes a directory of
 * its own — they expect the caller to have made it. That caller is this
 * function, and it runs *before* either class is constructed so a first save
 * cannot fail on a missing parent.
 *
 * @param {ReturnType<typeof pluginPaths>} paths - from {@link accountPaths}
 */
export function ensureAccountDirs(paths) {
  ensureStateDirs(paths)
  ensureDir(join(paths.vaultDir, 'accounts', accountIdOf(paths)))
  return paths
}

/**
 * Recover the account id from a path set built by {@link accountPaths}.
 *
 * The credential path is `<vault>/accounts/<id>/login.json`, so the id is the
 * directory two levels up from `login`. Kept private-ish (exported for the
 * runtime's logging only) so callers do not re-derive the layout by hand.
 *
 * @param {ReturnType<typeof pluginPaths>} paths
 * @returns {string}
 */
export function accountIdOf(paths) {
  const marker = `${sep}accounts${sep}`
  const index = paths.login.lastIndexOf(marker)
  if (index === -1) throw new TypeError('these paths do not belong to an account')
  const rest = paths.login.slice(index + marker.length)
  const id = rest.slice(0, rest.indexOf(sep))
  if (!ACCOUNT_ID_RE.test(id)) throw new TypeError(`invalid account id: ${JSON.stringify(id)}`)
  return id
}

/** Whether `child` is `parent` itself or lives under it (both resolved first). */
export function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}
