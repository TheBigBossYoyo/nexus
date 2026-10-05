import { z } from 'zod'
import { PresetSchema } from './domain'
import { StrategySchema } from './v3'

/**
 * v0.4: Programs. A program pursues an engineering goal across several milestones; each milestone is
 * worked on by one or more missions (ordinary runs). Everything here is data and pure decisions: the
 * application state machine owns the truth, Claude only proposes plans and judgments that are validated
 * against these schemas before anything is stored.
 */

/**
 * The first line of the prompt of each kind of program reasoning session. The marker records the session's
 * purpose with its run, and lets lists of missions leave these internal read-only runs out.
 */
export const REASONING_MARKERS = {
  plan: 'NEXUS PROGRAM PLANNER',
  replan: 'NEXUS PROGRAM REPLANNER',
  verify: 'NEXUS MILESTONE VERIFIER',
  background: 'NEXUS BACKGROUND ANALYSIS',
} as const

/** The first line of the prompt of the session that plans a cross-repository mission (v0.5). */
export const WORKSPACE_PLANNER_MARKER = 'NEXUS WORKSPACE PLANNER'

/** Every marker of a read-only session NEXUS runs for itself; lists of missions leave these runs out. */
export const INTERNAL_RUN_MARKERS: readonly string[] = [...Object.values(REASONING_MARKERS), WORKSPACE_PLANNER_MARKER]

/** True for a read-only run NEXUS started for itself (planning, verifying, reassessing, background analysis). */
export function isReasoningRun(run: { mode: string; prompt: string }): boolean {
  return run.mode === 'ask' && INTERNAL_RUN_MARKERS.some((marker) => run.prompt.startsWith(marker))
}

// ───────────────────────────── states ─────────────────────────────

export const PROGRAM_STATES = ['DRAFT', 'PLANNING', 'ACTIVE', 'PAUSED', 'WAITING_FOR_QUOTA', 'BLOCKED', 'REPLANNING', 'COMPLETED', 'CANCELLED', 'FAILED'] as const
export type ProgramState = (typeof PROGRAM_STATES)[number]
export const TERMINAL_PROGRAM_STATES: readonly ProgramState[] = ['COMPLETED', 'CANCELLED', 'FAILED']
/** States in which the engine is (or will be, by itself) doing work. */
export const LIVE_PROGRAM_STATES: readonly ProgramState[] = ['PLANNING', 'ACTIVE', 'WAITING_FOR_QUOTA', 'REPLANNING']

export const MILESTONE_STATES = ['PLANNED', 'READY', 'ACTIVE', 'VERIFYING', 'COMPLETED', 'BLOCKED', 'DEFERRED', 'CANCELLED'] as const
export type MilestoneState = (typeof MILESTONE_STATES)[number]
export const TERMINAL_MILESTONE_STATES: readonly MilestoneState[] = ['COMPLETED', 'DEFERRED', 'CANCELLED']

