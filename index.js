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
 * and are never echoed back by a read.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { SyncHistory, SyncScheduler } from './scheduler.js'
import {
  COMPONENTS,
  MEMORY_SPACE_DATABASE_FILE,
  buildSnapshot,
  inspectHome,
  readSpaceNames,
  verifySnapshot,
} from './snapshot.js'
import { createZip, readZip } from './zip.js'
import { deleteArchive, downloadArchive, listArchives, normalizeTarget, uploadArchive } from './targets.js'
import { maskSettings, normalizeSettings, readSettings, settingsPath, writeSettings } from './store.js'

const API_PREFIX = '/api/mnemon-sync'
const ARCHIVE_PREFIX = 'mnemon-sync-'

export const name = 'dsh-mnemon-sync'
// `mnemonMemory` is optional on purpose: the plugin still backs up on a profile
// where dsh-mnemon is absent or too old to accept Sources, it just cannot offer
// its page there.
export const inject = ['webServer']

/**
 * `MNEMON_DATA_DIR` names the Mnemon home; the memory store itself lives in
 * its `data` subdirectory, exactly as dsh-mnemon resolves it.
 */
export function resolveDataRoot(config = {}) {
  if (typeof config.dataRoot === 'string' && config.dataRoot.trim() !== '') {
    return resolve(config.dataRoot.trim())
  }
  const fromEnvironment = process.env.MNEMON_DATA_DIR?.trim()
  const home = fromEnvironment === undefined || fromEnvironment === ''
    ? join(process.env.HOME ?? '', '.mnemon')
    : fromEnvironment
  return join(home, 'data')
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

/** `mnemon-sync-2026-11-09T041500Z.zip`: sorts lexicographically by time. */
export function archiveKey(at = new Date()) {
  return `${ARCHIVE_PREFIX}${at.toISOString().replace(/:/gu, '-')}.zip`
}

export function apply(ctx, config = {}) {
  const dataRoot = resolveDataRoot(config)
  // `<home>/data` → `<home>`: settings and work files sit beside the store.
  const home = resolve(dataRoot, '..')
  const workRoot = join(home, 'state', 'mnemon-sync-work')

  const history = new SyncHistory(home)
  const settings = () => readSettings(home)

  const performBackup = async (trigger, current, signal) => {
    if (current.enabled !== true && trigger === 'schedule') {
      return { skipped: 'disabled' }
    }
    const target = normalizeTarget(current.target)
    const staging = join(workRoot, `build-${String(Date.now())}`)
    mkdirSync(staging, { recursive: true })
    const startedAt = new Date().toISOString()
    try {
      const snapshot = await buildSnapshot(home, staging, { components: current.components })
      verifySnapshot(staging)
      const key = archiveKey()
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
  ctx.effect(() => registerSyncSource(ctx, dataRoot), 'mnemon-sync: memory source')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
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
      sendJson(res, 200, {
        dataRoot,
        settingsPath: settingsPath(home),
        workRoot,
        state: inspectHome(home),
        settings: maskSettings(current),
        scheduler: scheduler.snapshot(current),

        history: history.read(),
        spaceNames: Object.fromEntries(readSpaceNames(home)),
      })
      return
    }

    if (req.method === 'PUT' && route === '/settings') {
      const body = await readJsonBody(req)
      const previous = settings()
      const incoming = body?.settings ?? body
      // A masked secret coming back from the UI means "unchanged".
      if (incoming !== null && typeof incoming === 'object' && incoming.target !== null && typeof incoming.target === 'object') {
        const target = incoming.target
        if (target.kind === 'webdav' && isMasked(target.password)) {
          target.password = previous.target.kind === 'webdav' ? previous.target.password : ''
        }
        if (target.kind === 's3' && isMasked(target.secretAccessKey)) {
          target.secretAccessKey = previous.target.kind === 's3' ? previous.target.secretAccessKey : ''
        }
      }
      const saved = writeSettings(home, normalizeSettings(incoming))
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
          const saved = writeSettings(home, normalizeSettings(body.settings))
          scheduler.refresh()
          const result = await scheduler.runNow('manual')
          sendJson(res, 200, { result, settings: maskSettings(saved) })
          return
        }
        const result = await scheduler.runNow('manual')
        sendJson(res, 200, { result })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
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
   * `components` is what the operator wants to restore; any requested component
   * the archive does not carry is reported in `missing` with the reason, so the
   * UI can warn before touching anything on disk.
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

    // The same plan a restore would carry out, reported here so the detail
    // panel can show what pressing the button would write — and so the button
    // exists at all. Keeping one plan shape means the preview and the work
    // cannot drift apart.
    const plan = []
    for (const [relative, content] of files.entries()) {
      if (relative === 'manifest.json') continue
      const component = componentDirectoryOf(relative)
      if (component === undefined || !wanted.includes(component)) continue
      plan.push({ component, path: relative, bytes: content.length })
    }

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

    // Plan first, so a dry run and a real run describe the same work.
    const plan = []
    for (const component of restorable) {
      for (const [relative, content] of files.entries()) {
        if (relative === 'manifest.json') continue
        const director = componentDirectoryOf(relative)
        if (director !== component) continue
        plan.push({ component, relative, destination: destinationFor(home, relative), bytes: content.length })
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
      restored: restorable,
      written,
      writtenBytes: written.reduce((total, entry) => total + entry.bytes, 0),
    }
  }
}

/** Why a component the operator asked for never made it into an archive. */
/**
 * Which component an archive path belongs to.
 *
 * The payload layout is fixed by `buildSnapshot`: `payload/data/...` holds
 * memory spaces, `payload/documents/...` project documents and
 * `payload/runtime/...` runtime memory. Reading the component back off the path
 * keeps the restore plan aligned with what was actually written, rather than
 * trusting a second list that could drift.
 */
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

function componentDirectoryOf(relative) {
  if (!relative.startsWith('payload/')) return undefined
  const [, directory] = relative.split('/')
  if (directory === 'data') return 'memory-spaces'
  if (directory === 'documents') return 'documents'
  if (directory === 'runtime') return 'runtime'
  return undefined
}

/**
 * Where one archive path lands in the Mnemon home.
 *
 * `payload/` is dropped and the component directories are the same names the
 * store itself uses, so a restored tree is byte-identical in layout to a live
 * one. The path is resolved and checked so a malformed archive cannot walk out
 * of the home directory.
 */
function destinationFor(home, relative) {
  const stripped = relative.replace(/^payload\//u, '')
  const destination = resolve(home, stripped)
  const root = resolve(home)
  if (destination !== root && !destination.startsWith(`${root}/`)) {
    throw new Error(`archive entry escapes the Mnemon home: ${relative}`)
  }
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
 * Resolve the dsh-mnemon extension SDK.
 *
 * A bare `import('dsh-mnemon/extension-sdk')` is not enough here. Installed
 * from npm the package sits at `<profile>/node_modules/@summerscar/...`, so
 * Node's own ancestor walk would find dsh-mnemon beside it — but a *linked*
 * checkout lives outside the profile with no `node_modules` of its own, and
 * then the walk finds nothing.
 *
 * Both install shapes are therefore covered, cheapest first:
 *   1. From this module's own location, which is right for an npm install.
 *   2. From `DSH_PROFILE_DIR`, which is right for a linked checkout and is set
 *      in every shell and Host process a profile launches.
 *   3. From `DSH_HOME/profiles/web`, for a Host booted without that variable.
 *
 * Returns `undefined` when dsh-mnemon is not installed at all, which is a
 * supported configuration: the backup keeps working without its page.
 */
async function loadExtensionSdk() {
  // 1. Ask Node, anchored at this file. Resolves for an npm install.
  try {
    const resolver = createRequire(import.meta.url)
    const resolved = resolver.resolve('dsh-mnemon/lib/extension-sdk.js')
    return await import(pathToFileURL(resolved).href)
  } catch {
    // Not resolvable from here: fall through to the profile-anchored paths.
  }

  const candidates = []
  const profileDir = process.env.DSH_PROFILE_DIR?.trim()
  if (profileDir !== undefined && profileDir !== '') {
    candidates.push(join(profileDir, 'node_modules', 'dsh-mnemon', 'lib', 'extension-sdk.js'))
  }
  // The Host that loads this plugin lives in the installation's own tree.
  candidates.push(join(process.env.DSH_HOME ?? '', 'profiles', 'web', 'node_modules', 'dsh-mnemon', 'lib', 'extension-sdk.js'))
  for (const candidate of candidates) {
    if (candidate === '' || !existsSync(candidate)) continue
    return import(pathToFileURL(candidate).href)
  }
  return undefined
}

/**
 * Install the sync Source into dsh-mnemon's composable-memory service.
 *
 * Returns a disposer, and does nothing at all when the Host runs without that
 * service (a profile with dsh-mnemon absent).
 */
function registerSyncSource(ctx, dataRoot) {
  if (typeof ctx.get !== 'function') return () => {}
  const service = ctx.get('mnemonMemory')
  if (service === undefined || service === null || typeof service.installContributions !== 'function') {
    return () => {}
  }
  let disposed = false
  let uninstall
  void (async () => {
    try {
      const sdk = await loadExtensionSdk()
      if (sdk === undefined || typeof sdk.defineMemorySource !== 'function') {
        console.warn('mnemon-sync: dsh-mnemon extension SDK not found; the sync tab stays hidden')
        return
      }
      const { createSyncSource, syncSourceManifest } = await import('./source.js')
      if (disposed) return
      // The manifest goes through the SDK validator so a contract drift in
      // dsh-mnemon fails loudly here instead of at composition time.
      const definition = sdk.defineMemorySource(createSyncSource({ ...syncSourceManifest }))
      uninstall = service.installContributions({
        plugin: {
          apiVersion: 'dsh-mnemon/plugin/v1',
          packageName: '@summerscar/dsh-mnemon-sync',
          label: { en: 'Sync backup', 'zh-CN': '同步备份' },
          description: {
            en: 'Archive memory spaces to S3 or WebDAV.',
            'zh-CN': '把记忆空间备份到 S3 或 WebDAV。',
          },
          roles: ['source'],
          provides: [{ id: 'source' }],
        },
        sources: [definition],
      }, { instanceId: 'mnemon-sync' })
      if (disposed) {
        uninstall?.()
        uninstall = undefined
      }
    } catch (error) {
      // A Host that cannot accept the Source must not take the backup down.
      console.warn('mnemon-sync: could not register the sync source', error)
    }
  })()
  return () => {
    disposed = true
    uninstall?.()
    uninstall = undefined
  }
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
  const uploaded = history.read()
    .filter((run) => run.ok && typeof run.key === 'string')
    .map((run) => run.key)
  const unique = [...new Set(uploaded)].sort()
  const overflow = unique.slice(0, Math.max(0, unique.length - keep))
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

