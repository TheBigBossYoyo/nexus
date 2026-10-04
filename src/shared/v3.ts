import { z } from 'zod'
import { ComplexitySchema, RiskSchema, type Complexity, type Risk, type RunState } from './domain'

/**
 * v0.3 contracts: usage intelligence, quota recovery, strategies, speculative execution, Arena, adaptive
 * policy. Pure types and schemas; no behaviour beyond small total helpers.
 */

// ───────────────────────────── provenance ─────────────────────────────

/** How NEXUS knows a value. A percentage or a reset time may be shown only with EXACT. */
export const CONFIDENCES = ['EXACT', 'OBSERVED', 'ESTIMATED', 'UNKNOWN'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export const USAGE_SOURCES = ['RUNTIME', 'SDK_EVENT', 'ERROR_METADATA', 'LOCAL_AGGREGATION', 'UNKNOWN'] as const
export type UsageSource = (typeof USAGE_SOURCES)[number]

/** A value with its provenance. `value === null` always comes with confidence UNKNOWN. */
export interface Measured<T> {
  value: T | null
  source: UsageSource
  confidence: Confidence
}

export const unknownValue = <T>(): Measured<T> => ({ value: null, source: 'UNKNOWN', confidence: 'UNKNOWN' })
export const measured = <T>(value: T | null | undefined, source: UsageSource, confidence: Confidence): Measured<T> =>
  value === null || value === undefined ? unknownValue<T>() : { value, source, confidence }

// ───────────────────────────── usage ─────────────────────────────

/** What the runtime last told NEXUS about the account. */
export const AVAILABILITIES = [
  'AVAILABLE',
  'THROTTLED',
  'QUOTA_EXHAUSTED',
  'AUTH_REQUIRED',
  'RUNTIME_UNAVAILABLE',
  'UNKNOWN',
] as const
export type Availability = (typeof AVAILABILITIES)[number]

/** The deterministic status machine of the usage service (usage/machine.ts). */
export const USAGE_STATUSES = [
  'AVAILABLE',
  'LIMIT_APPROACHING',
  'THROTTLED',
  'QUOTA_PAUSED',
  'WAITING_FOR_RESET',
  'PROBING',
  'AUTH_REQUIRED',
  'RUNTIME_UNAVAILABLE',
] as const
export type UsageStatus = (typeof USAGE_STATUSES)[number]

/** Statuses in which no new Claude session may be started. */
export const DISPATCH_BLOCKED_STATUSES: readonly UsageStatus[] = [
  'QUOTA_PAUSED',
  'WAITING_FOR_RESET',
  'PROBING',
  'AUTH_REQUIRED',
  'RUNTIME_UNAVAILABLE',
]

export const USAGE_EVENT_TYPES = [
  'session', // one agent session ended: tokens, turns, duration
  'limit_warning', // runtime status allowed_warning
  'limit_allowed', // runtime status allowed (carries utilization/reset when the runtime sent them)
  'limit_rejected', // runtime status rejected, or a usage-limit error
  'throttle', // transient overload / server error
  'auth', // authentication required
  'runtime_error', // runtime unavailable
  'probe', // an availability probe and its result
  'usage_report', // the runtime's no-prompt usage report
] as const
export type UsageEventType = (typeof USAGE_EVENT_TYPES)[number]

/** One persisted observation. Token fields are what this NEXUS session reported, never an account total. */
export interface UsageEvent {
  id: string
  createdAt: string
  eventType: UsageEventType
  projectId: string | null
  runId: string | null
  taskId: string | null
  agentId: string | null
  sdkSessionId: string | null
  role: string | null
  model: string | null
  strategy: Strategy | null
  arenaCampaignId: string | null
  /** Local calendar day (YYYY-MM-DD) of createdAt, stored so daily aggregation is an indexed GROUP BY. */
  day: string
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  turns: number | null
  durationMs: number | null
  /** The runtime's own cost figure when it reported one. Not shown as a bill for subscription accounts. */
  costUsd: number | null
  availability: Availability
  /** Runtime window type (five_hour, seven_day, ...), verbatim. */
  limitType: string | null
  /** Runtime utilization figure, verbatim (unit as the runtime sent it; see `utilizationUnit`). */
  utilization: number | null
  /** 'percent' when the runtime documents 0-100, 'raw' when the unit is undocumented. */
  utilizationUnit: 'percent' | 'raw' | null
  /** ISO time the runtime gave for the window reset. */
  resetAt: string | null
  retryAfterMs: number | null
  source: UsageSource
  confidence: Confidence
  /** The runtime's own classification text (status, error kind), for audit. Never credentials. */
  rawClassification: string | null
}

/** A plan window as last reported by the runtime (from a rate-limit event or the usage report). */
export interface UsageWindow {
  id: string
  /** five_hour, seven_day, seven_day_opus, ... */
  limitType: string
  status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown'
  /** 0-100. Non-null only when the runtime supplied a documented percentage. */
  utilizationPercent: number | null
  resetAt: string | null
  source: UsageSource
  confidence: Confidence
  observedAt: string
  updatedAt: string
}

export type QuotaPauseState = 'waiting' | 'probing' | 'resumed' | 'ended' | 'cancelled'
export const LIVE_QUOTA_PAUSE_STATES: readonly QuotaPauseState[] = ['waiting', 'probing']

/** The durable record of one quota wait. `runId === null` is the global (application-wide) wait. */
export interface QuotaPause {
  id: string
  runId: string | null
  /** 'global' rows gate all dispatch; 'run' rows track one paused run; 'overnight' is owned by the supervisor. */
  scope: 'global' | 'run' | 'overnight'
  state: QuotaPauseState
  pausedAt: string
  limitType: string | null
  /** ISO reset time when the runtime gave one. */
  resetAt: string | null
  resetConfidence: Confidence
  /** When NEXUS will next probe or resume. */
  nextCheckAt: string | null
  probes: number
  checkpointId: string | null
  /** Run state to restore, as stored by the pause (informational; the run row is authoritative). */
  resumeState: RunState | null
  endedAt: string | null
  /** Why the wait ended without a resume (deadline, user, policy, auth). */
  endReason: string | null
  createdAt: string
  updatedAt: string
}

export interface QuotaResume {
  id: string
  pauseId: string
  runId: string | null
  attemptedAt: string
  /** probe = availability check; resume = a run was resumed. */
  kind: 'probe' | 'resume'
  result: 'available' | 'still_limited' | 'resumed' | 'failed' | 'skipped'
  /** How the probe was made: the runtime's usage report, or one minimal session. */
  method: 'usage_report' | 'minimal_session' | 'none'
  detail: string | null
  waitedMs: number | null
  createdAt: string
}

/** Observed totals. Every figure is OBSERVED/LOCAL_AGGREGATION by construction. */
export interface UsageTotals {
  sessions: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  durationMs: number
  limitEvents: number
}

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  sessions: 0,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  durationMs: 0,
  limitEvents: 0,
}

