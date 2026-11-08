/**
 * Mnemon Sync — the Source that owns this page.
 *
 * Why a Source is required at all: dsh-mnemon renders a page tab only when its
 * `sourceTypeId` appears in the live source catalog, and the catalog lists
 * real, running Source implementations. A UI-only contribution can borrow
 * `memory-spaces` and be shown, but the tab bar highlights *every* tab sharing
 * the selected page's type prefix, so borrowing means clicking one lights up
 * the other. Declaring our own type is the only way to get an independent tab.
 *
 * This Source is deliberately honest about what it holds. It is not a memory
 * backend: it stores no insights, so it contributes an empty projection and
 * declares no read routes or write actions. Its role is to be the identity the
 * sync page hangs from, which is why every capability is false and the facts
 * report only what the backup configuration currently is.
 *
 * The alternative — faking routes that answer with nothing — would pollute the
 * model's memory view with an empty source and could make a composition look
 * incomplete. An empty, clearly-labelled source is the smaller lie.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { resolveDataRoot } from './index.js'
import { inspectHome } from './snapshot.js'
import { readSettings } from './store.js'

export const SYNC_SOURCE_TYPE_ID = 'mnemon-sync'
export const SYNC_PACKAGE_NAME = '@summerscar/dsh-mnemon-sync'

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
  // A management descriptor is not decoration. dsh-mnemon builds its Source
  // catalog from installed Sources that declare one, and the workbench decides
  // a layer is "running" by whether its type is in that catalog — so a Source
  // without `management` is installed but reported as "on yet not running".
  // Fields stay empty: this page does its own editing.
  management: {
    label: 'Sync backup',
    description: 'Archive memory spaces to S3 or WebDAV.',
  },
}

/**
 * Build the Source definition.
 *
 * `facts()` must return the Host's *facts envelope* — `sourceInstanceKey`,
 * `sourceTypeId`, `role`, `availability`, `revision`, `capabilities`,
 * `routeIds`, `actionIds` (plus optional `hints`). dsh-mnemon rejects anything
 * else: `normalizeFacts()` compares `facts.sourceInstanceKey` against the
 * registry key and throws `memory Source facts instance mismatch` when it is
 * missing, which is exactly what a `{ summary, details }` shape produced.
 *
 * `hints` is the only free-form channel that survives normalization, so the
 * backup configuration a human may want to see travels there. `project()`
 * returns `{ fragments: [] }`: there is no memory content here to contribute.
 */
export function createSyncSource(manifest = syncSourceManifest) {
  return {
    manifest,
    create(context) {
      const configuredRoot = typeof context?.configuration?.dataRoot === 'string'
        ? context.configuration.dataRoot
        : undefined
      const dataRoot = resolveDataRoot(configuredRoot === undefined ? {} : { dataRoot: configuredRoot })
      const home = join(dataRoot, '..')

      return {
        facts() {
          const settings = safeSettings(home)
          const inspected = safeInspect(dataRoot)
          return {
            sourceInstanceKey: context.sourceInstanceKey,
            sourceTypeId: manifest.typeId,
            role: manifest.role,
            // This Source is a maintenance identity, not a memory backend: it
            // is always ready and holds nothing a View could select.
            availability: 'ready',
            revision: configurationRevision(settings, inspected),
            capabilities: [],
            routeIds: [],
            actionIds: [],
            // Facts are JSON only and must stay small: metadata the Host may
            // surface, never memory content. Only `hints` survives
            // normalization, so anything worth showing goes here.
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
          // Nothing to inject: this Source holds no memories to contribute.
          return { fragments: [] }
        },
        dispose() {},
      }
    },
  }
}

/**
 * A stable revision for the current backup configuration.
 *
 * The Host requires a non-empty string and compares it across a turn, so this
 * must change when the configuration changes and stay equal otherwise. It is
 * derived from the facts themselves rather than a clock, which keeps
 * composition deterministic.
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
