import type { Run, RunState } from './domain'
import type { OvernightStatus } from './overnight'
import type {
  ArenaCampaign,
  ArenaCase,
  ArenaCaseVersion,
  ArenaCell,
  ArenaEvaluation,
  ArenaTrial,
  ArenaTrialMetrics,
  CandidateResult,
  ConcreteStrategy,
  EvidenceLabel,
  EvidenceSummaryRow,
  Interval,
  Measured,
  MissionOutcome,
  PolicyCandidate,
  PolicyDecision,
  PolicyPointer,
  PolicyPromotion,
  PolicySnapshot,
  QuotaPause,
  QuotaResume,
  RegressionFlag,
  RunStrategyInfo,
  SpeculativeRun,
  StrategyComparisonRow,
  StrategyPreference,
  TaskProfile,
  TournamentDecision,
  TrialState,
  UsageBreakdownRow,
  UsageEvent,
  UsageOverview,
  UsageTotals,
} from './v3'

/** v0.3 read models returned over IPC. Lists are paged or aggregated in the main process. */

// ───────────────────────────── usage ─────────────────────────────

export interface QuotaPauseWithResumes extends QuotaPause {
  resumes: QuotaResume[]
  /** First 80 characters of the paused run's mission, when the wait belongs to one run. */
  runLabel: string | null
}

export interface UsageLimitHistory {
  events: UsageEvent[]
  pauses: QuotaPauseWithResumes[]
}

export interface RunUsage {
  runId: string
  strategy: RunStrategyInfo | null
  totals: UsageTotals
  agents: number
  byAgent: UsageBreakdownRow[]
  byModel: UsageBreakdownRow[]
  byRole: UsageBreakdownRow[]
  pauses: QuotaPauseWithResumes[]
}

export interface StrategyEfficiencyRow {
  strategy: ConcreteStrategy
  /** Real missions and Arena trials are reported separately; they are never pooled. */
  kind: 'arena' | 'mission'
  n: number
  successes: number
  passRate: number | null
  meanSessions: number | null
  meanObservedTokens: number | null
  medianDurationMs: number | null
  label: EvidenceLabel
}

export interface UsageEfficiency {
  /** Observed tokens of all sessions divided by tasks that completed. Null with no completed task. */
  tokensPerSuccessfulTask: Measured<number>
  sessionsPerSuccessfulTask: Measured<number>
  repairsPerTask: Measured<number>
  successfulTasks: number
  byStrategy: StrategyEfficiencyRow[]
}

// ───────────────────────────── arena ─────────────────────────────

export interface ArenaCaseSummary {
  case: ArenaCase
  version: ArenaCaseVersion
}

export interface ArenaCampaignSummary {
  campaign: ArenaCampaign
  counts: Record<TrialState, number>
  total: number
}

export interface ArenaCampaignDetail extends ArenaCampaignSummary {
  cases: ArenaCaseSummary[]
  matrix: ArenaCell[]
  comparison: StrategyComparisonRow[]
  usage: UsageTotals
}

export interface ArenaTrialRow {
  trial: ArenaTrial
  metrics: ArenaTrialMetrics | null
  /** Evaluation without the evaluator output (use `arena.trial` for that). */
  score: number | null
  hiddenPassed: boolean | null
  runState: RunState | null
}

export interface ArenaTrialDetail {
  trial: ArenaTrial
  case: ArenaCaseSummary | null
  metrics: ArenaTrialMetrics | null
  evaluation: ArenaEvaluation | null
  profile: TaskProfile | null
}

export interface ArenaResults {
  comparison: StrategyComparisonRow[]
  /** Per case: one comparison row per strategy. */
  byCase: { caseId: string; caseName: string; rows: StrategyComparisonRow[] }[]
  regressions: RegressionFlag[]
  totalTrials: number
  /** Plain-language statement of what the evidence does and does not separate. */
  notes: string[]
}

// ───────────────────────────── policy ─────────────────────────────

export interface PolicyContextRow {
  contextKey: string
  /** What the default policy gives for this context. */
  defaultStrategy: ConcreteStrategy
  /** What the active snapshot gives (the default unless a preference exists). */
  preferred: ConcreteStrategy
  preference: StrategyPreference | null
  arenaTrials: number
  missions: number
  label: EvidenceLabel
  reason: string
  rows: EvidenceSummaryRow[]
}

export interface PolicySnapshotSummary {
  id: string
  version: number
  createdAt: string
  origin: PolicySnapshot['origin']
  preferences: number
  note: string | null
}

export interface PolicyOverview {
  active: PolicySnapshot
  pointer: PolicyPointer
  evidence: { arenaTrials: number; arenaCampaigns: number; missions: number; computedAt: string | null }
  contexts: PolicyContextRow[]
  candidates: PolicyCandidate[]
  history: PolicyPromotion[]
  snapshots: PolicySnapshotSummary[]
}

export interface PolicyDiff {
  a: PolicySnapshotSummary
  b: PolicySnapshotSummary
  added: StrategyPreference[]
  removed: StrategyPreference[]
  changed: { contextKey: string; from: ConcreteStrategy; to: ConcreteStrategy }[]
  config: { field: string; from: string; to: string }[]
}

export interface PolicyPreview {
  profile: TaskProfile
  decision: PolicyDecision
}

export interface RunPolicyInfo {
  strategy: RunStrategyInfo | null
  profile: TaskProfile | null
  decision: PolicyDecision | null
  outcome: MissionOutcome | null
}

export interface LearnResult {
  statistics: number
  candidates: PolicyCandidate[]
  /** Why no candidate was produced, per context that had evidence. */
  notes: string[]
}

// ───────────────────────────── speculative ─────────────────────────────

export interface SpeculativeDetail {
  runs: SpeculativeRun[]
  /** `diffPatch` is cut to 20,000 characters here. */
  candidates: CandidateResult[]
  decisions: TournamentDecision[]
}

// ───────────────────────────── home ─────────────────────────────

export interface HomeRun {
  run: Run
  projectName: string
  tasksTotal: number
  tasksCompleted: number
  activeAgents: number
  strategy: ConcreteStrategy | null
}

export interface HomeSummary {
  activeRuns: HomeRun[]
  recentRuns: HomeRun[]
  projects: { id: string; name: string; branch: string | null; lastOpenedAt: string }[]
  activeAgents: number
  usage: UsageOverview
  overnight: OvernightStatus[]
  arena: {
    campaigns: number
    trials: number
    latest: ArenaCampaignSummary | null
    /** e.g. "BUILD leads on bugfix (n=27, moderate evidence)"; null without enough evidence to say anything. */
    headline: string | null
  }
  policy: { version: number; preferences: number; candidates: number; exploration: string; pinned: boolean }
}

export interface IntervalText {
  interval: Interval | null
}