export const USAGE_GROUPINGS = ['agent', 'task', 'run', 'day', 'model', 'strategy', 'campaign', 'role'] as const
export type UsageGrouping = (typeof USAGE_GROUPINGS)[number]

export interface UsageBreakdownRow extends UsageTotals {
  key: string
  label: string
}

/** The read model behind the header indicator, the popover and the dashboard's status section. */
export interface UsageOverview {
  capturedAt: string
  provider: 'claude'
  /** subscription | api_key | third_party | unknown, from the runtime's account info. */
  accountMode: Measured<string>
  /** e.g. "max", as the runtime reports it. */
  subscriptionType: Measured<string>
  status: UsageStatus
  availability: Availability
  /** Observed since NEXUS started. */
  session: UsageTotals
  /** Plan windows the runtime reported. Empty when it reported none. */
  windows: UsageWindow[]
  /** Never a NEXUS estimate: EXACT from a runtime percentage, else UNKNOWN. */
  subscriptionUtilizationPercent: Measured<number>
  nextResetAt: Measured<string>
  retryAfterMs: Measured<number>
  /** The last limit_rejected event, if any. */
  lastLimitAt: string | null
  autoResume: {
    enabled: boolean
    /** The open global wait, if any. */
    pause: QuotaPause | null
    /** Planned next probe/resume. ESTIMATED when the reset time is unknown. */
    nextCheckAt: Measured<string>
    pausedRuns: number
  }
  /** True when the runtime's no-prompt usage report answered at least once in this session. */
  usageReportSupported: boolean | null
}

