import { z } from 'zod'
import {
  AgentRoleSchema,
  ComplexitySchema,
  MissionPlanSchema,
  RiskSchema,
  SeveritySchema,
  type AgentPurpose,
  type AgentRole,
  type Complexity,
  type MissionPlan,
  type ModelTier,
  type Risk,
  type TaskKind,
  type TaskState,
} from './domain'

// ───────────────────────────── run options ─────────────────────────────

export const PLANNING_MODES = ['single', 'consensus'] as const
export const PlanningModeSchema = z.enum(PLANNING_MODES)
export type PlanningMode = z.infer<typeof PlanningModeSchema>

/** `auto` uses dual review for high-risk tasks and standard review otherwise. */
export const REVIEW_MODES = ['standard', 'dual', 'auto'] as const
export const ReviewModeSchema = z.enum(REVIEW_MODES)
export type ReviewMode = z.infer<typeof ReviewModeSchema>

// ───────────────────────────── dynamic graph ─────────────────────────────

export const PROPOSAL_TYPES = [
  'ADD_TASK',
  'SPLIT_TASK',
  'CANCEL_TASK',
  'ADD_DEPENDENCY',
  'REMOVE_DEPENDENCY',
  'REPRIORITIZE',
  'REPLAN',
] as const
export const ProposalTypeSchema = z.enum(PROPOSAL_TYPES)
export type ProposalType = z.infer<typeof ProposalTypeSchema>

const TaskKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'task key must be lowercase kebab-case')

/** A task an agent proposes to add. Dependencies and dependants are task keys. */
export const ProposedTaskSchema = z.object({
  key: TaskKey,
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  role: AgentRoleSchema,
  dependencies: z.array(TaskKey),
  suggestedFiles: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().min(1)),
  complexity: ComplexitySchema,
  risk: RiskSchema,
})
export type ProposedTask = z.infer<typeof ProposedTaskSchema>

/** What an agent submits through `propose_graph_change`. Unused fields stay at their defaults. */
export const GraphChangesSchema = z.object({
  /** ADD_TASK, SPLIT_TASK (the subtasks), REPLAN (the replacement open tasks). */
  tasks: z.array(ProposedTaskSchema).default([]),
  /** SPLIT_TASK, CANCEL_TASK, REPRIORITIZE, ADD/REMOVE_DEPENDENCY: the task acted on. */
  targetTask: TaskKey.nullable().default(null),
  /** ADD/REMOVE_DEPENDENCY: the prerequisite. */
  dependsOn: TaskKey.nullable().default(null),
  /** ADD_TASK: the proposer's own task must wait for the new tasks (it yields and resumes later). */
  blocksProposer: z.boolean().default(false),
  /** REPRIORITIZE. */
  priority: z.number().int().min(-100).max(100).nullable().default(null),
})
export type GraphChanges = z.infer<typeof GraphChangesSchema>

export const GraphProposalInputSchema = z.object({
  type: ProposalTypeSchema,
  reason: z.string().min(1).max(4000),
  evidence: z.string().min(1).max(8000),
  changes: GraphChangesSchema,
})
export type GraphProposalInput = z.infer<typeof GraphProposalInputSchema>

export type ProposalStatus = 'proposed' | 'awaiting_approval' | 'applied' | 'rejected'

export interface GraphProposal {
  id: string
  runId: string
  /** Agent that proposed it; null for user-originated changes. */
  proposedByAgentId: string | null
  proposedBy: string
  /** The proposer's task, when it has one. */
  taskId: string | null
  type: ProposalType
  reason: string
  evidence: string
  changes: GraphChanges
  status: ProposalStatus
  /** Validation errors or the user's denial. */
  rejectionReason: string | null
  /** Revision created by applying this proposal. */
  revisionId: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface GraphSnapshotTask {
  id: string
  key: string
  title: string
  role: AgentRole
  kind: TaskKind
  state: TaskState
  priority: number
  parentTaskId: string | null
}

export interface GraphSnapshot {
  tasks: GraphSnapshotTask[]
  dependencies: { taskId: string; dependsOnTaskId: string }[]
}

export interface GraphRevision {
  id: string
  runId: string
  /** 1 is the approved plan; each applied proposal adds one. */
  version: number
  reason: string
  proposalId: string | null
  snapshot: GraphSnapshot
  createdAt: string
}

// ───────────────────────────── consensus planning ─────────────────────────────

export interface PlanningCandidate {
  id: string
  runId: string
  /** e.g. "Planner A (risk-first)". */
  label: string
  lens: string
  agentId: string | null
  plan: MissionPlan | null
  valid: boolean
  errors: string[]
  durationMs: number | null
  model: string | null
  costUsd: number | null
  createdAt: string
}

export const PlanCritiqueOutputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      /** Candidate label the finding is about, or "all". */
      candidate: z.string().min(1),
      severity: SeveritySchema,
      issue: z.string().min(1),
      recommendation: z.string(),
    }),
  ),
  /** Label of the candidate the synthesis should start from. */
  preferredCandidate: z.string().min(1),
})
export type PlanCritiqueOutput = z.infer<typeof PlanCritiqueOutputSchema>

