/**
 * Mnemon Sync — snapshot building.
 *
 * A backup is built from up to five *components*. The first three are the ones
 * dsh-mnemon itself groups its own Pack by:
 *
 * - `memory-spaces` — the `<MNEMON_DATA_DIR>/data` directory: one SQLite
 *   database per space (`<id>/mnemon.db`) plus the space registry.
 * - `documents`     — `<MNEMON_DATA_DIR>/documents`: `index.json` and the
 *   active / archived Markdown files it points at.
 * - `runtime`        — `<MNEMON_DATA_DIR>/runtime`: `memories.json` and the two
 *   projections (`USER.md`, `MEMORY.md`) generated from it.
 *
 * The other two are skills, which live in two stores that dsh-mnemon does not
 * merge (see `skills.js` for why they stay separate):
 *
 * - `skills`      — `<MNEMON_DATA_DIR>/skills`: the Skills Source's ledger,
 *   evals, versions, trajectories, market and trash.
 * - `skill-files` — the real `SKILL.md` trees under DSH's *user-level* skill
 *   roots. Project-level roots are excluded on purpose: they are repository
 *   files that git already carries, and a restore must not overwrite a checkout.
 *
 * Any subset may be selected, which is why the snapshot records exactly which
 * components it holds: a restore can then say "this archive has no documents"
 * instead of silently restoring a subset and calling it complete.
 *
 * Copying `mnemon.db` with `cp` while the store is live produces torn pages:
 * the database runs in WAL mode, so the newest committed rows live in
 * `mnemon.db-wal` until a checkpoint folds them back. `node:sqlite`'s
 * `backup()` reads through SQLite itself, which is the only copy that stays
 * consistent under concurrent writes. Files that are not databases are copied
 * verbatim: they are small JSON and Markdown documents written atomically by
 * the store.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SKILLS_DATA_DIRECTORY, collectSkillRootFiles, collectSkillsData, inspectSkillRoots, skillRoots, skillsDataRoot } from './skills.js'

/** Memory space directories are validated with the store's own rule. */
export const MEMORY_SPACE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
export const MEMORY_SPACES_DIRECTORY = 'data'
export const MEMORY_SPACE_DATABASE_FILE = 'mnemon.db'
export const MEMORY_SPACE_REGISTRY_FILE = '.dsh-memory-bodies.json'
export const DOCUMENTS_DIRECTORY = 'documents'
export const DOCUMENTS_INDEX_FILE = 'index.json'
export const RUNTIME_DIRECTORY = 'runtime'
export const RUNTIME_MEMORIES_FILE = 'memories.json'
export const RUNTIME_PROJECTION_FILES = { user: 'USER.md', memory: 'MEMORY.md' }

/** The components a backup may contain, in the order dsh-mnemon lists them. */
export const COMPONENTS = ['memory-spaces', 'documents', 'runtime', 'skills', 'skill-files']

/**
 * The components that come from the Mnemon home itself, as opposed to the
 * filesystem skill roots. Kept as one list because the build loop and the
 * restore plan both key off the same split.
 */
export const HOME_COMPONENTS = ['memory-spaces', 'documents', 'runtime', 'skills']

/** Payload directory each component is stored under. */
export const COMPONENT_DIRECTORIES = {
  'memory-spaces': 'data',
  documents: 'documents',
  runtime: 'runtime',
  skills: SKILLS_DATA_DIRECTORY,
  'skill-files': 'skill-files',
}

/** Files inside a space directory that are regenerable and never worth carrying. */
const VOLATILE_SUFFIXES = ['-wal', '-shm', '-journal']

/**
 * OS bookkeeping files that are never Mnemon data, whatever directory they
 * appear in: Finder's `.DS_Store` and `._*` resource forks, Explorer's
 * `Thumbs.db` / `desktop.ini`, and the editor swap/backup leftovers that turn
 * up next to Markdown. They are excluded when listing and when collecting, so
 * an archive stays portable and a restore never writes desktop junk into the
 * memory directory.
 */