export const UsageSettingsSchema = z.object({
  autoResume: z.boolean(),
  /** Seconds after a known reset before the resume probe. */
  resumeDelaySeconds: z.number().int().min(15).max(3600),
  /** First interval of the unknown-reset probe schedule; it doubles up to the maximum. */
  unknownResetProbeMinutes: z.number().int().min(5).max(240),
  unknownResetProbeMaxMinutes: z.number().int().min(5).max(720),
  /** 0 = no limit of its own (an Overnight run is still bounded by its deadline). */
  maxQuotaWaitMinutes: z.number().int().min(0).max(10080),
  pauseAllOnGlobalLimit: z.boolean(),
  allowLocalTasksWhileWaiting: z.boolean(),
  notifyOnResume: z.boolean(),
  overnightWaitForReset: z.boolean(),
  /** Ask the runtime for its (experimental) usage report. Off: probes use one minimal session. */
  useRuntimeUsageReport: z.boolean(),
})
export type UsageSettings = z.infer<typeof UsageSettingsSchema>

export const DEFAULT_USAGE_SETTINGS: UsageSettings = {
  autoResume: true,
  resumeDelaySeconds: 60,
  unknownResetProbeMinutes: 5,
  unknownResetProbeMaxMinutes: 30,
  maxQuotaWaitMinutes: 0,
  pauseAllOnGlobalLimit: true,
  allowLocalTasksWhileWaiting: true,
  notifyOnResume: true,
  overnightWaitForReset: true,
  useRuntimeUsageReport: true,
}

// ───────────────────────────── strategies ─────────────────────────────

export const STRATEGIES = ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS', 'SPECULATIVE', 'ADAPTIVE'] as const
export const StrategySchema = z.enum(STRATEGIES)
export type Strategy = z.infer<typeof StrategySchema>

/** Strategies that can actually execute (ADAPTIVE resolves to one of these). */
export const CONCRETE_STRATEGIES = ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS', 'SPECULATIVE'] as const
export const ConcreteStrategySchema = z.enum(CONCRETE_STRATEGIES)
export type ConcreteStrategy = z.infer<typeof ConcreteStrategySchema>

export const SPECULATION_POLICIES = ['OFF', 'AUTO', 'ALWAYS_FOR_HIGH_RISK'] as const
export const SpeculationPolicySchema = z.enum(SPECULATION_POLICIES)
export type SpeculationPolicy = z.infer<typeof SpeculationPolicySchema>

export const DEFAULT_SPECULATIVE_CANDIDATES = 2
export const MAX_SPECULATIVE_CANDIDATES = 3

/** Stored in `runs.config.strategy` (absent on runs created before 0.3). */
export interface RunStrategyInfo {
  /** What the user or the Arena asked for. */
  requested: Strategy
  /** What runs. Equal to `requested` unless it was ADAPTIVE. */
  resolved: ConcreteStrategy
  speculativeCandidates: number
  policyDecisionId: string | null
  policySnapshotId: string | null
  taskProfileId: string | null
  arenaTrialId: string | null
}

// ───────────────────────────── speculative execution ─────────────────────────────

export interface SpeculativeRun {
  id: string
  runId: string
  taskId: string
  baseCommit: string
  candidateCount: number
  state: 'running' | 'decided' | 'failed' | 'cancelled'
  winnerCandidateId: string | null
  createdAt: string
  finishedAt: string | null
}

/** Objective evidence about one candidate. Null = not measured. */
export interface CandidateEvidence {
  /** The implementing session ended with a usable result. */
  implemented: boolean
  checksPassed: boolean | null
  checksFailedCount: number | null
  /** Visible acceptance commands (never the Arena's hidden evaluator). */
  acceptancePassed: boolean | null
  criticalFindings: number | null
  highFindings: number | null
  filesChanged: number | null
  linesChanged: number | null
  durationMs: number | null
  inputTokens: number | null
  outputTokens: number | null
}

