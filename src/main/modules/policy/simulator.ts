import type { Complexity, Risk } from '@shared/domain'
import { DEFAULT_SETTINGS } from '@shared/settings'
import {
  DEFAULT_POLICY_CONFIG,
  type ConcreteStrategy,
  type ExplorationMode,
  type MissionOutcome,
  type PolicyCandidate,
  type PolicyDecision,
  type PolicySnapshot,
  type SpeculationPolicy,
  type StrategyStatistic,
  type TaskCategory,
  type TaskProfileFeatures,
  type UsageStatus,
} from '@shared/v3'
import { defaultStrategy } from './defaults'
import { decide } from './engine'
import { aggregateEvidence, proposeCandidates, type EvidenceTrial } from './learning'
import { applyPromotion } from './snapshots'
import { mulberry32 } from './stats'

/**
 * Deterministic policy simulator. A synthetic world gives every (context, strategy) a hidden true pass
 * rate and cost; the simulator generates Arena trials and mission outcomes from it and feeds them through
 * the real `aggregateEvidence`, `proposeCandidates`, `decide` and promotion logic. In memory, no database,
 * no clock: one seed reproduces a whole history.
 */

export interface SimTruth {
  /** Hidden probability that a run of this strategy passes. */
  passRate: number
  /** Hidden probability that a run crashes (a stability failure), on top of failing. */
  crashRate?: number
  sessions: number
  durationMs: number
}

export interface SimContext {
  contextKey: string
  /** Relative frequency of this kind of task among simulated missions. */
  weight?: number
  truth: Partial<Record<ConcreteStrategy, SimTruth>>
}

export interface SimWorld {
  contexts: SimContext[]
  /** Truth used for a strategy a context does not define. */
  fallback?: SimTruth
}

export interface SimOptions {
  seed: number
  steps: number
  world: SimWorld
  mode: ExplorationMode
  speculation?: SpeculationPolicy
  /** Promote every proposed candidate at each learning pass (the user's "yes" is simulated). */
  autoPromote?: boolean
  /** Learn every N steps. */
  learnEvery?: number
  /** Arena trials generated per step (controlled evidence), round-robin over contexts and strategies. */
  arenaPerStep?: number
  /** Real missions per step (observational evidence). */
  missionsPerStep?: number
  /** Days the clock moves per step. */
  stepDays?: number
  /** Availability by step; default always AVAILABLE. */
  usage?: (step: number) => { status: UsageStatus; recentLimit: boolean }
}

export interface SimStep {
  step: number
  day: number
  contextKey: string
  strategy: ConcreteStrategy
  defaultStrategy: ConcreteStrategy
  layer: PolicyDecision['layer']
  exploration: boolean
  seed: number | null
  snapshotVersion: number
  success: boolean
  decision: PolicyDecision
}

export interface SimEvent {
  step: number
  kind: 'learn' | 'promote' | 'rollback'
  detail: string
}

export interface SimTrace {
  steps: SimStep[]
  events: SimEvent[]
  snapshots: PolicySnapshot[]
  final: PolicySnapshot
  candidates: PolicyCandidate[]
  stats: StrategyStatistic[]
  trials: EvidenceTrial[]
  outcomes: MissionOutcome[]
}

const DAY_MS = 86_400_000
export const SIM_START = Date.UTC(2026, 0, 1)
const DEFAULT_TRUTH: SimTruth = { passRate: 0.5, sessions: 3, durationMs: 600_000 }

/** Features of a synthetic task for a context key. */
export function featuresForContext(contextKey: string): TaskProfileFeatures {
  const [category = 'feature', complexity = 'medium', risk = 'low'] = contextKey.split('|')
  const inf = <T>(value: T) => ({ value, basis: 'INFERRED' as const })
  const mea = <T>(value: T) => ({ value, basis: 'MEASURED' as const })
  return {
    category: inf(category as TaskCategory),
    complexity: inf(complexity as Complexity),
    risk: inf(risk as Risk),
    primaryLanguage: mea('TypeScript'),
    frameworks: mea([]),
    repoFileCount: mea(100),
    moduleCount: mea(5),
    testDensity: mea(null),
    fileScope: inf('few' as const),
    ambiguity: inf('medium' as const),
    securitySensitive: inf(category === 'security'),
    parallelizability: inf('medium' as const),
  }
}

