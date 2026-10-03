import { z } from 'zod'

// ───────────────────────────── enums ─────────────────────────────

export const TASK_STATES = [
  'draft',
  'ready',
  'blocked',
  'queued',
  'assigned',
  'running',
  'waiting',
  'review',
  'verification',
  'failed',
  'completed',
  'cancelled',
] as const
export const TaskStateSchema = z.enum(TASK_STATES)
export type TaskState = z.infer<typeof TaskStateSchema>

export const AGENT_STATES = [
  'idle',
  'starting',
  'working',
  'waiting',
  'blocked',
  'stopping',
  'stopped',
  'failed',
] as const
export const AgentStateSchema = z.enum(AGENT_STATES)
export type AgentState = z.infer<typeof AgentStateSchema>

export const RUN_STATES = [
  'planning',
  'awaiting_approval',
  'executing',
  'testing',
  'reviewing',
  'verifying',
  'repairing',
  'paused',
  'failed',
  'completed',
  'cancelled',
] as const
export const RunStateSchema = z.enum(RUN_STATES)
export type RunState = z.infer<typeof RunStateSchema>

export const AGENT_ROLES = [
  'planner',
  'architect',
  'worker',
  'debugger',
  'reviewer',
  'verifier',
  'researcher',
  'security_reviewer',
] as const
export const AgentRoleSchema = z.enum(AGENT_ROLES)
export type AgentRole = z.infer<typeof AgentRoleSchema>

/** Roles whose sessions may modify files (and therefore need a private worktree). */
export const WRITING_ROLES: readonly AgentRole[] = ['worker', 'debugger']

export const RUN_MODES = ['ask', 'build', 'swarm', 'repair', 'audit', 'mission', 'loop'] as const
export const RunModeSchema = z.enum(RUN_MODES)
export type RunMode = z.infer<typeof RunModeSchema>

export const PRESETS = ['eco', 'balanced', 'maximum'] as const
export const PresetSchema = z.enum(PRESETS)
export type Preset = z.infer<typeof PresetSchema>

/** Abstract model tiers. Mapped to concrete model ids/aliases in settings, never hardcoded in logic. */
export const MODEL_TIERS = ['strongest', 'balanced', 'fast'] as const
export const ModelTierSchema = z.enum(MODEL_TIERS)
export type ModelTier = z.infer<typeof ModelTierSchema>

export const TASK_KINDS = [
  'research',
  'design',
  'implement',
  'repair',
  'audit',
  'synthesis',
  'ask',
] as const
export const TaskKindSchema = z.enum(TASK_KINDS)
export type TaskKind = z.infer<typeof TaskKindSchema>

export const MESSAGE_TYPES = [
  'question',
  'information',
  'blocker',
  'interface_change',
  'review_finding',
  'handoff',
  'decision_request',
  'acknowledgement',
  'user_instruction',
] as const
export const MessageTypeSchema = z.enum(MESSAGE_TYPES)
export type MessageType = z.infer<typeof MessageTypeSchema>

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'] as const
export const SeveritySchema = z.enum(SEVERITIES)
export type Severity = z.infer<typeof SeveritySchema>

export const REVIEW_CATEGORIES = [
  'correctness',
  'security',
  'architecture',
  'concurrency',
  'performance',
  'maintainability',
  'ux',
  'testing',
  'requirement_mismatch',
] as const
export const ReviewCategorySchema = z.enum(REVIEW_CATEGORIES)
export type ReviewCategory = z.infer<typeof ReviewCategorySchema>

export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export const RiskSchema = z.enum(RISK_LEVELS)
export type Risk = z.infer<typeof RiskSchema>

export const COMPLEXITIES = ['small', 'medium', 'large'] as const
export const ComplexitySchema = z.enum(COMPLEXITIES)
export type Complexity = z.infer<typeof ComplexitySchema>

export type PauseReason = 'user' | 'quota' | 'recovery'
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'
export type ApprovalKind = 'plan' | 'tool' | 'git' | 'task' | 'merge' | 'graph'
export type MemoryScope = 'global' | 'project' | 'run'
export type MemoryStatus = 'proposed' | 'approved' | 'rejected'
export type WorktreeState = 'active' | 'merged' | 'removed' | 'orphaned'
export type SessionState = 'active' | 'ended' | 'rotated' | 'failed'
export type ToolEventStatus = 'started' | 'completed' | 'failed' | 'denied'
export type CriterionStatus = 'pending' | 'passed' | 'failed'

// ───────────────────────────── plan (planner output) ─────────────────────────────

export const PlannedTaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'task id must be lowercase kebab-case'),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  role: AgentRoleSchema,
  dependencies: z.array(z.string()),
  parallelizable: z.boolean(),
  suggestedFiles: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().min(1)),
  complexity: ComplexitySchema,
  risk: RiskSchema,
  requiresApproval: z.boolean(),
})
export type PlannedTask = z.infer<typeof PlannedTaskSchema>

