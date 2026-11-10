/**
 * Mnemon Sync — Host half.
 *
 * Backs up the whole `<MNEMON_DATA_DIR>/data` directory — every memory space
 * database, not just `default` — and ships it to an S3-compatible bucket or a
 * WebDAV collection.
 *
 * Why not litestream: it replicates *one* database per instance, and in v0.5 a
 * database accepts exactly one replica, so directory-level backup would mean
 * one long-lived process per space plus dynamic reconfiguration whenever a
 * space is added. It also holds the WAL open, which makes dsh-mnemon's own
 * Pack export fail its `-wal is not checkpointed` check. `node:sqlite`'s
 * `backup()` gives a transaction-consistent copy of each live database with no
 * resident process, which is both simpler and compatible with the store.
 *
 * The browser half only ever sees JSON: credentials are masked on the way out
 * and are never echoed back by a read. The memory Source that owns the page is
 * a separate Cordis entry (./source.js), mounted by the bundle patch.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { SyncHistory, SyncScheduler } from './scheduler.js'
import {
  COMPONENTS,
  COMPONENT_DIRECTORIES,
  MEMORY_SPACE_DATABASE_FILE,
  buildSnapshot,
  inspectHome,
  isSystemJunk,
  readSpaceNames,
  verifySnapshot,
} from './snapshot.js'
import { skillFileDestination, skillRoots, skillsDataDestination } from './skills.js'
import { createZip, readZip } from './zip.js'
import { deleteArchive, downloadArchive, listArchives, normalizeTarget, uploadArchive } from './targets.js'
import { maskSettings, normalizeSettings, readSettings, settingsPath, writeSettings } from './store.js'

const API_PREFIX = '/api/mnemon-sync'
const ARCHIVE_PREFIX = 'mnemon-sync-'

/**
 * Which build of this module is actually loaded.
 *
 * Bump the suffix on every change to the Host half. It answers a question no
 * other signal can: HMR reloads this file without restarting the container, so
 * a browser refresh, a 200 from the API and a working page all stay true while
 * the *old* module is still the one running. Telling "the new code is live"
 * apart from "the old code happens to answer" needs a value that only the new
 * source can produce, which is exactly this constant.
 *
 * Read it from `GET /api/mnemon-sync/status` (`build`), or grep the response
 * before trusting any conclusion about whether a change took effect.
 */
export const BUILD = 'mnemon-sync-2026-11-11.3'

export const name = 'dsh-mnemon-sync'
// `connection` gates every HTTP route below. `mnemonMemory` stays optional on
// purpose: the plugin still backs up on a profile where dsh-mnemon is absent
// or too old to accept Sources, it just cannot offer its page there.
export const inject = ['webServer', 'connection']

/**
 * Expand the one shorthand dsh-mnemon accepts in its own storage settings: a
 * leading `~` (or `~\` on Windows) means the OS home directory. dsh-mnemon's
 * `canonical()` does exactly this, so a `MNEMON_DATA_DIR=~/mnemon` value that
 * works there must not turn into a literal `~` directory here.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * The Mnemon home this Host resolves on its own, with no in-page override.
 *
 * `MNEMON_DATA_DIR` names it when set; otherwise it is `~/.mnemon`, resolved
 * through `os.homedir()`.
 *
 * `homedir()` is used instead of `process.env.HOME` on purpose. Windows does
 * not define `HOME` (it uses `USERPROFILE`), so reading `HOME` yields
 * `undefined`, `join('', '.mnemon')` degrades to the *relative* path
 * `.mnemon`, and `resolve()` anchors it at the process working directory —
 * which for the desktop app is `<DSH_HOME>/profiles/desktop`. The reported
 * root was then a folder that holds no memory at all. `homedir()` follows the
 * platform's own rule, matching how dsh-mnemon's `globalRoot()` resolves it.
 *
 * `config.dataRoot` is the Host-level entry option and names the *data*
 * directory (`<home>/data`), so its parent is the home.
 */
export function resolveHome(config = {}) {
  if (typeof config.dataRoot === 'string' && config.dataRoot.trim() !== '') {
    return resolve(resolve(expandHome(config.dataRoot.trim())), '..')
  }
  const fromEnvironment = process.env.MNEMON_DATA_DIR?.trim()
  return fromEnvironment === undefined || fromEnvironment === ''
    ? join(homedir(), '.mnemon')
    : resolve(expandHome(fromEnvironment))
}

