import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { TERMINAL_RUN_STATES, type ApprovalRequest, type Preset, type Run, type RunConfig } from '@shared/domain'
import type { PauseCause, PushMessage, RunEvent } from '@shared/events'
import { newId } from '@shared/ids'
import {
  decidePowerAction,
  decideQuota,
  EndActionSchema,
  EndConditionsSchema,
  normalizeEpochMs,
  OVERNIGHT_CONFIRMATION_TEXT,
  OvernightPolicySchema,
  toStatus,
  type EndAction,
  type EndConditions,
  type OvernightPolicy,
  type OvernightRun,
  type OvernightState,
  type OvernightStatus,
  type PowerAction,
  type PowerAuditEntry,
  type PowerCommandResult,
  type TerminalReason,
  type WatchdogDiagnostic,
} from '@shared/overnight'
import { errorMessage, NexusError } from '@shared/result'
import type { EventBus } from '@main/modules/events'
import type { GitService } from '@main/modules/git'
import type { Repositories } from '@main/modules/persistence'
import { isEffectivelyForced, type PowerController } from '@main/modules/power'
import { buildCheckpoint, buildOvernightReport, powerAddendum, type GitStateCapture } from './report'

/** The orchestrator surface the supervisor drives. It never reaches into scheduling internals. */
export interface OvernightOrchestrator {
  createRun(input: {
    projectId: string
    mode: Run['mode']
    preset: Preset
    prompt: string
    overrides?: Partial<RunConfig>
    prepare?: (run: Run) => Promise<void>
  }): Promise<Run>
  pauseRun(runId: string, reason?: 'user' | 'quota' | 'recovery', detail?: string, cause?: PauseCause): Promise<Run>
  resumeRun(runId: string): Promise<Run>
  cancelRun(runId: string): Promise<Run>
  recover(runId: string, action: 'resume' | 'inspect' | 'cancel'): Promise<Run>
  requestTick(runId: string): void
  resolveApproval(approvalId: string, approve: boolean, note?: string): ApprovalRequest
}

export interface OvernightDeps {
  repos: Repositories
  bus: EventBus
  orchestrator: OvernightOrchestrator
  /** The power controller is held here and nowhere else. */
  power: PowerController
  git: GitService
  push: (message: PushMessage) => void
  /** Force SQLite to write its log into the database file. */
  flush: () => void
  /** Directory under the NEXUS data directory that always receives a copy of the final report. */
  reportsDir: string
  now?: () => number
  /** Epoch milliseconds at which Windows booted; used to tell whether an OS shutdown timer can still exist. */
  bootTime?: () => number
  /** Milliseconds between supervisor passes; 0 disables the timer (tests call tick()). */
  tickIntervalMs?: number
  /** Longest wait for agent sessions to stop during finalization. */
  stopTimeoutMs?: number
  /** Longest time finalization spends on Git (checkpoint commits and state capture). */
  gitTimeoutMs?: number
  /**
   * Keyed signature over the authorization and the current policy. The key never leaves the main
   * process, so a row edited from outside (an agent's shell can reach the database file) fails the
   * check and no power action is taken. Without a sealer the stored row is trusted (tests).
   */
  sealer?: { sign(payload: string): string }
  logger?: (line: string) => void
}

export interface OvernightStartInput {
  projectId: string
  prompt: string
  preset: Preset
  policy: OvernightPolicy
  confirmed: boolean
  confirmation: string
  maxParallelAgents?: number
  maxIterations?: number
  planningMode?: 'single' | 'consensus'
  reviewMode?: 'standard' | 'dual' | 'auto'
}

export interface OvernightAmendment {
  endAction?: EndAction
  shutdownOn?: EndConditions
  finalDelaySeconds?: number
  forceCloseApplications?: boolean
}