const PROGRAM_TRANSITIONS: Record<ProgramState, readonly ProgramState[]> = {
  DRAFT: ['PLANNING', 'CANCELLED'],
  PLANNING: ['ACTIVE', 'PAUSED', 'WAITING_FOR_QUOTA', 'BLOCKED', 'CANCELLED', 'FAILED'],
  ACTIVE: ['PAUSED', 'WAITING_FOR_QUOTA', 'BLOCKED', 'REPLANNING', 'COMPLETED', 'CANCELLED', 'FAILED'],
  // WAITING_FOR_QUOTA from PAUSED: the user resumed a program while Claude is still limited.
  PAUSED: ['PLANNING', 'ACTIVE', 'REPLANNING', 'WAITING_FOR_QUOTA', 'CANCELLED'],
  WAITING_FOR_QUOTA: ['PLANNING', 'ACTIVE', 'REPLANNING', 'PAUSED', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['PLANNING', 'ACTIVE', 'REPLANNING', 'WAITING_FOR_QUOTA', 'CANCELLED'],
  REPLANNING: ['ACTIVE', 'PAUSED', 'WAITING_FOR_QUOTA', 'BLOCKED', 'COMPLETED', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
}

const MILESTONE_TRANSITIONS: Record<MilestoneState, readonly MilestoneState[]> = {
  PLANNED: ['READY', 'DEFERRED', 'CANCELLED'],
  // BLOCKED from READY: the milestone used all its missions without being accepted.
  READY: ['ACTIVE', 'PLANNED', 'BLOCKED', 'DEFERRED', 'CANCELLED'],
  ACTIVE: ['VERIFYING', 'READY', 'BLOCKED', 'CANCELLED'],
  // A rejected verification sends the milestone back to READY for another mission.
  VERIFYING: ['COMPLETED', 'READY', 'BLOCKED', 'CANCELLED'],
  COMPLETED: [],
  BLOCKED: ['READY', 'DEFERRED', 'CANCELLED'],
  DEFERRED: ['PLANNED', 'CANCELLED'],
  CANCELLED: [],
}

export function canTransitionProgram(from: ProgramState, to: ProgramState): boolean {
  return PROGRAM_TRANSITIONS[from].includes(to)
}

export function canTransitionMilestone(from: MilestoneState, to: MilestoneState): boolean {
  return MILESTONE_TRANSITIONS[from].includes(to)
}

// ───────────────────────────── policy, schedule ─────────────────────────────

export const PROGRAM_PRESETS = ['conservative', 'balanced', 'autonomous'] as const
export type ProgramPreset = (typeof PROGRAM_PRESETS)[number]

export const ProgramPolicySchema = z
  .object({
    preset: z.enum([...PROGRAM_PRESETS, 'custom']),
    /** Active time (not waiting for a usage limit, not paused, not outside a work window). */
    maxDurationMinutes: z.number().int().min(10).max(14 * 24 * 60),
    /** Parallel agents of one mission. */
    maxAgents: z.number().int().min(1).max(16),
    /** Missions running at the same time. 0.4 runs the milestones of a program one after another. */
    maxConcurrentMissions: z.literal(1),
    /** Missions spent on one milestone before it is blocked. */
    maxMissionsPerMilestone: z.number().int().min(1).max(10),
    maxTotalMissions: z.number().int().min(1).max(200),
    /** Plan revisions after the initial plan. */
    maxReplans: z.number().int().min(0).max(50),
    /** Repair tasks one mission may create (passed to the run). */
    maxRepairs: z.number().int().min(0).max(50),
    /** `wait`: a usage limit pauses the program until Claude is available again. `stop`: it pauses for the user. */
    usageBehavior: z.enum(['wait', 'stop']),
    /** Longest single wait for a usage limit before the program is blocked. */
    quotaWaitMaxMinutes: z.number().int().min(5).max(7 * 24 * 60),
    /** Allow the SPECULATIVE strategy when the adaptive policy chooses it. */
    speculation: z.boolean(),
    /** Allow background Arena exploration proposals. Never starts a campaign by itself. */
    arenaExploration: z.boolean(),
    /** `plan`: the user approves the initial plan and every revision. `initial`: only the first plan. `none`: nothing. */
    approvalPolicy: z.enum(['plan', 'initial', 'none']),
    missionStrategy: StrategySchema,
    missionPreset: PresetSchema,
    /** Work only inside the program's schedule windows (when it has any). */
    respectWorkWindows: z.boolean(),
  })
  .strict()
export type ProgramPolicy = z.infer<typeof ProgramPolicySchema>

export const PROGRAM_POLICY_PRESETS: Record<ProgramPreset, ProgramPolicy> = {
  conservative: {
    preset: 'conservative',
    maxDurationMinutes: 8 * 60,
    maxAgents: 2,
    maxConcurrentMissions: 1,
    maxMissionsPerMilestone: 2,
    maxTotalMissions: 10,
    maxReplans: 3,
    maxRepairs: 4,
    usageBehavior: 'stop',
    quotaWaitMaxMinutes: 6 * 60,
    speculation: false,
    arenaExploration: false,
    approvalPolicy: 'plan',
    missionStrategy: 'BUILD',
    missionPreset: 'balanced',
    respectWorkWindows: true,
  },
  balanced: {
    preset: 'balanced',
    maxDurationMinutes: 24 * 60,
    maxAgents: 4,
    maxConcurrentMissions: 1,
    maxMissionsPerMilestone: 3,
    maxTotalMissions: 30,
    maxReplans: 8,
    maxRepairs: 8,
    usageBehavior: 'wait',
    quotaWaitMaxMinutes: 12 * 60,
    speculation: false,
    arenaExploration: false,
    approvalPolicy: 'initial',
    missionStrategy: 'ADAPTIVE',
    missionPreset: 'balanced',
    respectWorkWindows: true,
  },
  autonomous: {
    preset: 'autonomous',
    maxDurationMinutes: 7 * 24 * 60,
    maxAgents: 6,
    maxConcurrentMissions: 1,
    maxMissionsPerMilestone: 4,
    maxTotalMissions: 100,
    maxReplans: 20,
    maxRepairs: 12,
    usageBehavior: 'wait',
    quotaWaitMaxMinutes: 24 * 60,
    speculation: true,
    arenaExploration: true,
    approvalPolicy: 'none',
    missionStrategy: 'ADAPTIVE',
    missionPreset: 'balanced',
    respectWorkWindows: true,
  },
}

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const WorkWindowSchema = z
  .object({
    /** Days the window STARTS on. 0 = Sunday. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    /** Local time, 24 h. A window whose end is not after its start runs past midnight. */
    start: TimeOfDay,
    end: TimeOfDay,
  })
  .strict()
export type WorkWindow = z.infer<typeof WorkWindowSchema>

export const ProgramScheduleSchema = z
  .object({
    windows: z.array(WorkWindowSchema).max(14),
  })
  .strict()
export type ProgramSchedule = z.infer<typeof ProgramScheduleSchema>

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const DAY_MS = 24 * 60 * 60_000

/** The windows that start on the local day containing `dayStart`, as [start, end) epoch intervals. */
function windowsStartingOn(schedule: ProgramSchedule, dayStart: Date): [number, number][] {
  const out: [number, number][] = []
  for (const w of schedule.windows) {
    if (!w.days.includes(dayStart.getDay())) continue
    const start = new Date(dayStart)
    start.setHours(0, minutesOf(w.start), 0, 0)
    const end = new Date(dayStart)
    end.setHours(0, minutesOf(w.end), 0, 0)
    // 22:00 to 07:00 ends on the next local day (a calendar day, so a daylight-saving change is respected).
    if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1)
    out.push([start.getTime(), end.getTime()])
  }
  return out
}

export interface WindowStatus {
  /** True when work may be dispatched now. Always true without windows. */
  open: boolean
  /** When the current window closes (epoch ms); null when closed or without windows. */
  closesAt: number | null
  /** When the next window opens (epoch ms); null when open or without windows. */
  nextOpensAt: number | null
}

/** Where `now` falls in the schedule. Overlapping windows are merged. Pure; uses the local time zone. */
export function windowStatus(schedule: ProgramSchedule | null, now: number): WindowStatus {
  if (!schedule || schedule.windows.length === 0) return { open: true, closesAt: null, nextOpensAt: null }
  const intervals: [number, number][] = []
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  // Yesterday's windows can still be open; the next opening is at most a week away.
  for (let offset = -1; offset <= 8; offset++) {
    const day = new Date(today)
    day.setDate(day.getDate() + offset)
    intervals.push(...windowsStartingOn(schedule, day))
  }
  intervals.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const interval of intervals) {
    const last = merged.at(-1)
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
    else merged.push([interval[0], interval[1]])
  }
  const current = merged.find(([start, end]) => now >= start && now < end)
  if (current) return { open: true, closesAt: current[1], nextOpensAt: null }
  const next = merged.find(([start]) => start > now)
  return { open: false, closesAt: null, nextOpensAt: next ? next[0] : now + 7 * DAY_MS }
}

