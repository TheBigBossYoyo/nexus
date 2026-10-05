import { z } from 'zod'
import {
  ContractKindSchema,
  DependencyKindSchema,
  RepositoryRoleSchema,
  WORKSPACE_MEMORY_KINDS,
  WorkspacePolicySchema,
  WorkspaceProgramInputSchema,
  type CompatibilityResult,
  type Contract,
  type ContractConsumer,
  type ContractVersion,
  type CrossRepoDependency,
  type CrossRepoTask,
  type ReleaseTrain,
  type Service,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceMemoryEntry,
  type WorkspaceMission,
  type WorkspaceProgram,
  type WorkspaceRepository,
  type WorkspaceSummary,
} from './workspace'
import { ControlLimitsSchema, EnqueueInputSchema, PrioritySchema, ScheduleInputSchema, type ControlLimits, type ControlPlaneOverview, type GlobalWorkItem, type Schedule } from './control-plane'
import { SecurityDecisionsInputSchema, type SecurityDecisionPage } from './security'
import { ProviderIdSchema, ProviderPolicySchema, type ProviderPolicy, type ProviderSession, type ProvidersOverview, type ProviderStatus } from './provider'
import {
  BACKLOG_STATUSES,
  BackgroundJobKindSchema,
  BackgroundSettingsSchema,
  PROGRAM_PRESETS,
  ProgramPolicySchema,
  ProgramScheduleSchema,
  type BackgroundJob,
  type BackgroundSettings,
  type BacklogItem,
  type ExpertiseProfile,
  type Program,
  type ProgramDetail,
  type ProgramPolicy,
  type ProgramPreset,
  type ProgramSummary,
} from './program'
import {
  AgentRoleSchema,
  ComplexitySchema,
  PresetSchema,
  RunModeSchema,
  type AcceptanceCriterion,
  type Agent,
  type AgentOutput,
  type AgentSession,
  type ApprovalRequest,
  type CommandResult,
  type Decision,
  type MemoryEntry,
  type Message,
  type Project,
  type Review,
  type Run,
  type Task,
  type TaskDependency,
  type ToolEvent,
  type Verification,
  type Worktree,
} from './domain'
import type { AuthStatus, ModelOption } from './auth'
import type { PushMessage, RunEvent } from './events'
import type {
  ContextPack,
  GraphProposal,
  GraphRevision,
  PerformanceStat,
  PlanningCandidate,
  PlanningCritique,
  RepositoryFact,
  RoutingDecision,
} from './v2'
import { SettingsSchema, type Settings } from './settings'
import {
  ArenaBudgetPresetSchema,
  ConcreteStrategySchema,
  ExplorationModeSchema,
  SpeculationPolicySchema,
  StrategySchema,
  USAGE_GROUPINGS,
  type ArenaCampaign,
  type ArenaCaseVersion,
  type PolicyDecision,
  type PolicySnapshot,
  type UsageBreakdownRow,
  type UsageOverview,
  type UsageTotals,
} from './v3'
import type {
  ArenaCampaignDetail,
  ArenaCampaignSummary,
  ArenaCaseSummary,
  ArenaResults,
  ArenaStatus,
  ArenaTrialDetail,
  ArenaTrialRow,
  HomeSummary,
  LearnResult,
  PolicyDiff,
  PolicyOverview,
  PolicyPreview,
  RunPolicyInfo,
  RunUsage,
  SpeculativeDetail,
  UsageEfficiency,
  UsageLimitHistory,
} from './v3-read'
import {
  EndActionSchema,
  EndConditionsSchema,
  OVERNIGHT_CONFIRMATION_TEXT,
  OvernightPolicySchema,
  type OvernightStatus,
  type PowerAuditEntry,
  type RunCheckpoint,
} from './overnight'

const Id = z.string().min(1).max(64)
const Empty = z.object({}).strict()

export interface AppInfo {
  version: string
  dataDir: string
  dbPath: string
  worktreesDir: string
  platform: string
  gitVersion: string | null
  sdkVersion: string
  isPackaged: boolean
}

export interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

export interface DiffResult {
  /** What the diff covers, e.g. a task branch against its base, or the integration branch. */
  scope: 'task' | 'run'
  base: string | null
  head: string | null
  files: DiffFile[]
  /** Unified diff text (git format), possibly truncated. */
  patch: string
  truncated: boolean
}

export interface RunSummary {
  runId: string
  tasksTotal: number
  tasksCompleted: number
  tasksFailed: number
  tasksCancelled: number
  reviewsTotal: number
  reviewsApproved: number
  verificationsPassed: number
  verificationsFailed: number
  filesChanged: number
  commits: number
  agentSessions: number
  durationMs: number | null
  /** Most recent check-command results on the integration branch (or last task). */
  lastChecks: CommandResult[]
  costUsd: number | null
}

