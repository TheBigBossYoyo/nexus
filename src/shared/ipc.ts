import { z } from 'zod'
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
import { SettingsSchema, type Settings } from './settings'

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

  'runs.list': z.object({ projectId: Id.optional() }).strict(),
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