// ───────────────────────────── plan (planner output) ─────────────────────────────

export const EXPERTISE_AREAS = ['frontend', 'backend', 'reliability', 'security', 'testing', 'architecture'] as const
export const ExpertiseAreaSchema = z.enum(EXPERTISE_AREAS)
export type ExpertiseArea = z.infer<typeof ExpertiseAreaSchema>

const Key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower-case letters, digits and dashes')
const Line = z.string().trim().min(1).max(400)

export const PlannedMilestoneSchema = z
  .object({
    key: Key,
    title: z.string().trim().min(1).max(120),
    /** What must be true when the milestone is done, in one paragraph. Not a task list. */
    objective: z.string().trim().min(1).max(1200),
    acceptanceCriteria: z.array(Line).min(1).max(8),
    workstream: z.string().trim().min(1).max(60),
    expertise: ExpertiseAreaSchema,
    dependsOn: z.array(Key).max(8),
    complexity: z.enum(['small', 'medium', 'large']),
    risk: z.enum(['low', 'medium', 'high']),
  })
  .strict()
export type PlannedMilestone = z.infer<typeof PlannedMilestoneSchema>

/** A program plan is a short list of milestones. The mission planner, not this plan, produces coding tasks. */
export const MAX_PLAN_MILESTONES = 12

