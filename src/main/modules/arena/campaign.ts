import { join } from 'node:path'
import type { Preset, Project, Run, RunConfig, RunMode, RunState } from '@shared/domain'
import type { PushMessage } from '@shared/events'
import { newId, nowIso, shortId } from '@shared/ids'
import { NexusError, errorMessage } from '@shared/result'
import {
  ARENA_BUDGET_DEFAULTS,
  DEFAULT_SCORING,
  SCORE_VERSION,
  TERMINAL_TRIAL_STATES,
  TRIAL_STATES,
  type ArenaBudgetPreset,
  type ArenaCampaign,
  type ArenaCampaignBudgets,
  type ArenaCase,
  type ArenaCaseVersion,
  type ArenaEnvironment,
  type ArenaEvaluation,
  type ArenaTrial,
  type ArenaTrialMetrics,
  type ConcreteStrategy,
  type TrialState,
} from '@shared/v3'
import type {
  ArenaCampaignDetail,
  ArenaCampaignSummary,
  ArenaCaseSummary,
  ArenaResults,
  ArenaTrialDetail,
  ArenaTrialRow,
} from '@shared/v3-read'
import type { EventBus } from '../events'
import type { GitService } from '../git'
import type { Repositories } from '../persistence'
import { importCase, registerCases, trustCaseVersion, type ImportedCase } from './case-format'
import { evaluateTrial } from './evaluator'
import { provisionTrial } from './fixtures'
import { collectTrialMetrics } from './metrics'
import {
  COUNTED_STATES,
  buildMatrix,
  compareStrategies,
  detectRegressions,
  mergeScoring,
  resultNotes,
  scoreTrial,
  type ComparisonTrial,
} from './scoring'

/** What the Arena needs from the orchestrator. The lead adapts the real Orchestrator to this. */
export interface ArenaRunHost {
  createRun(input: {
    projectId: string
    mode: RunMode
    preset: Preset
    prompt: string
    /** The case's visible acceptance criteria (also appended to the prompt). */
    acceptanceCriteria: string[]
    strategy: ConcreteStrategy
    arenaTrialId: string
    overrides?: Partial<RunConfig>
  }): Promise<Run>
  pauseRun(runId: string): Promise<unknown>
  resumeRun(runId: string): Promise<unknown>
  cancelRun(runId: string): Promise<unknown>
}

export interface ArenaServiceDeps {
  repos: Repositories
  bus: EventBus
  git: GitService
  /** Trials live in `<dataDir>/arena/<campaignShort>/<trialShort>/`. */
  dataDir: string
  /** Directory holding the built-in cases (`arena/cases` in dev, a resources path when packaged). */
  casesDir: string
  host: ArenaRunHost
  projects: { open(path: string): Promise<Project> }
  usage?: { canDispatch(): boolean; onChange(listener: () => void): () => void }
  policy?: { activeSnapshotId(): string | null }
  push?: (message: PushMessage) => void
  now?: () => string
  nexusVersion: string
  environment(): Promise<ArenaEnvironment>
  logger?: (line: string) => void
  /** Test seams. */
  provision?: typeof provisionTrial
  evaluate?: typeof evaluateTrial
  /** Milliseconds in one budget "minute" (tests shrink it). */
  minuteMs?: number
  /** Safety poll of run state (0 disables); events are the primary signal. */
  pollMs?: number
  /** How long a finished run's agents may take to become inactive before evaluation is refused. */
  agentSettleMs?: number
}

export interface CreateCampaignInput {
  name: string
  /** Case ids (or case version ids). */
  caseIds: string[]
  strategies: ConcreteStrategy[]
  repetitions: number
  modelPreset: Preset
  budgetPreset: ArenaBudgetPreset
  maxConcurrentTrials?: number
  maxWallClockMinutes?: number
  maxTrials?: number
  maxAgentSessions?: number
  maxAgentsPerTrial?: number
  overnight?: boolean
  start?: boolean
}

type StopKind = 'cancel' | 'budget' | 'timeout'
type RunEnd =
  | { kind: 'completed' | 'failed' | 'cancelled' | 'missing' }
  | { kind: 'blocked'; detail: string }
  | { kind: 'stopped'; stop: StopKind; detail: string }

/** Active time only: a quota wait does not count against a wall-clock budget. */
class Stopwatch {
  private acc = 0
  private since: number | null = null
  start(): void {
    if (this.since === null) this.since = Date.now()
  }
  stop(): void {
    if (this.since !== null) {
      this.acc += Date.now() - this.since
      this.since = null
    }
  }
  preload(ms: number): void {
    this.acc = Math.max(0, ms)
  }
  elapsed(): number {
    return this.acc + (this.since === null ? 0 : Date.now() - this.since)
  }
}

interface Job {
  trialId: string
  campaignId: string
  runId: string | null
  stop: { kind: StopKind; detail: string } | null
  quotaPaused: boolean
  clock: Stopwatch
  timer: ReturnType<typeof setTimeout> | null
  poke: (() => void) | null
  promise: Promise<void>
}

const RUN_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.paused', 'run.resumed', 'run.state_changed'])
const TERMINAL_RUN: readonly RunState[] = ['completed', 'failed', 'cancelled']
const isTerminalTrial = (s: TrialState): boolean => TERMINAL_TRIAL_STATES.includes(s)
const TIMER_TICK_MS = 5000

const unref = <T extends ReturnType<typeof setTimeout>>(t: T): T => {
  ;(t as { unref?: () => void }).unref?.()
  return t
}

const emptyCounts = (): Record<TrialState, number> =>
  Object.fromEntries(TRIAL_STATES.map((s) => [s, 0])) as Record<TrialState, number>