export interface RunDetail {
  run: Run
  tasks: Task[]
  dependencies: TaskDependency[]
  agents: Agent[]
  criteria: AcceptanceCriterion[]
  worktrees: Worktree[]
  pendingApprovals: ApprovalRequest[]
}

export interface RecoverableRun {
  run: Run
  projectName: string
  staleAgents: number
  activeTasks: number
  worktrees: number
}

export interface AgentDetail {
  agent: Agent
  sessions: AgentSession[]
  task: Task | null
}

/** Renderer → main request schemas. Every handler validates its input with these before acting. */
/** A repository, contract or task key of a workspace. */
const WorkspaceKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)

import type { ConnectionState, RuntimeStatus } from './runtime-protocol'
import type { WorkersOverview } from './workers'

export const ipcInputs = {
  'app.info': Empty,
  'app.openDataDir': Empty,

  'auth.status': z.object({ refresh: z.boolean().optional() }).strict(),
  'auth.models': Empty,

  'settings.get': Empty,
  'settings.update': z.object({ settings: SettingsSchema }).strict(),

  'projects.list': Empty,
  /** Without `path`, main shows the native folder picker. The renderer never touches the filesystem. */
  'projects.open': z.object({ path: z.string().min(1).optional() }).strict(),
  'projects.get': z.object({ projectId: Id }).strict(),
  'projects.reprofile': z.object({ projectId: Id }).strict(),
  'projects.update': z
    .object({ projectId: Id, respectProjectClaudeConfig: z.boolean() })
    .strict(),
  'projects.remove': z.object({ projectId: Id }).strict(),

  /** Missions as the user sees them. `includeInternal` adds the read-only sessions NEXUS ran for itself (0.4). */
  'runs.list': z.object({ projectId: Id.optional(), includeInternal: z.boolean().optional() }).strict(),
  'runs.get': z.object({ runId: Id }).strict(),
  'runs.create': z
    .object({
      projectId: Id,
      mode: RunModeSchema,
      preset: PresetSchema,
      prompt: z.string().min(1).max(20_000),
      maxParallelAgents: z.number().int().min(1).max(16).optional(),
      maxIterations: z.number().int().min(1).max(50).optional(),
      maxDurationMinutes: z.number().int().min(1).max(1440).optional(),
      requirePlanApproval: z.boolean().optional(),
      planningMode: z.enum(['single', 'consensus']).optional(),
      reviewMode: z.enum(['standard', 'dual', 'auto']).optional(),
      /** Rotate agent sessions after this many turns (0 disables). Lets an acceptance run exercise rotation cheaply. */
      sessionRotationTurns: z.number().int().min(0).max(1000).optional(),
      /** v0.3. Absent: the run behaves as before 0.3 (the mode decides). */
      strategy: StrategySchema.optional(),
      speculativeCandidates: z.number().int().min(2).max(3).optional(),
    })
    .strict(),
  'runs.approvePlan': z.object({ runId: Id }).strict(),
  'runs.replan': z.object({ runId: Id, feedback: z.string().max(10_000) }).strict(),
  'runs.pause': z.object({ runId: Id }).strict(),
  'runs.resume': z.object({ runId: Id }).strict(),
  'runs.cancel': z.object({ runId: Id }).strict(),
  'runs.summary': z.object({ runId: Id }).strict(),
  'runs.diff': z.object({ runId: Id }).strict(),
  'runs.recoverable': Empty,
  'runs.recover': z
    .object({ runId: Id, action: z.enum(['resume', 'inspect', 'cancel']) })
    .strict(),
  /** Remove worktrees of a finished run. Branches are kept. */
  'runs.cleanup': z.object({ runId: Id }).strict(),

  'tasks.retry': z.object({ taskId: Id }).strict(),
  'tasks.cancel': z.object({ taskId: Id }).strict(),
  'tasks.setPriority': z.object({ taskId: Id, priority: z.number().int().min(-100).max(100) }).strict(),
  'tasks.add': z
    .object({
      runId: Id,
      title: z.string().min(1).max(200),
      description: z.string().min(1).max(20_000),
      role: AgentRoleSchema,
      dependsOn: z.array(Id),
      suggestedFiles: z.array(z.string()),
      acceptanceCriteria: z.array(z.string().min(1)),
      complexity: ComplexitySchema,
    })
    .strict(),
  'tasks.instruct': z.object({ taskId: Id, instruction: z.string().min(1).max(10_000) }).strict(),
  'tasks.resolveBlocker': z.object({ taskId: Id, note: z.string().max(10_000) }).strict(),
  'tasks.diff': z.object({ taskId: Id }).strict(),
  'tasks.reviews': z.object({ taskId: Id }).strict(),
  'tasks.verifications': z.object({ taskId: Id }).strict(),

  'criteria.update': z.object({ criterionId: Id, text: z.string().min(1).max(2000) }).strict(),

  'agents.get': z.object({ agentId: Id }).strict(),
  'agents.stop': z.object({ agentId: Id }).strict(),
  'agents.output': z
    .object({ agentId: Id, afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(2000).optional() })
    .strict(),
  'agents.tools': z.object({ agentId: Id }).strict(),

  'messages.list': z.object({ runId: Id, taskId: Id.optional() }).strict(),
  'events.list': z
    .object({ runId: Id, afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(5000).optional() })
    .strict(),
  'reviews.list': z.object({ runId: Id }).strict(),
  'verifications.list': z.object({ runId: Id }).strict(),
  'decisions.list': z.object({ runId: Id }).strict(),

  'approvals.pending': Empty,
  'approvals.resolve': z
    .object({ approvalId: Id, approve: z.boolean(), note: z.string().max(2000).optional() })
    .strict(),

  'memory.list': z
    .object({ projectId: Id.optional(), scope: z.enum(['global', 'project', 'run']).optional(), query: z.string().max(500).optional() })
    .strict(),
  'memory.add': z
    .object({
      scope: z.enum(['global', 'project']),
      projectId: Id.optional(),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(10_000),
      tags: z.array(z.string().max(50)).max(20),
    })
    .strict(),
  'memory.setStatus': z.object({ memoryId: Id, status: z.enum(['approved', 'rejected']) }).strict(),
  'memory.delete': z.object({ memoryId: Id }).strict(),

  // v0.2
  'graph.revisions': z.object({ runId: Id }).strict(),
  'graph.proposals': z.object({ runId: Id }).strict(),
  'planning.candidates': z.object({ runId: Id }).strict(),
  'planning.recommend': z.object({ projectId: Id, prompt: z.string().max(20_000) }).strict(),
  'routing.list': z.object({ runId: Id }).strict(),
  'performance.summary': z.object({ projectId: Id.optional() }).strict(),
  'intelligence.list': z.object({ projectId: Id, query: z.string().max(500).optional(), includeStale: z.boolean().optional() }).strict(),
  'intelligence.refresh': z.object({ projectId: Id }).strict(),
  'context.packs': z.object({ taskId: Id.optional(), agentId: Id.optional() }).strict(),

  // v0.2.1: Overnight Mode. The renderer chooses from enums and bounded numbers; it never supplies a
  // command, an executable or an argument. Main decides what actually runs.
  'overnight.start': z
    .object({
      projectId: Id,
      preset: PresetSchema,
      prompt: z.string().min(1).max(20_000),
      policy: OvernightPolicySchema,
      /** The run-specific authorization: the ticked box and the exact sentence that was shown. */
      confirmed: z.literal(true),
      confirmation: z.literal(OVERNIGHT_CONFIRMATION_TEXT),
      maxParallelAgents: z.number().int().min(1).max(16).optional(),
      maxIterations: z.number().int().min(1).max(50).optional(),
      planningMode: z.enum(['single', 'consensus']).optional(),
      reviewMode: z.enum(['standard', 'dual', 'auto']).optional(),
      /** v0.3. Absent: BUILD, which configures the run exactly as before 0.3 and lets its outcome be recorded. */
      strategy: StrategySchema.optional(),
    })
    .strict(),
  /**
   * v0.3: an Arena campaign under the overnight supervisor. The same campaign fields as `arena.createCampaign`
   * and the same power policy and authorization as `overnight.start`; nothing else is accepted.
   */
  'overnight.startArena': z
    .object({
      campaign: z
        .object({
          name: z.string().min(1).max(120),
          caseIds: z.array(Id).min(1).max(50),
          strategies: z.array(ConcreteStrategySchema).min(1).max(5),
          repetitions: z.number().int().min(1).max(20),
          modelPreset: PresetSchema,
          budgetPreset: ArenaBudgetPresetSchema,
          maxConcurrentTrials: z.number().int().min(1).max(4).optional(),
          maxWallClockMinutes: z.number().int().min(1).max(1440).optional(),
        })
        .strict(),
      policy: OvernightPolicySchema,
      confirmed: z.literal(true),
      confirmation: z.literal(OVERNIGHT_CONFIRMATION_TEXT),
    })
    .strict(),
  /**
   * v0.4: a program under the overnight supervisor for one autonomous work window. The policy's duration is
   * the window; at its end the program is paused in a safe state before the end action.
   */
  'overnight.startProgram': z.object({ programId: Id, policy: OvernightPolicySchema, confirmed: z.literal(true), confirmation: z.literal(OVERNIGHT_CONFIRMATION_TEXT) }).strict(),
  /** v0.5: a cross-repository mission under the overnight supervisor. */
  'overnight.startWorkspaceMission': z.object({ missionId: Id, policy: OvernightPolicySchema, confirmed: z.literal(true), confirmation: z.literal(OVERNIGHT_CONFIRMATION_TEXT) }).strict(),
  'overnight.get': z.object({ runId: Id }).strict(),
  'overnight.active': Empty,
  'overnight.cancelPower': z.object({ runId: Id }).strict(),
  'overnight.changeEndAction': z
    .object({
      runId: Id,
      endAction: EndActionSchema.optional(),
      shutdownOn: EndConditionsSchema.optional(),
      finalDelaySeconds: z.number().int().min(10).max(3600).optional(),
      forceCloseApplications: z.boolean().optional(),
    })
    .strict(),
  'overnight.extend': z.object({ runId: Id, minutes: z.number().int().min(1).max(24 * 60) }).strict(),
  'overnight.cancelMission': z.object({ runId: Id }).strict(),
  'overnight.report': z.object({ runId: Id }).strict(),
  'overnight.audit': z.object({ runId: Id }).strict(),
  'overnight.checkpoints': z.object({ runId: Id }).strict(),

  // v0.3: usage intelligence
  'usage.overview': Empty,
  'usage.totals': z
    .object({ runId: Id.optional(), projectId: Id.optional(), campaignId: Id.optional(), sinceDays: z.number().int().min(1).max(365).optional() })
    .strict(),
  'usage.breakdown': z
    .object({
      by: z.enum(USAGE_GROUPINGS),
      runId: Id.optional(),
      campaignId: Id.optional(),
      sinceDays: z.number().int().min(1).max(365).optional(),
      limit: z.number().int().min(1).max(400).optional(),
    })
    .strict(),
  'usage.limitHistory': z.object({ limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }).strict(),
  'usage.run': z.object({ runId: Id }).strict(),
  'usage.efficiency': Empty,
  /** Ask the runtime now (no prompt is sent when the runtime supports its usage report). */
  'usage.refresh': Empty,
  /** Probe now and resume the waiting runs if Claude is available. */
  'usage.resumeNow': Empty,
  /** Stop waiting: the runs stay paused for a manual resume. */
  'usage.endWait': z.object({ runId: Id.optional() }).strict(),

  // v0.3: arena
  'arena.cases': Empty,
  'arena.status': Empty,
  /** Removes the trial repositories of a finished campaign from disk. Database rows are kept. */
  'arena.cleanup': z.object({ campaignId: Id }).strict(),
  /** Opens the native folder picker; returns null when cancelled. The case is registered untrusted. */
  'arena.importCase': Empty,
  'arena.trustCase': z.object({ caseVersionId: Id }).strict(),
  'arena.campaigns': z.object({ limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }).strict(),
  'arena.createCampaign': z
    .object({
      name: z.string().min(1).max(120),
      caseIds: z.array(Id).min(1).max(50),
      strategies: z.array(ConcreteStrategySchema).min(1).max(5),
      repetitions: z.number().int().min(1).max(20),
      modelPreset: PresetSchema,
      budgetPreset: ArenaBudgetPresetSchema,
      maxConcurrentTrials: z.number().int().min(1).max(4).optional(),
      maxWallClockMinutes: z.number().int().min(1).max(1440).optional(),
      start: z.boolean().optional(),
    })
    .strict(),
  'arena.campaign': z.object({ campaignId: Id }).strict(),
  'arena.trials': z
    .object({ campaignId: Id, limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() })
    .strict(),
  'arena.trial': z.object({ trialId: Id }).strict(),
  'arena.start': z.object({ campaignId: Id }).strict(),
  'arena.pause': z.object({ campaignId: Id }).strict(),
  'arena.resume': z.object({ campaignId: Id }).strict(),
  'arena.cancel': z.object({ campaignId: Id }).strict(),
  'arena.results': z.object({ campaignId: Id.optional(), sinceDays: z.number().int().min(1).max(730).optional() }).strict(),

  // v0.3: adaptive policy
  'policy.overview': Empty,
  'policy.snapshot': z.object({ snapshotId: Id }).strict(),
  'policy.compare': z.object({ a: Id, b: Id }).strict(),
  'policy.learn': Empty,
  'policy.promote': z.object({ candidateId: Id }).strict(),
  'policy.reject': z.object({ candidateId: Id }).strict(),
  'policy.rollback': Empty,
  'policy.pin': z.object({ snapshotId: Id.nullable() }).strict(),
  'policy.setConfig': z.object({ exploration: ExplorationModeSchema.optional(), speculation: SpeculationPolicySchema.optional() }).strict(),
  'policy.decisions': z.object({ limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }).strict(),
  /** What ADAPTIVE would choose for this mission, and why. Nothing is stored. */
  'policy.preview': z.object({ projectId: Id, prompt: z.string().min(1).max(20_000) }).strict(),
  'policy.run': z.object({ runId: Id }).strict(),

  // v0.3: speculative execution, home, activity
  'speculative.list': z.object({ runId: Id }).strict(),
  'home.summary': Empty,
  'activity.recent': z.object({ limit: z.number().int().min(1).max(500).optional(), beforeSeq: z.number().int().min(1).optional() }).strict(),

  // v0.4: programs, backlog, background engineering, expertise
  'program.list': z.object({ projectId: Id.optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }).strict(),
  'program.get': z.object({ programId: Id }).strict(),
  'program.presets': Empty,
  'program.create': z
    .object({
      projectId: Id,
      name: z.string().trim().min(1).max(120),
      goal: z.string().trim().min(1).max(8000),
      successCriteria: z.array(z.string().trim().min(1).max(400)).max(10).optional(),
      constraints: z.array(z.string().trim().min(1).max(400)).max(10).optional(),
      preset: z.enum(PROGRAM_PRESETS),
      /** A custom policy; when absent the preset is used as it is. */
      policy: ProgramPolicySchema.optional(),
      schedule: ProgramScheduleSchema.nullable().optional(),
      start: z.boolean().optional(),
    })
    .strict(),
  'program.start': z.object({ programId: Id }).strict(),
  'program.pause': z.object({ programId: Id }).strict(),
  'program.resume': z.object({ programId: Id }).strict(),
  'program.cancel': z.object({ programId: Id }).strict(),
  'program.decidePlan': z.object({ programId: Id, revisionId: Id, accept: z.boolean() }).strict(),
  /** The user asks for a reassessment of the remaining plan. The note is data for the planner, never a command. */
  'program.replan': z.object({ programId: Id, note: z.string().trim().min(1).max(2000) }).strict(),
  'backlog.list': z
    .object({ projectId: Id.optional(), programId: Id.optional(), statuses: z.array(z.enum(BACKLOG_STATUSES)).max(6).optional(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() })
    .strict(),
  /** A person changes the status of a backlog item. Nothing in the backlog becomes work by itself. */
  'backlog.setStatus': z.object({ itemId: Id, status: z.enum(BACKLOG_STATUSES) }).strict(),
  'background.settings': Empty,
  'background.setSettings': z.object({ settings: BackgroundSettingsSchema }).strict(),
  'background.jobs': z.object({ projectId: Id }).strict(),
  'background.start': z.object({ projectId: Id, kind: BackgroundJobKindSchema }).strict(),
  'background.cancel': z.object({ jobId: Id }).strict(),
  'expertise.list': z.object({ projectId: Id }).strict(),

  // v0.5: workspaces. The renderer names repositories, contracts and tasks by key or id; it never supplies a
  // command, and a path inside a repository is checked again in the main process.
  'workspace.list': Empty,
  'workspace.get': z.object({ workspaceId: Id }).strict(),
  'workspace.create': z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).optional() }).strict(),
  'workspace.setPolicy': z.object({ workspaceId: Id, policy: WorkspacePolicySchema }).strict(),
  'workspace.remove': z.object({ workspaceId: Id }).strict(),
  /** Without `path` the native folder picker opens. Enrolling is always an explicit choice. */
  'workspace.enroll': z.object({ workspaceId: Id, path: z.string().min(1).max(1024).optional(), key: WorkspaceKey.optional(), role: RepositoryRoleSchema.optional() }).strict(),
  'workspace.refresh': z.object({ repositoryId: Id }).strict(),
  'workspace.unenroll': z.object({ repositoryId: Id }).strict(),
  'workspace.setRole': z.object({ repositoryId: Id, role: RepositoryRoleSchema }).strict(),
  'workspace.discover': z.object({ workspaceId: Id }).strict(),
  'workspace.addDependency': z.object({ workspaceId: Id, from: WorkspaceKey, to: WorkspaceKey, kind: DependencyKindSchema, detail: z.string().trim().min(1).max(400) }).strict(),
  'workspace.removeDependency': z.object({ dependencyId: Id }).strict(),
  'workspace.addService': z.object({ repositoryId: Id, name: z.string().trim().min(1).max(80), description: z.string().trim().max(400) }).strict(),
  'workspace.registerContract': z.object({ workspaceId: Id, key: WorkspaceKey, name: z.string().trim().min(1).max(120), kind: ContractKindSchema, provider: WorkspaceKey, path: z.string().trim().min(1).max(400) }).strict(),
  'workspace.addConsumer': z.object({ contractId: Id, repository: WorkspaceKey, copyPath: z.string().trim().min(1).max(400).nullable().optional() }).strict(),
  'workspace.captureContract': z.object({ contractId: Id }).strict(),
  'workspace.addMemory': z
    .object({ workspaceId: Id, kind: z.enum(WORKSPACE_MEMORY_KINDS), title: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(1500), evidence: z.string().trim().min(1).max(1500), repositories: z.array(WorkspaceKey).min(2).max(20) })
    .strict(),
  'workspace.createMission': z.object({ workspaceId: Id, goal: z.string().trim().min(1).max(8000), start: z.boolean().optional() }).strict(),
  'workspace.mission': z.object({ missionId: Id }).strict(),
  'workspace.startMission': z.object({ missionId: Id }).strict(),
  'workspace.decidePlan': z.object({ missionId: Id, accept: z.boolean() }).strict(),
  'workspace.pauseMission': z.object({ missionId: Id }).strict(),
  'workspace.resumeMission': z.object({ missionId: Id }).strict(),
  'workspace.cancelMission': z.object({ missionId: Id }).strict(),
  /** A workspace program: an ordered series of cross-repository missions, one per milestone the user wrote. */
  'workspace.createProgram': z.object({ workspaceId: Id, program: WorkspaceProgramInputSchema, start: z.boolean().optional() }).strict(),
  'workspace.startProgram': z.object({ programId: Id }).strict(),
  'workspace.resumeProgram': z.object({ programId: Id }).strict(),
  'workspace.cancelProgram': z.object({ programId: Id }).strict(),
  'workspace.prepareRelease': z.object({ missionId: Id }).strict(),
  /** Always refused in 0.5: NEXUS prepares release trains and does not publish them. */
  'workspace.publishRelease': z.object({ trainId: Id }).strict(),
  'workspace.cancelRelease': z.object({ trainId: Id }).strict(),
  // v0.6: providers.
  'providers.overview': Empty,
  /** Detects every provider again (versions and sign-in state; no prompt is sent). */
  'providers.refresh': Empty,
  'providers.setPolicy': z.object({ policy: ProviderPolicySchema }).strict(),
  /** One minimal real session with the provider. Explicit, because it uses that provider's quota. */
  'providers.probe': z.object({ provider: ProviderIdSchema }).strict(),
  'providers.sessions': z.object({ runId: Id }).strict(),
  // v0.7: the control plane.
  'control.overview': Empty,
  /** Puts an existing program, campaign or workspace mission, or an audit, on the global queue. */
  'control.enqueue': z.object({ item: EnqueueInputSchema }).strict(),
  'control.setPriority': z.object({ itemId: Id, priority: PrioritySchema }).strict(),
  'control.move': z.object({ itemId: Id, where: z.enum(['top', 'up', 'down']) }).strict(),
  'control.pause': z.object({ itemId: Id }).strict(),
  'control.resume': z.object({ itemId: Id }).strict(),
  'control.cancel': z.object({ itemId: Id }).strict(),
  'control.setLimits': z.object({ limits: ControlLimitsSchema }).strict(),
  'control.createSchedule': z.object({ schedule: ScheduleInputSchema }).strict(),
  'control.setScheduleEnabled': z.object({ scheduleId: Id, enabled: z.boolean() }).strict(),
  'control.removeSchedule': z.object({ scheduleId: Id }).strict(),
  'control.decisions': z.object({ itemId: Id }).strict(),
  // v0.7: the runtime process and its workers. `desktop.*` is answered by the window's own main process.
  'runtime.status': Empty,
  'runtime.workers': Empty,
  'runtime.workerSelfTest': Empty,
  'runtime.tray': Empty,
  'runtime.setDispatchPaused': z.object({ paused: z.boolean() }).strict(),
  'runtime.stop': Empty,
  'desktop.connection': Empty,
  'desktop.reconnect': Empty,
  // v0.7: the execution security decision log (read-only, paged).
  'security.decisions': SecurityDecisionsInputSchema,
} as const

