/**
 * AgentScope Platform — the daily check-in.
 *
 * HONEST PREMISE: the platform has no check-in endpoint. Its "每日登录 +1"
 * contribution is awarded BY THE SERVER when the account signs in; there is
 * nothing to POST, and no claim call exists. The WorkBuddy/CodeBuddy billing
 * gateway has a real `/v2/billing/meter/daily-checkin`, but that is a different
 * service and copying it here would be a fabricated feature.
 *
 * So this module does the only thing that is actually true:
 *
 *   1. Keep the login alive once a day by reading the account document (which is
 *      what makes the server count the daily login).
 *   2. Read the contribution ledger back and look for TODAY's `daily_login`
 *      entry.
 *   3. Report what it saw: `credited` when the entry is there, `pending` when
 *      the keep-alive ran but the platform has not scored it yet, `failed` when
 *      the keep-alive itself failed.
 *
 * The panel says exactly this. It never claims a check-in succeeded on the
 * strength of our own request alone.
 *
 * IDEMPOTENT PER LOCAL DAY — exactly ONE keep-alive request per day. The day is
 * the platform-visible Asia/Shanghai date (UTC+8).
 *
 * SCHEDULING is a re-armed one-shot timer. A heartbeat tick ONLY checks whether
 * the local day changed; it must NOT call `userinfo()` again. Running the whole
 * keep-alive on every heartbeat would log the account in 48 times a day, which
 * is both pointless (daily_login counts once) and hard on the rotating token.
 *
 * The action runs when: the switch is turned on, the local day rolls over, a
 * manual "run now" is pressed, or an earlier attempt failed (with backoff). A
 * day already scored (or still pending) just keeps ticking the clock.
 *
 * Failures back off instead of hammering.
 *
 * @module dsh-connect-agentscope-platform/checkin
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { zonedParts } from './as.js'
import { pluginPaths } from './paths.js'

/** Clock heartbeat: cheap day-rollover check. It performs NO account request. */
const HEARTBEAT_MS = 5 * 60 * 1000
/** Backoff ladder after a failed attempt (last value repeats). */
const RETRY_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000]
/** How many ledger entries to scan for today's daily_login. */
const LEDGER_PAGE_SIZE = 20

/**
 * @typedef {object} CheckinState
 * @property {string} day          - local (Asia/Shanghai) YYYY-MM-DD this record describes
 * @property {'idle'|'pending'|'credited'|'failed'} status
 * @property {number} attempts     - attempts made on this day
 * @property {number} lastAttemptAt
 * @property {string} detail       - human-readable outcome of the last attempt
 * @property {string} [error]
 */

/** The empty record for a day the plugin has not acted on yet. */
function freshState(day) {
  return { day, status: 'idle', attempts: 0, lastAttemptAt: 0, detail: '', error: '' }
}

/**
 * The daily check-in scheduler.
 *
 * State is deliberately tiny and secret-free: a day, a status and an attempt
 * counter. No token, no account id — this file may be copied between machines
 * without leaking anything.
 */