/**
 * Owns the persisted Arena queue. Campaign `draft -> running <-> paused(quota|user) -> completed | cancelled`;
 * trial `queued -> provisioning -> running -> evaluating -> passed | failed | blocked | cancelled`. Every state
 * change is written before the next step and announced with `{ kind: 'arena', campaignId }`.
 *
 * Pausing a campaign (user) starts no new trial and lets running ones finish; it does not pause their runs.
 * A quota pause is derived: the usage gate is closed or a trial's run is paused for `quota`; the campaign
 * continues by itself when both clear.
 */
export class ArenaService {
  private readonly jobs = new Map<string, Job>()
  private readonly jobsByRun = new Map<string, Job>()
  private readonly clocks = new Map<string, Stopwatch>()
  private readonly campaignTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Campaigns that ran out of a budget: nothing new starts, running trials are stopped. */
  private readonly closing = new Set<string>()
  private readonly unsubscribes: (() => void)[] = []
  private readonly now: () => string
  private readonly minuteMs: number
  private readonly provision: typeof provisionTrial
  private readonly evaluate: typeof evaluateTrial
  private disposed = false

  constructor(private readonly deps: ArenaServiceDeps) {
    this.now = deps.now ?? nowIso
    this.minuteMs = deps.minuteMs ?? 60_000
    this.provision = deps.provision ?? provisionTrial
    this.evaluate = deps.evaluate ?? evaluateTrial
    this.unsubscribes.push(
      deps.bus.subscribe((event) => {
        if (!RUN_EVENTS.has(event.type)) return
        this.jobsByRun.get(event.runId)?.poke?.()
      }),
    )
    if (deps.usage) this.unsubscribes.push(deps.usage.onChange(() => this.onUsageChange()))
  }

  private log(line: string): void {
    this.deps.logger?.(`[arena] ${line}`)
  }

  private get repos(): Repositories {
    return this.deps.repos
  }

  private push(campaignId: string): void {
    try {
      this.deps.push?.({ kind: 'arena', campaignId })
    } catch (e) {
      this.log(`push failed: ${errorMessage(e)}`)
    }
  }

  // ───────────────────────────── cases ─────────────────────────────

  /** Registers the shipped cases (trusted). Throws when a shipped evaluator changed without a version bump. */
  syncBuiltinCases(): ArenaCaseSummary[] {
    return registerCases(this.repos, this.deps.casesDir, 'builtin').map((r) => ({ case: r.case, version: r.version }))
  }

  listCases(): ArenaCaseSummary[] {
    return this.repos.arenaCases.list().flatMap((c) => {
      const version = this.repos.arenaCaseVersions.latest(c.id)
      return version ? [{ case: c, version }] : []
    })
  }

  importCase(dir: string): ImportedCase {
    return importCase(this.repos, dir)
  }

  /** Confirms the commands of an imported case version (shown by `importCase`). */
  trustCase(caseVersionId: string): ArenaCaseVersion {
    return trustCaseVersion(this.repos, caseVersionId)
  }

  private resolveVersion(id: string): { caseRow: ArenaCase; version: ArenaCaseVersion } {
    const byCase = this.repos.arenaCases.get(id)
    const version = byCase ? this.repos.arenaCaseVersions.latest(id) : this.repos.arenaCaseVersions.get(id)
    if (!version) throw new NexusError('not_found', `Arena case not found: ${id}`)
    return { caseRow: byCase ?? this.repos.arenaCases.require(version.caseId), version }
  }

  // ───────────────────────────── campaigns ─────────────────────────────

  async createCampaign(input: CreateCampaignInput): Promise<ArenaCampaign> {
    if (input.caseIds.length === 0) throw new NexusError('invalid_input', 'Choose at least one case')
    if (input.strategies.length === 0) throw new NexusError('invalid_input', 'Choose at least one strategy')
    const strategies = [...new Set(input.strategies)]
    const resolved = [...new Map(input.caseIds.map((id) => this.resolveVersion(id)).map((r) => [r.version.id, r])).values()]
    for (const { version } of resolved) {
      if (!version.trusted) {
        throw new NexusError(
          'invalid_state',
          `Case ${version.caseId} v${version.version} is not trusted. Review its commands and trust it first.`,
          { caseId: version.caseId },
        )
      }
    }
    const defaults = ARENA_BUDGET_DEFAULTS[input.budgetPreset]
    const budgets: ArenaCampaignBudgets = {
      preset: input.budgetPreset,
      maxWallClockMinutes: input.maxWallClockMinutes ?? defaults.maxWallClockMinutes,
      maxTrials: input.maxTrials ?? defaults.maxTrials,
      maxConcurrentTrials: input.maxConcurrentTrials ?? defaults.maxConcurrentTrials,
      maxAgentSessions: input.maxAgentSessions ?? defaults.maxAgentSessions,
      maxAgentsPerTrial: input.maxAgentsPerTrial ?? defaults.maxAgentsPerTrial,
    }
    // Repetition is the outermost loop: a campaign cut short by a budget still has balanced strategies.
    const planned: { version: ArenaCaseVersion; strategy: ConcreteStrategy; repetition: number }[] = []
    for (let repetition = 1; repetition <= input.repetitions; repetition++) {
      for (const { version } of resolved) {
        for (const strategy of strategies) {
          if (version.definition.allowedStrategies.includes(strategy)) planned.push({ version, strategy, repetition })
        }
      }
    }
    if (planned.length === 0) throw new NexusError('invalid_input', 'None of the chosen strategies is allowed for the chosen cases')
    if (planned.length > budgets.maxTrials) {
      throw new NexusError('invalid_input', `The campaign has ${planned.length} trials, above the limit of ${budgets.maxTrials}`, {
        trials: planned.length,
        maxTrials: budgets.maxTrials,
      })
    }
    const environment = await this.deps.environment()
    const now = this.now()
    const campaign: ArenaCampaign = {
      id: newId(),
      name: input.name,
      state: 'draft',
      pauseReason: null,
      caseVersionIds: resolved.map((r) => r.version.id),
      strategies,
      repetitions: input.repetitions,
      modelPreset: input.modelPreset,
      budgets,
      overnight: input.overnight ?? false,
      policySnapshotId: this.deps.policy?.activeSnapshotId() ?? null,
      nexusVersion: this.deps.nexusVersion,
      environment,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    }
    this.repos.transaction(() => {
      this.repos.arenaCampaigns.insert(campaign)
      planned.forEach((p, ordinal) => {
        this.repos.arenaTrials.insert({
          id: newId(),
          campaignId: campaign.id,
          caseId: p.version.caseId,
          caseVersionId: p.version.id,
          strategy: p.strategy,
          repetition: p.repetition,
          ordinal,
          state: 'queued',
          projectId: null,
          runId: null,
          repoPath: null,
          baselineCommit: null,
          resultCommit: null,
          policySnapshotId: null,
          taskProfileId: null,
          models: {},
          detail: null,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
        })
      })
    })
    this.push(campaign.id)
    return input.start ? this.start(campaign.id) : campaign
  }

