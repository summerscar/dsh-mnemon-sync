/**
 * Mnemon Sync — the Source that owns this page.
 *
 * This module is a standard Cordis plugin entry, written the same way the
 * shipped dsh-mnemon Source packages are (see dsh-mnemon-source-runtime):
 * `inject = ['mnemonMemory']` and `installMemory(ctx, ...)` inside `apply`.
 * The Loader waits for the service, calls apply when it appears, and disposes
 * the registration when it goes away.
 *
 * One concession to being distributable: the SDK is loaded with `createRequire`
 * instead of a static `import`. A static import resolves fine for an npm
 * install (the package sits under `<profile>/node_modules/`, with dsh-mnemon
 * as a sibling ancestor) but fails for a `link:` checkout that lives outside
 * the profile and has no `node_modules` of its own. `createRequire` with an
 * explicit `DSH_PROFILE_DIR` fallback covers both shapes.
 *
 * Why a Source is required at all: dsh-mnemon renders a page tab only when its
 * `sourceTypeId` appears in the live source catalog, and that catalog lists
 * real, running Source implementations. A UI-only contribution can borrow
 * `memory-spaces` and be shown, but the tab bar highlights *every* tab sharing
 * the selected page's type prefix, so borrowing means clicking one lights up
 * the other. Declaring our own type is the only way to get an independent tab.
 *
 * This Source is deliberately honest about what it holds. It is not a memory
 * backend: it stores no insights, contributes an empty projection and declares
 * no read routes or write actions. Its role is to be the identity the sync
 * page hangs from.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { resolveEffectiveHome, resolveHome } from './index.js'
import { inspectHome } from './snapshot.js'
import { readSettings } from './store.js'

const require = createRequire(import.meta.url)

export const SYNC_SOURCE_TYPE_ID = 'mnemon-sync'
export const SYNC_PACKAGE_NAME = '@summerscar/dsh-mnemon-sync'

export const name = SYNC_PACKAGE_NAME
// The one dependency the Source needs. The Loader holds this Entry until
// dsh-mnemon publishes mnemonMemory, then mounts it.
export const inject = ['mnemonMemory']

/**
 * Resolve the extension SDK synchronously so `apply` can stay synchronous.
 * Tries normal package resolution first, then the profile-anchored absolute
 * path for linked checkouts.
 */
function loadSdk() {
  try {
    return require('dsh-mnemon/extension-sdk')
  } catch {
    // Fall through: linked checkout has no ancestor node_modules.
  }
  const profileDir = process.env.DSH_PROFILE_DIR?.trim()
  const candidates = []
  if (profileDir !== undefined && profileDir !== '') {
    candidates.push(join(profileDir, 'node_modules', 'dsh-mnemon', 'lib', 'extension-sdk.js'))
  }
  candidates.push(join(process.env.DSH_HOME ?? '', 'profiles', 'web', 'node_modules', 'dsh-mnemon', 'lib', 'extension-sdk.js'))
  for (const candidate of candidates) {
    if (candidate === '' || !existsSync(candidate)) continue
    return require(candidate)
  }
  return undefined
}

const sdk = loadSdk()

/** The plugin descriptor, validated by the SDK when available. */
export const memoryPlugin = sdk === undefined ? {
  packageName: SYNC_PACKAGE_NAME,
  label: { en: 'Sync backup', 'zh-CN': '同步备份' },
  description: {
    en: 'Back up and restore dsh-mnemon memory and skill components.',
    'zh-CN': '备份与恢复 dsh-mnemon 的记忆与技能组件。',
  },
  roles: ['source'],
  provides: [{ id: 'source' }],
} : sdk.defineMemoryPlugin({
  packageName: SYNC_PACKAGE_NAME,
  label: { en: 'Sync backup', 'zh-CN': '同步备份' },
  description: {
    en: 'Back up and restore dsh-mnemon memory components.',
    'zh-CN': '备份与恢复 dsh-mnemon 的记忆组件。',
  },
  roles: ['source'],
  provides: [{ id: 'source' }],
})

/** The manifest Core validates before this Source may take part in a View. */
export const syncSourceManifest = {
  apiVersion: 'dsh-mnemon/v1',
  kind: 'source',
  typeId: SYNC_SOURCE_TYPE_ID,
  packageName: SYNC_PACKAGE_NAME,
  // A role of its own keeps it out of any Strategy's default source selection:
  // no shipped Strategy asks for a "maintenance" role, so this Source never
  // lands in a model prompt.
  role: 'maintenance',
  capabilities: [],
  consistency: 'exact-snapshot',
  routes: [],
  actions: [],
  // A management descriptor is required for managementCatalog to list this
  // Source; without it the Source is installed but reported "on yet not running".
  management: {
    label: 'Sync backup',
    description: 'Back up and restore dsh-mnemon memory and skill components.',
  },
}

