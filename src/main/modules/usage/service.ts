import type { PushMessage, RunEvent } from '@shared/events'
import { newId } from '@shared/ids'
import type { AuthStatus } from '@shared/auth'
import type { Run } from '@shared/domain'
import { errorMessage } from '@shared/result'
import {
  EMPTY_USAGE_TOTALS,
  measured,
  unknownValue,
  USAGE_WINDOW_MAX_AGE_MS,
  type ConcreteStrategy,
  type Strategy,
  type UsageBreakdownRow,
  type UsageEvent,
  type UsageGrouping,
  type UsageOverview,
  type UsageStatus,
  type UsageTotals,
  type UsageWindow,
  type UsageWindowView,
} from '@shared/v3'
import type { RunUsage, StrategyEfficiencyRow, UsageEfficiency, UsageLimitHistory } from '@shared/v3-read'
import type { EventBus } from '../events'
import type { Repositories } from '../persistence'
import type { UsageFilter } from '../persistence/repositories/v3'
import type { AgentRuntime, RuntimeUsageReport } from '../agent-runtime/types'
import { evidenceLabel, mean, median, wilsonInterval } from '../policy/stats'
import { classifyUsageSignal, limitingWindow, type UsageSignal } from './classify'
import { initialUsageState, isDispatchBlocked, rampLimit, RAMP_MS, reduceUsage, type UsageMachineEvent, type UsageMachineState } from './machine'
import type { ProbeResult } from './probe'

export interface UsageServiceDeps {
  repos: Repositories
  bus: EventBus
  runtime: AgentRuntime
  push: (message: PushMessage) => void
  /**
   * v0.6: true for an agent whose session runs on a provider other than Claude. What such a session reports
   * (tokens, limits, starts, failures) says nothing about the Claude account and is not recorded here.
   */
  isOtherProvider?: (agentId: string) => boolean
  now?: () => number
  logger?: (line: string) => void
}

/** Trailing push interval for changes that are not status changes (token totals moving). */
const PUSH_INTERVAL_MS = 1000
/** A second rejected signal of the same run within this window is the same limit hit reported twice. */
const LIMIT_DEDUPE_MS = 10_000

const localDay = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

interface SessionRow {
  rowId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turns: number
  durationMs: number
  costUsd: number
  /** Output tokens per model, to name the session by the model that did most of the work. */
  byModel: Map<string, number>
}

/**
 * Usage intelligence: observes what the runtime says (rate-limit events, error kinds, usage reports) and
 * what NEXUS sessions used, persists it, holds the status machine, and answers the read model.
 * Nothing here estimates remaining capacity: percentages come only from the runtime.
 */
export class UsageIntelligenceService {
  private readonly now: () => number
  private state: UsageMachineState
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private readonly sessions = new Map<string, SessionRow>()
  private readonly runInfo = new Map<string, { projectId: string; strategy: Strategy | null; campaignId: string | null }>()
  private readonly lastRejected = new Map<string, number>()
  private observed: UsageTotals = { ...EMPTY_USAGE_TOTALS }
  private account: AuthStatus | null = null
  private accountLoading: Promise<void> | null = null
  private reportSupported: boolean | null = null
  private reportSubscriptionType: string | null = null
  private pushTimer: NodeJS.Timeout | null = null
  private lastPushAt = 0
  private disposed = false

  constructor(private readonly deps: UsageServiceDeps) {
    this.now = deps.now ?? Date.now
    this.state = initialUsageState(this.now())
    this.unsubscribe = deps.bus.subscribe((event) => this.onEvent(event))
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    this.listeners.clear()
  }

  private log(line: string): void {
    this.deps.logger?.(`usage: ${line}`)
  }

  private iso(ms: number = this.now()): string {
    return new Date(ms).toISOString()
  }

  // ───────────────────────────── status and the dispatch gate ─────────────────────────────

  status(): UsageStatus {
    return this.state.status
  }

