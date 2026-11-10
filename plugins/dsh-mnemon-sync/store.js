/**
 * Mnemon Sync — settings store.
 *
 * Settings live in `<dataRoot>/state/mnemon-sync.json` at mode 0600, never in
 * the DSH profile patch. Two reasons, both learned from how dsh-mnemon keeps
 * its own Git credentials:
 *
 * - The profile patch is plain text that the DSH UI renders and that any
 *   profile backup copies wholesale; a WebDAV password or S3 secret key has no
 *   business there.
 * - `state/` is deliberately not part of a Mnemon Pack, so a backup never
 *   carries the secret that unlocks the backup target.
 *
 * The file is written whole through a temporary sibling, so a crash mid-write
 * leaves the previous settings intact instead of a truncated JSON file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'mnemon-sync.json'
const DIRECTORY = 'state'

/**
 * The intervals the settings page offers, in minutes.
 *
 * Copied from dsh-mnemon's own Git auto-backup so the two backup surfaces read
 * the same: off, hourly, 3/6/12 hours, daily, every 3 days, weekly. A value
 * outside this list is still accepted when a profile sets one by hand — the
 * list only constrains what the UI offers.
 */
export const AUTO_SYNC_CHOICES = [0, 60, 180, 360, 720, 1440, 4320, 10080]

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  // The Mnemon home to read. Empty means "whatever this Host resolves on its
  // own" — the `MNEMON_DATA_DIR` environment variable, else `~/.mnemon`. It is
  // stored rather than hard-coded because dsh-mnemon's real root can be
  // `workspace`, `custom` or `workspaces`, and this plugin only receives `{}`
  // as a third-party Source's configuration, so it cannot look the value up.
  mnemonHome: '',
  target: { kind: 'webdav', url: '', username: '', password: '', remotePath: 'mnemon-sync' },
  // Which dsh-mnemon components a backup carries. All three by default: a
  // backup that silently omits memory spaces would be the worst default.
  components: ['memory-spaces', 'documents', 'runtime'],
  // One number, as dsh-mnemon's Git channel stores it: 0 means "only when you
  // press the button", anything else is a whole number of minutes. Keeping the
  // representation identical avoids a second vocabulary for the same idea.
  autoSyncMinutes: 0,
  retention: { keep: 14 },
})

export function settingsPath(dataRoot) {
  return join(dataRoot, DIRECTORY, FILE)
}

/** Read settings, falling back to defaults for anything missing or malformed. */
export function readSettings(dataRoot) {
  const path = settingsPath(dataRoot)
  if (!existsSync(path)) return clone(DEFAULT_SETTINGS)
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    return normalizeSettings(stored)
  } catch {
    // A hand-edited file with a stray comma must not stop a backup from
    // running with sane defaults; the settings page shows the defaults back.
    return clone(DEFAULT_SETTINGS)
  }
}

export function writeSettings(dataRoot, value) {
  const normalized = normalizeSettings(value)
  const path = settingsPath(dataRoot)
  mkdirSync(join(dataRoot, DIRECTORY), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  try {
    renameSync(temporary, path)
  } catch (error) {
    // Platforms that cannot replace an existing file keep the old content.
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
    throw error
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort on filesystems with no POSIX modes.
  }
  return normalized
}
/** Coerce arbitrary input into the exact shape the uploaders and timer expect. */
export function normalizeSettings(raw) {
  const source = isRecord(raw) ? raw : {}
  return {
    enabled: source.enabled === true,
    mnemonHome: normalizeOptionalPath(source.mnemonHome),
    target: normalizeTargetSettings(source.target),
    components: normalizeComponents(source.components),
    autoSyncMinutes: normalizeAutoSyncMinutes(source.autoSyncMinutes),
    retention: {
      keep: clampInt(source.retention?.keep, 1, 365, 14),
    },
  }
}

/**
 * An optional directory the operator typed. Empty means "use the Host's own
 * answer", so an absent, blank or whitespace-only value all collapse to `''`
 * rather than pinning whatever the process happened to resolve that day --
 * a pinned path would silently go stale when `MNEMON_DATA_DIR` changes.
 */
function normalizeOptionalPath(value) {
  const text = String(value ?? '').trim()
  return text === '' ? '' : text
}

/**
 * Which components a backup carries.
 *
 * An absent value means "everything", which is what a caller that sends only
 * what it changed expects. An explicit empty list is a mistake rather than a
 * choice — a backup of nothing is not a backup — so it falls back too.
 */
function normalizeComponents(value) {
  if (value === undefined || value === null) return [...DEFAULT_SETTINGS.components]
  const requested = Array.isArray(value) ? value.map(String) : []
  const known = DEFAULT_SETTINGS.components.filter((component) => requested.includes(component))
  return known.length === 0 ? [...DEFAULT_SETTINGS.components] : known
}

/**
 * One interval in minutes. Zero disables the timer; anything else is clamped to
 * the same ceiling dsh-mnemon's form uses, so a typo cannot schedule a run a
 * year out.
 */
export function normalizeAutoSyncMinutes(value) {
  if (value === null || value === undefined || value === '') return 0
  const minutes = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080) return 0
  return minutes
}

function normalizeTargetSettings(raw) {
  const source = isRecord(raw) ? raw : {}
  const kind = source.kind === 's3' ? 's3' : 'webdav'
  if (kind === 'webdav') {
    return {
      kind,
      url: String(source.url ?? ''),
      username: String(source.username ?? ''),
      password: String(source.password ?? ''),
      remotePath: normalizeRemotePath(source.remotePath),
    }
  }
  return {
    kind,
    endpoint: String(source.endpoint ?? ''),
    bucket: String(source.bucket ?? ''),
    region: String(source.region ?? '') || 'auto',
    accessKeyId: String(source.accessKeyId ?? ''),
    secretAccessKey: String(source.secretAccessKey ?? ''),
    sessionToken: String(source.sessionToken ?? ''),
    remotePath: normalizeRemotePath(source.remotePath),
    forcePathStyle: source.forcePathStyle === true,
  }
}

function normalizeRemotePath(value) {
  const text = String(value ?? '').trim().replace(/^\/+/u, '').replace(/\/+$/u, '')
  return text === '' ? 'mnemon-sync' : text
}

function clampInt(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const integer = Math.floor(number)
  if (integer < minimum) return minimum
  if (integer > maximum) return maximum
  return integer
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * The public view of settings: identical to what is stored, except that a
 * secret is reported by presence rather than by value. The UI needs to know a
 * password is set without being handed it, so a screenshot or a support paste
 * never leaks the target credentials.
 */
export function maskSettings(settings) {
  const masked = clone(settings)
  if (masked.target.kind === 'webdav') {
    masked.target.password = masked.target.password === '' ? '' : '••••••••'
  } else {
    masked.target.secretAccessKey = masked.target.secretAccessKey === '' ? '' : '••••••••'
    masked.target.sessionToken = masked.target.sessionToken === '' ? '' : '••••••••'
  }
  return masked
}
