/**
 * Mnemon Sync — skills.
 *
 * Skills live in two stores that dsh-mnemon does not merge for us, so a backup
 * has to know about both:
 *
 * - `<MNEMON_HOME>/skills` — the Skills Source's own data: `ledger.json`,
 *   `evals.json`, `trajectories/`, `versions/`, `market/` and `trash/`. This is
 *   the *history* of the skills, not the skills themselves.
 * - the user-wide DSH skill roots — the real `SKILL.md` trees the model loads,
 *   exactly the two roots `dsh-skill-filesystem` reads from the user level:
 *   `$DSH_HOME/skills` and `$DSH_AGENTS_HOME/skills`.
 *
 * Project-level roots (`<project>/.dsh/skills`, `<project>/.agents/skills`) are
 * deliberately out of scope. Those files belong to a repository and travel with
 * it through git; copying them into a memory backup would duplicate a source of
 * truth that already has one, and a restore could silently overwrite a checkout.
 * This plugin backs up the machine, not the checkout.
 *
 * Why two components instead of one: they have different lifetimes and
 * different trust. A skill's `SKILL.md` is what makes the model capable, and
 * people want it on a new machine; the ledger and trajectories are local history
 * that may be large and is regenerable. Ticking one and not the other is
 * therefore a legitimate choice, and squashing them together would force the
 * wrong one.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The user-level skill roots DSH reads, in its own precedence order. */
export const SKILL_ROOT_KINDS = ['user-dsh', 'user-agents']

/** The mnemon-owned skills data directory, relative to the Mnemon home. */
export const SKILLS_DATA_DIRECTORY = 'skills'

/** Absolute path of that directory, for display and for collecting. */
export function skillsDataRoot(home) {
  return join(home, SKILLS_DATA_DIRECTORY)
}

/**
 * A skill folder is expected to hold text plus the odd reference or asset, so a
 * depth cap keeps a pathological tree from turning a backup into a full
 * filesystem walk. The cap matches what the Skills Source lists as resources.
 */
const MAX_SKILL_DEPTH = 4
const MAX_SKILL_FILES = 4000

/** Expand the one shorthand these roots accept: a leading `~`. */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** `$DSH_HOME`, else `~/.dsh` — the same fallback the Host uses. */
export function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured === undefined || configured === ''
    ? join(homedir(), '.dsh')
    : resolve(expandHome(configured))
}

/** `$DSH_AGENTS_HOME`, else `~/.agents`. */
export function agentsHome() {
  const configured = process.env.DSH_AGENTS_HOME?.trim()
  return configured === undefined || configured === ''
    ? join(homedir(), '.agents')
    : resolve(expandHome(configured))
}

/**
 * Every user-level skill root, whether or not it exists yet.
 *
 * Listing the missing ones is deliberate: the page says "this root has
 * nothing", which is different from "this root was never considered" and is
 * exactly what someone checking a restore wants to know.
 */
export function skillRoots() {
  return [
    { kind: 'user-dsh', path: join(dshHome(), 'skills') },
    { kind: 'user-agents', path: join(agentsHome(), 'skills') },
  ]
}

/**
 * Files under one skill root, as `{ relative, bytes }` with `/` separators.
 *
 * Everything inside a skill folder travels — a skill that loses its
 * `references/` folder is a broken skill. Dot-directories at the root are
 * skipped: they are VCS or editor state, never skill content.
 */
export function collectSkillRootFiles(root) {
  const files = []
  if (!existsSync(root)) return files
  walk(root, '', files)
  files.sort((left, right) => left.relative.localeCompare(right.relative))
  return files
}

function walk(root, prefix, files) {
  if (files.length >= MAX_SKILL_FILES) return
  const depth = prefix === '' ? 0 : prefix.split('/').length
  if (depth > MAX_SKILL_DEPTH) return
  let entries
  try {
    entries = readdirSync(prefix === '' ? root : join(root, prefix), { withFileTypes: true })
  } catch {
    // An unreadable directory is reported by its absence rather than failing
    // the whole backup: one broken symlink must not cost every other skill.
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && prefix === '') continue
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      walk(root, relativePath, files)
      continue
    }
    if (!entry.isFile()) continue
    let bytes = 0
    try {
      bytes = statSync(join(root, relativePath)).size
    } catch {
      continue
    }
    files.push({ relative: relativePath, bytes })
    if (files.length >= MAX_SKILL_FILES) return
  }
}

