import type { Database } from '../database'
import {
  AgentRepository,
  MessageRepository,
  OutputRepository,
  SessionRepository,
  ToolEventRepository,
} from './agents'
import { DependencyRepository, ProjectRepository, RunRepository, TaskRepository } from './core'
import { EventRepository, SettingsRepository } from './events-settings'
import { MemoryRepository } from './memory'
import { CheckpointRepository, OvernightRepository, PowerAuditRepository } from './overnight'
import {
  ContextPackRepository,
  FactRepository,
  GraphProposalRepository,
  GraphRevisionRepository,
  PlanningCandidateRepository,
  PlanningCritiqueRepository,
  RoutingDecisionRepository,
  TaskOutcomeRepository,
} from './v2'
import {
  UsageEventRepository,
  UsageWindowRepository,
  QuotaPauseRepository,
  QuotaResumeRepository,
  ArenaCaseRepository,
  ArenaCaseVersionRepository,
  ArenaCampaignRepository,
  ArenaTrialRepository,
  ArenaMetricsRepository,
  ArenaEvaluationRepository,
  TaskProfileRepository,
  MissionOutcomeRepository,
  PolicySnapshotRepository,
  PolicyDecisionRepository,
  PolicyCandidateRepository,
  PolicyPromotionRepository,
  StrategyStatisticRepository,
  SpeculativeRunRepository,
  CandidateResultRepository,
  TournamentDecisionRepository,
} from './v3'
import {
  ApprovalRepository,
  ArtifactRepository,
  CriterionRepository,
  DecisionRepository,
  ReviewRepository,
  UsageRepository,
  VerificationRepository,
  WorktreeRepository,
} from './work'

export interface Repositories {
  projects: ProjectRepository
  runs: RunRepository
  tasks: TaskRepository
  dependencies: DependencyRepository
  agents: AgentRepository
  sessions: SessionRepository
  messages: MessageRepository
  outputs: OutputRepository
  events: EventRepository
  toolEvents: ToolEventRepository
  worktrees: WorktreeRepository
  reviews: ReviewRepository
  verifications: VerificationRepository
  criteria: CriterionRepository
  decisions: DecisionRepository
  approvals: ApprovalRepository
  memory: MemoryRepository
  usage: UsageRepository
  artifacts: ArtifactRepository
  settings: SettingsRepository
  graphRevisions: GraphRevisionRepository
  graphProposals: GraphProposalRepository
  planningCandidates: PlanningCandidateRepository
  planningCritiques: PlanningCritiqueRepository
  routingDecisions: RoutingDecisionRepository
  taskOutcomes: TaskOutcomeRepository
  facts: FactRepository
  contextPacks: ContextPackRepository
  overnight: OvernightRepository
  powerAudit: PowerAuditRepository
  checkpoints: CheckpointRepository
  usageEvents: UsageEventRepository
  usageWindows: UsageWindowRepository
  quotaPauses: QuotaPauseRepository
  quotaResumes: QuotaResumeRepository
  arenaCases: ArenaCaseRepository
  arenaCaseVersions: ArenaCaseVersionRepository
  arenaCampaigns: ArenaCampaignRepository
  arenaTrials: ArenaTrialRepository
  arenaMetrics: ArenaMetricsRepository
  arenaEvaluations: ArenaEvaluationRepository
  taskProfiles: TaskProfileRepository
  missionOutcomes: MissionOutcomeRepository
  policySnapshots: PolicySnapshotRepository
  policyDecisions: PolicyDecisionRepository
  policyCandidates: PolicyCandidateRepository
  policyPromotions: PolicyPromotionRepository
  strategyStatistics: StrategyStatisticRepository
  speculativeRuns: SpeculativeRunRepository
  candidateResults: CandidateResultRepository
  tournamentDecisions: TournamentDecisionRepository
  /** Runs `fn` atomically. Nests (savepoints); an exception rolls back everything done inside. */
  transaction<T>(fn: () => T): T
}