const SYSTEM_JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.directory'])
const JUNK_PREFIXES = ['._']
const JUNK_SUFFIXES = ['.swp', '.swx', '~']

export function isSystemJunk(name) {
  const lower = name.toLowerCase()
  if (SYSTEM_JUNK.has(lower)) return true
  if (JUNK_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  return JUNK_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

export function isComponent(value) {
  return COMPONENTS.includes(value)
}

/** Normalise a caller's selection to a stable, ordered, de-duplicated list. */
export function normalizeSelection(selection) {
  const requested = Array.isArray(selection) ? selection : COMPONENTS
  const kept = requested.filter((value) => isComponent(value))
  return COMPONENTS.filter((component) => kept.includes(component))
}

/**
 * Report what a Mnemon home currently holds, per component, so the page can
 * show each with its own count and size before a backup runs.
 *
 * @param {string} home absolute path of `<MNEMON_DATA_DIR>`
 */
export function inspectHome(home) {
  const dataRoot = join(home, MEMORY_SPACES_DIRECTORY)
  const documentsRoot = join(home, DOCUMENTS_DIRECTORY)
  const runtimeRoot = join(home, RUNTIME_DIRECTORY)

  const spaces = []
  const extras = []
  if (existsSync(dataRoot)) {
    for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
      const full = join(dataRoot, entry.name)
      if (entry.isFile()) {
        // An OS bookkeeping file beside the space directories is not Mnemon
        // data; leaving it out keeps archives portable across machines.
        if (!isSystemJunk(entry.name)) extras.push({ name: entry.name, bytes: safeSize(full) })
        continue
      }
      if (!entry.isDirectory()) continue
      if (!MEMORY_SPACE_ID_PATTERN.test(entry.name)) continue
      const database = join(full, MEMORY_SPACE_DATABASE_FILE)
      if (!existsSync(database)) continue
      spaces.push({
        id: entry.name,
        database,
        bytes: safeSize(database),
        walBytes: safeSize(`${database}-wal`),
        files: listRegularFiles(full),
      })
    }
    spaces.sort((left, right) => left.id.localeCompare(right.id))
  }

  const documents = existsSync(documentsRoot)
    ? {
        indexBytes: safeSize(join(documentsRoot, DOCUMENTS_INDEX_FILE)),
        files: collectRelativeFiles(documentsRoot),
      }
    : { indexBytes: 0, files: [] }

  const runtimeFiles = existsSync(runtimeRoot) ? collectRelativeFiles(runtimeRoot) : []
  const runtime = {
    memoriesBytes: safeSize(join(runtimeRoot, RUNTIME_MEMORIES_FILE)),
    files: runtimeFiles,
  }

  // The skills data directory holds the ledger and the version copies it
  // points at, so it travels whole: a ledger restored without the versions
  // beside it would offer rollbacks to files that no longer exist.
  const skillsFiles = collectSkillsData(home)

  // Skill roots are reported with their existence flag, because "this root was
  // never created" and "this root exists but is empty" mean different things to
  // someone deciding whether a backup is complete.
  const roots = inspectSkillRoots()
  const skillFiles = []
  for (const root of roots) {
    for (const file of root.files) {
      skillFiles.push({ relative: `${root.kind}/${file.relative}`, bytes: file.bytes })
    }
  }
  skillFiles.sort((left, right) => left.relative.localeCompare(right.relative))

  const rootSummaries = roots.map((root) => ({
    kind: root.kind,
    path: root.path,
    exists: root.exists,
    skills: root.skills,
    bytes: root.bytes,
  }))

  return {
    home,
    skillRoots: rootSummaries,
    components: {
      'memory-spaces': {
        available: spaces.length > 0,
        spaces,
        extras,
        totalBytes: spaces.reduce((total, space) => total + space.bytes, 0),
      },
      documents: {
        available: documents.files.length > 0,
        files: documents.files,
        totalBytes: documents.files.reduce((total, file) => total + file.bytes, 0),
      },
      runtime: {
        available: runtime.files.length > 0,
        files: runtime.files,
        totalBytes: runtime.files.reduce((total, file) => total + file.bytes, 0),
      },
      skills: {
        available: skillsFiles.length > 0,
        files: skillsFiles,
        totalBytes: skillsFiles.reduce((total, file) => total + file.bytes, 0),
        // The absolute directory, so the page can show where a tick reads from
        // instead of describing it as "mnemon skill data" and leaving the reader
        // to guess which folder that is.
        path: skillsDataRoot(home),
      },
      'skill-files': {
        available: skillFiles.length > 0,
        files: skillFiles,
        totalBytes: skillFiles.reduce((total, file) => total + file.bytes, 0),
        roots: rootSummaries,
      },
    },
  }
}

/** Backwards-compatible view of just the memory-space part. */
export function inspectDataDirectory(dataRoot, options = {}) {
  const home = dirname(dataRoot)
  const inspected = inspectHome(home, options)
  const spaces = inspected.components['memory-spaces'].spaces
  return {
    exists: spaces.length > 0,
    root: dataRoot,
    spaces,
    extras: inspected.components['memory-spaces'].extras,
    totalBytes: inspected.components['memory-spaces'].totalBytes,
  }
}

function listRegularFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (isSystemJunk(entry.name)) continue
    if (VOLATILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
    files.push(entry.name)
  }
  return files.sort()
}