export class CheckinScheduler {
  /**
   * @param {object} options
   * @param {import('./as.js').CreditEngine} options.engine
   * @param {string} options.stateDir
   * @param {() => { enabled?: boolean }} options.settings
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.engine = options.engine
    this.settings = options.settings
    this.log = options.log ?? (message => console.warn(`[agentscope-platform] ${message}`))
    // Resolved through the plugin's own paths module, never a literal.
    this.file = (options.paths ?? pluginPaths({ dshHome: options.dshHome })).checkin
    this.timer = null
    this.running = false
    this.generation = 0
    /** @type {CheckinState} */
    this.state = freshState(zonedParts(new Date()).day)
    this.load()
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  load() {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return
      this.state = {
        day: typeof parsed.day === 'string' ? parsed.day : this.state.day,
        status: ['idle', 'pending', 'credited', 'failed'].includes(parsed.status) ? parsed.status : 'idle',
        attempts: Number(parsed.attempts) || 0,
        lastAttemptAt: Number(parsed.lastAttemptAt) || 0,
        detail: typeof parsed.detail === 'string' ? parsed.detail : '',
        error: typeof parsed.error === 'string' ? parsed.error : '',
      }
    } catch { /* a corrupt file must not stop the plugin */ }
  }

  save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    } catch { /* best effort */ }
  }

  /** The record for TODAY, resetting in place when the local day rolled over. */
  todayRecord() {
    const day = zonedParts(new Date()).day
    if (this.state.day !== day) {
      this.state = freshState(day)
      this.save()
    }
    return this.state
  }

  /** Browser-facing view: today's record plus whether we are enabled. */
  view() {
    const record = this.todayRecord()
    const settings = this.settings()
    return {
      enabled: settings.enabled === true,
      day: record.day,
      status: record.status,
      attempts: record.attempts,
      lastAttemptAt: record.lastAttemptAt,
      detail: record.detail,
      error: record.error,
      running: this.running,
      timerActive: this.timer !== null,
      timezone: 'Asia/Shanghai',
    }
  }

  // -------------------------------------------------------------------------
  // The one attempt
  // -------------------------------------------------------------------------

  /**
   * Is today's `daily_login` already in the ledger page?
   * @param {Array<object>} items
   * @param {string} day
   */
  static hasDailyLogin(items, day) {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue
      const action = typeof item.action === 'string' ? item.action : ''
      if (action !== 'daily_login') continue
      // `score_date` is the day the score counts for; `created_at` is the
      // fallback because a ledger row may carry only one of them.
      const scoreDate = typeof item.score_date === 'string' ? item.score_date.slice(0, 10) : ''
      const created = typeof item.created_at === 'string' ? item.created_at.slice(0, 10) : ''
      if (scoreDate === day || created === day) return true
    }
    return false
  }

  /**
   * Run one check-in attempt.
   *
   * The sequence is the honest one:
   *   1. read the account document — this is the keep-alive that makes the
   *      server count a daily login, and it also proves the login still works;
   *   2. read the contribution ledger and look for today's entry;
   *   3. report the outcome. It performs NO account-writing operations.
   *
   * @param {string} [trigger]
   */
  async runOnce(trigger = 'manual') {
    if (this.running) return { skipped: true, reason: 'a check-in attempt is already running' }
    const settings = this.settings()
    if (settings.enabled !== true && trigger === 'schedule') return { skipped: true, reason: 'daily check-in is switched off' }
    this.running = true
    const record = this.todayRecord()
    record.attempts += 1
    record.lastAttemptAt = Date.now()
    const outcome = { at: new Date().toISOString(), trigger, day: record.day, keepAlive: false, dailyLogin: false, error: '' }
    try {
      // 1. Keep-alive: this is the only action the check-in performs. Reading
      // the account document is what lets the server count today's login; there
      // is no check-in endpoint to POST to.
      await this.engine.userinfo()
      outcome.keepAlive = true

      // 2. Read the ledger back and report what the platform ACTUALLY scored.
      const ledger = await this.engine.contributions(1, LEDGER_PAGE_SIZE)
      const items = ledger !== null && Array.isArray(ledger.items) ? ledger.items : []
      outcome.dailyLogin = CheckinScheduler.hasDailyLogin(items, record.day)

      record.status = outcome.dailyLogin ? 'credited' : 'pending'
      record.detail = outcome.dailyLogin
        ? `${record.day}: the ledger already carries today's daily_login`
        : `${record.day}: keep-alive done, the platform has not scored a daily_login yet`
      record.error = ''
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record.status = 'failed'
      record.error = message.slice(0, 300)
      record.detail = `${record.day}: ${message.slice(0, 200)}`
      outcome.error = record.error
    } finally {
      this.running = false
      this.save()
    }
    return { outcome, view: this.view() }
  }


  /**
   * Re-read ONLY the contribution ledger, without touching the account
   * document.
   *
   * A pending day means the keep-alive already ran but the platform had not
   * scored `daily_login` yet. Checking again later is a READ, not another login,
   * so it can run on a heartbeat without inflating the daily login count.
   */
  async refreshLedger() {
    const record = this.todayRecord()
    if (record.status !== 'pending') return record
    try {
      const ledger = await this.engine.contributions(1, LEDGER_PAGE_SIZE)
      const items = ledger !== null && Array.isArray(ledger.items) ? ledger.items : []
      if (CheckinScheduler.hasDailyLogin(items, record.day)) {
        record.status = 'credited'
        record.detail = `${record.day}: the ledger now carries today's daily_login`
        this.save()
      }
    } catch { /* a read failure just leaves it pending */ }
    return record
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /** Milliseconds until the next attempt should be made. */
  /** Milliseconds until the next timer tick (a tick is NOT a login). */
  nextDelayMs() {
    const settings = this.settings()
    if (settings.enabled !== true) return 0
    const record = this.todayRecord()
    if (record.status === 'failed') {
      const index = Math.min(record.attempts === 0 ? 0 : record.attempts - 1, RETRY_MS.length - 1)
      return RETRY_MS[index]
    }
    // A day that was already acted on (credited OR pending) needs NO more
    // requests: just tick until the clock crosses local midnight.
    if (record.attempts > 0) return HEARTBEAT_MS
    // Never acted on today (fresh enable, or a new local day).
    return 2_000
  }

  /** Whether this tick should actually perform the keep-alive. */
  shouldRunNow(record) {
    // A failed attempt retries (nextDelayMs already backed off).
    if (record.status === 'failed') return true
    // One attempt per local day. Everything else is a pure clock tick.
    return record.attempts === 0
  }

  /** Arm the next attempt. Safe to call repeatedly: it always re-arms. */
  arm() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    const settings = this.settings()
    if (settings.enabled !== true) return
    const delay = this.nextDelayMs()
    const generation = (this.generation += 1)
    this.timer = setTimeout(() => {
      if (this.generation !== generation) return
      this.timer = null
      const record = this.todayRecord()  // also resets the record on a new day
      if (!this.shouldRunNow(record)) {
        // Clock tick: NO keep-alive / no login. If the day is still pending, do a
        // read-only ledger check so the status can move to "credited" once the
        // platform scores it. Then simply wait for the next local midnight.
        void this.refreshLedger().finally(() => {
          if (this.generation !== generation) return
          this.arm()
        })
        return
      }
      void this.runOnce('schedule').finally(() => {
        if (this.generation !== generation) return
        this.arm()
      })
    }, Math.max(1_000, delay))
    this.timer.unref?.()
  }

  /** Re-evaluate the switch and the day: call this on every settings write. */
  sync() {
    const settings = this.settings()
    if (settings.enabled !== true) {
      if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
      return
    }
    // A day that rolled over while the plugin was idle starts as `idle` again,
    // which `todayRecord()` performs as a side effect.
    this.todayRecord()
    this.arm()
  }

  /** Release the timer (plugin disposal). */
  stop() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    this.generation += 1
  }
}