  /** A snapshot of the machine, for the recovery controller and tests. */
  machineState(): UsageMachineState {
    return this.state
  }

  /** False while Claude is limited or unreachable, or while a global quota wait is open. */
  canDispatch(): boolean {
    if (isDispatchBlocked(this.state.status)) return false
    return this.deps.repos.quotaPauses.liveGlobal() === null
  }

  /** The parallel-session limit now: one new session at a time for the first minute after a resume. */
  dispatchLimit(normal: number): number {
    if (this.state.resumedAt === null) return normal
    return rampLimit(this.now() - this.state.resumedAt, normal)
  }

  /** True when a usage limit was hit within the last `ms` (the policy engine avoids heavy strategies then). */
  recentLimitWithin(ms: number): boolean {
    const at = this.state.lastLimitAt ?? this.lastLimitAtFromDb()
    return at !== null && this.now() - at <= ms
  }

  private lastLimitAtFromDb(): number | null {
    const row = this.deps.repos.usageEvents.latestOfType('limit_rejected')
    return row ? Date.parse(row.createdAt) : null
  }

  /** Called when the status or the gate may have changed. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Feed the machine (the recovery controller and the overnight events use this). */
  apply(event: UsageMachineEvent): UsageMachineState {
    const before = this.state
    const next = reduceUsage(before, event, this.now())
    this.state = next
    const gateChanged = before.status !== next.status || before.resumedAt !== next.resumedAt || before.resetAt !== next.resetAt
    if (gateChanged) {
      if (before.status !== next.status) this.log(`${before.status} -> ${next.status}`)
      this.notify()
      this.schedulePush(true)
    }
    return next
  }

  /** A successful account check clears AUTH/RUNTIME statuses, but never reopens the gate during an open wait. */
  private accountOk(): void {
    if (this.deps.repos.quotaPauses.liveGlobal()) return
    this.apply({ type: 'account_ok' })
  }

  /** DispatchGate: the parallel-session limit to apply now (same as `dispatchLimit`). */
  limit(normal: number): number {
    return this.dispatchLimit(normal)
  }

  /** The ramp window ended without an event: tell the scheduler so it can use the full limit again. */
  tickRamp(): void {
    if (this.state.resumedAt === null) return
    if (this.now() - this.state.resumedAt >= RAMP_MS) {
      this.state = { ...this.state, resumedAt: null }
      this.notify()
    }
  }