export type IpcChannel = keyof typeof ipcInputs
export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcInputs)[C]>

export interface IpcOutputs {
  'app.info': AppInfo
  'app.openDataDir': null
  'auth.status': AuthStatus
  'auth.models': ModelOption[]
  'settings.get': Settings
  'settings.update': Settings
  'projects.list': Project[]
  /** Null when the user cancels the folder picker. */
  'projects.open': Project | null
  'projects.get': Project
  'projects.reprofile': Project
  'projects.update': Project
  'projects.remove': null
  'runs.list': Run[]
  'runs.get': RunDetail
  'runs.create': Run
  'runs.approvePlan': Run
  'runs.replan': Run
  'runs.pause': Run
  'runs.resume': Run
  'runs.cancel': Run
  'runs.summary': RunSummary
  'runs.diff': DiffResult
  'runs.recoverable': RecoverableRun[]
  'runs.recover': Run
  'runs.cleanup': null
  'tasks.retry': Task
  'tasks.cancel': Task
  'tasks.setPriority': Task
  'tasks.add': Task
  'tasks.instruct': Message
  'tasks.resolveBlocker': Task
  'tasks.diff': DiffResult
  'tasks.reviews': Review[]
  'tasks.verifications': Verification[]
  'criteria.update': AcceptanceCriterion
  'agents.get': AgentDetail
  'agents.stop': Agent
  'agents.output': AgentOutput[]
  'agents.tools': ToolEvent[]
  'messages.list': Message[]
  'events.list': RunEvent[]
  'reviews.list': Review[]
  'verifications.list': Verification[]
  'decisions.list': Decision[]
  'approvals.pending': ApprovalRequest[]
  'approvals.resolve': ApprovalRequest
  'memory.list': MemoryEntry[]
  'memory.add': MemoryEntry
  'memory.setStatus': MemoryEntry
  'memory.delete': null
  'graph.revisions': GraphRevision[]
  'graph.proposals': GraphProposal[]
  'planning.candidates': { candidates: PlanningCandidate[]; critiques: PlanningCritique[] }
  'planning.recommend': { mode: 'single' | 'consensus'; reasons: string[] }
  'routing.list': RoutingDecision[]
  'performance.summary': { stats: PerformanceStat[]; totalOutcomes: number; minSamples: number }
  'intelligence.list': RepositoryFact[]
  'intelligence.refresh': { facts: number; stale: number }
  'context.packs': ContextPack[]
  'overnight.start': { run: Run; overnight: OvernightStatus }
  'overnight.startArena': { campaignId: string; overnight: OvernightStatus }
  'overnight.startProgram': { programId: string; overnight: OvernightStatus }
  'overnight.startWorkspaceMission': { missionId: string; overnight: OvernightStatus }
  'program.list': { programs: ProgramSummary[]; total: number }
  'program.get': ProgramDetail
  'program.presets': Record<ProgramPreset, ProgramPolicy>
  'program.create': Program
  'program.start': Program
  'program.pause': Program
  'program.resume': Program
  'program.cancel': Program
  'program.decidePlan': Program
  'program.replan': Program
  'backlog.list': BacklogItem[]
  'backlog.setStatus': BacklogItem
  'background.settings': BackgroundSettings
  'background.setSettings': BackgroundSettings
  'background.jobs': BackgroundJob[]
  'background.start': BackgroundJob
  'background.cancel': BackgroundJob
  'expertise.list': ExpertiseProfile[]
  'workspace.list': WorkspaceSummary[]
  'workspace.get': WorkspaceDetail
  'workspace.create': Workspace
  'workspace.setPolicy': Workspace
  'workspace.remove': null
  'workspace.enroll': WorkspaceRepository | null
  'workspace.refresh': WorkspaceRepository
  'workspace.unenroll': null
  'workspace.setRole': WorkspaceRepository
  'workspace.discover': CrossRepoDependency[]
  'workspace.addDependency': CrossRepoDependency
  'workspace.removeDependency': null
  'workspace.addService': Service
  'workspace.registerContract': Contract
  'workspace.addConsumer': ContractConsumer
  'workspace.captureContract': { version: ContractVersion; result: CompatibilityResult; created: boolean }
  'workspace.addMemory': WorkspaceMemoryEntry
  'workspace.createMission': WorkspaceMission
  'workspace.mission': { mission: WorkspaceMission; tasks: CrossRepoTask[] }
  'workspace.startMission': WorkspaceMission
  'workspace.decidePlan': WorkspaceMission
  'workspace.pauseMission': WorkspaceMission
  'workspace.resumeMission': WorkspaceMission
  'workspace.cancelMission': WorkspaceMission
  'workspace.createProgram': WorkspaceProgram
  'workspace.startProgram': WorkspaceProgram
  'workspace.resumeProgram': WorkspaceProgram
  'workspace.cancelProgram': WorkspaceProgram
  'workspace.prepareRelease': ReleaseTrain
  'workspace.publishRelease': never
  'workspace.cancelRelease': ReleaseTrain
  'providers.overview': ProvidersOverview
  'providers.refresh': ProvidersOverview
  'providers.setPolicy': ProviderPolicy
  'providers.probe': { ok: boolean; detail: string; status: ProviderStatus | null }
  'providers.sessions': ProviderSession[]
  'control.overview': ControlPlaneOverview
  'control.enqueue': GlobalWorkItem
  'control.setPriority': GlobalWorkItem
  'control.move': GlobalWorkItem
  'control.pause': GlobalWorkItem
  'control.resume': GlobalWorkItem
  'control.cancel': GlobalWorkItem
  'control.setLimits': ControlLimits
  'control.createSchedule': Schedule
  'control.setScheduleEnabled': Schedule
  'control.removeSchedule': null
  'control.decisions': { at: string; itemId: string; decision: string; reason: string }[]
  'runtime.status': RuntimeStatus
  'runtime.workers': WorkersOverview
  /** Starts one worker process without a session and says whether it came up. Uses no provider. */
  'runtime.workerSelfTest': { ok: boolean; pid: number | null; capabilities: string[]; milliseconds: number; detail: string }
  /** What the tray shows; read by tests. */
  'runtime.tray': unknown
  'runtime.setDispatchPaused': { paused: boolean }
  /** Stops the runtime: work in progress is paused as when NEXUS quits and continues after the next start. */
  'runtime.stop': { stopping: boolean }
  'desktop.connection': ConnectionState
  'desktop.reconnect': ConnectionState
  'security.decisions': SecurityDecisionPage
  /** Null when the run is not an overnight run. */
  'overnight.get': OvernightStatus | null
  'overnight.active': OvernightStatus[]
  'overnight.cancelPower': OvernightStatus
  'overnight.changeEndAction': OvernightStatus
  'overnight.extend': OvernightStatus
  'overnight.cancelMission': OvernightStatus
  'overnight.report': { text: string | null; path: string | null }
  'overnight.audit': PowerAuditEntry[]
  'overnight.checkpoints': RunCheckpoint[]