  /** Writes a campaign patch, keeps the budget clock in step with the state, and announces it. */
  private setCampaign(id: string, patch: Partial<Omit<ArenaCampaign, 'id'>>): ArenaCampaign {
    const next = this.repos.arenaCampaigns.update(id, patch)
    this.syncClock(next)
    this.push(id)
    return next
  }

  private clockOf(id: string): Stopwatch {
    let c = this.clocks.get(id)
    if (!c) {
      c = new Stopwatch()
      this.clocks.set(id, c)
    }
    return c
  }

  private syncClock(c: ArenaCampaign): void {
    const clock = this.clockOf(c.id)
    if (c.state === 'running') {
      clock.start()
      this.armCampaignTimer(c.id)
    } else {
      clock.stop()
      this.disarmCampaignTimer(c.id)
    }
  }

  private armCampaignTimer(id: string): void {
    this.disarmCampaignTimer(id)
    if (this.disposed) return
    const c = this.repos.arenaCampaigns.get(id)
    if (!c || c.state !== 'running') return
    const limit = c.budgets.maxWallClockMinutes * this.minuteMs
    const remaining = limit - this.clockOf(id).elapsed()
    this.campaignTimers.set(
      id,
      unref(
        setTimeout(() => {
          this.campaignTimers.delete(id)
          const cur = this.repos.arenaCampaigns.get(id)
          if (!cur || cur.state !== 'running') return
          if (this.clockOf(id).elapsed() >= limit) {
            this.exhaust(id, `Budget: maxWallClockMinutes (${c.budgets.maxWallClockMinutes}) reached`)
          } else {
            this.armCampaignTimer(id)
          }
        }, Math.max(5, Math.min(remaining, TIMER_TICK_MS))),
      ),
    )
  }

  private disarmCampaignTimer(id: string): void {
    const t = this.campaignTimers.get(id)
    if (t) clearTimeout(t)
    this.campaignTimers.delete(id)
  }

  start(campaignId: string): ArenaCampaign {
    const c = this.repos.arenaCampaigns.require(campaignId)
    if (c.state !== 'draft') throw new NexusError('invalid_state', `Campaign is ${c.state}; only a draft can be started`)
    const next = this.setCampaign(campaignId, { state: 'running', pauseReason: null, startedAt: this.now() })
    this.reconcile(campaignId)
    this.schedule(campaignId)
    return this.repos.arenaCampaigns.get(campaignId) ?? next
  }

  pause(campaignId: string): ArenaCampaign {
    const c = this.repos.arenaCampaigns.require(campaignId)
    if (c.state === 'paused') return c.pauseReason === 'user' ? c : this.setCampaign(campaignId, { pauseReason: 'user' })
    if (c.state !== 'running') throw new NexusError('invalid_state', `Campaign is ${c.state}; only a running campaign can be paused`)
    return this.setCampaign(campaignId, { state: 'paused', pauseReason: 'user' })
  }

  resume(campaignId: string): ArenaCampaign {
    const c = this.repos.arenaCampaigns.require(campaignId)
    if (c.state === 'running') return c
    if (c.state !== 'paused') throw new NexusError('invalid_state', `Campaign is ${c.state}; only a paused campaign can be resumed`)
    this.setCampaign(campaignId, { state: 'running', pauseReason: null })
    this.reconcile(campaignId)
    this.schedule(campaignId)
    return this.repos.arenaCampaigns.require(campaignId)
  }

  cancel(campaignId: string): ArenaCampaign {
    const c = this.repos.arenaCampaigns.require(campaignId)
    if (c.state === 'completed' || c.state === 'cancelled' || c.state === 'failed') return c
    const next = this.setCampaign(campaignId, { state: 'cancelled', pauseReason: null, completedAt: this.now() })
    this.cancelQueued(campaignId, 'Campaign cancelled')
    for (const job of this.jobsOf(campaignId)) this.requestStop(job, 'cancel', 'Campaign cancelled')
    this.disarmCampaignTimer(campaignId)
    return next
  }