/**
 * The skills a root holds, counted the way the Skills Source counts them: one
 * per directory containing a `SKILL.md`, or one for a lone `SKILL.md` file.
 */
export function countSkills(files) {
  const names = new Set()
  for (const file of files) {
    if (file.relative === 'SKILL.md') {
      names.add('/')
      continue
    }
    if (!file.relative.endsWith('/SKILL.md')) continue
    names.add(file.relative.slice(0, -'/SKILL.md'.length))
  }
  return names.size
}

/**
 * What each root currently holds, for the status payload.
 *
 * The `exists` flag is reported separately from the counts so the page can say
 * "not created yet" without implying the root was ignored.
 */
export function inspectSkillRoots() {
  return skillRoots().map((root) => {
    if (!existsSync(root.path)) {
      return { kind: root.kind, path: root.path, exists: false, skills: 0, bytes: 0, files: [] }
    }
    const files = collectSkillRootFiles(root.path)
    return {
      kind: root.kind,
      path: root.path,
      exists: true,
      skills: countSkills(files),
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      files,
    }
  })
}

/**
 * Everything under `<home>/skills`, as `{ relative, bytes }`.
 *
 * Unlike a skill root this tree is machine state, so it is walked whole with no
 * depth cap: `versions/` nests one directory per skill and `trajectories/` holds
 * one file per reviewed conversation, and truncating either would restore a
 * ledger that no longer matches the files beside it.
 */
export function collectSkillsData(home) {
  const root = join(home, SKILLS_DATA_DIRECTORY)
  const files = []
  if (!existsSync(root)) return files
  walkAll(root, '', files)
  files.sort((left, right) => left.relative.localeCompare(right.relative))
  return files
}

function walkAll(root, prefix, files) {
  let entries
  try {
    entries = readdirSync(prefix === '' ? root : join(root, prefix), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      walkAll(root, relativePath, files)
      continue
    }
    if (!entry.isFile()) continue
    try {
      files.push({ relative: relativePath, bytes: statSync(join(root, relativePath)).size })
    } catch {
      // Disappeared between listing and stat; nothing worth failing over.
    }
  }
}

/**
 * Where one `payload/skill-files/<kind>/...` entry lands, or `undefined`.
 *
 * A restore must never let an archive choose its own destination: the payload
 * names a root *kind*, and this function resolves that kind against the roots
 * that apply on this machine right now. An archive made on a machine with a
 * different `$DSH_HOME` still restores, just into this machine's root — the only
 * outcome that keeps the files loadable there.
 *
 * The containment check uses `path.relative` rather than string prefixes because
 * ZIP entry names always use `/` while `resolve()` returns the platform
 * separator.
 */
export function skillFileDestination(roots, entryName) {
  const stripped = entryName.slice('payload/skill-files/'.length)
  const separator = stripped.indexOf('/')
  if (separator <= 0) return undefined
  const kind = stripped.slice(0, separator)
  const rest = stripped.slice(separator + 1)
  if (rest === '' || rest.includes('\0') || rest.split('/').includes('..')) return undefined
  const root = roots.find((candidate) => candidate.kind === kind)
  if (root === undefined) return undefined
  const destination = resolve(root.path, ...rest.split('/'))
  const inside = relative(resolve(root.path), destination)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
  return destination
}

/** Where one `payload/skills/...` entry lands inside the Mnemon home. */
export function skillsDataDestination(home, entryName) {
  const rest = entryName.slice('payload/skills/'.length)
  if (rest === '' || rest.includes('\0') || rest.split('/').includes('..')) return undefined
  const root = resolve(home, SKILLS_DATA_DIRECTORY)
  const destination = resolve(root, ...rest.split('/'))
  const inside = relative(root, destination)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
  return destination
}