/** Every regular file under `root`, as `{ relative, bytes }`, sorted. */
function collectRelativeFiles(root, prefix = '') {
  const files = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    // Skipped while descending, not merely filtered from the result, so a junk
    // directory never costs a second pass.
    if (isSystemJunk(entry.name)) continue
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...collectRelativeFiles(root, relative))
      continue
    }
    if (!entry.isFile()) continue
    files.push({ relative, bytes: safeSize(join(root, relative)) })
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function safeSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Load `node:sqlite` lazily and tolerate builds without it.
 *
 * `backup()` is already promise-based in current Node (calling it with a
 * callback throws ERR_INVALID_ARG_TYPE). It is returned as-is, and the result
 * is awaited by the caller, so no promisification happens here.
 */
async function loadSqlite() {
  const module = await import('node:sqlite')
  return {
    DatabaseSync: module.DatabaseSync,
    backup: typeof module.backup === 'function' ? module.backup : undefined,
  }
}

/**
 * Copy one live database into `destination` consistently.
 *
 * Preferred: `backup()` — it drives SQLite's online backup API, so a writer
 * holding the WAL open cannot tear the copy, and a concurrent write only makes
 * the backup restart its current batch rather than fail.
 *
 * Fallback: open the source read-only and `VACUUM INTO`, which materialises a
 * transaction-consistent copy when the backup API is unavailable.
 */
export async function copyDatabase(source, destination) {
  const { DatabaseSync, backup } = await loadSqlite()
  if (backup !== undefined) {
    const handle = new DatabaseSync(source, { readOnly: true })
    try {
      await backup(handle, destination)
    } finally {
      handle.close()
    }
    return 'backup-api'
  }
  const handle = new DatabaseSync(source, { readOnly: true })
  try {
    // VACUUM INTO refuses to overwrite, so the target must be absent.
    handle.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
  } finally {
    handle.close()
  }
  return 'vacuum-into'
}

/**
 * Build a snapshot of the selected components under `stagingDirectory`.
 *
 * Layout produced:
 *   payload/data/<spaceId>/mnemon.db   consistent copy of each space
 *   payload/data/<registry>            space registry, verbatim
 *   payload/documents/**               index plus every Markdown file
 *   payload/runtime/**                 memories.json plus both projections
 *   manifest.json                      components, files and checksums
 *
 * @returns {Promise<{directory: string, manifest: object, files: string[]}>}
 */