export const MissionPlanSchema = z.object({
  summary: z.string().min(1),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().min(1)),
  tasks: z.array(PlannedTaskSchema).min(1),
  risks: z.array(z.object({ description: z.string().min(1), mitigation: z.string() })),
})
export type MissionPlan = z.infer<typeof MissionPlanSchema>

// ───────────────────────────── review / verification (agent output) ─────────────────────────────

export const ReviewFindingSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  evidence: z.string().min(1),
  severity: SeveritySchema,
  category: ReviewCategorySchema,
  file: z.string().nullable(),
  lineStart: z.number().int().nullable(),
  lineEnd: z.number().int().nullable(),
  confidence: z.enum(['low', 'medium', 'high']),
  suggestedCorrection: z.string().nullable(),
})
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

export const ReviewOutputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
})
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>

export const VerificationFailureSchema = z.object({
  criterion: z.string().min(1),
  evidence: z.string().min(1),
  likelyCause: z.string(),
  relevantFiles: z.array(z.string()),
})
export type VerificationFailure = z.infer<typeof VerificationFailureSchema>

export const VerifierOutputSchema = z.object({
  summary: z.string().min(1),
  criteria: z.array(
    z.object({ criterion: z.string().min(1), passed: z.boolean(), evidence: z.string().min(1) }),
  ),
  failures: z.array(VerificationFailureSchema),
})
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>

/** Structured handoff requested from an agent before its session is rotated or after a crash. */
export const HandoffSchema = z.object({
  completedWork: z.array(z.string()),
  commits: z.array(z.string()),
  filesChanged: z.array(z.string()),
  unresolvedIssues: z.array(z.string()),
  importantFindings: z.array(z.string()),
  nextSteps: z.array(z.string()),
})
export type Handoff = z.infer<typeof HandoffSchema>

// ───────────────────────────── entities ─────────────────────────────

export interface CheckCommands {
  build: string | null
  test: string | null
  lint: string | null
  typecheck: string | null
}

export interface ProjectProfile {
  repoRoot: string
  isGitRepo: boolean
  currentBranch: string | null
  headCommit: string | null
  dirty: boolean
  packageManagers: string[]
  languages: string[]
  frameworks: string[]
  scripts: Record<string, string>
  commands: CheckCommands
  docs: string[]
  hasClaudeMd: boolean
  fileCount: number
  sizeBytes: number
  generatedPaths: string[]
  profiledAt: string
}

export interface Project {
  id: string
  name: string
  rootPath: string
  profile: ProjectProfile | null
  /** Explicit opt-in: load the project's CLAUDE.md / .claude settings into agent sessions. */
  respectProjectClaudeConfig: boolean
  createdAt: string
  lastOpenedAt: string
}

export interface RunConfig {
  maxParallelAgents: number
  maxTurnsPerAgent: number
  maxRetriesPerTask: number
  maxDurationMinutes: number
  /** LOOP mode bound; also caps repair cycles per task in every mode. */
  maxIterations: number
  requirePlanApproval: boolean
  /** Role → tier. Tiers resolve to concrete models through settings at session start. */
  modelPolicy: Record<AgentRole, ModelTier>
  checks: CheckCommands
  respectProjectClaudeConfig: boolean
  subscriptionMode: boolean
  /** Rotate an agent session after this many turns (0 disables rotation). */
  sessionRotationTurns: number
  /** Minutes before a task lease expires without a heartbeat. */
  leaseMinutes: number
  enabledMcpServers: string[]
  /** v0.2. Absent on runs created by v0.1; treat as 'single'. */
  planningMode?: 'single' | 'consensus'
  /** v0.2. Absent on runs created by v0.1; treat as 'auto'. */
  reviewMode?: 'standard' | 'dual' | 'auto'
}