export const ProgramPlanSchema = z
  .object({
    goal: z.string().trim().min(1).max(2000),
    successCriteria: z.array(Line).min(1).max(10),
    milestones: z.array(PlannedMilestoneSchema).min(1).max(MAX_PLAN_MILESTONES),
    risks: z.array(Line).max(10),
    constraints: z.array(Line).max(10),
  })
  .strict()
export type ProgramPlan = z.infer<typeof ProgramPlanSchema>

export interface PlanProblem {
  milestone: string | null
  problem: string
}

/** Structural checks the schema cannot express: unique keys, known dependencies, no cycle. */
export function validatePlanStructure(milestones: readonly Pick<PlannedMilestone, 'key' | 'dependsOn'>[], known: readonly string[] = []): PlanProblem[] {
  const problems: PlanProblem[] = []
  const keys = new Set<string>()
  for (const m of milestones) {
    if (keys.has(m.key) || known.includes(m.key)) problems.push({ milestone: m.key, problem: 'duplicate milestone key' })
    keys.add(m.key)
  }
  for (const m of milestones) {
    for (const d of m.dependsOn) {
      if (d === m.key) problems.push({ milestone: m.key, problem: 'depends on itself' })
      else if (!keys.has(d) && !known.includes(d)) problems.push({ milestone: m.key, problem: `depends on unknown milestone ${d}` })
    }
  }
  // Kahn: whatever is left has a cycle.
  const remaining = new Map(milestones.map((m) => [m.key, m.dependsOn.filter((d) => keys.has(d) && d !== m.key)]))
  for (;;) {
    const free = [...remaining.entries()].filter(([, deps]) => deps.every((d) => !remaining.has(d))).map(([k]) => k)
    if (free.length === 0) break
    for (const k of free) remaining.delete(k)
  }
  for (const key of remaining.keys()) problems.push({ milestone: key, problem: 'is part of a dependency cycle' })
  return problems
}