/**
 * The home actually read and backed up: the page's own override when set,
 * else whatever {@link resolveHome} reports.
 *
 * The override exists because dsh-mnemon's real root is not always `global`:
 * its `storageScope` may be `workspace`, `custom` or `workspaces`, and a
 * third-party Source only ever receives `{}` as configuration (the Host passes
 * `dataDir` to its built-in sources alone), so this plugin cannot look the
 * value up. An empty string means "follow the Host", which keeps the default
 * correct without pinning a path that a later environment change would stale.
 */
export function resolveEffectiveHome(configuredHome, config = {}) {
  const text = typeof configuredHome === 'string' ? configuredHome.trim() : ''
  return text === '' ? resolveHome(config) : resolve(expandHome(text))
}

/** Backwards-compatible helper: the `<home>/data` directory. */
export function resolveDataRoot(config = {}) {
  if (typeof config.dataRoot === 'string' && config.dataRoot.trim() !== '') {
    return resolve(expandHome(config.dataRoot.trim()))
  }
  return join(resolveHome(config), 'data')
}

function sendJson(res, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/**
 * The name this machine goes by in an archive name.
 *
 * Read from dsh-mnemon's own identity file (`state/machine.json`) so a backup
 * uploaded from several machines stays tellable apart. Falls back to the
 * hostname, then to a fixed word, so the key never ends up with an empty
 * segment. Characters that would be awkward in a filename — slashes, spaces,
 * anything a WebDAV path segment must escape — collapse to a single dash.
 */
export function deviceName(home) {
  let label = ''
  try {
    const identity = JSON.parse(readFileSync(join(home, 'state', 'machine.json'), 'utf8'))
    if (typeof identity?.label === 'string') label = identity.label
  } catch {
    // No identity file yet: the hostname is the same fallback dsh-mnemon uses.
  }
  if (label.trim() === '') {
    try {
      label = hostname()
    } catch {
      label = ''
    }
  }
  const cleaned = label.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return cleaned === '' ? 'device' : cleaned.slice(0, 60)
}

/**
 * `mnemon-sync-<device>-2026-11-09T00-53-57.903Z.zip`
 *
 * The device name sits after the prefix and before the timestamp, so archives
 * from different machines sort together by time within one device and are
 * still obvious at a glance in a shared folder.
 */
export function archiveKey(at = new Date(), device = 'device') {
  const stamp = at.toISOString().replace(/:/gu, '-')
  return `${ARCHIVE_PREFIX}${device}-${stamp}.zip`
}
export function apply(ctx, config = {}) {
  // Where this plugin keeps its *own* state — settings, run history, the
  // staging workroot. Deliberately fixed to the Host-resolved home and never
  // to the page's override: the override lives inside `state/`, so letting it
  // decide where `state/` is would make the settings file read itself.
  const stateHome = resolveHome(config)
  const workRoot = join(stateHome, 'state', 'mnemon-sync-work')

  const history = new SyncHistory(stateHome)
  const settings = () => readSettings(stateHome)

  const performBackup = async (trigger, current, signal) => {
    if (current.enabled !== true && trigger === 'schedule') {
      return { skipped: 'disabled' }
    }
    const home = resolveEffectiveHome(current.mnemonHome, config)
    const target = normalizeTarget(current.target)
    const staging = join(workRoot, `build-${String(Date.now())}`)
    mkdirSync(staging, { recursive: true })
    const startedAt = new Date().toISOString()
    try {
      const snapshot = await buildSnapshot(home, staging, { components: current.components })
      verifySnapshot(staging)
      const key = archiveKey(new Date(), deviceName(home))
      const archive = createZip(collect(staging), { level: 6 })
      const uploaded = await uploadArchive(target, key, archive, { signal })
      const removed = await applyRetention(history, target, current.retention.keep, { signal })
      const record = {
        id: `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: true,
        trigger,
        durationMs: Date.now() - Date.parse(startedAt),
        // What actually shipped, so the history row can say "3 components"
        // rather than assuming memory spaces were involved.
        components: snapshot.manifest.components,
        spaces: countSpaces(snapshot.manifest),
        files: snapshot.files.length,
        bytes: archive.length,
        key,
        location: uploaded.location,
        removed,
      }
      history.append(record)
      return record
    } catch (error) {
      history.append({
        id: `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: false,
        trigger,
        durationMs: Date.now() - Date.parse(startedAt),
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  const scheduler = new SyncScheduler({
    readSettings: settings,
    run: performBackup,
    onError: () => {
      // History already records the failure; the timer must stay silent.
    },
  })

  ctx.effect(() => scheduler.start(), 'mnemon-sync: scheduler')

  // Register the Source that owns the sync page.
  //
  // dsh-mnemon shows a page tab only when its `sourceTypeId` appears in the
  // live source catalog, and that catalog lists running Source implementations
  // — not UI contributions. Standing up this minimal Source is what lets the
  // page use its own type instead of borrowing `memory-spaces`, which is the
  // only way its tab can highlight independently.

  /**
   * Admit only requests the Host's connection service vouches for.
   *
   * These routes read credentials, trigger uploads and can restore files onto
   * disk, so an unauthenticated local request must never reach them. Follow
   * the current `requestRejection(req)` contract (undefined = admit, or an
   * HTTP status); older Hosts exposing only `authorizeIndex` still work.
   * If neither is available, reject rather than falling back to Host/Origin
   * or loopback checks — a missing guard is not a reason to open the route.
   */
  const rejected = (req, res) => {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection === undefined || connection === null) {
      res.statusCode = 401
      res.end()
      return true
    }
    if (typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end()
      return true
    }
    if (typeof connection.authorizeIndex === 'function') {
      // `authorizeIndex` answers the response itself when it rejects; its
      // boolean says which way it went.
      return connection.authorizeIndex(req, res) === false
    }
    res.statusCode = 401
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      if (rejected(req, res)) return
      void handle(req, res).catch((error) => {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    },
  }), 'mnemon-sync: http api')

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mnemon-sync.invalid')
    const route = url.pathname.slice(API_PREFIX.length) || '/'

    if (req.method === 'GET' && route === '/status') {
      const current = settings()
      const home = resolveEffectiveHome(current.mnemonHome, config)
      const state = inspectHome(home)
      sendJson(res, 200, {
        // The identity of the running module, not of the files on disk. See the
        // comment on BUILD: this is the only field that can prove a reload.
        build: BUILD,
        dataRoot: join(home, 'data'),
        stateHome,
        settingsPath: settingsPath(stateHome),
        workRoot,
        home,
        hostHome: resolveHome(config),
        state,
        // Hoisted out of `components['skill-files']` because the roots are worth
        // showing even when the component itself is empty — "neither root has a
        // skill yet" is a useful thing to read before pressing backup.
        skillRoots: state.skillRoots,
        settings: maskSettings(current),
        scheduler: scheduler.snapshot(current),

        history: history.read(),
        spaceNames: Object.fromEntries(readSpaceNames(home)),
      })
      return
    }

    if (req.method === 'PUT' && route === '/settings') {
      const body = await readJsonBody(req)
      const incoming = body?.settings ?? body
      const saved = writeSettings(stateHome, normalizeSettings(restoreMaskedSecrets(incoming, settings())))
      scheduler.refresh()
      sendJson(res, 200, { settings: maskSettings(saved) })
      return
    }

    if (req.method === 'POST' && route === '/run') {
      // An unsaved edit followed by "Back up now" must back up what the user is
      // looking at, not what was last saved. When the page sends its draft, it
      // is normalized and saved first — so the button never silently ignores a
      // change — and the run then reads that same saved state.
      const body = await readJsonBody(req)
      try {
        if (body?.settings !== undefined) {
          // The same masked-secret rule as saving settings: the page always
          // sends the mask it was shown, and writing that mask as the real
          // password would silently break the next upload with a 401.
          const saved = writeSettings(stateHome, normalizeSettings(restoreMaskedSecrets(body.settings, settings())))
          scheduler.refresh()
          const result = await scheduler.runNow('manual')
          sendJson(res, 200, { build: BUILD, result, settings: maskSettings(saved) })
          return
        }
        const result = await scheduler.runNow('manual')
        sendJson(res, 200, { build: BUILD, result })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (req.method === 'POST' && route === '/clear-history') {
      // Only the local run log is cleared; archives on the target are untouched.
      sendJson(res, 200, { history: history.clear() })
      return
    }

    if (req.method === 'POST' && route === '/refresh-schedule') {
      scheduler.refresh()
      sendJson(res, 200, { scheduler: scheduler.snapshot(settings()) })
      return
    }

    if (req.method === 'GET' && route === '/archives') {
      // What the target actually holds, so the page can list backups this
      // machine did not necessarily make — which is what a person wants after
      // reinstalling or on a second machine.
      try {
        const archives = await listArchives(normalizeTarget(settings().target))
        sendJson(res, 200, { archives })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (req.method === 'POST' && route === '/inspect-archive') {
      // Read one archive back and report what it actually holds. This is the
      // restore half of "back up these components": an archive made when only
      // documents were selected has no memory spaces, and saying so plainly is
      // the difference between a restore and a silent half-restore.
      const body = await readJsonBody(req)
      try {
        const report = await inspectArchive(settings(), String(body?.key ?? '').trim(), body?.components)
        sendJson(res, 200, report)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (req.method === 'POST' && route === '/restore') {
      // Restore is a staged, verified operation: download, verify every
      // checksum, extract to a staging directory, then either hand the files
      // back for inspection or replace live data only when explicitly asked.
      const body = await readJsonBody(req)
      try {
        const report = await restoreArchive(settings(), body ?? {})
        sendJson(res, 200, report)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    sendJson(res, 404, { error: `unknown route: ${req.method} ${route}` })
  }

  /**
   * Download one archive from the configured target and describe its contents.
   *
   * This describes *the archive*, never what the operator currently has ticked
   * in the backup scope. Those are two different questions — "what is in this
   * zip" and "what should a backup make" — and letting the scope answer the
   * first one made a full archive look incomplete: untick a component in the
   * scope, open an archive that does contain it, and the page would report it
   * missing and refuse to offer it for restore.
   *
   * `components` is still accepted so a caller can ask "does this archive have
   * these?" — anything asked for that the archive lacks lands in `missing` with
   * a reason. Omit it to describe everything the archive holds, which is what
   * the detail panel wants.
   */
  async function inspectArchive(current, key, requested) {
    if (key === '') throw new Error('an archive key is required')
    const target = normalizeTarget(current.target)
    const bytes = await downloadArchive(target, key)
    const files = readZip(bytes)
    const manifestBytes = files.get('manifest.json')
    if (manifestBytes === undefined) {
      throw new Error('this archive has no manifest.json, so its contents cannot be verified')
    }
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (manifest?.format !== 'mnemon-sync-snapshot') {
      throw new Error(`unexpected archive format: ${String(manifest?.format)}`)
    }
    const present = Array.isArray(manifest.components) ? manifest.components : []
    const wanted = Array.isArray(requested) && requested.length > 0
      ? requested.filter((value) => COMPONENTS.includes(value))
      : present
    const missing = wanted
      .filter((component) => !present.includes(component))
      .map((component) => ({
        component,
        reason: skipReason(manifest, component) ?? 'this archive was made without it',
      }))
    // Every payload file the manifest promises is checked against the archive,
    // so a truncated upload is caught here rather than after a restore starts.
    const expected = manifest.checksums?.files ?? {}
    const absent = Object.keys(expected).filter((relative) => !files.has(relative))

    const plan = planArchive(files)

    return {
      key,
      createdAt: manifest.createdAt,
      archiveComponents: present,
      requested: wanted,
      missing,
      entries: (manifest.entries ?? []).filter((entry) => typeof entry.component === 'string'),
      skipped: Array.isArray(manifest.skipped) ? manifest.skipped : [],
      files: files.size,
      bytes: bytes.length,
      plan,
      planBytes: plan.reduce((total, entry) => total + entry.bytes, 0),
      // `intact` means "this archive is complete and readable", which is what the
      // badge says. A missing component the operator asked for is reported in
      // `missing` separately: the archive is not damaged, it simply does not
      // contain that component.
      intact: absent.length === 0,
      ...absent.length === 0 ? {} : { absent },
    }
  }

  /**
   * Restore one archive into the live Mnemon home.
   *
   * The order is deliberate and never short-circuited:
   *   1. download the archive,
   *   2. verify every checksum in its manifest,
   *   3. report any requested component the archive does not carry,
   *   4. write files only for components the caller confirmed.
   *
   * Without `apply: true` this is a dry run: it answers what *would* be written
   * and touches nothing. That makes the button safe to press while exploring,
   * and keeps the destructive step an explicit second decision.
   *
   * Live SQLite databases are replaced with their checkpointed copy from the
   * archive. The WAL and SHM sidecars are removed first, because a stale WAL
   * beside a restored database would make SQLite replay transactions that the
   * restored file never had — the one way a "correct" restore corrupts data.
   */
  async function restoreArchive(current, body) {
    const key = String(body?.key ?? '').trim()
    if (key === '') throw new Error('an archive key is required')
    const apply_ = body?.apply === true
    const home = resolveEffectiveHome(current.mnemonHome, config)
    const target = normalizeTarget(current.target)
    const bytes = await downloadArchive(target, key)
    const files = readZip(bytes)
    const manifestBytes = files.get('manifest.json')
    if (manifestBytes === undefined) {
      throw new Error('this archive has no manifest.json, so its contents cannot be verified')
    }
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (manifest?.format !== 'mnemon-sync-snapshot') {
      throw new Error(`unexpected archive format: ${String(manifest?.format)}`)
    }

    // Verify before writing anything: a truncated upload must be caught here.
    const expected = manifest.checksums?.files ?? {}
    const mismatched = []
    for (const [relative, digest] of Object.entries(expected)) {
      const content = files.get(relative)
      if (content === undefined) {
        mismatched.push({ path: relative, problem: 'missing from the archive' })
        continue
      }
      const actual = createHash('sha256').update(content).digest('hex')
      if (actual !== digest) mismatched.push({ path: relative, problem: 'checksum mismatch' })
    }
    if (mismatched.length > 0) {
      return { key, applied: false, intact: false, mismatched }
    }

    const present = Array.isArray(manifest.components) ? manifest.components : []
    const requested = Array.isArray(body?.components) && body.components.length > 0
      ? body.components.filter((value) => COMPONENTS.includes(value))
      : present
    const missing = requested
      .filter((component) => !present.includes(component))
      .map((component) => ({
        component,
        reason: skipReason(manifest, component) ?? 'this archive was made without it',
      }))
    const restorable = requested.filter((component) => present.includes(component))

    // Plan first, so a dry run and a real run describe the same work. Entries
    // whose path does not resolve into a component directory (a foreign file
    // smuggled into the archive) are rejected outright rather than skipped:
    // a listing that silently drops entries would hide what a restore does.
    //
    // OS bookkeeping files are the one exception. Archives made before the
    // backup side filtered them still carry `.DS_Store`, `Thumbs.db` and the
    // like, and refusing the whole restore over Finder's window-position cache
    // would be absurd: the data is fine, the file just has no business being
    // written back. They are skipped and reported, never a hard failure.
    const plan = []
    const ignored = []
    // Resolved once: every entry is mapped against the same root set, so a
    // restore cannot write half a skill into one root and half into another.
    const roots = skillRoots()
    for (const component of restorable) {
      for (const [relative, content] of files.entries()) {
        if (relative === 'manifest.json') continue
        const director = componentDirectoryOf(relative)
        if (director !== component) continue
        if (isSystemJunk(relative.slice(relative.lastIndexOf('/') + 1))) {
          ignored.push({ path: relative, reason: 'OS bookkeeping file, never restored' })
          continue
        }
        const destination = destinationFor(home, relative, roots)
        if (destination === undefined) {
          throw new Error(`archive entry cannot be restored safely: ${relative}`)
        }
        plan.push({ component, relative, destination, bytes: content.length })
      }
    }

    if (!apply_) {
      return {
        key,
        applied: false,
        intact: true,
        createdAt: manifest.createdAt,
        archiveComponents: present,
        requested,
        missing,
        ...ignored.length === 0 ? {} : { ignored },
        plan: plan.map(({ relative, bytes: size }) => ({ path: relative, bytes: size })),
        planBytes: plan.reduce((total, entry) => total + entry.bytes, 0),
      }
    }

    // Refuse a live restore of memory spaces while the store is writing: the
    // database being replaced may have an open connection, and swapping a file
    // under it loses whatever was committed since the backup.
    const written = []
    for (const component of restorable) {
      if (component === 'memory-spaces') {
        for (const entry of plan.filter((item) => item.component === component)) {
          const database = entry.destination
          if (database.endsWith(MEMORY_SPACE_DATABASE_FILE)) {
            // Remove sidecars before the database, see the doc comment.
            for (const suffix of ['-wal', '-shm']) {
              const sidecar = `${database}${suffix}`
              if (existsSync(sidecar)) rmSync(sidecar, { force: true })
            }
          }
        }
      }
      for (const entry of plan.filter((item) => item.component === component)) {
        const content = files.get(entry.relative)
        mkdirSync(dirname(entry.destination), { recursive: true })
        writeFileSync(entry.destination, content, { mode: 0o600 })
        written.push({ component, path: entry.relative, destination: entry.destination, bytes: entry.bytes })
      }
    }

    return {
      key,
      applied: true,
      intact: true,
      createdAt: manifest.createdAt,
      archiveComponents: present,
      requested,
      missing,
      ...ignored.length === 0 ? {} : { ignored },
      restored: restorable,
      written,
      writtenBytes: written.reduce((total, entry) => total + entry.bytes, 0),
    }
  }
}

/**
 * How many memory spaces a manifest holds.
 *
 * A memory-space summary entry lists its space ids in `spaces`; per-space
 * records carry a single `id`. Both shapes are counted here so the history row
 * is right whichever one the archive was made with, and a backup taken with
 * memory spaces deselected honestly reads zero.
 */
function countSpaces(manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : []
  const ids = new Set()
  for (const entry of entries) {
    if (entry?.component !== 'memory-spaces') continue
    if (Array.isArray(entry.spaces)) {
      for (const id of entry.spaces) if (typeof id === 'string') ids.add(id)
      continue
    }
    if (typeof entry.id === 'string') ids.add(entry.id)
  }
  return ids.size
}

/**
 * Every file an archive carries, grouped by component, in payload order.
 *
 * Deliberately takes only the archive: what a zip holds is a property of the
 * zip, not of whatever the backup scope happens to have ticked. Filtering here
 * by the scope is what once made a complete archive report its unticked
 * components as missing.
 *
 * @param {Map<string, Uint8Array>} files entries of a read archive
 * @returns {Array<{component: string, path: string, bytes: number}>}
 */
export function planArchive(files) {
  const plan = []
  for (const [relative, content] of files.entries()) {
    if (relative === 'manifest.json') continue
    const component = componentDirectoryOf(relative)
    if (component === undefined) continue
    plan.push({ component, path: relative, bytes: content.length })
  }
  return plan
}

/**
 * Which component an archive path belongs to, read back off the payload layout
 * `buildSnapshot` writes. Deriving it from the path rather than trusting a
 * second list means the restore plan cannot drift from what was captured.
 */
function componentDirectoryOf(relative) {
  if (!relative.startsWith('payload/')) return undefined
  const [, directory] = relative.split('/')
  return COMPONENT_BY_DIRECTORY[directory]
}

const COMPONENT_BY_DIRECTORY = Object.fromEntries(
  Object.entries(COMPONENT_DIRECTORIES).map(([component, directory]) => [directory, component]),
)

/**
 * Where one archive path lands, or `undefined` when the path is not part of a
 * restorable component.
 *
 * A restore must only ever touch the component directories a backup produced.
 * Everything else in the Mnemon home — `state/` with this plugin's own
 * credentials and dsh-mnemon's machine identity, the archive workroot — must be
 * unreachable from an archive, because the archive is untrusted data. A zip
 * entry like `payload/data/../state/mnemon-sync.json` resolves inside the home
 * yet would overwrite the stored credentials, so the first path segment after
 * `payload/` is matched exactly against the known component directories and no
 * `..` or nested separator survives.
 *
 * `skill-files` is the exception to "lands in the home": its payload names a
 * skill root *kind*, which `skills.js` resolves against the roots that exist on
 * this machine. A `roots` argument is accepted so a caller can resolve once and
 * reuse the same set for every entry.
 *
 * The containment check asks `path.relative` rather than comparing string
 * prefixes. ZIP entry names always use `/`, while `resolve()` returns the
 * platform separator, so a literal `startsWith(root + '/')` is false on
 * Windows for *every* entry and blocked the whole restore there.
 */
export function destinationFor(home, entryName, roots = skillRoots()) {
  if (!entryName.startsWith('payload/')) return undefined
  const component = componentDirectoryOf(entryName)
  if (component === undefined) return undefined
  if (component === 'skill-files') return skillFileDestination(roots, entryName)
  if (component === 'skills') return skillsDataDestination(home, entryName)
  const stripped = entryName.slice('payload/'.length)
  const separator = stripped.indexOf('/')
  if (separator <= 0) return undefined
  const componentDirectory = COMPONENT_DIRECTORIES[component]
  const rest = stripped.slice(separator + 1)
  if (rest === '' || rest.includes('\0') || rest.split('/').includes('..')) return undefined
  const destination = resolve(home, componentDirectory, ...rest.split('/'))
  const root = resolve(home, componentDirectory)
  // Inside the component directory *and* not the directory itself.
  const inside = relative(root, destination)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
  return destination
}

/**
 * Why a component the operator asked for never made it into an archive.
 */
function skipReason(manifest, component) {
  const skipped = Array.isArray(manifest?.skipped) ? manifest.skipped : []
  const entry = skipped.find((item) => item?.component === component)
  return typeof entry?.reason === 'string' ? entry.reason : undefined
}

function isMasked(value) {
  return typeof value === 'string' && value !== '' && /^•+$/u.test(value)
}

/**
 * Put the real secrets back into a settings payload that arrived masked.
 *
 * The page never receives a secret — `maskSettings` replaces it with bullets —
 * and echoes those bullets back on every save. Treating them as a value would
 * overwrite the real credential with eight bullet characters, which is exactly
 * what made a correctly configured WebDAV target answer 401: the stored
 * password really was `••••••••`.
 *
 * Any write path that accepts settings from the browser must run this first.
 */
function restoreMaskedSecrets(incoming, previous) {
  if (incoming === null || typeof incoming !== 'object') return incoming
  const target = incoming.target
  if (target === null || typeof target !== 'object') return incoming
  if (target.kind === 'webdav' && isMasked(target.password)) {
    target.password = previous.target.kind === 'webdav' ? previous.target.password : ''
  }
  if (target.kind === 's3' && isMasked(target.secretAccessKey)) {
    target.secretAccessKey = previous.target.kind === 's3' ? previous.target.secretAccessKey : ''
  }
  if (target.kind === 's3' && isMasked(target.sessionToken)) {
    target.sessionToken = previous.target.kind === 's3' ? previous.target.sessionToken : ''
  }
  return incoming
}

/** Read a staging tree into the flat `{ path, bytes }` entries the ZIP writer takes. */
function collect(root, prefix = '') {
  const entries = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      entries.push(...collect(root, relative))
      continue
    }
    if (!entry.isFile()) continue
    const path = join(root, relative)
    // Every staged file goes in, including an empty one. `USER.md` is legitimately
    // 0 bytes when the user profile holds nothing, and the manifest records a
    // checksum for it — skipping it here made every such archive fail its own
    // integrity check.
    entries.push({ path: relative, bytes: readFileSync(path) })
  }
  return entries
}

/**
 * Delete the oldest archives beyond `keep`.
 *
 * Listing is deliberately *local*: archive keys are timestamped and the run
 * history already records every key this plugin uploaded, so retention never
 * needs a LIST call — which would mean a second signature scheme and would
 * fail on buckets where listing is denied. A key that no longer exists counts
 * as removed.
 */
async function applyRetention(history, target, keep, options) {
  // Sort by when the run happened, not by key. With a device name in the key,
  // lexical order groups by device first, so "keep the newest N" would delete
  // this machine's newest archive before another machine's oldest one.
  const uploaded = history.read()
    .filter((run) => run.ok && typeof run.key === 'string')
    .map((run) => ({ key: run.key, at: Date.parse(run.finishedAt ?? run.startedAt ?? '') || 0 }))
  const seen = new Set()
  const unique = []
  for (const entry of uploaded) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    unique.push(entry)
  }
  unique.sort((left, right) => right.at - left.at)
  const overflow = unique.slice(keep).map((entry) => entry.key)
  const removed = []
  for (const key of overflow) {
    try {
      await deleteArchive(target, key, options)
      removed.push(key)
    } catch {
      // retention is best effort; the next run tries again
    }
  }
  return removed
}

export { buildSnapshot, inspectHome, readSettings, writeSettings }