export interface Run {
  id: string
  projectId: string
  mode: RunMode
  preset: Preset
  state: RunState
  /** State to return to when a paused run resumes. */
  resumeState: RunState | null
  pauseReason: PauseReason | null
  prompt: string
  plan: MissionPlan | null
  baseBranch: string | null
  baseCommit: string | null
  integrationBranch: string | null
  config: RunConfig
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface TaskError {
  what: string
  where: string | null
  why: string | null
  retryable: boolean
}

export interface Task {
  id: string
  runId: string
  /** Planner-assigned id, unique within the run. Used for dependency references and branch names. */
  key: string
  title: string
  description: string
  role: AgentRole
  kind: TaskKind
  state: TaskState
  priority: number
  complexity: Complexity
  risk: Risk
  parallelizable: boolean
  requiresApproval: boolean
  approvalGranted: boolean
  suggestedFiles: string[]
  acceptanceCriteria: string[]
  /** Implementation attempts so far (1-based once started). */
  attempt: number
  /** Review/verification → repair cycles so far. */
  repairCycles: number
  /** For repair tasks: the task being repaired. */
  parentTaskId: string | null
  /** Tier override set by escalation. */
  modelTierOverride: ModelTier | null
  branch: string | null
  worktreeId: string | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
  /** Final summary produced by the implementing agent; passed to dependants as dependency output. */
  resultSummary: string | null
  blockedReason: string | null
  error: TaskError | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface TaskDependency {
  taskId: string
  dependsOnTaskId: string
}

export type AgentPurpose =
  | 'plan'
  | 'implement'
  | 'diagnose'
  | 'review'
  | 'verify'
  | 'research'
  | 'audit'
  | 'synthesis'
  | 'ask'
  /** v0.2: plan critic, plan synthesizer, finding arbiter. */
  | 'critique'
  | 'synthesize'
  | 'arbitrate'

export interface AgentMetrics {
  turns: number
  toolCalls: number
  filesRead: number
  filesChanged: number
  commands: number
  /** Null means the SDK has not reported the value; it is never estimated. */
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  costUsd: number | null
  contextWindow: number | null
}

export interface Agent {
  id: string
  runId: string
  taskId: string | null
  role: AgentRole
  purpose: AgentPurpose
  label: string
  state: AgentState
  /** Model actually reported by the SDK init message (falls back to the requested model). */
  model: string | null
  activity: string | null
  metrics: AgentMetrics
  error: string | null
  createdAt: string
  startedAt: string | null
  stoppedAt: string | null
}

export interface AgentSession {
  id: string
  agentId: string
  /** Claude Agent SDK session id, needed for resume. */
  sdkSessionId: string | null
  model: string | null
  state: SessionState
  endReason: string | null
  handoff: Handoff | null
  startedAt: string
  endedAt: string | null
}

export interface Worktree {
  id: string
  runId: string
  taskId: string | null
  path: string
  branch: string
  baseCommit: string
  state: WorktreeState
  createdAt: string
}

export interface Message {
  id: string
  runId: string
  type: MessageType
  severity: Severity | null
  fromAgentId: string | null
  fromTaskId: string | null
  /** Display name of the sender, e.g. "Worker/api" or "User". */
  fromLabel: string
  toTaskId: string | null
  toRole: AgentRole | null
  toLabel: string
  subject: string
  body: string
  createdAt: string
}

export interface Artifact {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  kind: string
  title: string
  content: string
  createdAt: string
}

export interface Review {
  id: string
  runId: string
  taskId: string
  agentId: string | null
  attempt: number
  verdict: 'approved' | 'changes_requested'
  summary: string
  findings: ReviewFinding[]
  /** v0.2: set on the arbiter's review record of a dual review. Indexes refer to `findings`. */
  arbitration?: { summary: string; decisions: { findingIndex: number; accepted: boolean; reason: string }[] } | null
  createdAt: string
}

export interface CommandResult {
  name: string
  command: string
  cwd: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** Tail of combined stdout/stderr. */
  output: string
}

export interface Verification {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  attempt: number
  kind: 'checks' | 'verifier'
  passed: boolean
  summary: string
  criteria: { criterion: string; passed: boolean; evidence: string }[]
  commands: CommandResult[]
  failures: VerificationFailure[]
  createdAt: string
}

export interface AcceptanceCriterion {
  id: string
  runId: string
  /** Null for mission-level criteria. */
  taskId: string | null
  text: string
  status: CriterionStatus
  evidence: string | null
  updatedAt: string
}

export interface Decision {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  title: string
  decision: string
  rationale: string
  createdAt: string
}

export interface MemoryEntry {
  id: string
  scope: MemoryScope
  projectId: string | null
  runId: string | null
  taskId: string | null
  agentId: string | null
  kind: string
  title: string
  content: string
  tags: string[]
  filePaths: string[]
  /** Where the fact came from, e.g. "verifier", "architect", "user". */
  source: string
  evidence: string | null
  status: MemoryStatus
  createdAt: string
}

export interface ApprovalRequest {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  kind: ApprovalKind
  /** Short human-readable action, e.g. "Run shell command". */
  action: string
  reason: string
  /** Exact command or operation. */
  command: string | null
  requestedBy: string
  risk: Risk
  status: ApprovalStatus
  note: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface ToolEvent {
  id: string
  runId: string
  taskId: string | null
  agentId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  status: ToolEventStatus
  outputPreview: string | null
  startedAt: string
  completedAt: string | null
}

export type AgentOutputKind = 'text' | 'system' | 'user' | 'error'

/** One item of an agent's visible transcript. Hidden reasoning is never captured. */
export interface AgentOutput {
  id: string
  agentId: string
  seq: number
  kind: AgentOutputKind
  content: string
  createdAt: string
}

export interface UsageSnapshot {
  id: string
  runId: string
  agentId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  contextWindow: number | null
  turns: number
  createdAt: string
}

export function emptyMetrics(): AgentMetrics {
  return {
    turns: 0,
    toolCalls: 0,
    filesRead: 0,
    filesChanged: 0,
    commands: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    costUsd: null,
    contextWindow: null,
  }
}

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'failed', 'cancelled']
export const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled']
export const ACTIVE_AGENT_STATES: readonly AgentState[] = [
  'starting',
  'working',
  'waiting',
  'blocked',
  'stopping',
]