/** What a replanning session returns: the milestones that are not completed yet, as they should be from now on. */
export const ReplanSchema = z
  .object({
    /** `keep`: the remaining plan stands as it is. `revise`: replace it with `milestones`. */
    action: z.enum(['keep', 'revise']),
    reason: z.string().trim().min(1).max(1200),
    milestones: z.array(PlannedMilestoneSchema).max(MAX_PLAN_MILESTONES),
    /** Keys of remaining milestones to defer rather than drop (kept in the roadmap, not worked on). */
    defer: z.array(Key).max(MAX_PLAN_MILESTONES),
    strategyNote: z.string().trim().max(600).nullable(),
  })
  .strict()
export type Replan = z.infer<typeof ReplanSchema>

export interface PlanDiff {
  added: string[]
  removed: string[]
  deferred: string[]
  /** Keys whose title, objective, criteria or dependencies changed. */
  changed: { key: string; fields: string[] }[]
  /** True when the order of the kept milestones changed. */
  reordered: boolean
  before: string[]
  after: string[]
}

type DiffMilestone = Pick<PlannedMilestone, 'key' | 'title' | 'objective' | 'acceptanceCriteria' | 'dependsOn'>

/** Compares the remaining milestones before and after a revision. Pure. */
export function diffPlans(before: readonly DiffMilestone[], after: readonly DiffMilestone[], deferred: readonly string[] = []): PlanDiff {
  const beforeKeys = before.map((m) => m.key)
  const afterKeys = after.map((m) => m.key)
  const added = afterKeys.filter((k) => !beforeKeys.includes(k))
  const removed = beforeKeys.filter((k) => !afterKeys.includes(k) && !deferred.includes(k))
  const changed: PlanDiff['changed'] = []
  for (const a of after) {
    const b = before.find((m) => m.key === a.key)
    if (!b) continue
    const fields: string[] = []
    if (b.title !== a.title) fields.push('title')
    if (b.objective !== a.objective) fields.push('objective')
    if (JSON.stringify(b.acceptanceCriteria) !== JSON.stringify(a.acceptanceCriteria)) fields.push('acceptanceCriteria')
    if (JSON.stringify([...b.dependsOn].sort()) !== JSON.stringify([...a.dependsOn].sort())) fields.push('dependsOn')
    if (fields.length > 0) changed.push({ key: a.key, fields })
  }
  const keptBefore = beforeKeys.filter((k) => afterKeys.includes(k))
  const keptAfter = afterKeys.filter((k) => beforeKeys.includes(k))
  return {
    added,
    removed,
    deferred: beforeKeys.filter((k) => deferred.includes(k)),
    changed,
    reordered: JSON.stringify(keptBefore) !== JSON.stringify(keptAfter),
    before: beforeKeys,
    after: afterKeys,
  }
}

export function isEmptyDiff(diff: PlanDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.deferred.length === 0 && diff.changed.length === 0 && !diff.reordered
}

// ───────────────────────────── backlog, memory (proposals) ─────────────────────────────

export const BACKLOG_CATEGORIES = ['bug', 'debt', 'test_gap', 'performance', 'architecture', 'security', 'documentation'] as const
export const BacklogCategorySchema = z.enum(BACKLOG_CATEGORIES)
export type BacklogCategory = z.infer<typeof BacklogCategorySchema>
export const BACKLOG_STATUSES = ['proposed', 'accepted', 'scheduled', 'done', 'rejected', 'obsolete'] as const
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number]
const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])

/** What an agent, a verifier or a background job may propose. A proposal is never mandatory work. */
export const BacklogProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(2000),
    category: BacklogCategorySchema,
    severity: SeveritySchema,
    /** What was observed: a file and line, a failing command, a measurement. */
    evidence: z.string().trim().min(1).max(2000),
    complexity: z.enum(['small', 'medium', 'large']),
    dependencies: z.array(z.string().trim().min(1).max(160)).max(8),
    recommendedMilestone: z.string().trim().max(60).nullable(),
  })
  .strict()
export type BacklogProposal = z.infer<typeof BacklogProposalSchema>