export interface CandidateResult {
  id: string
  speculativeRunId: string
  runId: string
  taskId: string
  /** a, b, c */
  label: string
  agentId: string | null
  sdkSessionId: string | null
  branch: string
  worktreePath: string
  headCommit: string | null
  evidence: CandidateEvidence
  /** Kept for the losers after their worktree is removed (capped). */
  diffPatch: string | null
  rank: number | null
  outcome: 'pending' | 'winner' | 'rejected' | 'failed'
  cleanedAt: string | null
  createdAt: string
}

export interface TournamentComparison {
  /** Which rule separated the two candidates, e.g. "checks passed". */
  criterion: string
  better: string
  worse: string
  detail: string
}

export interface TournamentDecision {
  id: string
  speculativeRunId: string
  runId: string
  taskId: string
  winnerLabel: string | null
  /** Labels, best first. */
  ranking: string[]
  comparisons: TournamentComparison[]
  /** decisive: separated by a correctness rule; marginal: only by size/label; none: no candidate implemented. */
  confidence: 'decisive' | 'marginal' | 'none'
  reason: string
  createdAt: string
}

// ───────────────────────────── task profile ─────────────────────────────

export const TASK_CATEGORIES = [
  'bugfix',
  'feature',
  'refactor',
  'migration',
  'performance',
  'security',
  'testing',
  'ui',
  'infrastructure',
  'architecture',
] as const
export const TaskCategorySchema = z.enum(TASK_CATEGORIES)
export type TaskCategory = z.infer<typeof TaskCategorySchema>

export const FEATURE_BASES = ['MEASURED', 'INFERRED', 'USER_SPECIFIED'] as const
export type FeatureBasis = (typeof FEATURE_BASES)[number]

export interface Feature<T> {
  value: T
  basis: FeatureBasis
}

export type Level = 'low' | 'medium' | 'high'

export interface TaskProfileFeatures {
  category: Feature<TaskCategory>
  complexity: Feature<Complexity>
  risk: Feature<Risk>
  primaryLanguage: Feature<string | null>
  frameworks: Feature<string[]>
  repoFileCount: Feature<number | null>
  moduleCount: Feature<number | null>
  /** Test files per 100 source files, when measured. */
  testDensity: Feature<number | null>
  /** Estimated number of files the task touches. */
  fileScope: Feature<'single' | 'few' | 'many'>
  ambiguity: Feature<Level>
  securitySensitive: Feature<boolean>
  parallelizability: Feature<Level>
}

export interface TaskProfile {
  id: string
  projectId: string | null
  runId: string | null
  arenaTrialId: string | null
  /** `category|complexity|risk`, the policy context. */
  contextKey: string
  features: TaskProfileFeatures
  profilerVersion: string
  createdAt: string
}

export const contextKeyOf = (category: TaskCategory, complexity: Complexity, risk: Risk): string =>
  `${category}|${complexity}|${risk}`

/** Fallback chain for a context: exact, category only, global. */
export function contextFallbacks(contextKey: string): string[] {
  const [category] = contextKey.split('|')
  return [contextKey, `${category}|*|*`, '*|*|*']
}

// ───────────────────────────── evidence and statistics ─────────────────────────────

export const EVIDENCE_LABELS = ['INSUFFICIENT', 'WEAK', 'MODERATE', 'STRONG'] as const
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number]

export type EvidenceKind = 'arena' | 'mission'

export interface Interval {
  low: number
  high: number
}

/** Aggregated evidence for one (context, strategy, kind). Raw counts are kept next to the weighted ones. */
export interface StrategyStatistic {
  id: string
  contextKey: string
  strategy: ConcreteStrategy
  kind: EvidenceKind
  /** Raw number of observations. */
  n: number
  successes: number
  /** Recency- and model-weighted counts used by the policy. */
  effectiveN: number
  effectiveSuccesses: number
  passRate: number | null
  /** Wilson 95% interval on the raw counts. Null below 1 observation. */
  passInterval: Interval | null
  medianDurationMs: number | null
  meanDurationMs: number | null
  meanSessions: number | null
  meanObservedTokens: number | null
  meanRepairs: number | null
  /** Histogram of repair cycles: index = cycles (last bucket = that many or more). */
  repairDistribution: number[]
  stabilityFailures: number
  label: EvidenceLabel
  newestAt: string | null
  oldestAt: string | null
  computedAt: string
}