/**
 * Build the Source definition.
 *
 * `facts()` returns the Host's facts envelope — `sourceInstanceKey`,
 * `sourceTypeId`, `role`, `availability`, `revision`, `capabilities`,
 * `routeIds`, `actionIds` (plus optional `hints`). `project()` brings nothing
 * into a prompt, because there is no memory content here to bring.
 */
export function createSyncSource(manifest = syncSourceManifest) {
  return {
    manifest,
    create(context) {
      const configuredRoot = typeof context?.configuration?.dataRoot === 'string'
        ? context.configuration.dataRoot
        : undefined
      const config = configuredRoot === undefined ? {} : { dataRoot: configuredRoot }
      // Settings live under the Host-resolved home, never under the page's
      // override — that override is stored inside these very settings.
      const stateHome = resolveHome(config)

      return {
        facts() {
          const settings = safeSettings(stateHome)
          // Keep the Source honest about the same directory a backup would
          // read, so its revision changes when the override does.
          const home = resolveEffectiveHome(settings.mnemonHome, config)
          const inspected = safeInspect(home)
          return {
            sourceInstanceKey: context.sourceInstanceKey,
            sourceTypeId: manifest.typeId,
            role: manifest.role,
            availability: 'ready',
            revision: configurationRevision(settings, inspected),
            capabilities: [],
            routeIds: [],
            actionIds: [],
            // Only `hints` survives normalization, so the backup configuration
            // a human may want to see travels there.
            hints: {
              summary: settings.enabled
                ? `Sync backup every ${String(settings.autoSyncMinutes)} min to ${describeTarget(settings.target)}`
                : 'Sync backup is configured but disabled',
              enabled: settings.enabled,
              configured: isConfigured(settings),
              autoSyncMinutes: settings.autoSyncMinutes,
              components: settings.components,
              targetKind: settings.target.kind,
              remotePath: settings.target.remotePath,
              keep: settings.retention.keep,
              spaces: inspected.components['memory-spaces'].spaces.map((space) => space.id),
              totalBytes: Object.values(inspected.components)
                .reduce((total, part) => total + part.totalBytes, 0),
            },
          }
        },
        project() {
          return { fragments: [] }
        },
        dispose() {},
      }
    },
  }
}

/** The standard Cordis entry point, identical in shape to the shipped Sources. */
export function apply(ctx, config = {}) {
  if (sdk === undefined) {
    // dsh-mnemon is not installed at all; the backup engine in index.js still
    // works, only the page is unavailable. Do not fake a registration.
    console.warn('mnemon-sync: dsh-mnemon extension SDK not found; the sync tab stays hidden')
    return
  }
  sdk.installMemory(ctx, {
    plugin: memoryPlugin,
    sources: [sdk.defineMemorySource(createSyncSource({ ...syncSourceManifest }))],
  }, config?.instanceId === undefined ? undefined : { instanceId: config.instanceId })
}

/**
 * A stable revision for the current backup configuration, derived from the
 * facts themselves rather than a clock so composition stays deterministic.
 */
function configurationRevision(settings, inspected) {
  const material = JSON.stringify({
    enabled: settings.enabled,
    target: describeTarget(settings.target),
    remotePath: settings.target?.remotePath ?? '',
    autoSyncMinutes: settings.autoSyncMinutes ?? 0,
    components: settings.components ?? [],
    keep: settings.retention?.keep ?? 0,
    spaces: inspected.components['memory-spaces'].spaces.map((space) => space.id).sort(),
    totalBytes: Object.values(inspected.components)
      .reduce((total, part) => total + part.totalBytes, 0),
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 32)
}

const EMPTY_INSPECTION = {
  components: {
    'memory-spaces': { available: false, spaces: [], extras: [], totalBytes: 0 },
    documents: { available: false, files: [], totalBytes: 0 },
    runtime: { available: false, files: [], totalBytes: 0 },
  },
}

function safeSettings(home) {
  try {
    return readSettings(home)
  } catch {
    return {
      enabled: false,
      target: { kind: 'webdav', remotePath: '' },
      components: [],
      autoSyncMinutes: 0,
      retention: { keep: 0 },
    }
  }
}

function safeInspect(home) {
  try {
    return inspectHome(home)
  } catch {
    return EMPTY_INSPECTION
  }
}

/** Whether the target carries enough detail to actually upload somewhere. */
export function isConfigured(settings) {
  if (settings?.target === undefined) return false
  if (settings.target.kind === 's3') {
    return nonEmpty(settings.target.endpoint)
      && nonEmpty(settings.target.bucket)
      && nonEmpty(settings.target.accessKeyId)
      && nonEmpty(settings.target.secretAccessKey)
  }
  return nonEmpty(settings.target.url)
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== ''
}

function describeTarget(target) {
  if (target?.kind === 's3') {
    const bucket = String(target.bucket ?? '')
    return bucket === '' ? 'S3' : `S3 ${bucket}`
  }
  return 'WebDAV'
}