export interface BacklogProvenance {
  source: 'agent' | 'milestone_verifier' | 'mission_failure' | 'background_job' | 'user'
  runId: string | null
  milestoneKey: string | null
  jobId: string | null
}

export interface BacklogItem extends BacklogProposal {
  id: string
  projectId: string
  /** Null for an item found outside a program (a background job on the project). */
  programId: string | null
  provenance: BacklogProvenance
  status: BacklogStatus
  createdAt: string
  updatedAt: string
}

export const MEMORY_KINDS = ['architecture_decision', 'rejected_approach', 'hazard', 'performance_baseline', 'interface', 'security_constraint', 'failure', 'user_decision'] as const
export const MemoryKindSchema = z.enum(MEMORY_KINDS)
export type ProgramMemoryKind = z.infer<typeof MemoryKindSchema>

export const MemoryProposalSchema = z
  .object({
    kind: MemoryKindSchema,
    title: z.string().trim().min(1).max(160),
    /** The fact itself, a few sentences. Never a transcript. */
    content: z.string().trim().min(1).max(1500),
    evidence: z.string().trim().min(1).max(1500),
    tags: z.array(z.string().trim().min(1).max(40)).max(8),
  })
  .strict()
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>

export interface ProgramMemoryEntry extends MemoryProposal {
  id: string
  programId: string
  projectId: string
  milestoneKey: string | null
  /** Where it came from. Only entries that passed validation are stored. */
  source: { kind: 'milestone_verifier' | 'engine' | 'user'; runId: string | null }
  status: 'active' | 'superseded'
  createdAt: string
}

// ───────────────────────────── milestone verification ─────────────────────────────

/** What the milestone verifier session returns. The engine combines it with the deterministic gates. */
export const MilestoneJudgmentSchema = z
  .object({
    verdict: z.enum(['accepted', 'rejected']),
    criteria: z
      .array(z.object({ criterion: Line, met: z.boolean(), evidence: z.string().trim().min(1).max(800) }).strict())
      .min(1)
      .max(12),
    /** What is missing, when rejected. Becomes the next mission's brief. */
    gaps: z.array(Line).max(10),
    backlog: z.array(BacklogProposalSchema).max(10),
    memory: z.array(MemoryProposalSchema).max(6),
  })
  .strict()
export type MilestoneJudgment = z.infer<typeof MilestoneJudgmentSchema>

export interface MilestoneGate {
  name: 'mission_completed' | 'checks_passed' | 'no_blocking_findings' | 'mission_verified' | 'changes_present' | 'result_readable' | 'builds_on_accepted_work' | 'criteria_judged'
  passed: boolean
  detail: string
}

export interface MilestoneEvidence {
  runId: string
  verifierRunId: string | null
  gates: MilestoneGate[]
  judgment: MilestoneJudgment | null
  verdict: 'accepted' | 'rejected'
  /** Why, in one line: the first failed gate, or the verifier's verdict. */
  reason: string
  resultCommit: string | null
  createdAt: string
}

// ───────────────────────────── entities ─────────────────────────────

export interface ProgramGoal {
  statement: string
  successCriteria: string[]
  constraints: string[]
  risks: string[]
}

export interface ProgramOutcome {
  result: 'completed' | 'failed' | 'cancelled'
  summary: string
  milestonesCompleted: number
  milestonesTotal: number
  missions: number
  replans: number
  finishedAt: string
}

export type ProgramPauseReason = 'user' | 'work_window' | 'usage_policy' | 'restart' | 'approval'