  'usage.overview': UsageOverview
  'usage.totals': UsageTotals
  'usage.breakdown': UsageBreakdownRow[]
  'usage.limitHistory': UsageLimitHistory
  'usage.run': RunUsage
  'usage.efficiency': UsageEfficiency
  'usage.refresh': UsageOverview
  'usage.resumeNow': UsageOverview
  'usage.endWait': UsageOverview

  'arena.cases': ArenaCaseSummary[]
  'arena.status': ArenaStatus
  'arena.cleanup': { removed: number }
  'arena.importCase': { summary: ArenaCaseSummary; commands: string[] } | null
  'arena.trustCase': ArenaCaseVersion
  'arena.campaigns': { campaigns: ArenaCampaignSummary[]; total: number }
  'arena.createCampaign': ArenaCampaign
  'arena.campaign': ArenaCampaignDetail
  'arena.trials': { trials: ArenaTrialRow[]; total: number }
  'arena.trial': ArenaTrialDetail
  'arena.start': ArenaCampaign
  'arena.pause': ArenaCampaign
  'arena.resume': ArenaCampaign
  'arena.cancel': ArenaCampaign
  'arena.results': ArenaResults

  'policy.overview': PolicyOverview
  'policy.snapshot': PolicySnapshot
  'policy.compare': PolicyDiff
  'policy.learn': LearnResult
  'policy.promote': PolicyOverview
  'policy.reject': PolicyOverview
  'policy.rollback': PolicyOverview
  'policy.pin': PolicyOverview
  'policy.setConfig': PolicyOverview
  'policy.decisions': PolicyDecision[]
  'policy.preview': PolicyPreview
  'policy.run': RunPolicyInfo

  'speculative.list': SpeculativeDetail
  'home.summary': HomeSummary
  'activity.recent': RunEvent[]
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

export { IPC_INVOKE_CHANNEL, IPC_PUSH_CHANNEL } from './ipc-channels'

/** The entire surface exposed to the renderer through contextBridge. */
export interface NexusBridge {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcResult<IpcOutputs[C]>>
  /** Subscribe to main → renderer pushes. Returns an unsubscribe function. */
  onPush(listener: (message: PushMessage) => void): () => void
}

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ipcInputs, value)
}
