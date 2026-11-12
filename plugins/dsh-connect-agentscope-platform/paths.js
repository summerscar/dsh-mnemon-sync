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


/** Create the state root and the vault. */
export function ensureStateDirs(paths) {
  ensureDir(paths.stateDir)
  ensureDir(paths.vaultDir)
  return paths
}

/** Whether `child` is `parent` itself or lives under it (both resolved first). */
export function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}