export interface PlanningCritique {
  id: string
  runId: string
  agentId: string | null
  output: PlanCritiqueOutput
  createdAt: string
}

/** Re-exported so consumers validating synthesizer output need only this module. */
export const SynthesizedPlanSchema = MissionPlanSchema

// ───────────────────────────── model routing ─────────────────────────────

export const ROUTING_POLICIES = ['STRONGEST', 'BALANCED', 'FAST', 'INHERIT'] as const
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number]

export interface RoutingDecision {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  role: AgentRole
  purpose: AgentPurpose
  /** Policy the run's role policy asked for before any rule changed it. */
  requestedPolicy: RoutingPolicy
  resolvedPolicy: RoutingPolicy
  /** Tier used to look up the model; null for INHERIT. */
  resolvedTier: ModelTier | null
  /** Model id or alias passed to the runtime; null means the runtime default. */
  resolvedModel: string | null
  /** Human-readable rule applications, in order. */
  reasons: string[]
  createdAt: string
}

// ───────────────────────────── empirical performance ─────────────────────────────

export interface TaskOutcome {
  id: string
  projectId: string
  runId: string
  taskId: string
  role: AgentRole
  /** Model reported by the SDK for the implementing agent; null when it never started. */
  model: string | null
  tier: ModelTier | null
  category: TaskKind
  complexity: Complexity
  risk: Risk
  attempts: number
  /** Passed review and verification without any repair cycle or retry. */
  firstPassVerified: boolean
  completed: boolean
  reviewRejections: number
  repairCount: number
  checksFailed: number
  humanInterventions: number
  elapsedMs: number | null
  /** Null when the SDK reported no usage. */
  inputTokens: number | null
  outputTokens: number | null
  createdAt: string
}

export interface PerformanceStat {
  role: AgentRole
  model: string
  category: TaskKind
  /** Number of task outcomes behind every rate in this row. */
  samples: number
  /** False when `samples` is below the minimum for the rates to influence routing. */
  sufficient: boolean
  firstPassRate: number
  completionRate: number
  reviewRejectionRate: number
  averageRepairs: number
  checkFailureRate: number
  interventionRate: number
  averageElapsedMs: number | null
  averageOutputTokens: number | null
  recent: { taskId: string; completed: boolean; firstPassVerified: boolean; createdAt: string }[]
}

/** Outcomes needed per (role, model, category) before measured rates may change routing. */
export const MIN_ROUTING_SAMPLES = 5

// ───────────────────────────── repository intelligence ─────────────────────────────

export const FACT_KINDS = [
  'language',
  'framework',
  'module',
  'entry_point',
  'command',
  'dependency',
  'import_relation',
  'test_mapping',
  'boundary',
  'generated_path',
  'hot_file',
  'hazard',
  'interface',
  'decision',
] as const
export type FactKind = (typeof FACT_KINDS)[number]

export type FactSource = 'manifest' | 'static_analysis' | 'git' | 'agent' | 'verifier' | 'user'

export interface RepositoryFact {
  id: string
  projectId: string
  kind: FactKind
  /** What the fact is about, e.g. a module path or a command name. Unique per (project, kind). */
  subject: string
  statement: string
  source: FactSource
  confidence: 'low' | 'medium' | 'high'
  /** Repository-relative files that support the fact. */
  files: string[]
  /** Hash of the supporting files' state when the fact was verified; a mismatch means stale. */
  fingerprint: string
  stale: boolean
  createdAt: string
  verifiedAt: string
}

// ───────────────────────────── context engine ─────────────────────────────

export type ContextSourceKind =
  | 'role_policy'
  | 'task'
  | 'criteria'
  | 'dependency_output'
  | 'decision'
  | 'repository_fact'
  | 'memory'
  | 'message'
  | 'worktree'
  | 'review_finding'
  | 'failure'
  | 'handoff'
  | 'user_instruction'

export interface ContextPackEntry {
  id: string
  packId: string
  /** Section of the rendered prompt the entry belongs to. */
  section: string
  sourceKind: ContextSourceKind
  /** Id of the source row (fact, memory, message, decision, task), when it has one. */
  sourceId: string | null
  title: string
  /** Why it was included, or why it was left out. */
  reason: string
  included: boolean
  chars: number
}

export interface ContextPack {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  purpose: AgentPurpose
  totalChars: number
  createdAt: string
  entries: ContextPackEntry[]
}

// ───────────────────────────── review v2 ─────────────────────────────

export const ArbiterOutputSchema = z.object({
  summary: z.string().min(1),
  decisions: z.array(
    z.object({
      /** Index into the deduplicated finding list given to the arbiter. */
      findingIndex: z.number().int().min(0),
      accepted: z.boolean(),
      reason: z.string().min(1),
    }),
  ),
})
export type ArbiterOutput = z.infer<typeof ArbiterOutputSchema>
