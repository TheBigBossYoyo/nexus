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
export type { MessageRecipient } from './agents'
export { toFtsQuery } from './memory'
