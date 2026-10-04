import type { PushMessage, RunEvent } from '@shared/events'
import { newId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import type { UsageSettings, QuotaPause } from '@shared/v3'
import type { EventBus } from '../events'
import { buildCheckpoint } from '../overnight/report'
import type { Repositories } from '../persistence'
import { canPauseRun } from '../state'
import { planQuotaWait } from './machine'
import type { AvailabilityProbe, ProbeResult } from './probe'
import type { UsageIntelligenceService } from './service'

/** The slice of the orchestrator the controller drives. */
export interface QuotaOrchestrator {
  pauseRun(runId: string, reason: 'quota', detail?: string, cause?: 'quota'): Promise<unknown>
  resumeRun(runId: string): Promise<unknown>
}

/**
 * Timing overrides for end-to-end tests of an unpackaged build (env NEXUS_USAGE_RESUME_DELAY_S and
 * NEXUS_USAGE_PROBE_S). Production passes none: the stored settings decide.
 */
export interface RecoveryTimingOverrides {
  resumeDelaySeconds?: number
  /** First interval of the unknown-reset schedule, in seconds. It doubles up to `probeMaxSeconds`. */
  probeSeconds?: number
  probeMaxSeconds?: number
}

export interface QuotaRecoveryOptions {
  repos: Repositories
  bus: EventBus
  usage: UsageIntelligenceService
  probe: AvailabilityProbe
  orchestrator: QuotaOrchestrator
  push: (message: PushMessage) => void
  now?: () => number
  /** Interval of the internal scheduler. 0 = none: tests call `tick()` themselves. Default 10 s. */
  tickIntervalMs?: number
  /** Overnight runs own their quota wait (the supervisor); the controller never touches them. */
  isOvernightRun: (runId: string) => boolean
  overrides?: RecoveryTimingOverrides
  logger?: (line: string) => void
}

const DEFAULT_TICK_MS = 10_000
const MAX_CHECKPOINTS = 50
/** A run rejected again within this long after an automatic resume continues the same wait. */
const RESUME_CARRY_MS = 10 * 60_000
/** After this many automatic resumes that Claude rejected again, the wait ends and the runs stay paused. */
export const MAX_FAILED_RESUMES = 6

export interface ResumeNowResult {
  /** False when there was no open wait. */
  hadWait: boolean
  probe: ProbeResult | null
  resumed: number
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Pauses become waits, waits become probes, a successful probe becomes a resume. All state is in the
 * `quota_pauses` / `quota_resumes` rows, so a restart loses nothing. Overnight runs are not handled here.
 */
export class QuotaRecoveryController {
  private readonly now: () => number
  private readonly unsubscribe: () => void
  private timer: NodeJS.Timeout | null = null
  private probing: Promise<ResumeNowResult> | null = null
  private ticking: Promise<void> | null = null
  private disposed = false

  constructor(private readonly o: QuotaRecoveryOptions) {
    this.now = o.now ?? Date.now
    this.unsubscribe = o.bus.subscribe((event) => this.onEvent(event))
    const every = o.tickIntervalMs ?? DEFAULT_TICK_MS
    if (every > 0) {
      this.timer = setInterval(() => {
        void this.tick().catch((e) => this.log(`tick failed: ${errorMessage(e)}`))
      }, every)
      this.timer.unref?.()
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Resolves when no tick or probe is in flight. Call after `dispose()` and before closing the database. */
  async idle(): Promise<void> {
    await Promise.allSettled([this.ticking, this.probing].filter((p) => p !== null) as Promise<unknown>[])
  }

  private log(line: string): void {
    this.o.logger?.(`quota-recovery: ${line}`)
  }

  private iso(ms: number = this.now()): string {
    return new Date(ms).toISOString()
  }

  /** The stored settings, with the test-build timing overrides applied. */
  private settings(): UsageSettings {
    const base = this.o.repos.settings.get().usage
    const ov = this.o.overrides
    if (!ov) return base
    const probeMinutes = ov.probeSeconds !== undefined ? ov.probeSeconds / 60 : base.unknownResetProbeMinutes
    const probeMaxMinutes = ov.probeMaxSeconds !== undefined ? ov.probeMaxSeconds / 60 : ov.probeSeconds !== undefined ? (ov.probeSeconds * 6) / 60 : base.unknownResetProbeMaxMinutes
    return {
      ...base,
      resumeDelaySeconds: ov.resumeDelaySeconds ?? base.resumeDelaySeconds,
      unknownResetProbeMinutes: probeMinutes,
      unknownResetProbeMaxMinutes: probeMaxMinutes,
    }
  }

  // ───────────────────────────── events ─────────────────────────────

  private onEvent(event: RunEvent): void {
    if (this.disposed) return
    try {
      if (event.type === 'run.paused') {
        const cause = (event.payload as RunEvent<'run.paused'>['payload']).cause
        if (cause === 'quota' && !this.o.isOvernightRun(event.runId)) this.handleQuotaPause(event.runId)
        return
      }
      if (event.type === 'run.resumed' || event.type === 'run.cancelled' || event.type === 'run.failed' || event.type === 'run.completed') {
        this.reconcile()
      }
    } catch (e) {
      this.log(`event ${event.type}: ${errorMessage(e)}`)
    }
  }

  /** The person (or the max-wait rule) ended this run's wait after it paused: a restart must not reopen it. */
  private waitEndedSincePause(runId: string): boolean {
    const { repos } = this.o
    const last = repos.quotaPauses.listByRun(runId).at(-1)
    if (!last || last.state !== 'ended' || !last.endedAt) return false
    const pausedAt = repos.events.latestOfType(runId, 'run.paused')?.createdAt ?? ''
    return last.endedAt >= pausedAt
  }

  /** A run paused for quota: checkpoint it, open its wait, and (when configured) pause the others. */
  private handleQuotaPause(runId: string, source: 'event' | 'recover' = 'event'): void {
    const { repos, bus, usage, push } = this.o
    const run = repos.runs.get(runId)
    if (!run || run.state !== 'paused' || run.pauseReason !== 'quota') return
    if (repos.quotaPauses.liveForRun(runId)) return
    // An ended wait is durable: such a run is resumed only by the person.
    if (source === 'recover' && this.waitEndedSincePause(runId)) return
    const settings = this.settings()
    const now = this.now()
    const machine = usage.machineState()
    let global = repos.quotaPauses.liveGlobal()
    const resetAt = machine.resetAt ?? (global?.resetAt ? Date.parse(global.resetAt) : null)
    const limitType = machine.limitType ?? global?.limitType ?? null

    const checkpoint = repos.checkpoints.insert({ id: newId(), runId, reason: 'quota', snapshot: buildCheckpoint(repos, run), createdAt: this.iso(now) })
    if (repos.checkpoints.count(runId) > MAX_CHECKPOINTS) repos.checkpoints.prune(runId, MAX_CHECKPOINTS)
    bus.emit({ runId, type: 'checkpoint.saved', payload: { checkpointId: checkpoint.id, reason: 'quota' } })

    const createdGlobal = !global
    let endWhy: string | null = null
    if (!global) {
      // A run rejected again soon after an automatic resume continues the SAME wait: the probe count and the
      // original start carry over, so the backoff and the maximum wait accumulate instead of restarting.
      const previous = repos.quotaPauses
        .listRecent({ limit: 30 })
        .find((p) => p.scope === 'global' && p.state === 'resumed' && p.endedAt !== null && now - Date.parse(p.endedAt) <= RESUME_CARRY_MS)
      let probes = 0
      let pausedAtMs = now
      if (previous) {
        const chain = repos.quotaPauses.listRecent({ limit: 200 }).filter((p) => p.scope === 'global' && p.state === 'resumed' && p.pausedAt === previous.pausedAt).length
        probes = previous.probes + 1
        pausedAtMs = Date.parse(previous.pausedAt)
        if (chain >= MAX_FAILED_RESUMES) endWhy = `Claude accepted ${chain} automatic resumes and rejected the work again each time.`
      }
      const plan = planQuotaWait({ now, resetAt, probes, settings, deadline: null, pausedAt: pausedAtMs })
      if (plan.action === 'end') endWhy = endWhy ?? plan.why
      const checkAt = plan.action === 'wait' && settings.autoResume && endWhy === null ? plan.checkAt : null
      global = repos.quotaPauses.insert({ ...this.newRow(null, 'global', now, limitType, resetAt, checkAt, null, null), pausedAt: this.iso(pausedAtMs), probes })
    }

    const nextCheckAt = global.nextCheckAt
    repos.quotaPauses.insert(this.newRow(runId, 'run', now, limitType, resetAt, nextCheckAt ? Date.parse(nextCheckAt) : null, checkpoint.id, run.resumeState))
    usage.apply({ type: 'quota_checkpointed' })
    bus.emit({ runId, type: 'usage.quota_paused', payload: { pauseId: global.id, resetAt: global.resetAt, nextCheckAt, limitType } })
    if (endWhy !== null) {
      // The run's row is written (and closed with the reason), the event and the notice say so; the run stays paused.
      this.endWaitInternal(endWhy, true)
      return
    }

    let others = 0
    if (settings.pauseAllOnGlobalLimit) others = this.pauseOthers(runId)
    if (createdGlobal) {
      const resumeAt = settings.autoResume && nextCheckAt ? Date.parse(nextCheckAt) : null
      const window = limitType ? ` (${limitType.replace(/_/g, ' ')} limit)` : ''
      let when: string
      if (resumeAt === null) when = 'Resume the runs from their pages when Claude is available again.'
      else if (resetAt !== null) when = `Automatic resume: ${clockTime(resumeAt)}.`
      else when = `Claude did not say when it resets: NEXUS checks again every ${settings.unknownResetProbeMinutes} to ${Math.max(settings.unknownResetProbeMinutes, settings.unknownResetProbeMaxMinutes)} minutes (no sooner), and keeps doing so until Claude is available or you end the wait.`
      push({
        kind: 'usage.notice',
        notice: 'limit_reached',
        title: 'Claude usage limit reached',
        detail: `NEXUS has safely paused ${plural(1 + others, 'run')}${window}. ${when} No work has been lost.`,
      })
    }
  }

  private newRow(runId: string | null, scope: QuotaPause['scope'], now: number, limitType: string | null, resetAt: number | null, nextCheckAt: number | null, checkpointId: string | null, resumeState: QuotaPause['resumeState']): QuotaPause {
    const at = this.iso(now)
    return {
      id: newId(),
      runId,
      scope,
      state: 'waiting',
      pausedAt: at,
      limitType,
      resetAt: resetAt !== null ? this.iso(resetAt) : null,
      resetConfidence: resetAt !== null ? 'EXACT' : 'UNKNOWN',
      nextCheckAt: nextCheckAt !== null ? this.iso(nextCheckAt) : null,
      probes: 0,
      checkpointId,
      resumeState,
      endedAt: null,
      endReason: null,
      createdAt: at,
      updatedAt: at,
    }
  }

  /** Pause every other active, non-overnight run with the same reason; their own events create their rows. */
  private pauseOthers(exceptRunId: string): number {
    const { repos, orchestrator } = this.o
    let n = 0
    for (const run of repos.runs.listActive()) {
      if (run.id === exceptRunId || run.state === 'paused' || !canPauseRun(run.state)) continue
      if (this.o.isOvernightRun(run.id)) continue
      n += 1
      void orchestrator.pauseRun(run.id, 'quota', 'Claude usage limit reached (paused together with the other runs)', 'quota').catch((e) => this.log(`pause ${run.id}: ${errorMessage(e)}`))
    }
    return n
  }

  // ───────────────────────────── bookkeeping ─────────────────────────────

  /**
   * Close the rows of runs that are no longer paused for quota (the user resumed or cancelled them, or
   * another pause took over). A global wait with no run left behind it is closed too.
   */
  reconcile(): void {
    const { repos, bus, usage } = this.o
    const live = repos.quotaPauses.listLive()
    let closedAny = false
    for (const row of live) {
      if (row.scope !== 'run' || !row.runId) continue
      const run = repos.runs.get(row.runId)
      if (run && run.state === 'paused' && run.pauseReason === 'quota') continue
      if (repos.quotaPauses.close(row.id, 'cancelled', this.iso(), 'The run is no longer paused for a usage limit')) {
        closedAny = true
        if (run) bus.emit({ runId: row.runId, type: 'usage.wait_ended', payload: { pauseId: row.id, reason: 'cancelled' } })
      }
    }
    if (!closedAny) return
    const remaining = repos.quotaPauses.listLive().filter((p) => p.scope === 'run')
    const global = repos.quotaPauses.liveGlobal()
    if (global && remaining.length === 0 && repos.quotaPauses.close(global.id, 'cancelled', this.iso(), 'No run is waiting any more')) {
      usage.apply({ type: 'wait_ended' })
    }
  }

  // ───────────────────────────── the scheduler ─────────────────────────────

  /** One scheduling pass: probe and resume when the planned time has come. Never overlaps itself. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.doTick().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  private async doTick(): Promise<void> {
    if (this.disposed) return
    const { repos, usage } = this.o
    usage.tickRamp()
    this.reconcile()
    usage.apply({ type: 'tick', hasLiveWait: this.anyWait() })
    const global = repos.quotaPauses.liveGlobal()
    if (!global || !this.settings().autoResume) return
    // Auto-resume switched on during a wait (or a wait that was never scheduled): plan it now.
    if (!global.nextCheckAt) {
      this.ensureScheduled(global)
      return
    }
    if (this.now() < Date.parse(global.nextCheckAt)) return
    await this.probeAndResume(global.id)
  }

  /** Any wait that owns the gate: an open quota row, or an Overnight run waiting for its reset. */
  private anyWait(): boolean {
    const { repos } = this.o
    return repos.quotaPauses.listLive().length > 0 || repos.overnight.listLive().some((r) => r.state === 'QUOTA_PAUSED')
  }

  /** Give a live wait without a next check a schedule, or end it when the plan says so. */
  private ensureScheduled(global: QuotaPause): void {
    const { repos } = this.o
    const settings = this.settings()
    const now = this.now()
    const plan = planQuotaWait({ now, resetAt: global.resetAt ? Date.parse(global.resetAt) : null, probes: global.probes, settings, deadline: null, pausedAt: Date.parse(global.pausedAt) })
    if (plan.action === 'end') {
      this.endWaitInternal(plan.why, true)
      return
    }
    const at = this.iso(plan.checkAt)
    repos.quotaPauses.update(global.id, { nextCheckAt: at, updatedAt: this.iso(now) })
    for (const row of repos.quotaPauses.listLive()) if (row.scope === 'run') repos.quotaPauses.update(row.id, { nextCheckAt: at, updatedAt: this.iso(now) })
  }

  /** The person asked to look now: probe at once and resume if Claude is available. */
  resumeNow(): Promise<ResumeNowResult> {
    const global = this.o.repos.quotaPauses.liveGlobal()
    if (!global) {
      this.reconcile()
      return Promise.resolve({ hadWait: false, probe: null, resumed: 0 })
    }
    return this.probeAndResume(global.id)
  }

  /** Concurrent callers share one probe: never more than one in flight. */
  private probeAndResume(globalId: string): Promise<ResumeNowResult> {
    if (!this.probing) {
      this.probing = this.doProbeAndResume(globalId).finally(() => {
        this.probing = null
      })
    }
    return this.probing
  }

  private async doProbeAndResume(globalId: string): Promise<ResumeNowResult> {
    const { repos, bus, usage, probe } = this.o
    const global = repos.quotaPauses.get(globalId)
    if (!global || (global.state !== 'waiting' && global.state !== 'probing')) return { hadWait: false, probe: null, resumed: 0 }
    const settings = this.settings()
    const started = this.now()
    repos.quotaPauses.update(global.id, { state: 'probing', updatedAt: this.iso(started) })
    usage.apply({ type: 'probe_started' })

    let result: ProbeResult
    try {
      result = await probe.probe({ limitType: global.limitType })
    } catch (e) {
      result = { available: false, method: 'none', resetAt: null, detail: errorMessage(e), outcome: 'runtime' }
    }
    // Shutdown began while the probe ran: write nothing and resume nothing (the database may be closing).
    if (this.disposed) return { hadWait: true, probe: result, resumed: 0 }
    const now = this.now()
    const waitedMs = Math.max(0, now - Date.parse(global.pausedAt))
    // The wait may have been closed meanwhile (every run cancelled or resumed by hand): nothing to update.
    const stillLive = repos.quotaPauses.get(global.id)
    if (!stillLive || (stillLive.state !== 'waiting' && stillLive.state !== 'probing')) return { hadWait: false, probe: result, resumed: 0 }
    repos.quotaResumes.insert({
      id: newId(),
      pauseId: global.id,
      runId: null,
      attemptedAt: this.iso(now),
      kind: 'probe',
      result: result.available ? 'available' : result.outcome === 'limited' ? 'still_limited' : 'failed',
      method: result.method,
      detail: result.detail,
      waitedMs,
      createdAt: this.iso(now),
    })
    usage.recordProbe(result)
    for (const row of repos.quotaPauses.listLive()) {
      if (row.scope === 'run' && row.runId) bus.emit({ runId: row.runId, type: 'usage.probe', payload: { pauseId: global.id, method: result.method, result: result.available ? 'available' : result.outcome } })
    }

    if (result.available) {
      usage.apply({ type: 'probe_result', outcome: 'available', resetAt: null })
      const resumed = await this.resumeAll(global.id, result.method)
      return { hadWait: true, probe: result, resumed }
    }

    const resetMs = result.resetAt ? Date.parse(result.resetAt) : Number.NaN
    const knownReset = Number.isFinite(resetMs) ? resetMs : global.resetAt ? Date.parse(global.resetAt) : null
    usage.apply({ type: 'probe_result', outcome: result.outcome === 'limited' ? 'limited' : result.outcome === 'auth' ? 'auth' : 'runtime', resetAt: Number.isFinite(resetMs) ? resetMs : null })
    const probes = global.probes + 1
    const plan = planQuotaWait({ now, resetAt: knownReset, probes, settings, deadline: null, pausedAt: Date.parse(global.pausedAt) })
    if (plan.action === 'end') {
      this.endWaitInternal(plan.why, true)
      return { hadWait: true, probe: result, resumed: 0 }
    }
    const patch = {
      state: 'waiting' as const,
      probes,
      resetAt: knownReset !== null ? this.iso(knownReset) : null,
      resetConfidence: knownReset !== null ? ('EXACT' as const) : ('UNKNOWN' as const),
      nextCheckAt: settings.autoResume ? this.iso(plan.checkAt) : null,
      updatedAt: this.iso(now),
    }
    repos.quotaPauses.update(global.id, patch)
    for (const row of repos.quotaPauses.listLive()) {
      if (row.scope === 'run') repos.quotaPauses.update(row.id, { probes, resetAt: patch.resetAt, resetConfidence: patch.resetConfidence, nextCheckAt: patch.nextCheckAt, updatedAt: patch.updatedAt })
    }
    return { hadWait: true, probe: result, resumed: 0 }
  }

  /** Close the global wait (claiming it), then resume every run still paused for quota. */
  private async resumeAll(globalId: string, method: ProbeResult['method']): Promise<number> {
    const { repos, bus, push, orchestrator } = this.o
    const global = repos.quotaPauses.get(globalId)
    if (!global) return 0
    // Claiming the global row first is what makes the resume idempotent: a second caller finds it closed.
    if (!repos.quotaPauses.close(globalId, 'resumed', this.iso(), null)) return 0
    // The gate listeners (the scheduler) last looked while this row was still open.
    this.o.usage.notifyGate()
    const rows = repos.quotaPauses.listLive().filter((p) => p.scope === 'run').sort((a, b) => a.pausedAt.localeCompare(b.pausedAt))
    let resumed = 0
    for (const row of rows) {
      if (!row.runId) continue
      const run = repos.runs.get(row.runId)
      if (!run || run.state !== 'paused' || run.pauseReason !== 'quota') {
        repos.quotaPauses.close(row.id, 'cancelled', this.iso(), 'The run is no longer paused for a usage limit')
        continue
      }
      if (!repos.quotaPauses.close(row.id, 'resumed', this.iso(), null)) continue
      const waitedMs = Math.max(0, this.now() - Date.parse(row.pausedAt))
      try {
        await orchestrator.resumeRun(row.runId)
        resumed += 1
        repos.quotaResumes.insert({ id: newId(), pauseId: row.id, runId: row.runId, attemptedAt: this.iso(), kind: 'resume', result: 'resumed', method, detail: null, waitedMs, createdAt: this.iso() })
        bus.emit({ runId: row.runId, type: 'usage.quota_resumed', payload: { pauseId: row.id, waitedMs, method } })
      } catch (e) {
        repos.quotaResumes.insert({ id: newId(), pauseId: row.id, runId: row.runId, attemptedAt: this.iso(), kind: 'resume', result: 'failed', method, detail: errorMessage(e), waitedMs, createdAt: this.iso() })
        this.log(`resume ${row.runId}: ${errorMessage(e)}`)
        // Still paused for quota with no open row: track it again (a new wait, probed on the schedule).
        this.handleQuotaPause(row.runId)
      }
    }
    if (resumed > 0 && this.settings().notifyOnResume) {
      const minutes = Math.max(1, Math.round((this.now() - Date.parse(global.pausedAt)) / 60_000))
      push({
        kind: 'usage.notice',
        notice: 'resumed',
        title: 'Claude capacity available',
        detail: resumed === 1 ? `Mission resumed automatically after ${plural(minutes, 'minute')}.` : `${plural(resumed, 'mission')} resumed automatically after ${plural(minutes, 'minute')}.`,
      })
    }
    return resumed
  }

  // ───────────────────────────── ending a wait ─────────────────────────────

  /** Give up waiting for one run, or for all runs. The runs stay paused for the person to resume. */
  endWait(runId?: string): void {
    const { repos, bus } = this.o
    const live = repos.quotaPauses.listLive()
    if (runId) {
      const row = live.find((p) => p.scope === 'run' && p.runId === runId)
      if (row && repos.quotaPauses.close(row.id, 'ended', this.iso(), 'Ended by the user')) {
        bus.emit({ runId, type: 'usage.wait_ended', payload: { pauseId: row.id, reason: 'user' } })
      }
      const remaining = repos.quotaPauses.listLive().filter((p) => p.scope === 'run')
      const global = repos.quotaPauses.liveGlobal()
      if (global && remaining.length === 0 && repos.quotaPauses.close(global.id, 'ended', this.iso(), 'Ended by the user')) {
        this.o.usage.apply({ type: 'wait_ended' })
      }
      return
    }
    this.endWaitInternal('Ended by the user', false)
  }

  /** Close every live row as ended, open the gate, and tell the person the runs stay paused. */
  private endWaitInternal(why: string, notify: boolean): void {
    const { repos, bus, usage, push } = this.o
    const at = this.iso()
    for (const row of repos.quotaPauses.listLive()) {
      if (row.scope === 'overnight') continue
      if (repos.quotaPauses.close(row.id, 'ended', at, why) && row.scope === 'run' && row.runId) {
        bus.emit({ runId: row.runId, type: 'usage.wait_ended', payload: { pauseId: row.id, reason: why } })
      }
    }
    usage.apply({ type: 'wait_ended' })
    if (notify) {
      push({ kind: 'usage.notice', notice: 'wait_ended', title: 'Automatic resume stopped', detail: `${why} The runs stay paused; resume them when Claude is available.` })
    }
  }

  // ───────────────────────────── startup ─────────────────────────────

  /**
   * Called once after the orchestrator's `recoverOnStartup`. A run that is `paused/quota` stays that way
   * (recoverOnStartup only converts runs that were active); the stored rows are reloaded and re-planned.
   */
  recover(): void {
    const { repos, usage } = this.o
    const settings = this.settings()
    const now = this.now()
    this.reconcile()
    // Runs paused for quota whose rows were never written (a crash between the pause and the row).
    for (const run of repos.runs.listByState('paused')) {
      if (run.pauseReason === 'quota' && !this.o.isOvernightRun(run.id)) this.handleQuotaPause(run.id, 'recover')
    }
    // An Overnight mission waiting for its reset: the supervisor owns it, but the gate must stay closed across the
    // restart. Only a mission: the wait of a campaign's trial runs is this controller's own (their rows are restored
    // below), and closing the gate for a wait nobody probes would leave it closed.
    for (const record of repos.overnight.listLive()) {
      if (record.workloadType === 'mission' && record.state === 'QUOTA_PAUSED') usage.apply({ type: 'restore_wait', resetAt: record.quota?.resetsAt ? Date.parse(record.quota.resetsAt) : null, limitType: null })
    }
    const global = repos.quotaPauses.liveGlobal()
    const runRows = repos.quotaPauses.listLive().filter((p) => p.scope === 'run')
    if (!global) {
      if (runRows.length > 0) {
        const first = runRows[0] as QuotaPause
        const resetMs = first.resetAt ? Date.parse(first.resetAt) : null
        const plan = planQuotaWait({ now, resetAt: resetMs, probes: first.probes, settings, deadline: null, pausedAt: Date.parse(first.pausedAt) })
        repos.quotaPauses.insert(this.newRow(null, 'global', Date.parse(first.pausedAt), first.limitType, resetMs, plan.action === 'wait' && settings.autoResume ? plan.checkAt : null, null, null))
        usage.apply({ type: 'restore_wait', resetAt: resetMs, limitType: first.limitType })
      }
      return
    }
    const resetMs = global.resetAt ? Date.parse(global.resetAt) : null
    // A probe that was in flight when the app stopped did not complete: back to waiting.
    if (global.state === 'probing') repos.quotaPauses.update(global.id, { state: 'waiting', updatedAt: this.iso(now) })
    usage.apply({ type: 'restore_wait', resetAt: resetMs, limitType: global.limitType })
    if (!global.nextCheckAt && settings.autoResume) this.ensureScheduled(global)
  }
}