// ───────────────────────────── policy ─────────────────────────────

export const EXPLORATION_MODES = ['off', 'conservative', 'balanced', 'research'] as const
export const ExplorationModeSchema = z.enum(EXPLORATION_MODES)
export type ExplorationMode = z.infer<typeof ExplorationModeSchema>

export const EXPLORATION_RATES: Record<ExplorationMode, number> = {
  off: 0,
  conservative: 0.05,
  balanced: 0.15,
  research: 0.4,
}

export interface StrategyPreference {
  contextKey: string
  strategy: ConcreteStrategy
  /** The strategy the default policy gives for this context (what the preference replaced). */
  replaces: ConcreteStrategy
  reason: string
  evidence: { arenaTrials: number; missions: number; label: EvidenceLabel }
  candidateId: string | null
}

export interface PolicyConfig {
  exploration: ExplorationMode
  speculation: SpeculationPolicy
  /** Evidence older than this many days is ignored entirely. */
  evidenceWindowDays: number
  recencyHalfLifeDays: number
  /** Weight of a real-mission outcome relative to an Arena trial (observational vs controlled). */
  missionWeight: number
  /** Weight multiplier for evidence recorded with a different resolved model than the current one. */
  modelDriftWeight: number
  scoringVersion: string
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  exploration: 'conservative',
  speculation: 'OFF',
  evidenceWindowDays: 365,
  recencyHalfLifeDays: 90,
  missionWeight: 0.5,
  modelDriftWeight: 0.5,
  scoringVersion: 'score-v1',
}

/** Immutable once written. "Active" is a pointer in settings, never a mutation of a snapshot. */
export interface PolicySnapshot {
  id: string
  version: number
  createdAt: string
  /** default: the built-in policy; promotion: a candidate was promoted; config: the user changed settings. */
  origin: 'default' | 'promotion' | 'config'
  parentId: string | null
  preferences: StrategyPreference[]
  config: PolicyConfig
  /** Tier → model alias at the time, for reproducibility. */
  routing: Record<string, string>
  note: string | null
}

export interface PolicyPointer {
  activeId: string
  previousId: string | null
  /** When set, new decisions use this snapshot regardless of promotions. */
  pinnedId: string | null
}

export interface EvidenceSummaryRow {
  strategy: ConcreteStrategy
  arenaN: number
  arenaSuccesses: number
  missionN: number
  missionSuccesses: number
  effectiveN: number
  passRate: number | null
  passInterval: Interval | null
  meanSessions: number | null
  meanObservedTokens: number | null
  medianDurationMs: number | null
  label: EvidenceLabel
  suppressed: boolean
}

export type DecisionLayer = 'default' | 'evidence' | 'exploration' | 'user'

export interface PolicyDecision {
  id: string
  runId: string | null
  projectId: string | null
  taskProfileId: string | null
  snapshotId: string
  policyVersion: number
  contextKey: string
  /** The context the evidence actually came from (may be a fallback). */
  evidenceContextKey: string | null
  strategy: ConcreteStrategy
  planningMode: 'single' | 'consensus' | 'none'
  workerCount: number
  reviewDepth: 'standard' | 'dual' | 'auto'
  speculativeCandidates: number
  /** Role → tier at decision time. */
  modelPolicies: Record<string, string>
  layer: DecisionLayer
  exploration: boolean
  /** Seed of the exploration draw (null when exploration is off for this decision). */
  seed: number | null
  reason: string
  evidenceSummary: EvidenceSummaryRow[]
  /** Adjustments made for runtime availability, in words. */
  resourceNotes: string[]
  usageStatus: UsageStatus
  createdAt: string
}