export class PolicySimulator {
  readonly rng: () => number
  now = SIM_START
  readonly trials: EvidenceTrial[] = []
  readonly outcomes: MissionOutcome[] = []
  stats: StrategyStatistic[] = []
  readonly snapshots: PolicySnapshot[] = []
  readonly candidates: PolicyCandidate[] = []
  readonly events: SimEvent[] = []
  step = 0
  private head: PolicySnapshot
  private previous: PolicySnapshot | null = null
  private counter = 0
  private arenaCursor = 0

  constructor(
    readonly seed: number,
    readonly world: SimWorld,
    mode: ExplorationMode,
    speculation: SpeculationPolicy = 'OFF',
  ) {
    this.rng = mulberry32(seed)
    this.head = {
      id: 'snap-1',
      version: 1,
      createdAt: new Date(this.now).toISOString(),
      origin: 'default',
      parentId: null,
      preferences: [],
      config: { ...DEFAULT_POLICY_CONFIG, exploration: mode, speculation },
      routing: {},
      note: null,
    }
    this.snapshots.push(this.head)
  }

  get active(): PolicySnapshot {
    return this.head
  }

  private nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}-${this.counter}`
  }

  featuresOf(contextKey: string): TaskProfileFeatures {
    return featuresForContext(contextKey)
  }

  advanceDays(days: number): void {
    this.now += days * DAY_MS
  }

  truthOf(contextKey: string, strategy: ConcreteStrategy): SimTruth {
    return this.world.contexts.find((c) => c.contextKey === contextKey)?.truth[strategy] ?? this.world.fallback ?? DEFAULT_TRUTH
  }

  /** One controlled trial, appended to the evidence. */
  arenaTrial(contextKey: string, strategy: ConcreteStrategy, at: number = this.now): EvidenceTrial {
    const truth = this.truthOf(contextKey, strategy)
    const crashed = this.rng() < (truth.crashRate ?? 0)
    const passed = !crashed && this.rng() < truth.passRate
    const trial = syntheticTrial({
      id: this.nextId('trial'),
      contextKey,
      strategy,
      passed,
      crashed,
      sessions: truth.sessions,
      durationMs: truth.durationMs,
      at,
    })
    this.trials.push(trial)
    return trial
  }

  /** Ask the engine for a decision for a context. Nothing is recorded as evidence. */
  decideFor(
    contextKey: string,
    opts: { status?: UsageStatus; recentLimit?: boolean; forced?: ConcreteStrategy | null; seed?: number } = {},
  ): PolicyDecision {
    return decide({
      profile: { id: null, projectId: null, runId: null, contextKey, features: featuresForContext(contextKey) },
      snapshot: this.head,
      stats: this.stats,
      seed: opts.seed ?? Math.floor(this.rng() * 0x1_0000_0000),
      usageStatus: opts.status ?? 'AVAILABLE',
      recentLimit: opts.recentLimit ?? false,
      preset: 'balanced',
      settings: DEFAULT_SETTINGS,
      forced: opts.forced ?? null,
      id: this.nextId('decision'),
      now: this.now,
    })
  }

  /** A real mission: decide, run in the hidden world, record the observational outcome. */
  mission(contextKey: string, opts: { status?: UsageStatus; recentLimit?: boolean } = {}): { decision: PolicyDecision; success: boolean } {
    const decision = this.decideFor(contextKey, opts)
    const truth = this.truthOf(contextKey, decision.strategy)
    const crashed = this.rng() < (truth.crashRate ?? 0)
    const success = !crashed && this.rng() < truth.passRate
    this.outcomes.push(
      syntheticOutcome({
        id: this.nextId('mission'),
        contextKey,
        strategy: decision.strategy,
        success,
        crashed,
        sessions: truth.sessions,
        durationMs: truth.durationMs,
        at: this.now,
        snapshotId: this.head.id,
      }),
    )
    return { decision, success }
  }

  /** Recompute statistics and propose candidates (older proposals are superseded, identical ones kept). */
  learn(): { candidates: PolicyCandidate[]; notes: string[] } {
    this.stats = aggregateEvidence({
      trials: this.trials,
      outcomes: this.outcomes,
      config: this.head.config,
      now: this.now,
      currentModels: {},
    })
    const contexts = [...new Set(this.stats.map((s) => s.contextKey))].filter((k) => k !== '*|*|*')
    const { candidates, notes } = proposeCandidates({
      stats: this.stats,
      active: this.head,
      knownContexts: contexts,
      now: this.now,
      newId: () => this.nextId('cand'),
    })
    const proposed = this.candidates.filter((c) => c.status === 'proposed')
    const kept = new Set<string>()
    const fresh: PolicyCandidate[] = []
    for (const c of candidates) {
      const same = proposed.find(
        (e) =>
          e.contextKey === c.contextKey &&
          e.toStrategy === c.toStrategy &&
          e.fromStrategy === c.fromStrategy &&
          e.baseSnapshotId === c.baseSnapshotId &&
          e.arenaTrials === c.arenaTrials &&
          e.missions === c.missions,
      )
      if (same) kept.add(same.id)
      else {
        const full: PolicyCandidate = { ...c, shadow: null }
        this.candidates.push(full)
        kept.add(full.id)
        fresh.push(full)
      }
    }
    for (const e of proposed) if (!kept.has(e.id)) this.replaceCandidate(e.id, { status: 'superseded' })
    this.events.push({ step: this.step, kind: 'learn', detail: `${fresh.length} new candidate(s)` })
    return { candidates: this.candidates.filter((c) => c.status === 'proposed'), notes }
  }

  private replaceCandidate(id: string, patch: Partial<PolicyCandidate>): void {
    const i = this.candidates.findIndex((c) => c.id === id)
    if (i >= 0) this.candidates[i] = { ...this.candidates[i]!, ...patch, resolvedAt: new Date(this.now).toISOString() }
  }

  /** The user's explicit yes. The only way a preference enters a snapshot. */
  promote(candidateId: string): PolicySnapshot {
    const c = this.candidates.find((x) => x.id === candidateId)
    if (!c || c.status !== 'proposed') throw new Error('candidate is not proposed')
    const next = applyPromotion(this.head, c, {
      id: this.nextId('snap'),
      version: this.head.version + 1,
      now: new Date(this.now).toISOString(),
    })
    this.previous = this.head
    this.head = next
    this.snapshots.push(next)
    this.replaceCandidate(c.id, { status: 'promoted' })
    this.events.push({ step: this.step, kind: 'promote', detail: `${c.toStrategy} for ${c.contextKey}` })
    return next
  }

  /** One step back. Past outcomes and decisions are untouched. */
  rollback(): PolicySnapshot {
    if (!this.previous) throw new Error('nothing to roll back to')
    this.head = this.previous
    this.previous = null
    this.events.push({ step: this.step, kind: 'rollback', detail: `back to version ${this.head.version}` })
    return this.head
  }

  /** Round-robin arena trials over every (context, strategy) the world defines. */
  arenaRound(count: number): void {
    const cells: [string, ConcreteStrategy][] = []
    for (const c of this.world.contexts) {
      for (const s of Object.keys(c.truth) as ConcreteStrategy[]) cells.push([c.contextKey, s])
    }
    if (cells.length === 0) return
    for (let i = 0; i < count; i++) {
      const [ctx, strat] = cells[this.arenaCursor % cells.length]!
      this.arenaCursor += 1
      this.arenaTrial(ctx, strat)
    }
  }

  pickContext(): string {
    const total = this.world.contexts.reduce((a, c) => a + (c.weight ?? 1), 0)
    let r = this.rng() * total
    for (const c of this.world.contexts) {
      r -= c.weight ?? 1
      if (r < 0) return c.contextKey
    }
    return this.world.contexts[this.world.contexts.length - 1]!.contextKey
  }
}

export function simulate(opts: SimOptions): SimTrace {
  const sim = new PolicySimulator(opts.seed, opts.world, opts.mode, opts.speculation ?? 'OFF')
  const learnEvery = opts.learnEvery ?? 10
  const steps: SimStep[] = []
  for (let i = 1; i <= opts.steps; i++) {
    sim.step = i
    sim.advanceDays(opts.stepDays ?? 1)
    if (opts.arenaPerStep) sim.arenaRound(opts.arenaPerStep)
    for (let m = 0; m < (opts.missionsPerStep ?? 1); m++) {
      const contextKey = sim.pickContext()
      const usage = opts.usage?.(i) ?? { status: 'AVAILABLE' as const, recentLimit: false }
      const { decision, success } = sim.mission(contextKey, usage)
      steps.push({
        step: i,
        day: i * (opts.stepDays ?? 1),
        contextKey,
        strategy: decision.strategy,
        defaultStrategy: defaultStrategy(contextKey),
        layer: decision.layer,
        exploration: decision.exploration,
        seed: decision.seed,
        snapshotVersion: decision.policyVersion,
        success,
        decision,
      })
    }
    if (i % learnEvery === 0) {
      const { candidates } = sim.learn()
      if (opts.autoPromote) for (const c of candidates) sim.promote(c.id)
    }
  }
  return {
    steps,
    events: sim.events,
    snapshots: sim.snapshots,
    final: sim.active,
    candidates: sim.candidates,
    stats: sim.stats,
    trials: sim.trials,
    outcomes: sim.outcomes,
  }
}

// ───────────────────────────── synthetic evidence ─────────────────────────────

export function syntheticTrial(o: {
  id: string
  contextKey: string
  strategy: ConcreteStrategy
  passed: boolean
  crashed?: boolean
  sessions?: number
  durationMs?: number
  repairs?: number
  at: number
  models?: Record<string, string>
  inputTokens?: number | null
  outputTokens?: number | null
}): EvidenceTrial {
  const iso = new Date(o.at).toISOString()
  return {
    id: o.id,
    campaignId: 'sim-campaign',
    caseId: `case-${o.contextKey}`,
    caseVersionId: 'sim-case-version',
    strategy: o.strategy,
    repetition: 0,
    ordinal: 0,
    state: o.crashed ? 'blocked' : o.passed ? 'passed' : 'failed',
    projectId: null,
    runId: null,
    repoPath: null,
    baselineCommit: null,
    resultCommit: null,
    policySnapshotId: null,
    taskProfileId: null,
    models: o.models ?? {},
    detail: null,
    createdAt: iso,
    startedAt: iso,
    finishedAt: iso,
    contextKey: o.contextKey,
    metrics: {
      id: `m-${o.id}`,
      trialId: o.id,
      buildPassed: null,
      typecheckPassed: null,
      testsPassed: null,
      hiddenPassed: o.passed,
      acceptanceTotal: null,
      acceptancePassed: null,
      verifierPassed: null,
      criticalFindings: 0,
      highFindings: 0,
      mediumFindings: 0,
      repairs: o.repairs ?? 0,
      wallClockMs: o.durationMs ?? null,
      sessions: o.sessions ?? 1,
      turns: null,
      inputTokens: o.inputTokens ?? null,
      outputTokens: o.outputTokens ?? null,
      toolCalls: null,
      humanInterventions: 0,
      approvals: 0,
      manualRetries: 0,
      blockers: 0,
      crashedAgents: o.crashed ? 1 : 0,
      recoveredSessions: 0,
      schedulerFailures: 0,
      unfinishedTasks: 0,
      quotaPauses: 0,
      quotaWaitMs: 0,
      autoResumeSuccesses: 0,
      throttleEvents: 0,
      createdAt: iso,
    },
  }
}

export function syntheticOutcome(o: {
  id: string
  contextKey: string
  strategy: ConcreteStrategy
  success: boolean
  crashed?: boolean
  sessions?: number
  durationMs?: number
  repairs?: number
  at: number
  snapshotId?: string | null
  models?: Record<string, string>
  isArena?: boolean
  terminal?: MissionOutcome['terminal']
}): MissionOutcome {
  return {
    id: o.id,
    runId: `run-${o.id}`,
    projectId: 'sim-project',
    taskProfileId: null,
    contextKey: o.contextKey,
    strategy: o.strategy,
    requestedStrategy: 'ADAPTIVE',
    planningMode: 'single',
    reviewMode: 'auto',
    policyDecisionId: null,
    policySnapshotId: o.snapshotId ?? null,
    models: o.models ?? {},
    agents: 1,
    sessions: o.sessions ?? 1,
    tasks: 1,
    tasksCompleted: o.success ? 1 : 0,
    repairs: o.repairs ?? 0,
    reviews: 0,
    reviewRejections: 0,
    verificationPassed: null,
    elapsedMs: o.durationMs ?? null,
    inputTokens: null,
    outputTokens: null,
    quotaPauses: 0,
    quotaWaitMs: 0,
    humanInterventions: 0,
    terminal: o.terminal ?? (o.crashed ? 'blocked' : o.success ? 'completed' : 'failed'),
    success: o.success,
    isArena: o.isArena ?? false,
    nexusVersion: 'sim',
    createdAt: new Date(o.at).toISOString(),
  }
}
