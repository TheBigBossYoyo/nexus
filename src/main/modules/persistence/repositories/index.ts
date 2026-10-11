import type { Database } from '../database'
import { IntelligenceStore } from './intelligence'
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
  BackgroundJobRepository,
  BacklogRepository,
  ExpertiseRepository,
  MilestoneRepository,
  ProgramCheckpointRepository,
  ProgramDecisionRepository,
  ProgramMemoryRepository,
  ProgramMissionRepository,
  ProgramPlanRevisionRepository,
  ProgramRepository,
  WorkstreamRepository,
} from './program'
import {
  ContractConsumerStore,
  ContractStore,
  ContractVersionStore,
  EnrolledRepositoryStore,
  ReleaseTrainStore,
  ServiceStore,
  WorkspaceDecisionStore,
  WorkspaceDependencyStore,
  WorkspaceMemoryStore,
  WorkspaceMissionStore,
  WorkspaceProgramStore,
  WorkspaceRepositoryStore,
  WorkspaceTaskStore,
} from './workspace'
import { ProviderSessionStore } from './provider'
import { ControlIncidentStore, ControlScheduleStore, WorkItemStore } from './control-plane'
import { ScheduleFiringStore, SchedulerDecisionStore, WorkerLeaseStore, WorkerStore } from './workers'
import { FileProvenanceRepository, SecurityDecisionRepository } from './security'
import { contextGraphStores, type ContextGraphStores } from './context-graph'
import {
  ArtifactContextRefStore,
  CacheEventStore,
  CompactionEventStore,
  OptimizationDecisionStore,
  PromptComponentStore,
  PromptPrefixStore,
  RequestBreakdownStore,
  SessionEfficiencyStore,
  TokenBenchmarkStore,
} from './token'
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
  intelligenceArtifacts: IntelligenceStore
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
  // v0.4
  programs: ProgramRepository
  workstreams: WorkstreamRepository
  milestones: MilestoneRepository
  programMissions: ProgramMissionRepository
  programDecisions: ProgramDecisionRepository
  programCheckpoints: ProgramCheckpointRepository
  planRevisions: ProgramPlanRevisionRepository
  programMemory: ProgramMemoryRepository
  backlog: BacklogRepository
  expertise: ExpertiseRepository
  backgroundJobs: BackgroundJobRepository
  // v0.5
  /** v0.6: which provider ran each agent session. */
  providerSessions: ProviderSessionStore
  /** v0.7: the global queue, durable schedules and the control plane's incidents. */
  workItems: WorkItemStore
  controlSchedules: ControlScheduleStore
  controlIncidents: ControlIncidentStore
  /** v0.7: worker processes, their leases, schedule firings and the scheduler's decisions. */
  workers: WorkerStore
  workerLeases: WorkerLeaseStore
  scheduleFirings: ScheduleFiringStore
  schedulerDecisions: SchedulerDecisionStore
  /** v0.7: the security decision log and the record of which files agents wrote. */
  securityDecisions: SecurityDecisionRepository
  fileProvenance: FileProvenanceRepository
  /** v0.7.1: the Context Graph (an index over the stores above) and token accounting. */
  contextGraph: ContextGraphStores
  promptComponents: PromptComponentStore
  promptPrefixes: PromptPrefixStore
  requestBreakdowns: RequestBreakdownStore
  cacheEvents: CacheEventStore
  optimizationDecisions: OptimizationDecisionStore
  artifactContextRefs: ArtifactContextRefStore
  compactionEvents: CompactionEventStore
  sessionEfficiency: SessionEfficiencyStore
  tokenBenchmarks: TokenBenchmarkStore
  workspaces: WorkspaceRepositoryStore
  enrolledRepositories: EnrolledRepositoryStore
  workspaceServices: ServiceStore
  workspaceDependencies: WorkspaceDependencyStore
  workspaceContracts: ContractStore
  contractConsumers: ContractConsumerStore
  contractVersions: ContractVersionStore
  workspaceMissions: WorkspaceMissionStore
  workspacePrograms: WorkspaceProgramStore
  workspaceTasks: WorkspaceTaskStore
  releaseTrains: ReleaseTrainStore
  workspaceMemory: WorkspaceMemoryStore
  workspaceDecisions: WorkspaceDecisionStore
  /** Runs `fn` atomically. Nests (savepoints); an exception rolls back everything done inside. */
  transaction<T>(fn: () => T): T
}

export function createRepositories(db: Database): Repositories {
  return {
    intelligenceArtifacts: new IntelligenceStore(db),
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
    programs: new ProgramRepository(db),
    workstreams: new WorkstreamRepository(db),
    milestones: new MilestoneRepository(db),
    programMissions: new ProgramMissionRepository(db),
    programDecisions: new ProgramDecisionRepository(db),
    programCheckpoints: new ProgramCheckpointRepository(db),
    planRevisions: new ProgramPlanRevisionRepository(db),
    programMemory: new ProgramMemoryRepository(db),
    backlog: new BacklogRepository(db),
    expertise: new ExpertiseRepository(db),
    backgroundJobs: new BackgroundJobRepository(db),
    providerSessions: new ProviderSessionStore(db),
    workItems: new WorkItemStore(db),
    controlSchedules: new ControlScheduleStore(db),
    controlIncidents: new ControlIncidentStore(db),
    workers: new WorkerStore(db),
    workerLeases: new WorkerLeaseStore(db),
    scheduleFirings: new ScheduleFiringStore(db),
    schedulerDecisions: new SchedulerDecisionStore(db),
    securityDecisions: new SecurityDecisionRepository(db),
    fileProvenance: new FileProvenanceRepository(db),
    contextGraph: contextGraphStores(db),
    promptComponents: new PromptComponentStore(db),
    promptPrefixes: new PromptPrefixStore(db),
    requestBreakdowns: new RequestBreakdownStore(db),
    cacheEvents: new CacheEventStore(db),
    optimizationDecisions: new OptimizationDecisionStore(db),
    artifactContextRefs: new ArtifactContextRefStore(db),
    compactionEvents: new CompactionEventStore(db),
    sessionEfficiency: new SessionEfficiencyStore(db),
    tokenBenchmarks: new TokenBenchmarkStore(db),
    workspaces: new WorkspaceRepositoryStore(db),
    enrolledRepositories: new EnrolledRepositoryStore(db),
    workspaceServices: new ServiceStore(db),
    workspaceDependencies: new WorkspaceDependencyStore(db),
    workspaceContracts: new ContractStore(db),
    contractConsumers: new ContractConsumerStore(db),
    contractVersions: new ContractVersionStore(db),
    workspaceMissions: new WorkspaceMissionStore(db),
    workspacePrograms: new WorkspaceProgramStore(db),
    workspaceTasks: new WorkspaceTaskStore(db),
    releaseTrains: new ReleaseTrainStore(db),
    workspaceMemory: new WorkspaceMemoryStore(db),
    workspaceDecisions: new WorkspaceDecisionStore(db),
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
export type {
  BackgroundJobRepository,
  BacklogRepository,
  ExpertiseRepository,
  MilestoneRepository,
  ProgramCheckpointRepository,
  ProgramDecisionRepository,
  ProgramMemoryRepository,
  ProgramMissionRepository,
  ProgramPlanRevisionRepository,
  ProgramRepository,
  WorkstreamRepository,
} from './program'
export type { MessageRecipient } from './agents'
export { toFtsQuery } from './memory'
export type { ContextGraphStores, ContextNodeStore, ContextEdgeStore, ContextSourceStore, NodeListOptions, FtsHit } from './context-graph'
export type { CacheTotals, CacheGroup } from './token'