export async function buildSnapshot(home, stagingDirectory, options = {}) {
  const selection = normalizeSelection(options.components)
  if (selection.length === 0) {
    throw new Error('no backup component was selected')
  }
  const inspected = inspectHome(home)
  const available = selection.filter((component) => inspected.components[component].available)
  if (available.length === 0) {
    throw new Error(`the selected components hold no data: ${selection.join(', ')}`)
  }

  const payloadRoot = join(stagingDirectory, 'payload')
  mkdirSync(payloadRoot, { recursive: true })

  const checksums = {}
  const captured = []
  const skipped = []
  const onProgress = options.onProgress

  const record = (relative, bytes) => {
    checksums[relative] = sha256(bytes)
  }

  if (selection.includes('memory-spaces')) {
    const part = inspected.components['memory-spaces']
    if (!part.available) {
      skipped.push({ component: 'memory-spaces', reason: 'no memory space database was found' })
    } else {
      const dataDirectory = join(payloadRoot, MEMORY_SPACES_DIRECTORY)
      mkdirSync(dataDirectory, { recursive: true })
      for (const space of part.spaces) {
        const destinationDirectory = join(dataDirectory, space.id)
        mkdirSync(destinationDirectory, { recursive: true })
        const destination = join(destinationDirectory, MEMORY_SPACE_DATABASE_FILE)
        onProgress?.(`backing up ${space.id}`)
        const method = await copyDatabase(space.database, destination)
        const bytes = readFileSync(destination)
        record(`payload/${MEMORY_SPACES_DIRECTORY}/${space.id}/${MEMORY_SPACE_DATABASE_FILE}`, bytes)
        captured.push({
          component: 'memory-spaces',
          id: space.id,
          path: `payload/${MEMORY_SPACES_DIRECTORY}/${space.id}/${MEMORY_SPACE_DATABASE_FILE}`,
          bytes: bytes.length,
          sourceBytes: space.bytes,
          method,
          // Recorded so a restore can tell the operator the copy is not a byte
          // image of the live file: it is a checkpointed, consistent version.
          wireFormat: 'checkpointed',
        })
        // Small sidecars travel verbatim; WAL and SHM are deliberately excluded,
        // see the module comment.
        const spaceDirectory = dirname(space.database)
        for (const name of space.files) {
          if (name === MEMORY_SPACE_DATABASE_FILE) continue
          const from = join(spaceDirectory, name)
          if (!existsSync(from)) continue
          const fileBytes = readFileSync(from)
          writeFileSync(join(destinationDirectory, name), fileBytes)
          record(`payload/${MEMORY_SPACES_DIRECTORY}/${space.id}/${name}`, fileBytes)
        }
      }
      for (const extra of part.extras) {
        const from = join(home, MEMORY_SPACES_DIRECTORY, extra.name)
        if (!existsSync(from)) continue
        const bytes = readFileSync(from)
        writeFileSync(join(dataDirectory, extra.name), bytes)
        record(`payload/${MEMORY_SPACES_DIRECTORY}/${extra.name}`, bytes)
      }
      // `entries` holds one summary record per captured item, so a summary for
      // memory spaces carries the space ids it wrote — never a second record of
      // the same component, which would read as an extra space in a count.
      captured.push({
        component: 'memory-spaces',
        spaces: part.spaces.map((space) => space.id),
        files: Object.keys(checksums).filter((relative) => relative.startsWith(`payload/${MEMORY_SPACES_DIRECTORY}/`)).length,
        bytes: part.totalBytes,
      })
    }
  }

  // Components whose files all come from one directory inside the Mnemon home.
  // `skills` joins documents and runtime here because the Skills Source's data
  // is just another directory of the home; only the skill *files* live outside
  // it, and those are handled separately below.
  for (const component of ['documents', 'runtime', 'skills']) {
    if (!selection.includes(component)) continue
    const part = inspected.components[component]
    if (!part.available) {
      skipped.push({ component, reason: 'no files were found' })
      continue
    }
    onProgress?.(`backing up ${component}`)
    const directory = COMPONENT_DIRECTORIES[component]
    const targetRoot = join(payloadRoot, directory)
    for (const file of part.files) {
      const from = join(home, directory, file.relative)
      const bytes = readFileSync(from)
      const destination = join(targetRoot, file.relative)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, bytes)
      record(`payload/${directory}/${file.relative}`, bytes)
    }
    captured.push({
      component,
      files: part.files.length,
      bytes: part.totalBytes,
    })
  }

  // Skill files come from roots outside the Mnemon home, so each file is
  // copied from the root it was listed under. The root *kind* — not its
  // absolute path — is the payload's first segment: an archive must restore
  // into whatever those roots are on the machine it lands on, not into the
  // path this machine happened to use.
  if (selection.includes('skill-files')) {
    const part = inspected.components['skill-files']
    if (!part.available) {
      skipped.push({ component: 'skill-files', reason: 'no skill file was found in any skill root' })
    } else {
      onProgress?.('backing up skill files')
      const directory = COMPONENT_DIRECTORIES['skill-files']
      const roots = skillRoots()
      for (const root of roots) {
        const listed = collectSkillRootFiles(root.path)
        for (const file of listed) {
          const from = join(root.path, file.relative)
          if (!existsSync(from)) continue
          const bytes = readFileSync(from)
          const relativePath = `${root.kind}/${file.relative}`
          const destination = join(payloadRoot, directory, relativePath)
          mkdirSync(dirname(destination), { recursive: true })
          writeFileSync(destination, bytes)
          record(`payload/${directory}/${relativePath}`, bytes)
        }
      }
      captured.push({
        component: 'skill-files',
        files: part.files.length,
        bytes: part.totalBytes,
        // Which roots this archive actually drew from, so a restore can explain
        // a root that contributed nothing without pretending it was missing.
        roots: part.roots.filter((root) => root.exists).map((root) => root.kind),
      })
    }
  }

  const manifest = {
    format: 'mnemon-sync-snapshot',
    // 3 adds the two skill components. The restore half accepts any version and
    // dispatches on the component name, so archives written before this bump
    // keep restoring unchanged.
    version: 3,
    createdAt: new Date().toISOString(),
    source: { home },
    // What the operator asked for, what actually shipped, and what was empty —
    // a restore reads this to explain a missing component instead of guessing.
    requested: selection,
    components: [...new Set(captured.map((entry) => entry.component))],
    entries: captured,
    skipped,
    checksums: { algorithm: 'sha256', files: checksums },
  }
  writeFileSync(join(stagingDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const files = [...Object.keys(checksums), 'manifest.json']
  return { directory: stagingDirectory, manifest, files }
}

/**
 * Verify a snapshot directory against its own manifest before it is uploaded.
 * A backup that cannot be read back is worse than no backup.
 */
export function verifySnapshot(stagingDirectory) {
  const manifest = JSON.parse(readFileSync(join(stagingDirectory, 'manifest.json'), 'utf8'))
  if (manifest.format !== 'mnemon-sync-snapshot') {
    throw new Error(`unexpected manifest format: ${String(manifest.format)}`)
  }
  const expected = manifest.checksums?.files ?? {}
  let verified = 0
  for (const [relative, digest] of Object.entries(expected)) {
    const actual = sha256(readFileSync(join(stagingDirectory, relative)))
    if (actual !== digest) {
      throw new Error(`snapshot checksum mismatch for ${relative}`)
    }
    verified += 1
  }
  return { manifest, files: verified }
}

/**
 * Read the space registry so the UI can name spaces the way the store does.
 * Degrades to directory names when the registry is absent or unreadable: a
 * backup must not depend on metadata being well-formed.
 */
export function readSpaceNames(home) {
  const path = join(home, MEMORY_SPACES_DIRECTORY, MEMORY_SPACE_REGISTRY_FILE)
  const names = new Map()
  try {
    const registry = JSON.parse(readFileSync(path, 'utf8'))
    for (const body of registry?.bodies ?? []) {
      if (typeof body?.id === 'string' && typeof body?.name === 'string') names.set(body.id, body.name)
    }
  } catch {
    // ignored on purpose, see the doc comment
  }
  return names
}