  private jobsOf(campaignId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.campaignId === campaignId)
  }

  private cancelQueued(campaignId: string, detail: string): void {
    const finishedAt = this.now()
    for (const t of this.repos.arenaTrials.listByCampaignStates(campaignId, ['queued'])) {
      this.repos.arenaTrials.update(t.id, { state: 'cancelled', detail, finishedAt })
    }
    this.push(campaignId)
  }

  /** A campaign budget ran out: nothing new starts; queued trials are cancelled; running ones are stopped. */
  private exhaust(campaignId: string, note: string): void {
    const c = this.repos.arenaCampaigns.get(campaignId)
    if (!c || c.state === 'completed' || c.state === 'cancelled' || c.state === 'failed') return
    this.closing.add(campaignId)
    this.repos.arenaCampaigns.update(campaignId, { error: note })
    this.log(`${campaignId}: ${note}`)
    this.cancelQueued(campaignId, note)
    for (const job of this.jobsOf(campaignId)) this.requestStop(job, 'budget', note)
    this.maybeComplete(campaignId)
  }

  listCampaigns(page: { limit?: number; offset?: number } = {}): { campaigns: ArenaCampaignSummary[]; total: number } {
    const campaigns = this.repos.arenaCampaigns.list(page).map((c) => this.summary(c))
    return { campaigns, total: this.repos.arenaCampaigns.count() }
  }

  private summary(campaign: ArenaCampaign): ArenaCampaignSummary {
    const counts = emptyCounts()
    let total = 0
    for (const row of this.repos.arenaTrials.countsByCampaign(campaign.id)) {
      counts[row.state] = row.n
      total += row.n
    }
    return { campaign, counts, total }
  }

  campaignDetail(campaignId: string): ArenaCampaignDetail {
    const campaign = this.repos.arenaCampaigns.require(campaignId)
    const trials = this.repos.arenaTrials.listByCampaign(campaignId, { limit: 2000 })
    const evaluations = this.latestEvaluations(this.repos.arenaEvaluations.listByCampaign(campaignId))
    const metrics = new Map(this.repos.arenaMetrics.listByCampaign(campaignId).map((m) => [m.trialId, m]))
    const versions = this.repos.arenaCaseVersions.listByIds(campaign.caseVersionIds)
    return {
      ...this.summary(campaign),
      cases: versions.flatMap((v) => {
        const c = this.repos.arenaCases.get(v.caseId)
        return c ? [{ case: c, version: v }] : []
      }),
      matrix: buildMatrix(trials, [...evaluations.values()]),
      comparison: compareStrategies(this.comparisonTrials(trials, evaluations, metrics)),
      usage: this.repos.usageEvents.totals({ arenaCampaignId: campaignId }),
    }
  }

  trials(campaignId: string, page: { limit?: number; offset?: number } = {}): { trials: ArenaTrialRow[]; total: number } {
    const all = this.repos.arenaTrials.countsByCampaign(campaignId).reduce((n, r) => n + r.n, 0)
    const rows = this.repos.arenaTrials.listByCampaign(campaignId, { limit: page.limit ?? 50, offset: page.offset ?? 0 })
    const metrics = new Map(this.repos.arenaMetrics.listByTrials(rows.map((t) => t.id)).map((m) => [m.trialId, m]))
    return {
      total: all,
      trials: rows.map((trial) => {
        const evaluation = this.repos.arenaEvaluations.latestForTrial(trial.id)
        return {
          trial,
          metrics: metrics.get(trial.id) ?? null,
          score: evaluation?.score ?? null,
          hiddenPassed: evaluation ? evaluation.passed : null,
          runState: trial.runId ? (this.repos.runs.get(trial.runId)?.state ?? null) : null,
        }
      }),
    }
  }

  trial(trialId: string): ArenaTrialDetail {
    const trial = this.repos.arenaTrials.require(trialId)
    const caseRow = this.repos.arenaCases.get(trial.caseId)
    const version = this.repos.arenaCaseVersions.get(trial.caseVersionId)
    return {
      trial,
      case: caseRow && version ? { case: caseRow, version } : null,
      metrics: this.repos.arenaMetrics.getByTrial(trialId),
      evaluation: this.repos.arenaEvaluations.latestForTrial(trialId),
      profile: trial.runId ? this.repos.taskProfiles.getByRun(trial.runId) : null,
    }
  }

  private latestEvaluations(rows: ArenaEvaluation[]): Map<string, ArenaEvaluation> {
    const out = new Map<string, ArenaEvaluation>()
    for (const e of rows) out.set(e.trialId, e) // listByCampaign is oldest first: the newest wins
    return out
  }

  private comparisonTrials(
    trials: readonly ArenaTrial[],
    evaluations: Map<string, ArenaEvaluation>,
    metrics: Map<string, ArenaTrialMetrics>,
  ): ComparisonTrial[] {
    return trials.flatMap((t) => {
      const e = evaluations.get(t.id)
      // Only trials that were actually evaluated (or scored as failed acceptance) count; provisioning failures and cancellations do not.
      if (!e || !COUNTED_STATES.includes(t.state)) return []
      return [{ strategy: t.strategy, passed: e.passed, metrics: metrics.get(t.id) ?? null }]
    })
  }

  results(options: { campaignId?: string; sinceDays?: number } = {}): ArenaResults {
    let trials: ArenaTrial[]
    if (options.campaignId) {
      trials = this.repos.arenaTrials.listByCampaign(options.campaignId, { limit: 2000 })
    } else {
      const days = options.sinceDays ?? 3650
      trials = this.repos.arenaTrials.listFinishedSince(new Date(Date.parse(this.now()) - days * 86_400_000).toISOString())
    }
    const metrics = new Map(this.repos.arenaMetrics.listByTrials(trials.map((t) => t.id)).map((m) => [m.trialId, m]))
    const evaluations = new Map<string, ArenaEvaluation>()
    for (const t of trials) {
      const e = this.repos.arenaEvaluations.latestForTrial(t.id)
      if (e) evaluations.set(t.id, e)
    }
    const counted = this.comparisonTrials(trials, evaluations, metrics)
    const countedIds = new Set(trials.filter((t) => evaluations.has(t.id) && COUNTED_STATES.includes(t.state)).map((t) => t.id))
    const comparison = compareStrategies(counted)

    const byCaseMap = new Map<string, ArenaTrial[]>()
    for (const t of trials) if (countedIds.has(t.id)) byCaseMap.set(t.caseId, [...(byCaseMap.get(t.caseId) ?? []), t])
    const byCase = [...byCaseMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([caseId, list]) => ({
        caseId,
        caseName: this.repos.arenaCases.get(caseId)?.name ?? caseId,
        rows: compareStrategies(this.comparisonTrials(list, evaluations, metrics)),
      }))

    // Regression: oldest vs newest NEXUS version, over the case versions both ran.
    const campaigns = new Map<string, ArenaCampaign>()
    for (const t of trials) if (!campaigns.has(t.campaignId)) campaigns.set(t.campaignId, this.repos.arenaCampaigns.require(t.campaignId))
    const groups = new Map<string, { first: string; trials: ArenaTrial[] }>()
    for (const t of trials) {
      if (!countedIds.has(t.id)) continue
      const c = campaigns.get(t.campaignId)!
      const g = groups.get(c.nexusVersion) ?? { first: c.createdAt, trials: [] }
      g.first = g.first < c.createdAt ? g.first : c.createdAt
      g.trials.push(t)
      groups.set(c.nexusVersion, g)
    }
    const ordered = [...groups.entries()].sort(([, a], [, b]) => a.first.localeCompare(b.first))
    let regressions: ArenaResults['regressions'] = []
    if (ordered.length >= 2) {
      const [olderName, older] = ordered[0]!
      const [newerName, newer] = ordered[ordered.length - 1]!
      const common = new Set(older.trials.map((t) => t.caseVersionId).filter((id) => newer.trials.some((t) => t.caseVersionId === id)))
      const pick = (g: { trials: ArenaTrial[] }): ComparisonTrial[] =>
        this.comparisonTrials(g.trials.filter((t) => common.has(t.caseVersionId)), evaluations, metrics)
      regressions = detectRegressions({ group: `NEXUS ${olderName}`, trials: pick(older) }, { group: `NEXUS ${newerName}`, trials: pick(newer) })
    }
    return { comparison, byCase, regressions, totalTrials: counted.length, notes: resultNotes(comparison) }
  }

  // ───────────────────────────── scheduler ─────────────────────────────

  private gateClosed(campaignId: string): boolean {
    if (this.deps.usage && !this.deps.usage.canDispatch()) return true
    return this.jobsOf(campaignId).some((j) => j.quotaPaused)
  }

  /** Derives the quota pause of a campaign from the usage gate and from its trials' runs. */
  private reconcile(campaignId: string): void {
    const c = this.repos.arenaCampaigns.get(campaignId)
    if (!c || this.disposed) return
    if (c.state === 'running') {
      if (this.gateClosed(campaignId)) this.setCampaign(campaignId, { state: 'paused', pauseReason: 'quota' })
    } else if (c.state === 'paused' && c.pauseReason === 'quota') {
      if (!this.gateClosed(campaignId)) {
        this.setCampaign(campaignId, { state: 'running', pauseReason: null })
        this.schedule(campaignId)
      }
    }
  }

  private onUsageChange(): void {
    for (const c of this.repos.arenaCampaigns.listByState(['running', 'paused'])) this.reconcile(c.id)
  }

  /** Starts queued trials up to `maxConcurrentTrials`, lowest ordinal first. Synchronous: states flip before any await. */
  private schedule(campaignId: string): void {
    if (this.disposed) return
    if (this.closing.has(campaignId)) {
      this.maybeComplete(campaignId)
      return
    }
    const c = this.repos.arenaCampaigns.get(campaignId)
    if (!c || c.state !== 'running') return
    if (this.gateClosed(campaignId)) {
      this.reconcile(campaignId)
      return
    }
    if (this.sessionBudgetReached(c)) {
      this.exhaust(campaignId, `Budget: maxAgentSessions (${c.budgets.maxAgentSessions}) reached`)
      return
    }
    let active = this.jobsOf(campaignId).length
    if (active < c.budgets.maxConcurrentTrials) {
      const queued = this.repos.arenaTrials.listByCampaignStates(campaignId, ['queued'])
      for (const trial of queued) {
        if (active >= c.budgets.maxConcurrentTrials) break
        this.startJob(trial, 'provision')
        active++
      }
    }
    this.maybeComplete(campaignId)
  }

  private sessionBudgetReached(c: ArenaCampaign): boolean {
    const used = this.repos.arenaMetrics.listByCampaign(c.id).reduce((n, m) => n + m.sessions, 0)
    return used >= c.budgets.maxAgentSessions
  }

  private maybeComplete(campaignId: string): void {
    const c = this.repos.arenaCampaigns.get(campaignId)
    if (!c || (c.state !== 'running' && c.state !== 'paused')) return
    const open = this.repos.arenaTrials
      .countsByCampaign(campaignId)
      .some((r) => !isTerminalTrial(r.state) && r.n > 0)
    if (open || this.jobsOf(campaignId).length > 0) return
    this.closing.delete(campaignId)
    this.setCampaign(campaignId, { state: 'completed', pauseReason: null, completedAt: this.now() })
  }

  private startJob(trial: ArenaTrial, from: 'provision' | 'attach' | 'evaluate'): Job {
    const startedAt = this.now()
    if (from === 'provision') {
      this.repos.arenaTrials.update(trial.id, { state: 'provisioning', startedAt, detail: null })
      this.push(trial.campaignId)
    }
    const job: Job = {
      trialId: trial.id,
      campaignId: trial.campaignId,
      runId: trial.runId,
      stop: null,
      quotaPaused: false,
      clock: new Stopwatch(),
      timer: null,
      poke: null,
      promise: Promise.resolve(),
    }
    this.jobs.set(trial.id, job)
    if (trial.runId) this.jobsByRun.set(trial.runId, job)
    job.promise = this.runJob(job, from).finally(() => {
      if (job.timer) clearTimeout(job.timer)
      this.jobs.delete(job.trialId)
      if (job.runId) this.jobsByRun.delete(job.runId)
      this.onJobEnd(job.campaignId)
    })
    return job
  }

  private onJobEnd(campaignId: string): void {
    const c = this.repos.arenaCampaigns.get(campaignId)
    if (!c) return
    if (c.state === 'running' && !this.closing.has(campaignId) && this.sessionBudgetReached(c)) {
      this.exhaust(campaignId, `Budget: maxAgentSessions (${c.budgets.maxAgentSessions}) reached`)
    }
    this.reconcile(campaignId)
    this.schedule(campaignId)
    this.maybeComplete(campaignId)
  }

  private requestStop(job: Job, kind: StopKind, detail: string): void {
    if (job.stop) return
    job.stop = { kind, detail }
    if (job.runId) {
      Promise.resolve()
        .then(() => this.deps.host.cancelRun(job.runId!))
        .catch((e) => this.log(`cancelRun ${job.runId}: ${errorMessage(e)}`))
    }
    job.poke?.()
  }

  // ───────────────────────────── one trial ─────────────────────────────

  private trialDir(campaign: ArenaCampaign, trial: ArenaTrial): string {
    return join(this.deps.dataDir, 'arena', shortId(campaign.id), shortId(trial.id))
  }

  private setTrial(id: string, patch: Partial<Omit<ArenaTrial, 'id'>>): ArenaTrial {
    const next = this.repos.arenaTrials.update(id, patch)
    this.push(next.campaignId)
    return next
  }

  /** Never throws: a failing trial becomes a blocked trial with the reason, the campaign carries on. */
  private async runJob(job: Job, from: 'provision' | 'attach' | 'evaluate'): Promise<void> {
    let trial = this.repos.arenaTrials.require(job.trialId)
    try {
      const campaign = this.repos.arenaCampaigns.require(trial.campaignId)
      const caseRow = this.repos.arenaCases.require(trial.caseId)
      const version = this.repos.arenaCaseVersions.require(trial.caseVersionId)
      let end: RunEnd | null = null

      if (from === 'provision') {
        const started = await this.provisionAndStart(job, trial, campaign, caseRow, version)
        if (started.kind === 'ended') {
          this.finishWithoutEvaluation(job.trialId, started.state, started.detail)
          return
        }
        trial = started.trial
      }
      if (from === 'provision' || from === 'attach') {
        end = await this.waitForRunEnd(job, trial)
        if (end.kind === 'stopped' && end.stop !== 'timeout') {
          this.finishWithoutEvaluation(job.trialId, 'cancelled', end.detail)
          return
        }
      }
      await this.evaluateStage(job, campaign, caseRow, version, end)
    } catch (e) {
      this.log(`trial ${job.trialId} failed: ${errorMessage(e)}`)
      const current = this.repos.arenaTrials.get(job.trialId)
      if (current && !isTerminalTrial(current.state)) {
        this.finishWithoutEvaluation(job.trialId, job.stop && job.stop.kind !== 'timeout' ? 'cancelled' : 'blocked', `Trial error: ${errorMessage(e)}`)
      }
    }
  }

  private finishWithoutEvaluation(trialId: string, state: 'blocked' | 'cancelled', detail: string): void {
    this.setTrial(trialId, { state, detail, finishedAt: this.now() })
  }

  private async provisionAndStart(
    job: Job,
    trial: ArenaTrial,
    campaign: ArenaCampaign,
    caseRow: ArenaCase,
    version: ArenaCaseVersion,
  ): Promise<{ kind: 'started'; trial: ArenaTrial } | { kind: 'ended'; state: 'blocked' | 'cancelled'; detail: string }> {
    let provisioned: { repoPath: string; baselineCommit: string }
    try {
      provisioned = await this.provision({
        caseVersion: version,
        sourcePath: caseRow.sourcePath,
        trialDir: this.trialDir(campaign, trial),
        git: this.deps.git,
      })
    } catch (e) {
      return { kind: 'ended', state: 'blocked', detail: `Provisioning failed: ${errorMessage(e)}` }
    }
    trial = this.setTrial(trial.id, { repoPath: provisioned.repoPath, baselineCommit: provisioned.baselineCommit })
    if (job.stop) return { kind: 'ended', state: 'cancelled', detail: job.stop.detail }

    let run: Run
    try {
      const project = await this.deps.projects.open(provisioned.repoPath)
      trial = this.setTrial(trial.id, { projectId: project.id })
      const def = version.definition
      const cap = Math.min(campaign.budgets.maxAgentsPerTrial, def.budgets.maxAgentsPerTrial)
      run = await this.deps.host.createRun({
        projectId: project.id,
        mode: 'build',
        preset: campaign.modelPreset,
        prompt: `${def.taskPrompt}\n\nAcceptance criteria:\n${def.visibleAcceptance.map((a) => `- ${a}`).join('\n')}`,
        acceptanceCriteria: [...def.visibleAcceptance],
        strategy: trial.strategy,
        arenaTrialId: trial.id,
        overrides: {
          requirePlanApproval: false,
          maxParallelAgents: cap,
          maxTurnsPerAgent: def.budgets.maxTurnsPerAgent,
          maxDurationMinutes: def.budgets.maxWallClockMinutes,
          checks: def.checks,
          respectProjectClaudeConfig: false,
        },
      })
    } catch (e) {
      return { kind: 'ended', state: 'blocked', detail: `Could not start the run: ${errorMessage(e)}` }
    }
    job.runId = run.id
    this.jobsByRun.set(run.id, job)
    trial = this.setTrial(trial.id, {
      state: 'running',
      runId: run.id,
      policySnapshotId: this.deps.policy?.activeSnapshotId() ?? campaign.policySnapshotId,
    })
    return { kind: 'started', trial }
  }

  /** Waits for the trial's run to end. Events are the signal; a slow poll is the safety net. */
  private waitForRunEnd(job: Job, trial: ArenaTrial): Promise<RunEnd> {
    const def = this.repos.arenaCaseVersions.require(trial.caseVersionId).definition
    const limitMs = def.budgets.maxWallClockMinutes * this.minuteMs
    job.clock.start()
    const tick = (): void => {
      if (job.stop) return
      if (job.clock.elapsed() >= limitMs) {
        this.requestStop(job, 'timeout', `Trial exceeded the case wall-clock budget (${def.budgets.maxWallClockMinutes} min)`)
        return
      }
      job.timer = unref(setTimeout(tick, Math.max(5, Math.min(limitMs - job.clock.elapsed(), TIMER_TICK_MS))))
    }
    tick()

    return new Promise<RunEnd>((resolve) => {
      let done = false
      let recoveryResumed = false
      let poll: ReturnType<typeof setInterval> | null = null
      const finish = (end: RunEnd): void => {
        if (done) return
        done = true
        if (poll) clearInterval(poll)
        if (job.timer) clearTimeout(job.timer)
        job.poke = null
        job.clock.stop()
        resolve(end)
      }
      const setQuota = (paused: boolean): void => {
        if (job.quotaPaused === paused) return
        job.quotaPaused = paused
        if (paused) job.clock.stop()
        else job.clock.start()
        this.reconcile(job.campaignId)
      }
      const check = (): void => {
        if (done) return
        if (job.stop) return finish({ kind: 'stopped', stop: job.stop.kind, detail: job.stop.detail })
        const run = this.repos.runs.get(job.runId ?? '')
        if (!run) return finish({ kind: 'missing' })
        if (TERMINAL_RUN.includes(run.state)) return finish({ kind: run.state as 'completed' | 'failed' | 'cancelled' })
        if (run.state === 'awaiting_approval') {
          this.cancelQuietly(run.id)
          return finish({ kind: 'blocked', detail: 'The run is waiting for an approval no one can give in an Arena trial' })
        }
        if (run.state === 'paused') {
          if (run.pauseReason === 'quota') return setQuota(true)
          if (run.pauseReason === 'recovery') {
            if (!recoveryResumed) {
              recoveryResumed = true
              Promise.resolve()
                .then(() => this.deps.host.resumeRun(run.id))
                .catch((e) => {
                  this.log(`resumeRun ${run.id}: ${errorMessage(e)}`)
                  this.cancelQuietly(run.id)
                  finish({ kind: 'blocked', detail: `The run could not be resumed after a restart: ${errorMessage(e)}` })
                })
            }
            return
          }
          this.cancelQuietly(run.id)
          return finish({ kind: 'blocked', detail: `Run paused for intervention${run.error ? `: ${run.error}` : ''}` })
        }
        setQuota(false)
      }
      job.poke = check
      const pollMs = this.deps.pollMs ?? 2000
      if (pollMs > 0) poll = unref(setInterval(check, pollMs))
      check()
    })
  }

  private cancelQuietly(runId: string): void {
    Promise.resolve()
      .then(() => this.deps.host.cancelRun(runId))
      .catch((e) => this.log(`cancelRun ${runId}: ${errorMessage(e)}`))
  }

  private async waitForAgentsToStop(runId: string): Promise<boolean> {
    const deadline = Date.now() + (this.deps.agentSettleMs ?? 10_000)
    while (this.repos.agents.listActive(runId).length > 0) {
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, 50))
    }
    return true
  }

  private async evaluateStage(
    job: Job,
    campaign: ArenaCampaign,
    caseRow: ArenaCase,
    version: ArenaCaseVersion,
    end: RunEnd | null,
  ): Promise<void> {
    let trial = this.setTrial(job.trialId, { state: 'evaluating' })
    const run = trial.runId ? this.repos.runs.get(trial.runId) : null
    if (!run) {
      this.finishWithoutEvaluation(trial.id, 'blocked', 'The trial has no run to evaluate')
      return
    }
    if (!(await this.waitForAgentsToStop(run.id))) {
      this.finishWithoutEvaluation(trial.id, 'blocked', 'Agents of the run were still active; the evaluator never runs next to an agent')
      return
    }

    // End of the run, as the durable row says it (a recovered "evaluating" trial has no `end`).
    const runEnd: RunEnd['kind'] = end?.kind ?? (TERMINAL_RUN.includes(run.state) ? (run.state as 'completed') : 'missing')
    let resultCommit: string | null = trial.resultCommit
    if (runEnd === 'completed' && run.integrationBranch && trial.repoPath) {
      resultCommit = await this.deps.git.resolveCommit(trial.repoPath, run.integrationBranch).catch(() => null)
    }
    const models: Record<string, string> = {}
    for (const d of this.repos.routingDecisions.listByRun(run.id)) if (d.resolvedModel) models[d.role] = d.resolvedModel
    for (const a of this.repos.agents.listByRun(run.id)) if (a.model && !models[a.role]) models[a.role] = a.model
    const profile = this.repos.taskProfiles.getByRun(run.id)
    trial = this.setTrial(trial.id, { resultCommit, models, taskProfileId: profile?.id ?? trial.taskProfileId })

    // Metrics first (durable rows only), so a failing evaluator still leaves the raw numbers behind.
    const collected = collectTrialMetrics(this.repos, trial, run, { now: this.now() })
    this.repos.arenaMetrics.replaceForTrial(collected)

    const skippedReason =
      resultCommit !== null
        ? undefined
        : runEnd === 'completed'
          ? 'The run completed without an integration commit'
          : end?.kind === 'stopped'
            ? end.detail
            : end?.kind === 'blocked'
              ? end.detail
              : `The run ${run.state}${run.error ? `: ${run.error}` : ''}`
    let outcome
    try {
      outcome = await this.evaluate({
        repoPath: trial.repoPath ?? '',
        resultCommit,
        caseVersion: version,
        sourcePath: caseRow.sourcePath,
        trialDir: this.trialDir(campaign, trial),
        git: this.deps.git,
        skippedReason,
      })
    } catch (e) {
      this.finishWithoutEvaluation(trial.id, 'blocked', `Evaluation failed: ${errorMessage(e)}`)
      return
    }

    const metrics = this.repos.arenaMetrics.replaceForTrial({ ...collected, id: newId(), hiddenPassed: outcome.passed })
    const previous = this.repos.arenaEvaluations.latestForTrial(trial.id)
    const config = mergeScoring(DEFAULT_SCORING, version.definition.scoring)
    const peers = this.passingPeers(trial.campaignId, trial.caseVersionId, trial.id)
    const scored = scoreTrial(metrics, outcome.passed, peers, config)
    this.repos.transaction(() => {
      if (previous) this.repos.arenaEvaluations.delete(previous.id)
      this.repos.arenaEvaluations.insert({
        id: newId(),
        trialId: trial.id,
        kind: 'hidden',
        command: version.definition.hiddenEvaluation.command,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        output: outcome.output,
        passed: outcome.passed,
        skippedReason: outcome.skippedReason,
        evaluatorHash: version.evaluatorHash,
        scoreVersion: SCORE_VERSION,
        score: scored.score,
        scoreBreakdown: scored.breakdown,
        createdAt: this.now(),
      })
    })

    let state: TrialState
    let detail: string | null = null
    if (outcome.passed) state = 'passed'
    else if (runEnd === 'completed') {
      state = 'failed'
      detail = outcome.timedOut ? 'Hidden evaluation timed out' : `Hidden acceptance failed (exit ${outcome.exitCode ?? 'n/a'})`
    } else if (runEnd === 'failed') {
      state = 'failed'
      detail = `The run failed${run.error ? `: ${run.error}` : ''}`
    } else {
      state = 'blocked'
      detail = end?.kind === 'stopped' || end?.kind === 'blocked' ? end.detail : `The run ended ${run.state}`
    }
    this.setTrial(trial.id, { state, detail, finishedAt: this.now() })
    this.rescoreCase(trial.campaignId, trial.caseVersionId, version, config)
  }

  /** Metrics of the hidden-passed trials of a case in a campaign (reference for the relative score parts). */
  private passingPeers(campaignId: string, caseVersionId: string, exceptTrialId: string): ArenaTrialMetrics[] {
    const trials = this.repos.arenaTrials.listByCampaign(campaignId, { limit: 2000 }).filter((t) => t.caseVersionId === caseVersionId && t.id !== exceptTrialId)
    const metrics = this.repos.arenaMetrics.listByTrials(trials.map((t) => t.id))
    return metrics.filter((m) => m.hiddenPassed === true)
  }

  /** Relative parts depend on the peer set, so every evaluated trial of the case is rescored when one finishes. */
  private rescoreCase(campaignId: string, caseVersionId: string, version: ArenaCaseVersion, config = mergeScoring(DEFAULT_SCORING, version.definition.scoring)): void {
    const trials = this.repos.arenaTrials.listByCampaign(campaignId, { limit: 2000 }).filter((t) => t.caseVersionId === caseVersionId)
    const metrics = new Map(this.repos.arenaMetrics.listByTrials(trials.map((t) => t.id)).map((m) => [m.trialId, m]))
    const peers = [...metrics.values()].filter((m) => m.hiddenPassed === true)
    for (const t of trials) {
      const m = metrics.get(t.id)
      const e = this.repos.arenaEvaluations.latestForTrial(t.id)
      if (!m || !e) continue
      const s = scoreTrial(m, e.passed, peers, config)
      if (s.score !== e.score) this.repos.arenaEvaluations.update(e.id, { score: s.score, scoreBreakdown: s.breakdown })
    }
    this.push(campaignId)
  }

  // ───────────────────────────── recovery ─────────────────────────────

  /**
   * After a restart: a `running` campaign continues; a trial left `provisioning` goes back to the queue and is
   * re-provisioned from scratch in a clean directory; a `running` trial re-attaches to its run; an `evaluating`
   * trial is evaluated again (the evaluation is a pure function of the result commit). Trials of finished or
   * cancelled campaigns that were still open are cancelled.
   */
  recover(): void {
    const campaigns = this.repos.arenaCampaigns.listByState(['running', 'paused', 'completed', 'cancelled', 'failed'])
    for (const c of campaigns) {
      const live = c.state === 'running' || c.state === 'paused'
      const open = this.repos.arenaTrials.listByCampaignStates(c.id, ['queued', 'provisioning', 'running', 'evaluating'])
      if (!live) {
        for (const t of open) this.repos.arenaTrials.update(t.id, { state: 'cancelled', detail: 'Campaign ended before the trial finished', finishedAt: this.now() })
        continue
      }
      const budgetClosed = c.error?.startsWith('Budget:') === true
      if (budgetClosed) this.closing.add(c.id)
      if (c.state === 'running' && c.startedAt) this.clockOf(c.id).preload(Date.parse(this.now()) - Date.parse(c.startedAt))
      for (const t of open) {
        if (this.jobs.has(t.id)) continue
        if (t.state === 'queued') {
          if (budgetClosed) this.repos.arenaTrials.update(t.id, { state: 'cancelled', detail: c.error, finishedAt: this.now() })
        } else if (t.state === 'provisioning' || (t.state === 'running' && !t.runId)) {
          this.repos.arenaTrials.update(t.id, { state: 'queued', repoPath: null, baselineCommit: null, runId: null, startedAt: null, detail: null })
        } else if (t.state === 'running') {
          this.startJob(t, 'attach')
        } else {
          this.startJob(t, 'evaluate')
        }
      }
      this.syncClock(this.repos.arenaCampaigns.require(c.id))
      this.push(c.id)
      this.reconcile(c.id)
      this.schedule(c.id)
    }
  }

  /** Resolves when no trial is being worked on. */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.allSettled([...this.jobs.values()].map((j) => j.promise))
  }

  /** Stops timers and subscriptions. Runs and trials are left as they are (recover() picks them up). */
  dispose(): void {
    this.disposed = true
    for (const u of this.unsubscribes.splice(0)) u()
    for (const id of [...this.campaignTimers.keys()]) this.disarmCampaignTimer(id)
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer)
    }
  }
}