  /** Tell the scheduler the gate may have changed (a wait row was closed outside the machine). */
  notifyGate(): void {
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (e) {
        this.log(`listener failed: ${errorMessage(e)}`)
      }
    }
  }

  // ───────────────────────────── observing the bus ─────────────────────────────

  private onEvent(event: RunEvent): void {
    if (this.disposed) return
    if (event.agentId && event.type.startsWith('agent.') && this.deps.isOtherProvider?.(event.agentId)) return
    try {
      switch (event.type) {
        case 'agent.rate_limited':
          return this.onRateLimited(event as RunEvent<'agent.rate_limited'>)
        case 'agent.usage':
          return this.onAgentUsage(event as RunEvent<'agent.usage'>)
        case 'agent.started':
          // A session initialized: the account works. (Text from any agent is not evidence of that.)
          this.apply({ type: 'session_ok' })
          return
        case 'overnight.state_changed': {
          // Every exit from an overnight quota wait (resume by hand, deadline, cancel, ...) releases the gate.
          const p = event.payload as RunEvent<'overnight.state_changed'>['payload']
          if (p.from === 'QUOTA_PAUSED' && !this.deps.repos.quotaPauses.liveGlobal()) this.apply({ type: 'wait_ended' })
          return
        }
        case 'agent.stopped':
        case 'agent.failed':
          if (event.agentId) this.sessions.delete(event.agentId)
          return
        case 'run.paused': {
          const payload = event.payload as RunEvent<'run.paused'>['payload']
          if (payload.cause === 'auth') this.recordSignal(event, classifyUsageSignal({ kind: 'turn_outcome', outcome: 'auth' }, this.now()))
          return
        }
        case 'run.resumed':
          // The person resumed after fixing the account: let sessions try; a new failure re-enters the status.
          this.accountOk()
          return
        case 'overnight.quota':
          return this.onOvernightQuota(event as RunEvent<'overnight.quota'>)
        default:
          return
      }
    } catch (e) {
      this.log(`event ${event.type}: ${errorMessage(e)}`)
    }
  }

  private runDetails(runId: string): { projectId: string; strategy: Strategy | null; campaignId: string | null } | null {
    const cached = this.runInfo.get(runId)
    if (cached) return cached
    const run: Run | null = this.deps.repos.runs.get(runId)
    if (!run) return null
    const info = {
      projectId: run.projectId,
      strategy: (run.config.strategy?.resolved ?? null) as ConcreteStrategy | null,
      campaignId: this.deps.repos.arenaTrials.getByRun(runId)?.campaignId ?? null,
    }
    this.runInfo.set(runId, info)
    return info
  }

  private onRateLimited(event: RunEvent<'agent.rate_limited'>): void {
    const p = event.payload
    const now = this.now()
    const signal =
      p.status === 'throttled'
        ? classifyUsageSignal({ kind: 'assistant_error', error: p.limitType === 'server_error' ? 'server_error' : 'overloaded' }, now)
        : classifyUsageSignal(
            {
              kind: 'rate_limit',
              status: p.status,
              resetsAt: p.resetsAt,
              limitType: p.limitType,
              utilization: p.utilization ?? null,
              overageStatus: p.overageStatus ?? null,
              isUsingOverage: p.isUsingOverage ?? null,
              surpassedThreshold: p.surpassedThreshold ?? null,
            },
            now,
          )
    if (!signal) return
    if (signal.eventType === 'limit_rejected') {
      const key = event.runId
      const last = this.lastRejected.get(key)
      const duplicate = last !== undefined && now - last < LIMIT_DEDUPE_MS && signal.resetAt === null
      this.lastRejected.set(key, now)
      this.apply({ type: 'signal', signal })
      this.recordWindow(signal, p.status)
      if (!duplicate) this.persistSignal(signal, event)
      return
    }
    // During an open wait only a probe may change the status (a stray warning must not unblock a blocked one).
    if (!this.deps.repos.quotaPauses.liveGlobal()) this.apply({ type: 'signal', signal })
    this.recordWindow(signal, p.status)
    // A plain "allowed" is routine traffic: it only refreshes the window, no row.
    if (signal.eventType !== 'limit_allowed') this.persistSignal(signal, event)
  }

  private recordSignal(event: RunEvent, signal: UsageSignal | null): void {
    if (!signal) return
    this.apply({ type: 'signal', signal })
    this.persistSignal(signal, event)
  }

  private persistSignal(signal: UsageSignal, ctx: { runId: string | null; taskId?: string | null; agentId?: string | null }): void {
    const now = this.now()
    const info = ctx.runId ? this.runDetails(ctx.runId) : null
    this.deps.repos.usageEvents.insert(
      this.blankEvent(now, signal.eventType, {
        projectId: info?.projectId ?? null,
        runId: ctx.runId,
        taskId: ctx.taskId ?? null,
        agentId: ctx.agentId ?? null,
        strategy: info?.strategy ?? null,
        arenaCampaignId: info?.campaignId ?? null,
        availability: signal.availability,
        limitType: signal.limitType,
        utilization: signal.utilization,
        utilizationUnit: signal.utilizationUnit,
        resetAt: signal.resetAt,
        retryAfterMs: signal.retryAfterMs,
        source: signal.source,
        confidence: signal.confidence,
        rawClassification: signal.rawClassification,
      }),
    )
    this.schedulePush(false)
  }

  private blankEvent(now: number, eventType: UsageEvent['eventType'], over: Partial<UsageEvent>): UsageEvent {
    return {
      id: newId(),
      createdAt: this.iso(now),
      eventType,
      projectId: null,
      runId: null,
      taskId: null,
      agentId: null,
      sdkSessionId: null,
      role: null,
      model: null,
      strategy: null,
      arenaCampaignId: null,
      day: localDay(now),
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      turns: null,
      durationMs: null,
      costUsd: null,
      availability: 'AVAILABLE',
      limitType: null,
      utilization: null,
      utilizationUnit: null,
      resetAt: null,
      retryAfterMs: null,
      source: 'UNKNOWN',
      confidence: 'UNKNOWN',
      rawClassification: null,
      ...over,
    }
  }

  /** Keep the latest window per type. A raw (undocumented-unit) utilization is never stored as a percentage. */
  private recordWindow(signal: UsageSignal, status: string): void {
    if (!signal.limitType) return
    const now = this.iso()
    const known = status === 'allowed' || status === 'allowed_warning' || status === 'rejected'
    this.deps.repos.usageWindows.upsert({
      id: newId(),
      limitType: signal.limitType,
      status: known ? (status as UsageWindow['status']) : 'unknown',
      utilizationPercent: signal.utilizationUnit === 'percent' ? signal.utilization : null,
      resetAt: signal.resetAt,
      source: signal.source,
      confidence: signal.confidence,
      observedAt: now,
      updatedAt: now,
    })
  }

  private onAgentUsage(event: RunEvent<'agent.usage'>): void {
    const turn = event.payload.turn
    if (!turn || !event.agentId) return
    const now = this.now()
    const sum = (pick: (m: NonNullable<typeof turn>['models'][number]) => number): number => turn.models.reduce((n, m) => n + pick(m), 0)
    const delta = {
      inputTokens: sum((m) => m.inputTokens),
      outputTokens: sum((m) => m.outputTokens),
      cacheReadTokens: sum((m) => m.cacheReadTokens),
      cacheCreationTokens: sum((m) => m.cacheCreationTokens),
      costUsd: sum((m) => m.costUsd),
    }
    let row = this.sessions.get(event.agentId)
    const isNew = !row
    if (!row) {
      row = { rowId: newId(), ...EMPTY_SESSION, byModel: new Map() }
      this.sessions.set(event.agentId, row)
    }
    row.inputTokens += delta.inputTokens
    row.outputTokens += delta.outputTokens
    row.cacheReadTokens += delta.cacheReadTokens
    row.cacheCreationTokens += delta.cacheCreationTokens
    row.costUsd += delta.costUsd
    row.turns += turn.turns
    row.durationMs += turn.durationMs
    for (const m of turn.models) row.byModel.set(m.model, (row.byModel.get(m.model) ?? 0) + m.outputTokens + 1)
    const model = [...row.byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const fields = {
      model,
      sdkSessionId: turn.sdkSessionId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      turns: row.turns,
      durationMs: row.durationMs,
      costUsd: row.costUsd,
    }
    const { usageEvents } = this.deps.repos
    if (isNew) {
      const info = this.runDetails(event.runId)
      usageEvents.insert(
        this.blankEvent(now, 'session', {
          id: row.rowId,
          projectId: info?.projectId ?? null,
          runId: event.runId,
          taskId: event.taskId,
          agentId: event.agentId,
          role: turn.role,
          strategy: info?.strategy ?? null,
          arenaCampaignId: info?.campaignId ?? null,
          source: 'SDK_EVENT',
          confidence: 'OBSERVED',
          rawClassification: 'session',
          ...fields,
        }),
      )
    } else {
      usageEvents.update(row.rowId, fields)
    }
    // Totals observed since the process started.
    this.observed = {
      ...this.observed,
      sessions: this.observed.sessions + (isNew ? 1 : 0),
      turns: this.observed.turns + turn.turns,
      inputTokens: this.observed.inputTokens + delta.inputTokens,
      outputTokens: this.observed.outputTokens + delta.outputTokens,
      cacheReadTokens: this.observed.cacheReadTokens + delta.cacheReadTokens,
      cacheCreationTokens: this.observed.cacheCreationTokens + delta.cacheCreationTokens,
      durationMs: this.observed.durationMs + turn.durationMs,
    }
    this.schedulePush(false)
  }

  /** The overnight supervisor owns its quota wait; the status machine only mirrors it. */
  private onOvernightQuota(event: RunEvent<'overnight.quota'>): void {
    const p = event.payload
    if (p.action === 'waiting') {
      const resetAt = p.resetsAt ? Date.parse(p.resetsAt) : Number.NaN
      this.apply({ type: 'restore_wait', resetAt: Number.isFinite(resetAt) ? resetAt : null, limitType: null })
    } else if (p.action === 'resumed') {
      this.apply({ type: 'probe_result', outcome: 'available', resetAt: null })
    } else {
      this.apply({ type: 'wait_ended' })
    }
  }

  // ───────────────────────────── probes and reports (called by the controller) ─────────────────────────────

  /** Persist one availability probe and its result. */
  recordProbe(result: ProbeResult, ctx: { runId?: string | null } = {}): void {
    const now = this.now()
    const w = result.report ? limitingWindow(result.report) : null
    this.deps.repos.usageEvents.insert(
      this.blankEvent(now, 'probe', {
        runId: ctx.runId ?? null,
        availability: result.available ? 'AVAILABLE' : result.outcome === 'auth' ? 'AUTH_REQUIRED' : result.outcome === 'runtime' ? 'RUNTIME_UNAVAILABLE' : 'QUOTA_EXHAUSTED',
        limitType: w?.limitType ?? null,
        utilization: w?.utilizationPercent ?? null,
        utilizationUnit: w ? 'percent' : null,
        resetAt: result.resetAt,
        source: result.method === 'usage_report' ? 'RUNTIME' : 'SDK_EVENT',
        confidence: result.method === 'none' ? 'UNKNOWN' : 'EXACT',
        rawClassification: `probe:${result.method}:${result.outcome}`,
      }),
    )
    if (result.report) this.ingestReport(result.report, false)
    this.schedulePush(false)
  }

  /** Windows and subscription type from a usage report (no event row unless `persist`). */
  private ingestReport(report: RuntimeUsageReport, persist: boolean): void {
    this.reportSupported = true
    if (report.subscriptionType) this.reportSubscriptionType = report.subscriptionType
    const at = this.iso()
    const rows = report.windows.filter((w) => w.utilizationPercent !== null || w.resetsAt !== null)
    for (const w of rows) {
      this.deps.repos.usageWindows.upsert({
        id: newId(),
        limitType: w.limitType,
        status: w.utilizationPercent !== null && w.utilizationPercent >= 100 ? 'rejected' : w.utilizationPercent !== null && w.utilizationPercent >= 90 ? 'allowed_warning' : 'allowed',
        utilizationPercent: w.utilizationPercent,
        resetAt: w.resetsAt,
        source: 'RUNTIME',
        confidence: 'EXACT',
        observedAt: at,
        updatedAt: at,
      })
    }
    this.apply({ type: 'report', windows: report.windows })
    if (persist) {
      const w = limitingWindow(report)
      const signal = classifyUsageSignal({ kind: 'usage_report', report }, this.now())
      this.deps.repos.usageEvents.insert(
        this.blankEvent(this.now(), 'usage_report', {
          availability: signal?.availability ?? 'UNKNOWN',
          limitType: w?.limitType ?? null,
          utilization: w?.utilizationPercent ?? null,
          utilizationUnit: w ? 'percent' : null,
          resetAt: signal?.resetAt ?? null,
          source: 'RUNTIME',
          confidence: w ? 'EXACT' : 'UNKNOWN',
          rawClassification: signal?.rawClassification ?? 'usage_report',
        }),
      )
    }
  }

  // ───────────────────────────── the read model ─────────────────────────────

  private subscriptionMode(): boolean {
    return this.deps.repos.settings.get().claude.subscriptionMode
  }

  private loadAccount(): Promise<void> {
    if (!this.accountLoading) {
      this.accountLoading = this.deps.runtime
        .getAccountInfo({ subscriptionMode: this.subscriptionMode() })
        .then((a) => {
          this.account = a
          if (a.state === 'authenticated') this.accountOk()
          this.schedulePush(false)
        })
        .catch((e) => this.log(`account info failed: ${errorMessage(e)}`))
        .finally(() => {
          this.accountLoading = null
        })
    }
    return this.accountLoading
  }

  overview(): UsageOverview {
    const { repos } = this.deps
    if (!this.account && !this.accountLoading) void this.loadAccount()
    const s = this.state
    const now = this.now()
    // A window whose reset passed, or that was observed long ago, withholds its percentage and says it is stale.
    const windows = repos.usageWindows.list().map((w): UsageWindowView => {
      const resetPassed = w.resetAt !== null && Date.parse(w.resetAt) <= now
      const old = now - Date.parse(w.observedAt) > USAGE_WINDOW_MAX_AGE_MS
      if (!resetPassed && !old) return { ...w, stale: false }
      return { ...w, stale: true, utilizationPercent: null, confidence: 'UNKNOWN' }
    })
    const pause = repos.quotaPauses.liveGlobal()
    const live = repos.quotaPauses.listLive()

    // A percentage only from a window whose utilization the runtime supplied.
    let top: UsageWindow | null = null
    for (const w of windows) {
      if (w.utilizationPercent === null || w.confidence !== 'EXACT') continue
      if (!top || (top.utilizationPercent ?? 0) < w.utilizationPercent) top = w
    }
    const subscriptionType = this.account?.subscriptionType ?? this.reportSubscriptionType
    const mode = this.account?.mode
    const nextReset =
      s.resetAt !== null
        ? measured(this.iso(s.resetAt), 'SDK_EVENT', 'EXACT')
        : (() => {
            const future = windows.filter((w) => w.resetAt && Date.parse(w.resetAt) > now && w.confidence === 'EXACT').sort((a, b) => Date.parse(a.resetAt as string) - Date.parse(b.resetAt as string))[0]
            return future ? measured(future.resetAt, future.source, 'EXACT') : unknownValue<string>()
          })()
    const nextCheck = pause?.nextCheckAt ?? live.find((p) => p.nextCheckAt)?.nextCheckAt ?? null
    const checkOwner = pause ?? live.find((p) => p.nextCheckAt) ?? null
    return {
      capturedAt: this.iso(now),
      provider: 'claude',
      accountMode: mode && mode !== 'unknown' ? measured(mode, 'RUNTIME', 'EXACT') : unknownValue(),
      subscriptionType: subscriptionType ? measured(subscriptionType, 'RUNTIME', 'EXACT') : unknownValue(),
      status: s.status,
      availability: s.availability,
      session: { ...this.observed },
      windows,
      subscriptionUtilizationPercent: top ? measured(top.utilizationPercent, top.source, 'EXACT') : unknownValue(),
      nextResetAt: nextReset,
      retryAfterMs: s.retryAfterMs !== null && s.status === 'QUOTA_PAUSED' ? measured(s.retryAfterMs, 'ERROR_METADATA', 'EXACT') : unknownValue(),
      lastLimitAt: this.lastLimitAtIso(),
      autoResume: {
        enabled: repos.settings.get().usage.autoResume,
        pause,
        nextCheckAt: nextCheck ? measured(nextCheck, 'LOCAL_AGGREGATION', checkOwner?.resetConfidence === 'EXACT' ? 'EXACT' : 'ESTIMATED') : unknownValue(),
        pausedRuns: live.filter((p) => p.scope === 'run').length,
      },
      usageReportSupported: this.reportSupported,
    }
  }

  private lastLimitAtIso(): string | null {
    const row = this.deps.repos.usageEvents.latestOfType('limit_rejected')
    return row ? row.createdAt : null
  }

  /** Ask the runtime for its usage report (no prompt) and refresh the account. Never throws. */
  async refresh(): Promise<UsageOverview> {
    const { runtime } = this.deps
    await this.loadAccount()
    if (runtime.getUsageReport && this.deps.repos.settings.get().usage.useRuntimeUsageReport) {
      try {
        const report = await runtime.getUsageReport({ subscriptionMode: this.subscriptionMode() })
        if (report) this.ingestReport(report, true)
        else this.reportSupported = this.reportSupported ?? false
      } catch (e) {
        this.log(`usage report failed: ${errorMessage(e)}`)
        this.reportSupported = this.reportSupported ?? false
      }
    }
    const overview = this.overview()
    this.deps.push({ kind: 'usage', overview })
    return overview
  }

  totals(filter: UsageFilter = {}): UsageTotals {
    return this.deps.repos.usageEvents.totals(filter)
  }

  breakdown(by: UsageGrouping, filter: UsageFilter = {}, limit = 50): UsageBreakdownRow[] {
    const { repos } = this.deps
    const label = (key: string): string => {
      switch (by) {
        case 'run':
          return repos.runs.get(key)?.prompt.slice(0, 60) ?? key
        case 'agent':
          return repos.agents.get(key)?.label ?? key
        case 'task': {
          const t = repos.tasks.get(key)
          return t ? `${t.key} ${t.title}`.slice(0, 80) : key
        }
        case 'campaign':
          return repos.arenaCampaigns.get(key)?.name ?? key
        default:
          return key
      }
    }
    return repos.usageEvents.breakdown(by, filter, limit).map((row) => ({ ...row, label: label(row.key) }))
  }

  limitHistory(page: { limit?: number; offset?: number } = {}): UsageLimitHistory {
    const { repos } = this.deps
    const events = repos.usageEvents.listLimitEvents(page)
    const pauses = repos.quotaPauses.listRecent(page)
    return { events, pauses: this.withResumes(pauses) }
  }

  private withResumes(pauses: ReturnType<Repositories['quotaPauses']['listRecent']>): UsageLimitHistory['pauses'] {
    const { repos } = this.deps
    const resumes = repos.quotaResumes.listByPauses(pauses.map((p) => p.id))
    return pauses.map((p) => ({
      ...p,
      resumes: resumes.filter((r) => r.pauseId === p.id),
      runLabel: p.runId ? (repos.runs.get(p.runId)?.prompt.slice(0, 80) ?? null) : null,
    }))
  }

  runUsage(runId: string): RunUsage {
    const { repos } = this.deps
    const filter = { runId }
    const byAgent = this.breakdown('agent', filter, 400)
    return {
      runId,
      strategy: repos.runs.get(runId)?.config.strategy ?? null,
      totals: repos.usageEvents.totals(filter),
      agents: byAgent.length,
      byAgent,
      byModel: repos.usageEvents.breakdown('model', filter, 50),
      byRole: repos.usageEvents.breakdown('role', filter, 50),
      pauses: this.withResumes(repos.quotaPauses.listByRun(runId)),
    }
  }

  efficiency(): UsageEfficiency {
    const { repos } = this.deps
    const totals = repos.usageEvents.totals()
    const outcomes = repos.taskOutcomes.listAll()
    const successful = outcomes.filter((o) => o.completed).length
    const tokens = totals.inputTokens + totals.outputTokens
    const per = (n: number): ReturnType<typeof measured<number>> => (successful > 0 ? measured(n / successful, 'LOCAL_AGGREGATION', 'OBSERVED') : unknownValue<number>())
    const repairs = outcomes.reduce((n, o) => n + o.repairCount, 0)
    return {
      tokensPerSuccessfulTask: per(tokens),
      sessionsPerSuccessfulTask: per(totals.sessions),
      repairsPerTask: outcomes.length > 0 ? measured(repairs / outcomes.length, 'LOCAL_AGGREGATION', 'OBSERVED') : unknownValue<number>(),
      successfulTasks: successful,
      byStrategy: [...this.missionRows(), ...this.arenaRows()],
    }
  }

  private missionRows(): StrategyEfficiencyRow[] {
    const missions = this.deps.repos.missionOutcomes.listMissionsSince('1970-01-01T00:00:00.000Z')
    const groups = new Map<ConcreteStrategy, typeof missions>()
    for (const m of missions) groups.set(m.strategy, [...(groups.get(m.strategy) ?? []), m])
    return [...groups.entries()].map(([strategy, list]) => {
      const successes = list.filter((m) => m.success).length
      const tokens = list.filter((m) => m.inputTokens !== null || m.outputTokens !== null).map((m) => (m.inputTokens ?? 0) + (m.outputTokens ?? 0))
      const interval = wilsonInterval(successes, list.length)
      return {
        strategy,
        kind: 'mission' as const,
        n: list.length,
        successes,
        passRate: list.length > 0 ? successes / list.length : null,
        meanSessions: mean(list.map((m) => m.sessions)),
        meanObservedTokens: mean(tokens),
        medianDurationMs: median(list.map((m) => m.elapsedMs).filter((v): v is number => v !== null)),
        label: evidenceLabel(list.length, interval),
      }
    })
  }

  private arenaRows(): StrategyEfficiencyRow[] {
    const { repos } = this.deps
    const trials = repos.arenaTrials.listFinishedSince('1970-01-01T00:00:00.000Z').filter((t) => t.state === 'passed' || t.state === 'failed')
    if (trials.length === 0) return []
    const metrics = new Map<string, NonNullable<ReturnType<typeof repos.arenaMetrics.getByTrial>>>()
    for (let i = 0; i < trials.length; i += 400) {
      for (const m of repos.arenaMetrics.listByTrials(trials.slice(i, i + 400).map((t) => t.id))) metrics.set(m.trialId, m)
    }
    const groups = new Map<ConcreteStrategy, typeof trials>()
    for (const t of trials) groups.set(t.strategy, [...(groups.get(t.strategy) ?? []), t])
    return [...groups.entries()].map(([strategy, list]) => {
      const successes = list.filter((t) => t.state === 'passed').length
      const ms = list.map((t) => metrics.get(t.id)).filter((m): m is NonNullable<typeof m> => m !== undefined)
      const interval = wilsonInterval(successes, list.length)
      return {
        strategy,
        kind: 'arena' as const,
        n: list.length,
        successes,
        passRate: list.length > 0 ? successes / list.length : null,
        meanSessions: mean(ms.map((m) => m.sessions)),
        meanObservedTokens: mean(ms.filter((m) => m.inputTokens !== null || m.outputTokens !== null).map((m) => (m.inputTokens ?? 0) + (m.outputTokens ?? 0))),
        medianDurationMs: median(ms.map((m) => m.wallClockMs).filter((v): v is number => v !== null)),
        label: evidenceLabel(list.length, interval),
      }
    })
  }

  // ───────────────────────────── pushes ─────────────────────────────

  /** Status changes push at once; everything else at most once a second (trailing). */
  private schedulePush(immediate: boolean): void {
    if (this.disposed) return
    const wall = Date.now()
    if (immediate || wall - this.lastPushAt >= PUSH_INTERVAL_MS) {
      this.pushNow()
      return
    }
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.pushNow()
    }, PUSH_INTERVAL_MS - (wall - this.lastPushAt))
    this.pushTimer.unref?.()
  }

  private pushNow(): void {
    if (this.disposed) return
    this.lastPushAt = Date.now()
    try {
      this.deps.push({ kind: 'usage', overview: this.overview() })
    } catch (e) {
      this.log(`push failed: ${errorMessage(e)}`)
    }
  }
}

const EMPTY_SESSION = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
  durationMs: 0,
  costUsd: 0,
}