export interface PolicyCandidate {
  id: string
  contextKey: string
  fromStrategy: ConcreteStrategy
  toStrategy: ConcreteStrategy
  arenaTrials: number
  missions: number
  label: EvidenceLabel
  /** What the evidence showed, in measured terms. */
  expected: string[]
  reason: string
  evidence: EvidenceSummaryRow[]
  /** Result of replaying stored task profiles (a sanity check, not an effect estimate). */
  shadow: ShadowEvaluation | null
  status: 'proposed' | 'promoted' | 'rejected' | 'superseded'
  baseSnapshotId: string
  createdAt: string
  resolvedAt: string | null
}

export interface ShadowEvaluation {
  profilesReplayed: number
  decisionsChanged: number
  /** Changed decisions where the historical outcome of the newly chosen strategy is known. */
  changedWithKnownOutcome: number
  note: string
}

export interface PolicyPromotion {
  id: string
  /** promote | rollback | pin | unpin */
  action: 'promote' | 'reject' | 'rollback' | 'pin' | 'unpin' | 'config'
  candidateId: string | null
  fromSnapshotId: string | null
  toSnapshotId: string
  by: 'user' | 'system'
  note: string | null
  createdAt: string
}

export type MissionTerminal = 'completed' | 'failed' | 'cancelled' | 'blocked'

/** Observational evidence from a real run. Never treated as a controlled experiment. */
export interface MissionOutcome {
  id: string
  runId: string
  projectId: string
  taskProfileId: string | null
  contextKey: string
  strategy: ConcreteStrategy
  requestedStrategy: Strategy
  planningMode: 'single' | 'consensus' | 'none'
  reviewMode: 'standard' | 'dual' | 'auto'
  policyDecisionId: string | null
  policySnapshotId: string | null
  /** Role → resolved model actually used. */
  models: Record<string, string>
  agents: number
  sessions: number
  tasks: number
  tasksCompleted: number
  repairs: number
  reviews: number
  reviewRejections: number
  verificationPassed: boolean | null
  elapsedMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  quotaPauses: number
  quotaWaitMs: number
  humanInterventions: number
  terminal: MissionTerminal
  /** completed with mission verification passed. */
  success: boolean
  /** Arena-run outcomes are excluded from mission evidence; this marks them. */
  isArena: boolean
  nexusVersion: string
  createdAt: string
}

// ───────────────────────────── arena ─────────────────────────────

export const SCORE_VERSION = 'score-v1'

export interface ScoringConfig {
  /** Relative band inside which time or usage differences are ties. */
  band: number
  /** Points for a trial that passed acceptance, before the quality/efficiency parts. */
  passBase: number
  weights: { findings: number; verification: number; repairs: number; time: number; usage: number }
}

export const DEFAULT_SCORING: ScoringConfig = {
  band: 0.2,
  passBase: 60,
  weights: { findings: 15, verification: 10, repairs: 5, time: 5, usage: 5 },
}

export const ArenaBudgetsSchema = z.object({
  maxWallClockMinutes: z.number().int().min(1).max(1440),
  maxAgentSessions: z.number().int().min(1).max(500),
  maxAgentsPerTrial: z.number().int().min(1).max(16),
  maxTurnsPerAgent: z.number().int().min(5).max(400),
})
export type ArenaBudgets = z.infer<typeof ArenaBudgetsSchema>

const CaseId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'case id must be lowercase kebab-case')