export interface Program {
  id: string
  projectId: string
  name: string
  goal: ProgramGoal
  state: ProgramState
  /** The state to return to from PAUSED, WAITING_FOR_QUOTA or BLOCKED. */
  resumeState: ProgramState | null
  pauseReason: ProgramPauseReason | null
  blockedReason: string | null
  policy: ProgramPolicy
  schedule: ProgramSchedule | null
  /** Version of the accepted plan; 0 before the first plan. */
  planVersion: number
  /** The branch the accepted milestones accumulate on. Never checked out in the user's working tree. */
  branch: string | null
  baseCommit: string | null
  currentMilestoneId: string | null
  /** The run the engine is waiting on (a planner, mission or verifier run). */
  currentRunId: string | null
  currentRunKind: 'planner' | 'mission' | 'verifier' | 'replanner' | null
  /** Milliseconds the program was ACTIVE, PLANNING or REPLANNING. */
  activeMs: number
  /** Set while the active clock runs. */
  activeSince: string | null
  quotaWaitSince: string | null
  missions: number
  replans: number
  outcome: ProgramOutcome | null
  error: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  finishedAt: string | null
}

export interface Workstream {
  id: string
  programId: string
  key: string
  name: string
  expertise: ExpertiseArea
  createdAt: string
}

export interface Milestone {
  id: string
  programId: string
  key: string
  ordinal: number
  title: string
  objective: string
  acceptanceCriteria: string[]
  workstreamId: string | null
  expertise: ExpertiseArea
  dependsOn: string[]
  complexity: 'small' | 'medium' | 'large'
  risk: 'low' | 'medium' | 'high'
  state: MilestoneState
  /** Missions run for this milestone. */
  attempts: number
  /** Gaps of the last rejected verification; the next mission's brief. */
  gaps: string[]
  evidence: MilestoneEvidence | null
  blockedReason: string | null
  /** The plan version that introduced or last changed it. */
  planVersion: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface ProgramMission {
  id: string
  programId: string
  milestoneId: string
  runId: string
  attempt: number
  /** The strategy the run resolved to (recorded when the run ends). */
  strategy: string | null
  outcome: 'running' | 'completed' | 'failed' | 'cancelled'
  baseCommit: string | null
  resultCommit: string | null
  createdAt: string
  finishedAt: string | null
}

export const PROGRAM_DECISION_KINDS = [
  'created',
  'plan_proposed',
  'plan_accepted',
  'plan_rejected',
  'milestone_started',
  'mission_generated',
  'mission_ended',
  'milestone_accepted',
  'milestone_rejected',
  'milestone_blocked',
  'replan_requested',
  'replan_kept',
  'paused',
  'resumed',
  'quota_wait',
  'quota_resumed',
  'window_closed',
  'window_opened',
  'blocked',
  'unblocked',
  'recovered',
  'budget',
  'completed',
  'failed',
  'cancelled',
] as const
export type ProgramDecisionKind = (typeof PROGRAM_DECISION_KINDS)[number]

/** The durable trail of what the engine decided and why. Written by the engine only. */
export interface ProgramDecision {
  id: string
  programId: string
  kind: ProgramDecisionKind
  summary: string
  milestoneId: string | null
  runId: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

export interface ProgramCheckpoint {
  id: string
  programId: string
  reason: string
  snapshot: {
    state: ProgramState
    planVersion: number
    branch: string | null
    branchHead: string | null
    currentMilestone: string | null
    currentRunId: string | null
    milestones: { key: string; state: MilestoneState; attempts: number }[]
    backlog: number
    memory: number
    missions: number
  }
  createdAt: string
}

export interface ProgramPlanRevision {
  id: string
  programId: string
  version: number
  trigger: 'initial' | 'milestone_completed' | 'milestone_rejected' | 'mission_failed' | 'user'
  reason: string
  /** The remaining milestones as proposed (completed milestones are never part of a revision). */
  milestones: PlannedMilestone[]
  deferred: string[]
  diff: PlanDiff
  strategyNote: string | null
  status: 'proposed' | 'accepted' | 'rejected'
  runId: string | null
  createdAt: string
  decidedAt: string | null
}

// ───────────────────────────── expertise, background engineering ─────────────────────────────

/** A logical expertise profile: validated history and metrics of an area. Not a long-lived chat. */
export interface ExpertiseProfile {
  id: string
  projectId: string
  area: ExpertiseArea
  /** Path prefixes this area touched in accepted milestones. */
  projectAreas: string[]
  milestonesAccepted: number
  milestonesRejected: number
  missions: number
  /** Ids of program memory entries relevant to the area. */
  memoryIds: string[]
  updatedAt: string
}

export const BACKGROUND_JOB_KINDS = ['dependency_audit', 'flaky_test_analysis', 'intelligence_refresh', 'dead_code_analysis', 'test_gap_analysis', 'performance_baseline', 'architecture_audit'] as const
export const BackgroundJobKindSchema = z.enum(BACKGROUND_JOB_KINDS)
export type BackgroundJobKind = z.infer<typeof BackgroundJobKindSchema>

export interface BackgroundJob {
  id: string
  projectId: string
  kind: BackgroundJobKind
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  /** The read-only run that did the analysis, when the job needed Claude. */
  runId: string | null
  proposals: number
  summary: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** What a background analysis session returns: proposals only, never changes. */
export const BackgroundFindingsSchema = z
  .object({
    summary: z.string().trim().min(1).max(1200),
    proposals: z.array(BacklogProposalSchema).max(15),
  })
  .strict()
export type BackgroundFindings = z.infer<typeof BackgroundFindingsSchema>

/** Background engineering is off unless the user turns it on, and it only ever proposes. */
export const BackgroundSettingsSchema = z
  .object({
    enabled: z.boolean(),
    kinds: z.array(BackgroundJobKindSchema).max(BACKGROUND_JOB_KINDS.length),
  })
  .strict()
export type BackgroundSettings = z.infer<typeof BackgroundSettingsSchema>
export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = { enabled: false, kinds: [] }

// ───────────────────────────── read models ─────────────────────────────

export interface ProgramSummary {
  program: Program
  milestones: { total: number; completed: number; active: string | null }
  backlogOpen: number
  window: WindowStatus
}

export interface ProgramDetail extends ProgramSummary {
  roadmap: Milestone[]
  workstreams: Workstream[]
  missions: ProgramMission[]
  revisions: ProgramPlanRevision[]
  decisions: ProgramDecision[]
  memory: ProgramMemoryEntry[]
  backlog: BacklogItem[]
  /** `healthy`, or why not, derived from the state and the last decisions. */
  health: { level: 'healthy' | 'waiting' | 'attention' | 'ended'; reason: string }
}

export function programHealth(program: Program, window: WindowStatus): ProgramDetail['health'] {
  switch (program.state) {
    case 'COMPLETED':
      return { level: 'ended', reason: 'The program completed.' }
    case 'CANCELLED':
      return { level: 'ended', reason: 'The program was cancelled.' }
    case 'FAILED':
      return { level: 'attention', reason: program.error ?? 'The program failed.' }
    case 'BLOCKED':
      return { level: 'attention', reason: program.blockedReason ?? 'The program is blocked.' }
    case 'WAITING_FOR_QUOTA':
      return { level: 'waiting', reason: 'Waiting for the Claude usage limit to reset. This is not a failure.' }
    case 'PAUSED':
      if (program.pauseReason === 'work_window') return { level: 'waiting', reason: window.nextOpensAt ? 'Outside the work window.' : 'Paused by the schedule.' }
      if (program.pauseReason === 'approval') return { level: 'attention', reason: 'A plan is waiting for your approval.' }
      return { level: 'waiting', reason: program.pauseReason === 'restart' ? 'Paused by a restart of NEXUS.' : 'Paused.' }
    case 'DRAFT':
      return { level: 'waiting', reason: 'Not started.' }
    default:
      return { level: 'healthy', reason: program.state === 'PLANNING' ? 'Planning milestones.' : program.state === 'REPLANNING' ? 'Reassessing the plan.' : 'Working.' }
  }
}