export function createRepositories(db: Database): Repositories {
  return {
    projects: new ProjectRepository(db),
    runs: new RunRepository(db),
    tasks: new TaskRepository(db),
    dependencies: new DependencyRepository(db),
    agents: new AgentRepository(db),
    sessions: new SessionRepository(db),
    messages: new MessageRepository(db),
    outputs: new OutputRepository(db),
    events: new EventRepository(db),
    toolEvents: new ToolEventRepository(db),
    worktrees: new WorktreeRepository(db),
    reviews: new ReviewRepository(db),
    verifications: new VerificationRepository(db),
    criteria: new CriterionRepository(db),
    decisions: new DecisionRepository(db),
    approvals: new ApprovalRepository(db),
    memory: new MemoryRepository(db),
    usage: new UsageRepository(db),
    artifacts: new ArtifactRepository(db),
    settings: new SettingsRepository(db),
    graphRevisions: new GraphRevisionRepository(db),
    graphProposals: new GraphProposalRepository(db),
    planningCandidates: new PlanningCandidateRepository(db),
    planningCritiques: new PlanningCritiqueRepository(db),
    routingDecisions: new RoutingDecisionRepository(db),
    taskOutcomes: new TaskOutcomeRepository(db),
    facts: new FactRepository(db),
    contextPacks: new ContextPackRepository(db),
    overnight: new OvernightRepository(db),
    powerAudit: new PowerAuditRepository(db),
    checkpoints: new CheckpointRepository(db),
    usageEvents: new UsageEventRepository(db),
    usageWindows: new UsageWindowRepository(db),
    quotaPauses: new QuotaPauseRepository(db),
    quotaResumes: new QuotaResumeRepository(db),
    arenaCases: new ArenaCaseRepository(db),
    arenaCaseVersions: new ArenaCaseVersionRepository(db),
    arenaCampaigns: new ArenaCampaignRepository(db),
    arenaTrials: new ArenaTrialRepository(db),
    arenaMetrics: new ArenaMetricsRepository(db),
    arenaEvaluations: new ArenaEvaluationRepository(db),
    taskProfiles: new TaskProfileRepository(db),
    missionOutcomes: new MissionOutcomeRepository(db),
    policySnapshots: new PolicySnapshotRepository(db),
    policyDecisions: new PolicyDecisionRepository(db),
    policyCandidates: new PolicyCandidateRepository(db),
    policyPromotions: new PolicyPromotionRepository(db),
    strategyStatistics: new StrategyStatisticRepository(db),
    speculativeRuns: new SpeculativeRunRepository(db),
    candidateResults: new CandidateResultRepository(db),
    tournamentDecisions: new TournamentDecisionRepository(db),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  }
}

export type {
  AgentRepository,
  MessageRepository,
  OutputRepository,
  SessionRepository,
  ToolEventRepository,
  DependencyRepository,
  ProjectRepository,
  RunRepository,
  TaskRepository,
  EventRepository,
  SettingsRepository,
  MemoryRepository,
  ApprovalRepository,
  ArtifactRepository,
  CriterionRepository,
  DecisionRepository,
  ReviewRepository,
  UsageRepository,
  VerificationRepository,
  WorktreeRepository,
}
export type { CheckpointRepository, OvernightRepository, PowerAuditRepository } from './overnight'
export type { MemoryFilter } from './memory'
export type {
  ContextPackRepository,
  FactRepository,
  GraphProposalRepository,
  GraphRevisionRepository,
  PlanningCandidateRepository,
  PlanningCritiqueRepository,
  RoutingDecisionRepository,
  TaskOutcomeRepository,
  FactListOptions,
  FactSearchOptions,
} from './v2'
export type {
  UsageEventRepository,
  UsageWindowRepository,
  QuotaPauseRepository,
  QuotaResumeRepository,
  ArenaCaseRepository,
  ArenaCaseVersionRepository,
  ArenaCampaignRepository,
  ArenaTrialRepository,
  ArenaMetricsRepository,
  ArenaEvaluationRepository,
  TaskProfileRepository,
  MissionOutcomeRepository,
  PolicySnapshotRepository,
  PolicyDecisionRepository,
  PolicyCandidateRepository,
  PolicyPromotionRepository,
  StrategyStatisticRepository,
  SpeculativeRunRepository,
  CandidateResultRepository,
  TournamentDecisionRepository,
  UsageFilter,
  Page,
  TrialStateCount,
} from './v3'
export type { MessageRecipient } from './agents'
export { toFtsQuery } from './memory'