/** `case.json`. Commands are command lines run without a shell. */
export const ArenaCaseDefinitionSchema = z
  .object({
    id: CaseId,
    version: z.number().int().min(1),
    name: z.string().min(1).max(120),
    description: z.string().min(1),
    category: TaskCategorySchema,
    complexity: ComplexitySchema,
    risk: RiskSchema,
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    taskPrompt: z.string().min(1),
    /** Criteria the agents are given. */
    visibleAcceptance: z.array(z.string().min(1)).min(1),
    /** Check commands the agents and NEXUS run in the visible repository. */
    checks: z.object({
      build: z.string().nullable(),
      test: z.string().nullable(),
      lint: z.string().nullable(),
      typecheck: z.string().nullable(),
    }),
    /** Commands run once when the trial repository is provisioned (before the baseline commit). */
    setup: z.array(z.string()),
    /** Hidden evaluation, run by NEXUS only, in a directory no agent ever saw. */
    hiddenEvaluation: z.object({
      command: z.string().min(1),
      timeoutSeconds: z.number().int().min(5).max(3600),
    }),
    budgets: ArenaBudgetsSchema,
    allowedStrategies: z.array(ConcreteStrategySchema).min(1),
    scoring: z
      .object({
        band: z.number().min(0.01).max(1).optional(),
        weights: z
          .object({
            findings: z.number().min(0).max(40),
            verification: z.number().min(0).max(40),
            repairs: z.number().min(0).max(40),
            time: z.number().min(0).max(40),
            usage: z.number().min(0).max(40),
          })
          .optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict()
export type ArenaCaseDefinition = z.infer<typeof ArenaCaseDefinitionSchema>

export interface ArenaCase {
  id: string
  name: string
  /** builtin: shipped with NEXUS; imported: a user-supplied case directory; repository: a user repository snapshot. */
  origin: 'builtin' | 'imported' | 'repository'
  category: TaskCategory
  complexity: Complexity
  risk: Risk
  latestVersion: number
  /** Directory the case was loaded from (never shown to agents). */
  sourcePath: string
  createdAt: string
  updatedAt: string
}

export interface ArenaCaseVersion {
  id: string
  caseId: string
  version: number
  definition: ArenaCaseDefinition
  /** SHA-256 over the evaluator directory and the evaluation command. */
  evaluatorHash: string
  fixtureHash: string
  /** Imported cases need one confirmation of the evaluator commands before first execution. */
  trusted: boolean
  createdAt: string
}

export const ARENA_BUDGET_PRESETS = ['eco', 'balanced', 'research'] as const
export const ArenaBudgetPresetSchema = z.enum(ARENA_BUDGET_PRESETS)
export type ArenaBudgetPreset = z.infer<typeof ArenaBudgetPresetSchema>

export interface ArenaCampaignBudgets {
  preset: ArenaBudgetPreset
  maxWallClockMinutes: number
  maxTrials: number
  maxConcurrentTrials: number
  maxAgentSessions: number
  maxAgentsPerTrial: number
}

export const ARENA_BUDGET_DEFAULTS: Record<ArenaBudgetPreset, Omit<ArenaCampaignBudgets, 'preset'>> = {
  eco: { maxWallClockMinutes: 120, maxTrials: 12, maxConcurrentTrials: 1, maxAgentSessions: 120, maxAgentsPerTrial: 2 },
  balanced: { maxWallClockMinutes: 360, maxTrials: 40, maxConcurrentTrials: 1, maxAgentSessions: 400, maxAgentsPerTrial: 4 },
  research: { maxWallClockMinutes: 720, maxTrials: 120, maxConcurrentTrials: 2, maxAgentSessions: 1500, maxAgentsPerTrial: 6 },
}

export const CAMPAIGN_STATES = ['draft', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const
export type CampaignState = (typeof CAMPAIGN_STATES)[number]

export interface ArenaCampaign {
  id: string
  name: string
  state: CampaignState
  /** user | quota | budget | restart, when paused. */
  pauseReason: string | null
  caseVersionIds: string[]
  strategies: ConcreteStrategy[]
  repetitions: number
  /** Preset used for every trial, so the model policy is the same across strategies. */
  modelPreset: 'eco' | 'balanced' | 'maximum'
  budgets: ArenaCampaignBudgets
  /** Set when the campaign runs under the overnight supervisor. */
  overnight: boolean
  policySnapshotId: string | null
  nexusVersion: string
  environment: ArenaEnvironment
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface ArenaEnvironment {
  platform: string
  osRelease: string
  nodeVersion: string
  sdkVersion: string | null
  gitVersion: string | null
  /** Tier → configured model alias when the campaign was created. */
  modelTiers: Record<string, string>
}

export const TRIAL_STATES = ['queued', 'provisioning', 'running', 'evaluating', 'passed', 'failed', 'blocked', 'cancelled'] as const
export type TrialState = (typeof TRIAL_STATES)[number]

export const TERMINAL_TRIAL_STATES: readonly TrialState[] = ['passed', 'failed', 'blocked', 'cancelled']

export interface ArenaTrial {
  id: string
  campaignId: string
  caseId: string
  caseVersionId: string
  strategy: ConcreteStrategy
  repetition: number
  /** Position in the campaign queue; execution order is deterministic. */
  ordinal: number
  state: TrialState
  /** The hidden project and run created for the trial. */
  projectId: string | null
  runId: string | null
  repoPath: string | null
  baselineCommit: string | null
  resultCommit: string | null
  policySnapshotId: string | null
  taskProfileId: string | null
  /** Role → resolved model actually used. */
  models: Record<string, string>
  /** Why a trial is blocked or failed before evaluation (budget, timeout, run failed, ...). */
  detail: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** Raw metrics. Null = not measured; never replaced by the composite score. */
export interface ArenaTrialMetrics {
  id: string
  trialId: string
  // correctness
  buildPassed: boolean | null
  typecheckPassed: boolean | null
  testsPassed: boolean | null
  hiddenPassed: boolean | null
  acceptanceTotal: number | null
  acceptancePassed: number | null
  verifierPassed: boolean | null
  // quality
  criticalFindings: number
  highFindings: number
  mediumFindings: number
  repairs: number
  // efficiency
  wallClockMs: number | null
  sessions: number
  turns: number | null
  inputTokens: number | null
  outputTokens: number | null
  toolCalls: number | null
  // autonomy
  humanInterventions: number
  approvals: number
  manualRetries: number
  blockers: number
  // stability
  crashedAgents: number
  recoveredSessions: number
  schedulerFailures: number
  unfinishedTasks: number
  // limit behaviour
  quotaPauses: number
  quotaWaitMs: number
  autoResumeSuccesses: number
  throttleEvents: number
  createdAt: string
}

export interface ArenaEvaluation {
  id: string
  trialId: string
  /** hidden: the case's hidden evaluator. */
  kind: 'hidden'
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** Tail of the evaluator output (capped). Stored by NEXUS; never sent to an agent. */
  output: string
  passed: boolean
  /** Why no evaluator ran (no result commit, run failed, ...). */
  skippedReason: string | null
  evaluatorHash: string
  scoreVersion: string
  /** Convenience score 0-100; 0 whenever acceptance failed. */
  score: number
  scoreBreakdown: Record<string, number>
  createdAt: string
}

export interface ArenaCell {
  caseId: string
  strategy: ConcreteStrategy
  trials: { id: string; state: TrialState; repetition: number; score: number | null }[]
}

export interface StrategyComparisonRow {
  strategy: ConcreteStrategy
  n: number
  passed: number
  passRate: number | null
  passInterval: Interval | null
  medianWallClockMs: number | null
  meanSessions: number | null
  meanObservedTokens: number | null
  meanRepairs: number | null
  criticalHighFindings: number
  quotaPauses: number
  label: EvidenceLabel
}

export interface RegressionFlag {
  strategy: ConcreteStrategy
  baseline: { group: string; n: number; passRate: number; interval: Interval }
  current: { group: string; n: number; passRate: number; interval: Interval }
  /** established: intervals do not overlap; lower: lower but not separated. */
  verdict: 'established' | 'lower'
  label: 'ORCHESTRATION REGRESSION' | 'Lower, not established'
}

// ───────────────────────────── statuses for the UI ─────────────────────────────

/** Short text for the header indicator. Never contains a percentage NEXUS did not receive. */
export function usageStatusLabel(status: UsageStatus): string {
  switch (status) {
    case 'AVAILABLE':
      return 'Available'
    case 'LIMIT_APPROACHING':
      return 'Limit approaching'
    case 'THROTTLED':
      return 'Throttled'
    case 'QUOTA_PAUSED':
      return 'Paused · Usage limit'
    case 'WAITING_FOR_RESET':
      return 'Waiting for reset'
    case 'PROBING':
      return 'Checking availability'
    case 'AUTH_REQUIRED':
      return 'Sign-in required'
    case 'RUNTIME_UNAVAILABLE':
      return 'Runtime unavailable'
  }
}