const RUN_WORKING_STATES: readonly Run['state'][] = ['planning', 'executing', 'testing', 'reviewing', 'verifying', 'repairing']
const MAX_WATCHDOG_ENTRIES = 50
const MAX_CHECKPOINTS = 200
/** An app-timer power action that is this late was missed (the app was not running); it is not executed. */
const MISSED_ACTION_GRACE_MS = 5 * 60_000
/** After a Windows shutdown timer elapsed, NEXUS should no longer be running. */
const OS_TIMER_OVERRUN_MS = 3 * 60_000
/** NEXUS being down for longer than this ends the unattended session: no power action is applied afterwards. */
const CONTINUITY_GAP_MS = 10 * 60_000
const HEARTBEAT_INTERVAL_MS = 30_000
const heartbeatKey = (runId: string): string => `overnight-heartbeat:${runId}`
const CHECKPOINT_EVENTS: Partial<Record<RunEvent['type'], string>> = {
  'run.started': 'planning',
  'graph.revised': 'graph revision',
  'task.completed': 'task completion',
  'git.merged': 'integration',
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** JSON with sorted keys, so the same value always signs to the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Resolve with `fallback` when `work` takes longer than `ms`; the work itself is not interrupted. */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Deterministic owner of an overnight run's lifecycle: arms the failsafe before any agent starts,
 * watches the run, the wall clock, the usage limit and the budgets, and at the end stops the work,
 * saves the report and only then applies the power policy the user approved for this run.
 *
 * It is not an agent and takes no input from agents: nothing an agent writes (text, tool call,
 * message, graph proposal) reaches the policy or the power controller.
 */
export class OvernightSupervisor {
  private readonly live = new Set<string>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly stalls = new Map<string, { reconciledAt: number }>()
  private readonly lastCheckpoint = new Map<string, number>()
  private readonly ticking = new Set<string>()
  private readonly lastHeartbeat = new Map<string, number>()
  /** Set synchronously while a start is in flight, so two starts cannot both pass the single-run check. */
  private starting = false
  private readonly unsubscribe: () => void
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly deps: OvernightDeps) {
    for (const record of deps.repos.overnight.listLive()) this.live.add(record.runId)
    this.unsubscribe = deps.bus.subscribe((event) => this.onEvent(event))
    const interval = deps.tickIntervalMs ?? 5000
    if (interval > 0) {
      this.timer = setInterval(() => void this.tick(), interval)
      this.timer.unref?.()
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private log(line: string): void {
    this.deps.logger?.(`overnight: ${line}`)
  }

  // ───────────────────────────── queries ─────────────────────────────

  status(runId: string): OvernightStatus | null {
    const record = this.deps.repos.overnight.getByRun(runId)
    return record ? toStatus(record) : null
  }

  /** Overnight runs the supervisor still owns. */
  active(): OvernightStatus[] {
    return this.deps.repos.overnight.listLive().map(toStatus)
  }

  hasActive(): boolean {
    return this.live.size > 0
  }

  report(runId: string): { text: string | null; path: string | null } {
    const record = this.deps.repos.overnight.getByRun(runId)
    return { text: record?.finalReport ?? null, path: record?.reportPath ?? null }
  }

  audit(runId: string): PowerAuditEntry[] {
    return this.deps.repos.powerAudit.listByRun(runId)
  }

  /** What the supervisor believes is pending in Windows for this run (from its own records). */
  pendingPowerAction(runId: string): { kind: 'failsafe' | 'final'; action: PowerAction; at: string } | null {
    const record = this.deps.repos.overnight.getByRun(runId)
    if (!record) return null
    if (record.state === 'POWER_ACTION_SCHEDULED' && record.powerAction && !record.powerAction.cancelledAt && !record.powerAction.executedAt) {
      return { kind: 'final', action: record.powerAction.action, at: record.powerAction.executeAt }
    }
    if (this.failsafeArmed(record)) {
      return { kind: 'failsafe', action: 'SHUTDOWN', at: (record.failsafe as NonNullable<OvernightRun['failsafe']>).deadline }
    }
    return null
  }

  // ───────────────────────────── start ─────────────────────────────

  /**
   * Start an overnight run. The run row, the authorization and the failsafe exist (in that order)
   * before the first agent session starts; if the failsafe cannot be armed the run never begins.
   */
  async start(input: OvernightStartInput): Promise<{ run: Run; overnight: OvernightStatus }> {
    if (input.confirmed !== true || input.confirmation !== OVERNIGHT_CONFIRMATION_TEXT) {
      throw new NexusError('invalid_input', 'Overnight Mode needs the explicit power authorization for this run.')
    }
    const policy = OvernightPolicySchema.parse(input.policy)
    if (this.live.size > 0 || this.starting) {
      throw new NexusError('invalid_state', 'An overnight run is already active. Windows holds a single shutdown timer; finish or cancel that run first.')
    }
    this.starting = true
    try {
      return await this.startReserved(input, policy)
    } finally {
      this.starting = false
    }
  }

  private async startReserved(input: OvernightStartInput, policy: OvernightPolicy): Promise<{ run: Run; overnight: OvernightStatus }> {
    const { repos, orchestrator } = this.deps
    const run = await orchestrator.createRun({
      projectId: input.projectId,
      mode: 'mission',
      preset: input.preset,
      prompt: input.prompt,
      overrides: {
        // Nobody is there to approve a plan; starting the run is the approval.
        requirePlanApproval: false,
        maxDurationMinutes: policy.maxDurationMinutes,
        ...(input.maxParallelAgents !== undefined ? { maxParallelAgents: input.maxParallelAgents } : {}),
        ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
        ...(input.planningMode ? { planningMode: input.planningMode } : {}),
        ...(input.reviewMode ? { reviewMode: input.reviewMode } : {}),
      },
      prepare: (created) => this.arm(created, policy),
    })
    const record = repos.overnight.getByRun(run.id)
    if (!record) throw new NexusError('internal', 'The overnight record was not created')
    return { run: repos.runs.require(run.id), overnight: toStatus(record) }
  }

  private async arm(run: Run, policy: OvernightPolicy): Promise<void> {
    const { repos, bus, power } = this.deps
    const now = this.now()
    let record = repos.overnight.insert({
      id: run.id,
      runId: run.id,
      projectId: run.projectId,
      state: 'ARMING',
      policy,
      authorization: this.sealed({ runId: run.id, authorizedAt: iso(now), confirmation: OVERNIGHT_CONFIRMATION_TEXT, policy }, policy),
      startedAt: iso(now),
      deadlineAt: iso(now + policy.maxDurationMinutes * 60_000),
      failsafe: null,
      terminalReason: null,
      terminalDetail: null,
      finalReport: null,
      reportPath: null,
      reportSavedAt: null,
      powerAction: null,
      quota: null,
      watchdog: [],
      amendments: [],
      error: null,
      createdAt: iso(now),
      updatedAt: iso(now),
      finishedAt: null,
    })
    this.live.add(run.id)
    let timerScheduled = false
    try {
      // With no end action the user asked for no power action at all, so no shutdown timer is armed either.
      if (policy.failsafeEnabled && policy.endAction !== 'NONE') {
        const delaySeconds = policy.failsafeAfterMinutes * 60
        const result = await power.scheduleShutdown({ delaySeconds, force: policy.forceCloseApplications, purpose: 'failsafe' })
        this.writeAudit(run.id, 'arm_failsafe', 'SHUTDOWN', `Failsafe after ${policy.failsafeAfterMinutes} minutes`, result)
        if (!result.ok) {
          bus.emit({ runId: run.id, type: 'overnight.failsafe', payload: { action: 'failed', deadline: null, ok: false } })
          const why =
            result.exitCode === 1190
              ? 'Windows already has a shutdown scheduled. Cancel it (shutdown /a) and start again.'
              : `Windows refused the failsafe shutdown timer (exit ${result.exitCode ?? 'n/a'}): ${result.output || 'no output'}`
          throw new NexusError('invalid_state', `Overnight run not started: ${why}`)
        }
        timerScheduled = true
        const deadline = iso(Date.parse(result.at) + delaySeconds * 1000)
        record = this.update(record.id, { failsafe: { scheduledAt: result.at, deadline, result, cancelledAt: null, cancelResult: null, lostAt: null } })
        bus.emit({ runId: run.id, type: 'overnight.failsafe', payload: { action: 'armed', deadline, ok: true } })
      }
      // A cancel that arrived while Windows was being asked has already moved the record on.
      const current = repos.overnight.require(record.id)
      if (current.state === 'ARMING') this.setState(current, 'RUNNING')
      this.heartbeat(run.id, this.now())
      bus.emit({
        runId: run.id,
        type: 'overnight.started',
        payload: { deadlineAt: record.deadlineAt, endAction: policy.endAction, failsafeDeadline: record.failsafe?.deadline ?? null },
      })
    } catch (e) {
      this.live.delete(run.id)
      // The run does not start, so a timer Windows already accepted must not stay behind.
      let note = ''
      if (timerScheduled) {
        const aborted = await this.abortOsTimer(run.id, 'The overnight run did not start').catch(() => false)
        if (aborted) {
          const failsafe = repos.overnight.getByRun(run.id)?.failsafe
          if (failsafe) this.tryUpdate(record.id, { failsafe: { ...failsafe, cancelledAt: iso(this.now()) } })
        } else note = ' The failsafe shutdown timer could not be cancelled: run "shutdown /a".'
      }
      this.tryUpdate(record.id, { state: 'DONE', error: `${errorMessage(e)}${note}`, finishedAt: iso(this.now()) })
      if (note) throw new NexusError('internal', `${errorMessage(e)}${note}`)
      throw e
    }
  }

  /** The stored authorization with its signature over the approved and the current policy. */
  private sealed(authorization: Omit<OvernightRun['authorization'], 'seal'>, currentPolicy: OvernightPolicy): OvernightRun['authorization'] {
    const { sealer } = this.deps
    if (!sealer) return authorization
    return { ...authorization, seal: sealer.sign(canonical({ authorization, policy: currentPolicy })) }
  }

  /** The gate for every power decision: integrity of the stored row first, then the policy itself. */
  private decide(record: OvernightRun, reason: TerminalReason): ReturnType<typeof decidePowerAction> {
    if (!this.intact(record)) {
      return { action: null, why: 'The stored authorization or policy failed its integrity check (it was changed outside NEXUS).' }
    }
    return decidePowerAction(record, record.runId, reason)
  }

  private intact(record: OvernightRun): boolean {
    const { sealer } = this.deps
    if (!sealer) return true
    const { seal, ...authorization } = (record.authorization ?? {}) as OvernightRun['authorization']
    return Boolean(seal) && seal === sealer.sign(canonical({ authorization, policy: record.policy }))
  }

  /** Ask Windows to abort its shutdown timer, whatever the record says. True when none is pending afterwards. */
  private async abortOsTimer(runId: string, why: string): Promise<boolean> {
    const result = await this.deps.power.cancelShutdown()
    this.writeAudit(runId, 'cancel_failsafe', 'SHUTDOWN', why, result)
    return result.ok || result.exitCode === 1116
  }

  private tryUpdate(id: string, patch: Partial<Omit<OvernightRun, 'id'>>): void {
    try {
      this.update(id, patch)
    } catch (e) {
      this.log(`update ${id}: ${errorMessage(e)}`)
    }
  }

  // ───────────────────────────── events ─────────────────────────────

  private onEvent(event: RunEvent): void {
    if (this.disposed || !this.live.has(event.runId)) return
    const runId = event.runId
    switch (event.type) {
      case 'run.completed':
        void this.finalize(runId, 'SUCCESS')
        break
      case 'run.failed':
        void this.finalize(runId, 'FAILED', (event as RunEvent<'run.failed'>).payload.error)
        break
      case 'run.cancelled':
        void this.finalize(runId, 'USER_CANCELLED')
        break
      case 'run.paused': {
        const payload = (event as RunEvent<'run.paused'>).payload
        const cause: PauseCause = payload.cause ?? (payload.reason === 'user' ? (payload.detail ? 'intervention' : 'user') : payload.reason)
        if (cause === 'quota') void this.serial(runId, () => this.onQuota(runId))
        else if (cause === 'time_limit') void this.finalize(runId, 'TIME_LIMIT', payload.detail)
        else if (cause === 'intervention' || cause === 'auth') void this.finalize(runId, 'BLOCKED', payload.detail)
        break
      }
      case 'run.resumed':
        void this.serial(runId, async () => {
          const record = this.deps.repos.overnight.getByRun(runId)
          if (record?.state === 'QUOTA_PAUSED') this.setState(record, 'RUNNING', 'the run was resumed')
        })
        break
      case 'approval.requested':
        // Outside the emitting transaction: resolving re-enters the orchestrator.
        setImmediate(() => this.answerApproval(runId, (event as RunEvent<'approval.requested'>).payload.approvalId))
        break
      default: {
        const reason = CHECKPOINT_EVENTS[event.type]
        if (reason) this.checkpoint(runId, reason)
      }
    }
  }

  /** Unattended approvals: tool requests are denied; plan, task-start and graph changes follow the policy. */
  private answerApproval(runId: string, approvalId: string): void {
    const { repos, bus, orchestrator } = this.deps
    try {
      const record = repos.overnight.getByRun(runId)
      if (!record || (record.state !== 'RUNNING' && record.state !== 'QUOTA_PAUSED')) return
      const approval = repos.approvals.get(approvalId)
      if (!approval || approval.status !== 'pending') return
      const planChange = approval.kind === 'plan' || approval.kind === 'task' || approval.kind === 'graph'
      // A task the planner marked high-risk is never started without a person.
      const tooRisky = approval.kind === 'task' && approval.risk === 'high'
      const approve = planChange && !tooRisky && (approval.kind === 'plan' || record.policy.autoApprovePlanChanges)
      orchestrator.resolveApproval(approvalId, approve, `Overnight Mode (unattended): ${approve ? 'approved by run policy' : 'denied, nobody is present to approve it'}`)
      bus.emit({ runId, type: 'overnight.approval', payload: { approvalId, kind: approval.kind, decision: approve ? 'approved' : 'denied' } })
    } catch (e) {
      this.log(`approval ${approvalId}: ${errorMessage(e)}`)
    }
  }

  // ───────────────────────────── periodic pass ─────────────────────────────

  /** One supervisor pass over every live overnight run. Safe to call at any time. */
  async tick(): Promise<void> {
    if (this.disposed) return
    await Promise.allSettled(
      [...this.live].map((runId) => {
        if (this.ticking.has(runId)) return Promise.resolve()
        this.ticking.add(runId)
        return this.serial(runId, () => this.tickRun(runId)).finally(() => this.ticking.delete(runId))
      }),
    )
  }

  private async tickRun(runId: string): Promise<void> {
    const { repos } = this.deps
    const record = repos.overnight.getByRun(runId)
    if (!record) {
      this.live.delete(runId)
      return
    }
    const now = this.now()
    const run = repos.runs.get(runId)
    this.heartbeat(runId, now)
    switch (record.state) {
      case 'RUNNING':
      case 'QUOTA_PAUSED': {
        if (!run) return this.doFinalize(runId, 'FAILED', 'The run no longer exists.')
        // A terminal state whose event was missed (for example across a restart).
        if (run.state === 'completed') return this.doFinalize(runId, 'SUCCESS')
        if (run.state === 'failed') return this.doFinalize(runId, 'FAILED', run.error ?? undefined)
        if (run.state === 'cancelled') return this.doFinalize(runId, 'USER_CANCELLED')
        if (now >= Date.parse(record.deadlineAt)) {
          return this.doFinalize(runId, 'TIME_LIMIT', `The mission deadline of ${record.policy.maxDurationMinutes} minutes was reached.`)
        }
        if (record.state === 'QUOTA_PAUSED') {
          if (record.quota?.resumeAt && now >= Date.parse(record.quota.resumeAt)) await this.resumeFromQuota(record)
          return
        }
        if (run.state === 'paused' && run.pauseReason === 'quota') return this.onQuota(runId)
        const budget = this.budgetExceeded(record)
        if (budget) {
          this.diagnose(record, 'budget', budget)
          return this.doFinalize(runId, 'BLOCKED', budget)
        }
        const stalled = await this.watchdog(record, run, now)
        if (stalled) return this.doFinalize(runId, 'BLOCKED', stalled)
        const last = this.lastCheckpoint.get(runId) ?? Date.parse(record.startedAt)
        if (now - last >= record.policy.checkpointIntervalMinutes * 60_000) this.checkpoint(runId, 'interval')
        return
      }
      case 'FINALIZING':
        // Only reachable when a previous process died mid-finalization: finish it.
        return this.doFinalize(runId, record.terminalReason ?? 'FAILED', record.terminalDetail ?? undefined)
      case 'POWER_ACTION_SCHEDULED': {
        const action = record.powerAction
        if (!action || action.cancelledAt || action.executedAt) return
        const due = Date.parse(action.executeAt)
        if (action.mechanism === 'app_timer' && now > due + MISSED_ACTION_GRACE_MS) {
          // The machine slept or the clock jumped: acting now would surprise whoever is back at the keyboard.
          this.fail(record, 'POWER_ACTION_FAILED', `${action.action} was due at ${action.executeAt} but NEXUS could not act then (the PC slept or the clock changed); it is not executed late.`)
          return
        }
        if (action.mechanism === 'app_timer' && now >= due) return this.executeFinal(record)
        if (action.mechanism === 'os_timer' && now >= due + OS_TIMER_OVERRUN_MS) {
          this.fail(record, 'POWER_ACTION_FAILED', 'The Windows shutdown timer elapsed but Windows is still running.')
        }
        return
      }
      default:
        return
    }
  }

  /** Proof that NEXUS was alive, so a later launch can tell a short restart from a long absence. */
  private heartbeat(runId: string, now: number): void {
    const last = this.lastHeartbeat.get(runId) ?? 0
    if (now - last < HEARTBEAT_INTERVAL_MS) return
    this.lastHeartbeat.set(runId, now)
    this.deps.repos.settings.setValue(heartbeatKey(runId), iso(now))
  }

  private budgetExceeded(record: OvernightRun): string | null {
    const { repos } = this.deps
    const agents = repos.agents.listByRun(record.runId)
    const sessions = agents.reduce((n, a) => n + repos.sessions.listByAgent(a.id).length, 0)
    if (sessions > record.policy.budgets.maxAgentSessions) {
      return `Run budget exhausted: ${sessions} agent sessions (limit ${record.policy.budgets.maxAgentSessions}).`
    }
    const repairs = repos.tasks.listByRun(record.runId).filter((t) => t.kind === 'repair').length
    if (repairs > record.policy.budgets.maxTotalRepairs) {
      return `Run budget exhausted: ${repairs} repair tasks (limit ${record.policy.budgets.maxTotalRepairs}).`
    }
    return null
  }

  /**
   * Stall handling: snapshot, reconcile the scheduler, and only if the run is still silent after the
   * grace period report it as blocked. Returns the blocker text when the run must be finalized.
   */
  private async watchdog(record: OvernightRun, run: Run, now: number): Promise<string | null> {
    const { repos, orchestrator } = this.deps
    const runId = record.runId
    if (!RUN_WORKING_STATES.includes(run.state)) {
      this.stalls.delete(runId)
      return null
    }
    const lastAt = repos.events.lastActivityAt(runId)
    const idleMs = now - (lastAt ? Date.parse(lastAt) : Date.parse(record.startedAt))
    const stall = this.stalls.get(runId)
    // Check commands (build, test, lint, typecheck) run silently for up to their timeout each.
    const started = repos.events.latestOfType(runId, 'checks.started')
    const completed = repos.events.latestOfType(runId, 'checks.completed')
    const checkBudgetMs = started && started.seq > (completed?.seq ?? 0) ? started.payload.commands.length * repos.settings.get().execution.checkTimeoutMinutes * 60_000 : 0
    if (idleMs < record.policy.watchdog.stallMinutes * 60_000 + checkBudgetMs) {
      if (stall) {
        this.stalls.delete(runId)
        this.diagnose(record, 'recovered', 'Activity resumed after scheduler reconciliation.')
      }
      return null
    }
    const idleMinutes = Math.floor(idleMs / 60_000)
    if (!stall) {
      this.diagnose(record, 'stalled', `No orchestration activity for ${idleMinutes} minutes.`)
      this.stalls.set(runId, { reconciledAt: now })
      orchestrator.requestTick(runId)
      this.diagnose(repos.overnight.require(record.id), 'reconciled', 'Requested a scheduler reconciliation pass.')
      return null
    }
    if (now - stall.reconciledAt < record.policy.watchdog.graceMinutes * 60_000) return null
    this.stalls.delete(runId)
    const detail = `Watchdog: no orchestration activity for ${idleMinutes} minutes; reconciliation did not recover the run.`
    this.diagnose(repos.overnight.require(record.id), 'blocked', detail)
    return detail
  }

  private diagnose(record: OvernightRun, stage: WatchdogDiagnostic['stage'], detail: string): void {
    const { repos, bus } = this.deps
    const run = repos.runs.get(record.runId)
    const tasks: Record<string, number> = {}
    for (const task of repos.tasks.listByRun(record.runId)) tasks[task.state] = (tasks[task.state] ?? 0) + 1
    const entry: WatchdogDiagnostic = {
      at: iso(this.now()),
      stage,
      detail,
      lastEventAt: repos.events.lastActivityAt(record.runId),
      runState: run?.state ?? 'missing',
      tasks,
      activeAgents: repos.agents.listActive(record.runId).length,
      pendingApprovals: repos.approvals.listPending(record.runId).length,
    }
    const current = repos.overnight.require(record.id)
    this.update(record.id, { watchdog: [...current.watchdog, entry].slice(-MAX_WATCHDOG_ENTRIES) })
    bus.emit({ runId: record.runId, type: 'overnight.watchdog', payload: { stage, detail } })
  }

  private checkpoint(runId: string, reason: string): void {
    const { repos, bus } = this.deps
    try {
      const run = repos.runs.get(runId)
      if (!run) return
      const row = repos.checkpoints.insert({ id: newId(), runId, reason, snapshot: buildCheckpoint(repos, run), createdAt: iso(this.now()) })
      this.lastCheckpoint.set(runId, this.now())
      if (repos.checkpoints.count(runId) > MAX_CHECKPOINTS) repos.checkpoints.prune(runId, MAX_CHECKPOINTS)
      bus.emit({ runId, type: 'checkpoint.saved', payload: { checkpointId: row.id, reason } })
    } catch (e) {
      this.log(`checkpoint ${runId}: ${errorMessage(e)}`)
    }
  }

  // ───────────────────────────── usage limit ─────────────────────────────

  private async onQuota(runId: string): Promise<void> {
    const { repos, bus } = this.deps
    const record = repos.overnight.getByRun(runId)
    if (!record || record.state !== 'RUNNING') return
    const now = this.now()
    // The runtime can report the limit twice (a rate-limit event with the reset time, then an error
    // without one): take the newest rejection since the run last resumed that says when it resets.
    const since = repos.events.latestOfType(runId, 'run.resumed')?.seq ?? 0
    const limited = repos.events
      .recentOfType(runId, 'agent.rate_limited', 20)
      .find((e) => e.seq > since && e.payload.status === 'rejected' && normalizeEpochMs(e.payload.resetsAt) !== null)
    const resetsAt = limited ? normalizeEpochMs(limited.payload.resetsAt) : null
    const waits = record.quota?.waits ?? 0
    const decision = decideQuota({ policy: record.policy.quotaPolicy, now, deadline: Date.parse(record.deadlineAt), resetsAt, waits })
    if (decision.action === 'end') {
      this.update(record.id, { quota: { pausedAt: iso(now), resetsAt: resetsAt ? iso(resetsAt) : null, resumeAt: null, waits } })
      bus.emit({ runId, type: 'overnight.quota', payload: { action: 'exhausted', resetsAt: resetsAt ? iso(resetsAt) : null, resumeAt: null } })
      return this.doFinalize(runId, 'QUOTA_EXHAUSTED', decision.why)
    }
    const next = this.update(record.id, { quota: { pausedAt: iso(now), resetsAt: resetsAt ? iso(resetsAt) : null, resumeAt: iso(decision.resumeAt), waits: waits + 1 } })
    this.setState(next, 'QUOTA_PAUSED', `Claude usage limit; resuming at ${iso(decision.resumeAt)}`)
    bus.emit({ runId, type: 'overnight.quota', payload: { action: 'waiting', resetsAt: resetsAt ? iso(resetsAt) : null, resumeAt: iso(decision.resumeAt) } })
  }

  private async resumeFromQuota(record: OvernightRun): Promise<void> {
    const { repos, bus, orchestrator } = this.deps
    const run = repos.runs.get(record.runId)
    if (run?.state === 'paused' && run.pauseReason === 'quota') {
      try {
        await orchestrator.resumeRun(record.runId)
      } catch (e) {
        return this.doFinalize(record.runId, 'BLOCKED', `The run could not be resumed after the usage limit: ${errorMessage(e)}`)
      }
    }
    const current = repos.overnight.require(record.id)
    if (current.state === 'QUOTA_PAUSED') this.setState(current, 'RUNNING', 'usage limit reset')
    bus.emit({ runId: record.runId, type: 'overnight.quota', payload: { action: 'resumed', resetsAt: record.quota?.resetsAt ?? null, resumeAt: record.quota?.resumeAt ?? null } })
  }

  // ───────────────────────────── finalization ─────────────────────────────

  /** End the overnight run for `reason`. Idempotent: a second call (any reason) does nothing. */
  finalize(runId: string, reason: TerminalReason, detail?: string): Promise<void> {
    return this.serial(runId, () => this.doFinalize(runId, reason, detail))
  }

  private async doFinalize(runId: string, reason: TerminalReason, detail?: string, options: { suppressPower?: string } = {}): Promise<void> {
    const { repos, bus } = this.deps
    let record = repos.overnight.getByRun(runId)
    if (!record) return
    if (record.state !== 'RUNNING' && record.state !== 'QUOTA_PAUSED' && record.state !== 'ARMING' && record.state !== 'FINALIZING') return
    // The first terminal reason wins, also across a restart in the middle of finalization.
    const terminalReason = record.terminalReason ?? reason
    const terminalDetail = record.terminalDetail ?? detail ?? null
    record = this.update(record.id, { terminalReason, terminalDetail })
    record = this.setState(record, 'FINALIZING', terminalReason)
    this.stalls.delete(runId)

    try {
      // 1. No new work, then stop what is running. Pausing keeps a failed or unfinished run resumable.
      await this.stopRun(runId, terminalReason)
      // 2. Preserve unfinished work and capture what Git looks like now.
      const run = repos.runs.require(runId)
      const git = await within(this.captureGit(run, record.policy.commitCompletedWork), this.deps.gitTimeoutMs ?? 180_000, null)
      // 3. Everything so far reaches the database file.
      this.flushSafe()
      // 4. The report, saved before any power step.
      const decision = options.suppressPower
        ? ({ action: null, why: options.suppressPower } as const)
        : this.decide(repos.overnight.require(record.id), terminalReason)
      const powerPlan =
        decision.action !== null
          ? `${decision.action} after ${record.policy.finalDelaySeconds} seconds (${record.policy.forceCloseApplications ? 'forced close' : 'normal close'}), to be scheduled once this report is saved.`
          : `No power action: ${decision.why}`
      const finishedAt = iso(this.now())
      let text: string
      try {
        text = buildOvernightReport({ repos, record: repos.overnight.require(record.id), run, reason: terminalReason, detail: terminalDetail, finishedAt, git, powerPlan })
      } catch (e) {
        // A report must exist even if a section cannot be built.
        text = `# NEXUS Overnight Run\n\n- Run ID: ${runId}\n- Finished: ${finishedAt}\n- Outcome: ${terminalReason}\n\nThe full report could not be built: ${errorMessage(e)}\n\n## Power action\n\n${powerPlan}\n`
      }
      record = this.update(record.id, { finalReport: text, reportSavedAt: iso(this.now()), finishedAt })
      const path = this.writeReportFiles(record, run, text)
      if (path) record = this.update(record.id, { reportPath: path })
      bus.emit({ runId, type: 'overnight.report', payload: { path, chars: text.length } })
      this.flushSafe()
      // 5. Power.
      await this.applyPower(record, decision)
    } catch (e) {
      // The failsafe (if armed) stays armed: finalization did not finish, so nothing replaces it.
      this.fail(repos.overnight.require(record.id), 'FINALIZATION_FAILED', errorMessage(e))
    }
  }

  private async stopRun(runId: string, reason: TerminalReason): Promise<void> {
    const { repos, orchestrator } = this.deps
    const run = repos.runs.get(runId)
    if (!run || TERMINAL_RUN_STATES.includes(run.state) || run.state === 'paused') return
    const stop = orchestrator.pauseRun(runId, 'user', `Overnight Mode ended the run (${reason}).`, 'user').catch((e: unknown) => this.log(`stop ${runId}: ${errorMessage(e)}`))
    const timeout = this.deps.stopTimeoutMs ?? 120_000
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([stop, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout)))])
    if (timer) clearTimeout(timer)
  }

  private flushSafe(): void {
    try {
      this.deps.flush()
    } catch (e) {
      this.log(`flush: ${errorMessage(e)}`)
    }
  }

  private async captureGit(run: Run, commitWork: boolean): Promise<GitStateCapture | null> {
    const { repos, git } = this.deps
    const project = repos.projects.get(run.projectId)
    if (!project) return null
    const capture: GitStateCapture = {
      projectRoot: project.rootPath,
      branch: null,
      status: null,
      integrationBranch: run.integrationBranch,
      integrationHead: null,
      commits: [],
      filesChanged: [],
      checkpointCommits: [],
      error: null,
    }
    const problems: string[] = []
    const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
      } catch (e) {
        problems.push(`${what}: ${errorMessage(e)}`)
      }
    }
    if (commitWork) {
      const settings = repos.settings.get().git
      const author = { name: settings.commitAuthorName, email: settings.commitAuthorEmail }
      for (const worktree of repos.worktrees.listActive(run.id)) {
        if (worktree.taskId === null || !existsSync(worktree.path)) continue
        const task = repos.tasks.get(worktree.taskId)
        if (!task || task.state === 'completed' || task.state === 'cancelled') continue
        await attempt(`checkpoint commit ${task.key}`, async () => {
          // A half-finished merge would be committed with its conflict markers.
          if (await git.isMergeInProgress(worktree.path)) throw new Error('a merge is in progress; nothing was committed')
          const commit = await git.commitAll(worktree.path, `nexus: overnight checkpoint of unfinished work (${task.key})`, author)
          if (commit) capture.checkpointCommits.push({ task: task.key, branch: worktree.branch, commit })
        })
      }
    }
    await attempt('branch', async () => {
      capture.branch = await git.currentBranch(project.rootPath)
    })
    await attempt('status', async () => {
      capture.status = await git.status(project.rootPath)
    })
    if (run.baseCommit && run.integrationBranch) {
      const base = run.baseCommit
      const branch = run.integrationBranch
      await attempt('integration head', async () => {
        capture.integrationHead = await git.resolveCommit(project.rootPath, branch)
      })
      await attempt('commits', async () => {
        capture.commits = await git.log(project.rootPath, `${base}..${branch}`, 200)
      })
      await attempt('changed files', async () => {
        capture.filesChanged = await git.changedFiles(project.rootPath, base, branch)
      })
    }
    capture.error = problems.length > 0 ? problems.join('; ') : null
    return capture
  }

  /** Writes the report under the NEXUS data directory and, when the policy says so, into the project. */
  private writeReportFiles(record: OvernightRun, run: Run, text: string): string | null {
    const name = `overnight-${record.startedAt.slice(0, 19).replace(/:/g, '')}.md`
    let saved: string | null = null
    try {
      mkdirSync(this.deps.reportsDir, { recursive: true })
      const path = join(this.deps.reportsDir, name)
      writeFileSync(path, text)
      saved = path
    } catch (e) {
      this.log(`report (data dir): ${errorMessage(e)}`)
    }
    if (!record.policy.saveFinalReport) return saved
    const project = this.deps.repos.projects.get(run.projectId)
    if (!project || !existsSync(project.rootPath)) return saved
    try {
      const dir = join(project.rootPath, '.nexus', 'reports')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, name)
      writeFileSync(path, text)
      this.excludeFromGit(project.rootPath)
      return path
    } catch (e) {
      this.log(`report (project): ${errorMessage(e)}`)
      return saved
    }
  }

  /** Keep `.nexus/` out of the user's `git status` through the repository-local exclude file. */
  private excludeFromGit(root: string): void {
    try {
      // The project may be a subdirectory of the repository, or a linked worktree whose `.git` is a file.
      let dir = resolve(root)
      while (!existsSync(join(dir, '.git'))) {
        const parent = dirname(dir)
        if (parent === dir) return
        dir = parent
      }
      let gitDir = join(dir, '.git')
      if (!statSync(gitDir).isDirectory()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim()
        if (!pointer) return
        gitDir = resolve(dir, pointer)
        const common = join(gitDir, 'commondir')
        if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, 'utf8').trim())
      }
      if (!existsSync(gitDir)) return
      const info = join(gitDir, 'info')
      const exclude = join(info, 'exclude')
      const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (/^\.nexus\/$/m.test(current)) return
      mkdirSync(info, { recursive: true })
      appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}.nexus/\n`)
    } catch {
      // Cosmetic only.
    }
  }

  // ───────────────────────────── power ─────────────────────────────

  private failsafeArmed(record: OvernightRun): boolean {
    return record.failsafe !== null && record.failsafe.result.ok && record.failsafe.cancelledAt === null && record.failsafe.lostAt === null
  }

  private writeAudit(runId: string | null, operation: PowerAuditEntry['operation'], action: EndAction, detail: string, result: PowerCommandResult | null): void {
    const { repos, bus } = this.deps
    repos.powerAudit.insert({ id: newId(), runId, operation, action, detail, result, createdAt: iso(this.now()) })
    if (runId && repos.runs.get(runId)) {
      bus.emit({ runId, type: 'overnight.power', payload: { action, operation, ok: result ? result.ok : operation !== 'denied', executeAt: null, detail } })
    }
  }

  /** Abort the failsafe timer. True when no failsafe is pending afterwards. */
  private async cancelFailsafe(record: OvernightRun, why: string): Promise<boolean> {
    const { bus, power } = this.deps
    if (!record.failsafe || !this.failsafeArmed(record)) return true
    const result = await power.cancelShutdown()
    this.writeAudit(record.runId, 'cancel_failsafe', 'SHUTDOWN', why, result)
    // 1116: Windows had no shutdown in progress, so nothing is pending either way.
    const gone = result.ok || result.exitCode === 1116
    if (gone) {
      this.update(record.id, { failsafe: { ...record.failsafe, cancelledAt: result.at, cancelResult: result } })
      bus.emit({ runId: record.runId, type: 'overnight.failsafe', payload: { action: 'cancelled', deadline: record.failsafe.deadline, ok: true } })
    }
    return gone
  }

  /** Arm (again) the failsafe so it fires at `deadlineMs`. */
  private async rearmFailsafe(record: OvernightRun, deadlineMs: number, why: string): Promise<boolean> {
    const { bus, power } = this.deps
    const delaySeconds = Math.max(60, Math.round((deadlineMs - this.now()) / 1000))
    const result = await power.scheduleShutdown({ delaySeconds, force: record.policy.forceCloseApplications, purpose: 'failsafe' })
    this.writeAudit(record.runId, 'rearm_failsafe', 'SHUTDOWN', why, result)
    if (result.ok) {
      const deadline = iso(Date.parse(result.at) + delaySeconds * 1000)
      this.update(record.id, { failsafe: { scheduledAt: result.at, deadline, result, cancelledAt: null, cancelResult: null, lostAt: null } })
      bus.emit({ runId: record.runId, type: 'overnight.failsafe', payload: { action: 'rearmed', deadline, ok: true } })
    }
    return result.ok
  }

  private async applyPower(record: OvernightRun, decision: ReturnType<typeof decidePowerAction>): Promise<void> {
    const { repos, power } = this.deps
    const runId = record.runId
    if (decision.action === null) {
      this.writeAudit(runId, 'denied', record.policy.endAction, decision.why, null)
      // The run is over and nothing will be scheduled: an armed failsafe has no purpose left.
      const cancelled = await this.cancelFailsafe(repos.overnight.require(record.id), 'The run ended without a power action')
      const current = repos.overnight.require(record.id)
      if (!cancelled) return this.fail(current, 'POWER_ACTION_FAILED', `The failsafe shutdown at ${current.failsafe?.deadline ?? 'n/a'} could not be cancelled. Run "shutdown /a" to cancel it.`)
      this.appendAddendum(current)
      this.finish(current)
      return
    }

    if (record.policy.stopWorkersBeforePowerAction) await this.stopOtherRuns(runId)
    this.flushSafe()

    const now = this.now()
    const delay = record.policy.finalDelaySeconds
    const executeAt = iso(now + delay * 1000)
    if (decision.action === 'SHUTDOWN' && record.policy.forceCloseApplications) {
      // Replace the long failsafe with the final Windows timer.
      const before = repos.overnight.require(record.id)
      const failsafeDeadline = this.failsafeArmed(before) ? Date.parse((before.failsafe as NonNullable<OvernightRun['failsafe']>).deadline) : null
      if (!(await this.cancelFailsafe(before, 'Replaced by the final shutdown'))) {
        return this.fail(repos.overnight.require(record.id), 'POWER_ACTION_FAILED', `The failsafe could not be replaced; it stays armed for ${before.failsafe?.deadline ?? 'n/a'}.`)
      }
      // Written before Windows is asked: if NEXUS dies in between, the next start knows a final timer may exist.
      const intent = this.update(record.id, {
        powerAction: { action: 'SHUTDOWN', reason: decision.reason, scheduledAt: iso(now), executeAt, forced: true, mechanism: 'os_timer', result: null, executedAt: null, cancelledAt: null },
      })
      this.setState(intent, 'POWER_ACTION_SCHEDULED', `SHUTDOWN at ${executeAt}`)
      let result = await power.scheduleShutdown({ delaySeconds: delay, force: true, purpose: 'final' })
      this.writeAudit(runId, 'schedule_final', 'SHUTDOWN', `Final shutdown in ${delay} s (${decision.reason})`, result)
      if (!result.ok) {
        result = await power.scheduleShutdown({ delaySeconds: delay, force: true, purpose: 'final' })
        this.writeAudit(runId, 'schedule_final', 'SHUTDOWN', 'Retry of the final shutdown', result)
      }
      const action = repos.overnight.require(record.id).powerAction as NonNullable<OvernightRun['powerAction']>
      if (!result.ok && result.exitCode === 1190 && failsafeDeadline === null && before.failsafe?.cancelledAt) {
        // Our failsafe was already replaced in an earlier attempt that NEXUS did not live to record: the
        // timer Windows reports is that final shutdown. Keep it and say so.
        const adopted = this.update(record.id, { powerAction: { ...action, result: { ...result, ok: true, output: `${result.output} (adopted: a final shutdown was already scheduled)` } } })
        this.appendAddendum(adopted)
        return
      }
      if (!result.ok) {
        this.update(record.id, { powerAction: { ...action, result, cancelledAt: iso(this.now()) } })
        if (failsafeDeadline !== null) await this.rearmFailsafe(repos.overnight.require(record.id), failsafeDeadline, 'Final shutdown was refused; failsafe restored')
        return this.fail(repos.overnight.require(record.id), 'POWER_ACTION_FAILED', `Windows refused the final shutdown (exit ${result.exitCode ?? 'n/a'}): ${result.output}`)
      }
      const scheduled = this.update(record.id, { powerAction: { ...action, scheduledAt: result.at, executeAt: iso(Date.parse(result.at) + delay * 1000), result } })
      this.appendAddendum(scheduled)
      return
    }

    // A normal (non-forced) shutdown, sleep and hibernate have no delayed form in Windows: NEXUS counts
    // down and then runs the action. The failsafe stays armed until that moment.
    const scheduled = this.update(record.id, {
      powerAction: { action: decision.action, reason: decision.reason, scheduledAt: iso(now), executeAt, forced: false, mechanism: 'app_timer', result: null, executedAt: null, cancelledAt: null },
    })
    this.writeAudit(runId, 'schedule_final', decision.action, `${decision.action} in ${delay} s by NEXUS countdown (${decision.reason})`, null)
    this.appendAddendum(scheduled)
    this.setState(scheduled, 'POWER_ACTION_SCHEDULED', `${decision.action} at ${executeAt}`)
  }

  /** The countdown of an app-timer action ended: check the authorization again, then act. */
  private async executeFinal(record: OvernightRun): Promise<void> {
    const { repos, power } = this.deps
    const action = record.powerAction
    if (!action || action.cancelledAt || action.executedAt) return
    const decision = this.decide(record, action.reason)
    if (decision.action === null || decision.action !== action.action) {
      this.writeAudit(record.runId, 'denied', action.action, decision.action === null ? decision.why : 'The end action changed during the countdown.', null)
      this.update(record.id, { powerAction: { ...action, cancelledAt: iso(this.now()) } })
      await this.cancelFailsafe(repos.overnight.require(record.id), 'The power action was withdrawn')
      this.finish(repos.overnight.require(record.id))
      return
    }
    this.flushSafe()
    const failsafeDeadline = this.failsafeArmed(record) ? Date.parse((record.failsafe as NonNullable<OvernightRun['failsafe']>).deadline) : null
    if (!(await this.cancelFailsafe(record, `Replaced by ${action.action}`))) {
      return this.fail(repos.overnight.require(record.id), 'POWER_ACTION_FAILED', `The failsafe could not be replaced; it stays armed for ${record.failsafe?.deadline ?? 'n/a'}.`)
    }
    const result =
      action.action === 'SHUTDOWN'
        ? await power.scheduleShutdown({ delaySeconds: 0, force: false, purpose: 'final' })
        : action.action === 'SLEEP'
          ? await power.sleep()
          : await power.hibernate()
    this.writeAudit(record.runId, 'execute_final', action.action, `${action.action} executed (${action.reason})`, result)
    const current = repos.overnight.require(record.id)
    if (!result.ok) {
      if (failsafeDeadline !== null) await this.rearmFailsafe(current, failsafeDeadline, `${action.action} was refused; failsafe restored`)
      this.update(record.id, { powerAction: { ...action, result } })
      return this.fail(repos.overnight.require(record.id), 'POWER_ACTION_FAILED', `Windows refused ${action.action} (exit ${result.exitCode ?? 'n/a'}): ${result.output}`)
    }
    const done = this.update(record.id, { powerAction: { ...action, result, executedAt: result.at, forced: action.action === 'SHUTDOWN' ? isEffectivelyForced({ delaySeconds: 0, force: false }) : false } })
    this.appendAddendum(done)
    this.finish(done)
  }

  /** Other runs must not keep agents working into a power action. */
  private async stopOtherRuns(exceptRunId: string): Promise<void> {
    const { repos, orchestrator } = this.deps
    for (const run of repos.runs.listActive()) {
      if (run.id === exceptRunId || run.state === 'paused' || TERMINAL_RUN_STATES.includes(run.state)) continue
      const pause = orchestrator.pauseRun(run.id, 'user', 'Paused before the overnight power action.', 'user').then(() => undefined, (e: unknown) => this.log(`pause ${run.id}: ${errorMessage(e)}`))
      await within(pause, this.deps.stopTimeoutMs ?? 120_000, undefined)
    }
  }

  private appendAddendum(record: OvernightRun): void {
    if (record.finalReport === null) return
    const marker = '\n### Power action result\n'
    const base = record.finalReport.includes(marker) ? record.finalReport.slice(0, record.finalReport.indexOf(marker)) : record.finalReport
    const text = `${base.trimEnd()}\n${powerAddendum(record)}`
    const updated = this.update(record.id, { finalReport: text })
    const run = this.deps.repos.runs.get(record.runId)
    if (run) this.writeReportFiles(updated, run, text)
    this.flushSafe()
  }

  private finish(record: OvernightRun): void {
    this.setState(this.deps.repos.overnight.require(record.id), 'DONE')
    this.release(record.runId)
  }

  private release(runId: string): void {
    this.live.delete(runId)
    this.stalls.delete(runId)
    this.lastHeartbeat.delete(runId)
    this.lastCheckpoint.delete(runId)
    this.deps.repos.settings.deleteValue(heartbeatKey(runId))
  }

  private fail(record: OvernightRun, state: 'FINALIZATION_FAILED' | 'POWER_ACTION_FAILED', error: string): void {
    this.log(`${record.runId}: ${state}: ${error}`)
    const updated = this.update(record.id, { error })
    this.appendAddendum(updated)
    this.setState(this.deps.repos.overnight.require(record.id), state, error)
    this.release(record.runId)
  }

  // ───────────────────────────── user actions ─────────────────────────────

  /**
   * CANCEL SHUTDOWN. During the run: the end action becomes NONE and the failsafe is cancelled, the
   * mission continues. During the final countdown: the pending action is aborted.
   */
  cancelPower(runId: string): Promise<OvernightStatus> {
    return this.serial(runId, async () => {
      const { repos, power } = this.deps
      let record = this.requireRecord(runId)
      if (record.state === 'POWER_ACTION_SCHEDULED' && record.powerAction && !record.powerAction.executedAt) {
        record = this.setState(record, 'CANCELLING', 'the user cancelled the power action')
        const action = record.powerAction as NonNullable<OvernightRun['powerAction']>
        if (action.mechanism === 'os_timer') {
          const result = await power.cancelShutdown()
          this.writeAudit(runId, 'cancel_final', action.action, 'Cancelled by the user', result)
          if (!result.ok && result.exitCode !== 1116) {
            this.setState(repos.overnight.require(record.id), 'POWER_ACTION_SCHEDULED', 'cancel failed')
            throw new NexusError('internal', `Windows did not cancel the shutdown (exit ${result.exitCode ?? 'n/a'}): ${result.output}`)
          }
        } else {
          this.writeAudit(runId, 'cancel_final', action.action, 'Countdown cancelled by the user', null)
        }
        record = this.update(record.id, { powerAction: { ...action, cancelledAt: iso(this.now()) } })
        if (!(await this.cancelFailsafe(record, 'Cancelled by the user'))) {
          // The final action is off but the failsafe is still armed: say so, and stay cancellable.
          const message = `The final ${action.action} was cancelled, but the failsafe shutdown at ${record.failsafe?.deadline ?? 'n/a'} could not be. Try again, or run "shutdown /a".`
          this.fail(repos.overnight.require(record.id), 'POWER_ACTION_FAILED', message)
          throw new NexusError('internal', message)
        }
        record = this.amend(repos.overnight.require(record.id), { endAction: 'NONE' }, 'Power action cancelled during the final countdown')
        this.appendAddendum(record)
        this.finish(record)
        return toStatus(repos.overnight.require(record.id))
      }
      if (record.state === 'FINALIZATION_FAILED' || record.state === 'POWER_ACTION_FAILED') {
        // Finalization stopped half-way: whatever the record says, ask Windows to drop any pending shutdown.
        if (!(await this.abortOsTimer(runId, 'Cancelled by the user'))) {
          throw new NexusError('internal', 'Windows did not cancel the pending shutdown. Run "shutdown /a".')
        }
        const at = iso(this.now())
        const failsafe = record.failsafe && !record.failsafe.cancelledAt ? { ...record.failsafe, cancelledAt: at } : record.failsafe
        const powerAction = record.powerAction && !record.powerAction.cancelledAt && !record.powerAction.executedAt ? { ...record.powerAction, cancelledAt: at } : record.powerAction
        return toStatus(this.update(record.id, { failsafe, powerAction }))
      }
      if (record.state !== 'RUNNING' && record.state !== 'QUOTA_PAUSED') {
        throw new NexusError('invalid_state', `No power action can be cancelled while the overnight run is ${record.state}`)
      }
      if (!(await this.cancelFailsafe(record, 'Cancelled by the user'))) {
        throw new NexusError('internal', 'The failsafe shutdown could not be cancelled. Run "shutdown /a".')
      }
      record = this.amend(repos.overnight.require(record.id), { endAction: 'NONE' }, 'Shutdown cancelled; the mission continues without a power action or failsafe')
      return toStatus(record)
    })
  }

  /** CHANGE END ACTION. Only the person at the keyboard reaches this, through the typed IPC channel. */
  changeEndPolicy(runId: string, change: OvernightAmendment): Promise<OvernightStatus> {
    return this.serial(runId, async () => {
      const { repos } = this.deps
      let record = this.requireRecord(runId)
      if (record.state !== 'RUNNING' && record.state !== 'QUOTA_PAUSED') {
        throw new NexusError('invalid_state', `The end action cannot be changed while the overnight run is ${record.state}`)
      }
      const parts: string[] = []
      if (change.endAction !== undefined) parts.push(`end action ${record.policy.endAction} -> ${EndActionSchema.parse(change.endAction)}`)
      if (change.shutdownOn !== undefined) parts.push(`conditions -> ${JSON.stringify(EndConditionsSchema.parse(change.shutdownOn))}`)
      if (change.finalDelaySeconds !== undefined) parts.push(`final delay -> ${change.finalDelaySeconds} s`)
      if (change.forceCloseApplications !== undefined) parts.push(`force close -> ${change.forceCloseApplications ? 'yes' : 'no'}`)
      if (parts.length === 0) return toStatus(record)
      record = this.amend(record, change, parts.join('; '))
      if (record.policy.endAction === 'NONE') {
        // No power action is wanted any more: the failsafe goes too.
        if (!(await this.cancelFailsafe(record, 'End action set to NONE by the user'))) {
          throw new NexusError('internal', 'The end action is now NONE, but the failsafe shutdown could not be cancelled. Run "shutdown /a".')
        }
      } else if (record.policy.failsafeEnabled && !this.failsafeArmed(record)) {
        // A power action was switched (back) on and no failsafe is armed: arm it for the original offset.
        const wanted = record.failsafe ? Date.parse(record.failsafe.deadline) : Date.parse(record.startedAt) + record.policy.failsafeAfterMinutes * 60_000
        const armed = await this.rearmFailsafe(record, Math.max(wanted, this.now() + 120_000), 'End action enabled by the user')
        if (!armed) throw new NexusError('internal', 'The end action was changed, but Windows refused the failsafe timer: no failsafe is armed.')
      }
      return toStatus(repos.overnight.require(record.id))
    })
  }

  /** EXTEND MISSION: move the deadline and the failsafe by the same number of minutes. */
  extend(runId: string, minutes: number): Promise<OvernightStatus> {
    return this.serial(runId, async () => {
      const { repos } = this.deps
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw new NexusError('invalid_input', 'Invalid extension')
      let record = this.requireRecord(runId)
      if (record.state !== 'RUNNING' && record.state !== 'QUOTA_PAUSED') {
        throw new NexusError('invalid_state', `The mission cannot be extended while the overnight run is ${record.state}`)
      }
      const deadlineAt = iso(Date.parse(record.deadlineAt) + minutes * 60_000)
      if (this.failsafeArmed(record)) {
        const failsafe = record.failsafe as NonNullable<OvernightRun['failsafe']>
        const next = Date.parse(failsafe.deadline) + minutes * 60_000
        if (!(await this.cancelFailsafe(record, 'Mission extended'))) throw new NexusError('internal', 'The failsafe could not be moved; the mission was not extended.')
        if (!(await this.rearmFailsafe(repos.overnight.require(record.id), next, `Mission extended by ${minutes} minutes`))) {
          // Never leave an extended mission without the failsafe it had.
          await this.rearmFailsafe(repos.overnight.require(record.id), Date.parse(failsafe.deadline), 'Restoring the previous failsafe')
          throw new NexusError('internal', 'Windows refused the new failsafe timer; the mission was not extended.')
        }
        record = repos.overnight.require(record.id)
      }
      const run = repos.runs.require(runId)
      repos.runs.update(runId, { config: { ...run.config, maxDurationMinutes: Math.min(24 * 60, run.config.maxDurationMinutes + minutes) } })
      record = this.update(record.id, {
        deadlineAt,
        amendments: [...record.amendments, { at: iso(this.now()), by: 'user', change: `Mission extended by ${minutes} minutes (deadline ${deadlineAt})` }],
      })
      this.deps.bus.emit({ runId, type: 'overnight.amended', payload: { change: `extended by ${minutes} minutes` } })
      return toStatus(record)
    })
  }

  /** Cancel the mission. The end action applies only if the policy covers cancellation. */
  async cancelMission(runId: string): Promise<OvernightStatus> {
    this.requireRecord(runId)
    await this.deps.orchestrator.cancelRun(runId)
    await this.finalize(runId, 'USER_CANCELLED')
    return toStatus(this.requireRecord(runId))
  }

  private amend(record: OvernightRun, change: OvernightAmendment, description: string): OvernightRun {
    const policy = OvernightPolicySchema.parse({ ...record.policy, ...change })
    if (!this.intact(record)) {
      throw new NexusError('invalid_state', 'The stored overnight policy failed its integrity check; it cannot be changed. Cancel the shutdown instead.')
    }
    const authorization = { runId: record.authorization.runId, authorizedAt: record.authorization.authorizedAt, confirmation: record.authorization.confirmation, policy: record.authorization.policy }
    const updated = this.update(record.id, {
      policy,
      authorization: this.sealed(authorization, policy),
      amendments: [...record.amendments, { at: iso(this.now()), by: 'user', change: description }],
    })
    this.deps.bus.emit({ runId: record.runId, type: 'overnight.amended', payload: { change: description } })
    return updated
  }

  private requireRecord(runId: string): OvernightRun {
    const record = this.deps.repos.overnight.getByRun(runId)
    if (!record) throw new NexusError('not_found', 'This run is not an overnight run')
    return record
  }

  // ───────────────────────────── recovery ─────────────────────────────

  /**
   * Called once at startup, after the orchestrator paused the runs that were active. The Windows
   * failsafe scheduled by the previous process is authoritative: it is never cancelled here, and it is
   * re-armed only when Windows itself restarted (which is the only way the timer can be gone).
   */
  async recover(): Promise<OvernightStatus[]> {
    const { repos } = this.deps
    const recovered: OvernightStatus[] = []
    // A run that ended in a failed state may still show an armed failsafe; after a restart of Windows that
    // timer is gone, and the record must say so.
    const boot = this.bootTime()
    for (const record of repos.overnight.listAll(50)) {
      if (this.failsafeArmed(record) && !this.live.has(record.runId) && record.failsafe && boot > Date.parse(record.failsafe.scheduledAt) + 60_000) {
        this.update(record.id, { failsafe: { ...record.failsafe, lostAt: iso(this.now()) } })
      }
    }
    for (const record of repos.overnight.listLive()) {
      this.live.add(record.runId)
      await this.serial(record.runId, () => this.recoverOne(record.runId)).catch((e: unknown) => this.log(`recover ${record.runId}: ${errorMessage(e)}`))
      const after = repos.overnight.getByRun(record.runId)
      if (after) recovered.push(toStatus(after))
    }
    return recovered
  }

  private async recoverOne(runId: string): Promise<void> {
    const { repos, bus, orchestrator, power } = this.deps
    let record = this.requireRecord(runId)
    const now = this.now()
    const lastAlive = repos.settings.getValue<string>(heartbeatKey(runId)) ?? record.updatedAt
    // Windows booted after NEXUS was last alive in this run: it restarted in between. A clock correction can
    // make this true by mistake; that only makes the recovery more cautious, and Windows is asked either way.
    const rebooted = this.bootTime() > Date.parse(lastAlive) + 2000
    const gapMs = now - Date.parse(lastAlive)
    // After a restart of Windows or a long absence of NEXUS the unattended session the user authorized
    // is over: a person started NEXUS again, and nothing may power the machine off on that launch.
    const lapsed = rebooted
      ? 'Windows restarted since this run was authorized; the power authorization does not carry over a restart.'
      : gapMs > CONTINUITY_GAP_MS
        ? `NEXUS was not running for ${Math.round(gapMs / 60_000)} minutes; the power authorization lapsed.`
        : null
    const run = repos.runs.get(runId)
    bus.emit({ runId, type: 'overnight.state_changed', payload: { from: record.state, to: record.state, detail: 'RECOVERING OVERNIGHT RUN' } })

    // Whether a timer still exists is never inferred from clocks: when the session lapsed, or the record
    // cannot say what was scheduled, Windows is asked to drop whatever shutdown is pending.
    const dropTimers = async (why: string): Promise<boolean> => {
      // After a restart of Windows no timer can have survived, so a refused abort changes nothing.
      const aborted = (await this.abortOsTimer(runId, why)) || rebooted
      const current = repos.overnight.require(record.id)
      const at = iso(this.now())
      if (aborted) {
        const failsafe = current.failsafe && !current.failsafe.cancelledAt ? { ...current.failsafe, cancelledAt: at, lostAt: rebooted ? at : current.failsafe.lostAt } : current.failsafe
        const powerAction = current.powerAction && !current.powerAction.cancelledAt && !current.powerAction.executedAt ? { ...current.powerAction, cancelledAt: at } : current.powerAction
        record = this.update(record.id, { failsafe, powerAction })
        if (failsafe !== current.failsafe && failsafe) {
          bus.emit({ runId, type: 'overnight.failsafe', payload: { action: rebooted ? 'lost' : 'cancelled', deadline: failsafe.deadline, ok: true } })
        }
      }
      return aborted
    }
    const stuckTimer = 'Windows did not cancel the pending shutdown. Run "shutdown /a".'

    if (record.state === 'POWER_ACTION_SCHEDULED') {
      const action = record.powerAction
      if (!action) return this.finish(record)
      if (lapsed) {
        const pendingBefore = !action.executedAt && !action.cancelledAt
        if (!(await dropTimers(lapsed))) return this.fail(record, 'POWER_ACTION_FAILED', stuckTimer)
        // After a restart of Windows the shutdown either happened or died with it.
        if (rebooted || !pendingBefore) return this.finish(record)
        return this.fail(record, 'POWER_ACTION_FAILED', `${action.action} was pending when NEXUS stopped; it was cancelled and is not executed late.`)
      }
      if (now > Date.parse(action.executeAt) + MISSED_ACTION_GRACE_MS) {
        if (!(await dropTimers('A final action was overdue'))) return this.fail(record, 'POWER_ACTION_FAILED', stuckTimer)
        return this.fail(record, 'POWER_ACTION_FAILED', `${action.action} was due at ${action.executeAt} but did not happen while NEXUS was not running; it is not executed late.`)
      }
      if (action.mechanism === 'os_timer' && action.result === null) {
        // NEXUS died around the moment it asked Windows for the final timer: ask again. 1190 means the
        // first request was accepted, which is exactly the timer this record describes.
        const delaySeconds = Math.max(10, Math.round((Date.parse(action.executeAt) - now) / 1000))
        const result = await power.scheduleShutdown({ delaySeconds, force: true, purpose: 'final' })
        this.writeAudit(runId, 'schedule_final', 'SHUTDOWN', 'Completing a final shutdown interrupted by a restart of NEXUS', result)
        if (result.ok) this.update(record.id, { powerAction: { ...action, scheduledAt: result.at, executeAt: iso(Date.parse(result.at) + delaySeconds * 1000), result } })
        else if (result.exitCode === 1190) this.update(record.id, { powerAction: { ...action, result: { ...result, ok: true } } })
        else this.fail(record, 'POWER_ACTION_FAILED', `Windows refused the final shutdown (exit ${result.exitCode ?? 'n/a'}): ${result.output}`)
      }
      return
    }
    if (record.state === 'CANCELLING') {
      // The process died while the user was cancelling: finish the cancellation.
      if (!(await dropTimers('Completing a cancellation interrupted by a restart'))) return this.fail(record, 'POWER_ACTION_FAILED', stuckTimer)
      return this.finish(record)
    }
    if (record.state === 'ARMING') {
      // The process died while arming: the record cannot say whether Windows accepted the failsafe.
      if (!(await dropTimers('NEXUS stopped while arming the overnight run'))) return this.fail(record, 'POWER_ACTION_FAILED', stuckTimer)
      this.update(record.id, { error: 'NEXUS stopped while arming the overnight run; it was not started.' })
      return this.finish(record)
    }
    if (lapsed && !(await dropTimers(lapsed))) return this.fail(record, 'POWER_ACTION_FAILED', stuckTimer)
    const suppress = lapsed ? { suppressPower: lapsed } : {}
    if (record.state === 'FINALIZING') return this.doFinalize(runId, record.terminalReason ?? 'FAILED', record.terminalDetail ?? undefined, suppress)
    if (!run) return this.doFinalize(runId, 'FAILED', 'The run no longer exists.', suppress)
    if (lapsed) return this.doFinalize(runId, 'BLOCKED', `${lapsed} The run is paused and can be resumed by hand.`, suppress)
    if (now >= Date.parse(record.deadlineAt)) return this.doFinalize(runId, 'TIME_LIMIT', 'The mission deadline passed during a restart of NEXUS.')
    this.heartbeat(runId, now)
    if (run.state === 'paused' && run.pauseReason === 'recovery') {
      try {
        await orchestrator.recover(runId, 'resume')
      } catch (e) {
        return this.doFinalize(runId, 'BLOCKED', `The run could not be resumed after a restart of NEXUS: ${errorMessage(e)}`)
      }
      this.checkpoint(runId, 'recovery')
    }
    // Requests raised just before the restart have no listener any more: answer them now.
    for (const approval of repos.approvals.listPending(runId)) this.answerApproval(runId, approval.id)
  }

  // ───────────────────────────── plumbing ─────────────────────────────

  private bootTime(): number {
    return this.deps.bootTime ? this.deps.bootTime() : Date.now() - uptime() * 1000
  }

  /** Operations on one overnight run never interleave. */
  private serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.queues.set(runId, tail)
    void tail.then(() => {
      if (this.queues.get(runId) === tail) this.queues.delete(runId)
    })
    return next
  }

  /** Wait until no operation on any overnight run is in flight (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()])
  }

  private update(id: string, patch: Partial<Omit<OvernightRun, 'id'>>): OvernightRun {
    const record = this.deps.repos.overnight.update(id, { ...patch, updatedAt: iso(this.now()) })
    this.deps.push({ kind: 'overnight', status: toStatus(record) })
    return record
  }

  private setState(record: OvernightRun, to: OvernightState, detail?: string): OvernightRun {
    if (record.state === to) return record
    const updated = this.update(record.id, { state: to })
    this.deps.bus.emit({ runId: record.runId, type: 'overnight.state_changed', payload: { from: record.state, to, ...(detail ? { detail } : {}) } })
    return updated
  }
}
