/**
 * Mnemon Sync — the schedule and the run bookkeeping.
 *
 * The cadence model is copied from dsh-mnemon's own Git auto-backup, because
 * that design is already proven against this runtime and both surfaces should
 * read the same to a user:
 *
 * - One interval, a whole number of minutes, read from settings. Zero means
 *   "only when the button is pressed".
 * - One `setTimeout` for the whole Host, re-armed from `finally`, never an
 *   interval. Two timers can never overlap into a double upload.
 * - The interval is re-read from disk on every tick, so saving settings
 *   changes the cadence without restarting the process.
 * - A tick that fires while a run is in flight is dropped, not queued: a slow
 *   target must not build a backlog of pending uploads.
 * - Failures are recorded and swallowed. A timer is the last place that should
 *   raise an exception nobody is watching.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MINUTE_MS = 60_000
const HISTORY_LIMIT = 20
const STATE_DIRECTORY = 'state'
const HISTORY_FILE = 'mnemon-sync-history.json'

/** Present a run in a form the tab can render without extra shaping. */
function toRunRecord(entry) {
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    ok: entry.ok === true,
    trigger: entry.trigger,
    durationMs: entry.durationMs,
    ...entry.spaces === undefined ? {} : { spaces: entry.spaces },
    ...entry.bytes === undefined ? {} : { bytes: entry.bytes },
    ...entry.key === undefined ? {} : { key: entry.key },
    ...entry.location === undefined ? {} : { location: entry.location },
    ...entry.error === undefined ? {} : { error: entry.error },
    ...entry.removed === undefined ? {} : { removed: entry.removed },
  }
}

export class SyncHistory {
  constructor(home) {
    this.root = home
  }

  path() {
    return join(this.root, STATE_DIRECTORY, HISTORY_FILE)
  }

  read() {
    try {
      const stored = JSON.parse(readFileSync(this.path(), 'utf8'))
      const runs = Array.isArray(stored?.runs) ? stored.runs : []
      return runs.map(toRunRecord)
    } catch {
      return []
    }
  }

  append(record) {
    const runs = [toRunRecord(record), ...this.read()].slice(0, HISTORY_LIMIT)
    mkdirSync(join(this.root, STATE_DIRECTORY), { recursive: true, mode: 0o700 })
    writeFileSync(this.path(), `${JSON.stringify({ version: 1, runs }, null, 2)}\n`, { mode: 0o600 })
    return runs
  }

  latest() {
    return this.read()[0]
  }
}

/**
 * The Host-wide timer. `run()` is injected so the timer itself has no opinion
 * about what a backup does, which keeps it testable and keeps the wiring in
 * index.js.
 */
export class SyncScheduler {
  /**
   * @param {object} options
   * @param {() => object} options.readSettings current settings, read fresh each tick
   * @param {(trigger: string, settings: object, signal: AbortSignal) => Promise<object>} options.run performs one backup
   * @param {() => Date} [options.now]
   * @param {(error: unknown) => void} [options.onError]
   */
  constructor(options) {
    this.readSettings = options.readSettings
    this.run = options.run
    this.now = options.now ?? (() => new Date())
    this.onError = options.onError
    this.timer = undefined
    this.running = false
    this.stopped = false
    this.controller = undefined
    this.lastAttemptAt = undefined
    this.lastRunAt = undefined
    this.lastAt = undefined
    this.lastError = undefined
    this.lastFailure = undefined
  }

  start() {
    this.schedule()
    return () => {
      this.stopped = true
      this.cancel()
    }
  }

  /** Re-arm without running; called after the settings page saves. */
  refresh() {
    if (this.stopped) return
    this.cancel()
    this.schedule()
  }

  cancel() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.controller?.abort()
    this.controller = undefined
  }

  /**
   * What the settings block shows, mirroring the Git channel's shape so the two
   * read alike: whether the timer is armed, and when it ran and will run again.
   */
  snapshot(settings) {
    const minutes = minutesOf(settings)
    const available = minutes > 0 && !this.stopped && settings.enabled === true
    return {
      available,
      autoSyncMinutes: minutes,
      ...this.lastAt === undefined ? {} : { lastAt: this.lastAt },
      ...this.lastAttemptAt === undefined || !available
        ? {}
        : { nextAt: new Date(this.lastAttemptAt + minutes * MINUTE_MS).toISOString() },
      ...this.lastError === undefined ? {} : { lastError: this.lastError },
      ...this.lastError === undefined || this.lastFailure === undefined
        ? {}
        : { lastFailure: this.lastFailure },
      ...!this.running ? {} : { running: true },
    }
  }

  schedule() {
    if (this.stopped || this.timer !== undefined) return
    let settings
    try {
      settings = this.readSettings()
    } catch {
      return
    }
    const minutes = minutesOf(settings)
    if (minutes <= 0 || settings.enabled !== true) return
    this.lastAttemptAt = this.now().getTime()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick('schedule').catch(() => {
        // `tick` already recorded the failure; the timer must not rethrow.
      })
    }, minutes * MINUTE_MS)
  }

  /**
   * Run one backup now. Shared by the timer and the tab's button so both paths
   * record history and both refuse to overlap.
   */
  async runNow(trigger = 'manual') {
    return this.tick(trigger)
  }

  async tick(trigger) {
    if (this.stopped) return { skipped: 'stopped' }
    if (this.running) return { skipped: 'busy' }
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    const startedAt = this.now().toISOString()
    const startedMs = this.now().getTime()
    try {
      const settings = this.readSettings()
      if (trigger === 'schedule' && settings.enabled !== true) {
        return { skipped: 'disabled' }
      }
      const result = await this.run(trigger, settings, controller.signal)
      this.lastRunAt = this.now().toISOString()
      this.lastAt = this.lastRunAt
      this.lastError = undefined
      this.lastFailure = undefined
      return { ...result, startedAt, durationMs: this.now().getTime() - startedMs, trigger }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // An aborted run is the expected outcome of disable/refresh, not a fault.
      if (!this.stopped && !controller.signal.aborted) {
        this.lastError = message
        this.lastFailure = error instanceof Error ? error.reason : undefined
        try {
          this.onError?.(error)
        } catch {
          // the error hook must not become a second failure
        }
      }
      throw error
    } finally {
      this.running = false
      if (this.controller === controller) this.controller = undefined
      this.schedule()
    }
  }
}

/** The saved interval, or zero when it cannot be read at all. */
function minutesOf(settings) {
  const minutes = settings?.autoSyncMinutes
  return typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0 ? minutes : 0
}

export { HISTORY_LIMIT }
