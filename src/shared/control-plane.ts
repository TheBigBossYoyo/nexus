import { z } from 'zod'
import { BackgroundJobKindSchema } from './program'

/**
 * NEXUS 0.7: the control plane. One global queue above every kind of workload, one allocation of the
 * machine's agent capacity between them, durable schedules, and a health model. This file is the shared
 * model and the pure decisions; the service that owns the database and the clock is in
 * `src/main/modules/control-plane`.
 */

// ───────────────────────────── work items ─────────────────────────────

export const WORK_ITEM_TYPES = ['mission', 'program', 'arena', 'workspace_mission', 'background_job', 'scheduled_audit'] as const
export const WorkItemTypeSchema = z.enum(WORK_ITEM_TYPES)
export type WorkItemType = z.infer<typeof WorkItemTypeSchema>

export const WORK_ITEM_TYPE_LABEL: Record<WorkItemType, string> = {
  mission: 'Mission',
  program: 'Program',
  arena: 'Arena campaign',
  workspace_mission: 'Workspace mission',
  background_job: 'Background job',
  scheduled_audit: 'Scheduled audit',
}

/** P0 is the most urgent. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export const PrioritySchema = z.enum(PRIORITIES)
export type Priority = z.infer<typeof PrioritySchema>
export const DEFAULT_PRIORITY: Priority = 'P2'

export const WORK_ITEM_STATES = ['QUEUED', 'READY', 'RUNNING', 'PAUSED', 'QUOTA_WAIT', 'BLOCKED', 'SCHEDULED', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const
export type WorkItemState = (typeof WORK_ITEM_STATES)[number]
export const TERMINAL_WORK_ITEM_STATES: readonly WorkItemState[] = ['COMPLETED', 'FAILED', 'CANCELLED']
/** States in which an item holds, or may be given, agent capacity. */
export const LIVE_WORK_ITEM_STATES: readonly WorkItemState[] = ['RUNNING', 'QUOTA_WAIT', 'FINALIZING']

/**
 * What the workload behind an item is doing, as its own engine reports it. The control plane never keeps a
 * second truth about a workload: an item's state is derived from this.
 */
export type WorkloadPhase = 'not_started' | 'working' | 'finalizing' | 'paused' | 'quota_wait' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'missing'

export interface WorkloadSnapshot {
  phase: WorkloadPhase
  /** Agent sessions of this workload that are running now. */
  activeAgents: number
  /** The runs that currently belong to this workload; capacity is granted through them. */
  runIds: string[]
  detail: string | null
}

export interface GlobalWorkItem {
  id: string
  type: WorkItemType
  /** The workload this item stands for (run, program, campaign, workspace mission), once it exists. */
  refId: string | null
  title: string
  priority: Priority
  /** Order within the queue; lower runs first among equal priority. Persisted. */
  position: number
  state: WorkItemState
  /** The most agents this item should hold at once. */
  requestedAgents: number
  deadlineAt: string | null
  /** For `SCHEDULED`: when it becomes `QUEUED`. */
  notBefore: string | null
  /** The schedule that created it, if any. */
  scheduleId: string | null
  /** True when the user paused it here; the scheduler does not resume it by itself. */
  heldByUser: boolean
  /** What starting the workload needs, when the item is queued before the workload exists. */
  payload: Record<string, unknown> | null
  detail: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** The item state that corresponds to what the workload reports. */
export function stateFromPhase(phase: WorkloadPhase, current: WorkItemState, heldByUser: boolean): WorkItemState {
  switch (phase) {
    case 'working':
      return 'RUNNING'
    case 'finalizing':
      return 'FINALIZING'
    case 'quota_wait':
      return 'QUOTA_WAIT'
    case 'paused':
      return 'PAUSED'
    case 'blocked':
      return 'BLOCKED'
    case 'completed':
      return 'COMPLETED'
    case 'failed':
    case 'missing':
      return 'FAILED'
    case 'cancelled':
      return 'CANCELLED'
    case 'not_started':
      // Not started yet: it stays where the queue put it.
      return heldByUser ? 'PAUSED' : current === 'SCHEDULED' || current === 'READY' ? current : 'QUEUED'
  }
}

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** Queue order: priority, then the earlier deadline, then the persisted position, then age. */
export function compareWorkItems(a: GlobalWorkItem, b: GlobalWorkItem): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (a.deadlineAt ?? '9999').localeCompare(b.deadlineAt ?? '9999') ||
    a.position - b.position ||
    a.createdAt.localeCompare(b.createdAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

// ───────────────────────────── allocation ─────────────────────────────

export const ControlLimitsSchema = z
  .object({
    /** Agent sessions across every workload at once. */
    maxAgents: z.number().int().min(1).max(32),
    /** Workloads running at once. */
    maxActiveItems: z.number().int().min(1).max(16),
    /** After a restart of NEXUS: continue what was running, or leave everything paused for the user. */
    resumeOnBoot: z.enum(['resume', 'hold']),
    /**
     * Fairness: a waiting item is treated as one priority higher for every this many minutes it has waited,
     * so lower-priority work is not kept out for good by a stream of higher-priority work. 0 switches it off.
     */
    agingMinutes: z.number().int().min(0).max(1440).default(30),
  })
  .strict()
export type ControlLimits = z.infer<typeof ControlLimitsSchema>
export const DEFAULT_CONTROL_LIMITS: ControlLimits = { maxAgents: 6, maxActiveItems: 4, resumeOnBoot: 'hold', agingMinutes: 30 }

export interface AllocationInput {
  items: readonly GlobalWorkItem[]
  /** Running agent sessions per item id. */
  active: ReadonlyMap<string, number>
  limits: ControlLimits
  /** False while the Claude usage gate is closed: nothing new starts and no capacity is granted. */
  claudeAvailable: boolean
  /** True while the user paused dispatch: nothing starts and nothing more is granted; what runs keeps running. */
  paused?: boolean
  /** The present time, for aging. Absent: no aging. */
  now?: number
}

/**
 * The priority an item is served with: its own, raised by one for every `agingMinutes` it has waited without
 * starting. Only items that have not started age; a running item keeps its own priority.
 */
export function effectivePriority(item: Pick<GlobalWorkItem, 'priority' | 'state' | 'createdAt' | 'startedAt'>, now: number | undefined, agingMinutes: number): Priority {
  if (now === undefined || agingMinutes <= 0 || item.startedAt !== null || (item.state !== 'QUEUED' && item.state !== 'READY')) return item.priority
  const waited = Math.max(0, now - Date.parse(item.createdAt))
  const steps = Math.floor(waited / (agingMinutes * 60_000))
  return PRIORITIES[Math.max(0, PRIORITY_RANK[item.priority] - steps)] ?? item.priority
}

/** The order in which capacity is handed out: queue order with aging applied. Deterministic. */
export function serviceOrder<T extends GlobalWorkItem>(items: readonly T[], now: number | undefined, agingMinutes: number): T[] {
  return items
    .map((item) => ({ item, served: { ...item, priority: effectivePriority(item, now, agingMinutes) } }))
    .sort((a, b) => compareWorkItems(a.served, b.served))
    .map((x) => x.item)
}

export interface Allocation {
  /** Agent sessions each live item may hold now. Never below what it already runs. */
  allowance: Map<string, number>
  /** Queued items to start now, in order. */
  admit: string[]
  /** Queued items that could start but for capacity, with the reason shown to the user. */
  waiting: Map<string, string>
  /** Capacity left after every grant. */
  free: number
}

/**
 * Divides the machine's agent capacity. Deterministic and side-effect free.
 *
 * - Sessions that are running are never taken away: capacity is what is left beside them.
 * - Free capacity goes to items in queue order, so a higher priority gets it first. A lower-priority item
 *   that is already running keeps its sessions and gets no new one until the higher priority has what it asked for.
 * - A queued item starts only when at least one session can be granted to it and a workload slot is free.
 * - While Claude is unavailable, or dispatch is paused, nothing starts and nothing more is granted.
 * - A waiting item rises one priority for every `agingMinutes` it has waited, so it is not starved.
 */
export function allocate(input: AllocationInput): Allocation {
  const { limits } = input
  const ordered = serviceOrder(input.items, input.now, limits.agingMinutes ?? 0)
  const open = !input.paused && input.claudeAvailable
  const live = ordered.filter((i) => LIVE_WORK_ITEM_STATES.includes(i.state))
  const queued = ordered.filter((i) => (i.state === 'QUEUED' || i.state === 'READY') && !i.heldByUser)
  const activeOf = (id: string): number => Math.max(0, input.active.get(id) ?? 0)
  const allowance = new Map<string, number>()
  const admit: string[] = []
  const waiting = new Map<string, string>()
  let free = Math.max(0, limits.maxAgents - live.reduce((n, i) => n + activeOf(i.id), 0))
  let slots = Math.max(0, limits.maxActiveItems - live.length)

  // One pass in queue order over running and startable items together, so a queued P0 is served before a running P2.
  for (const item of ordered) {
    const isLive = LIVE_WORK_ITEM_STATES.includes(item.state)
    const isQueued = queued.includes(item)
    if (!isLive && !isQueued) continue
    const active = activeOf(item.id)
    const want = Math.max(1, item.requestedAgents)
    if (isLive) {
      const extra = open && item.state === 'RUNNING' ? Math.min(Math.max(0, want - active), free) : 0
      allowance.set(item.id, active + extra)
      free -= extra
      continue
    }
    if (input.paused) {
      waiting.set(item.id, 'Dispatch is paused. Nothing new starts until you resume it.')
      continue
    }
    if (!input.claudeAvailable) {
      waiting.set(item.id, 'Waiting for the Claude usage limit to reset.')
      continue
    }
    if (slots <= 0) {
      waiting.set(item.id, `Waiting for a workload slot (${limits.maxActiveItems} run at once).`)
      continue
    }
    if (free <= 0) {
      const ahead = ordered.find((other) => other.id !== item.id && allowance.has(other.id) && PRIORITY_RANK[other.priority] < PRIORITY_RANK[item.priority])
      waiting.set(item.id, ahead ? `Waiting for agent capacity: higher-priority work is active (${ahead.priority} "${ahead.title}").` : `Waiting for agent capacity (${limits.maxAgents} agents in use or reserved).`)
      continue
    }
    const grant = Math.min(want, free)
    allowance.set(item.id, grant)
    admit.push(item.id)
    free -= grant
    slots -= 1
  }
  return { allowance, admit, waiting, free }
}

// ───────────────────────────── schedules ─────────────────────────────

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
export const WeekdaySchema = z.enum(WEEKDAYS)
export type Weekday = z.infer<typeof WeekdaySchema>

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time as HH:MM')

/** When a schedule fires, in the computer's local time. */
export const ScheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: TimeOfDay }).strict(),
  z.object({ kind: z.literal('weekly'), day: WeekdaySchema, time: TimeOfDay }).strict(),
  z.object({ kind: z.literal('once'), at: z.string().datetime() }).strict(),
])
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>

/** What a schedule puts on the queue when it fires. */
export const ScheduleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('program'), programId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('arena'), campaignId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('workspace_mission'), missionId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('scheduled_audit'), projectId: z.string().min(1).max(64), kind: BackgroundJobKindSchema }).strict(),
])
export type ScheduleAction = z.infer<typeof ScheduleActionSchema>

export const ScheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    rule: ScheduleRuleSchema,
    action: ScheduleActionSchema,
    priority: PrioritySchema,
    enabled: z.boolean(),
  })
  .strict()
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>

export interface Schedule extends ScheduleInput {
  id: string
  /** The next time it fires; null for a one-time schedule that has fired or a disabled one. */
  nextRunAt: string | null
  lastRunAt: string | null
  /** What happened the last time: the item it queued, or why it queued none. */
  lastResult: string | null
  createdAt: string
  updatedAt: string
}

/**
 * The first moment strictly after `after` at which the rule fires, in local time. `offsetMinutes` is the
 * local zone's offset for tests; by default the computer's own zone is used through `Date`.
 */
export function nextOccurrence(rule: ScheduleRule, after: Date): Date | null {
  if (rule.kind === 'once') {
    const at = new Date(rule.at)
    return at.getTime() > after.getTime() ? at : null
  }
  const [hour, minute] = rule.time.split(':').map(Number) as [number, number]
  // Local wall-clock arithmetic through the Date fields, so a daylight-saving change moves the instant, not the time shown.
  for (let add = 0; add <= 8; add++) {
    const candidate = new Date(after.getFullYear(), after.getMonth(), after.getDate() + add, hour, minute, 0, 0)
    if (candidate.getTime() <= after.getTime()) continue
    if (rule.kind === 'weekly' && WEEKDAYS[candidate.getDay()] !== rule.day) continue
    return candidate
  }
  return null
}

/**
 * Whether a schedule is due, and what its next time is afterwards. A schedule that was due while NEXUS was not
 * running fires once when NEXUS is back, not once per missed occurrence.
 */
export function scheduleDue(schedule: Pick<Schedule, 'enabled' | 'nextRunAt' | 'rule'>, now: Date): { due: boolean; nextRunAt: string | null } {
  if (!schedule.enabled || !schedule.nextRunAt) return { due: false, nextRunAt: schedule.nextRunAt }
  if (Date.parse(schedule.nextRunAt) > now.getTime()) return { due: false, nextRunAt: schedule.nextRunAt }
  return { due: true, nextRunAt: nextOccurrence(schedule.rule, now)?.toISOString() ?? null }
}

export function describeRule(rule: ScheduleRule): string {
  if (rule.kind === 'daily') return `Every day at ${rule.time}`
  if (rule.kind === 'weekly') return `Every ${rule.day[0]?.toUpperCase()}${rule.day.slice(1)} at ${rule.time}`
  return `Once at ${rule.at}`
}

// ───────────────────────────── health ─────────────────────────────

export const HEALTH_COMPONENTS = ['database', 'scheduler', 'workers', 'providers', 'git', 'usage', 'power_supervisor', 'ipc', 'schedules'] as const
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number]
export type HealthLevel = 'HEALTHY' | 'DEGRADED' | 'RECOVERING' | 'BLOCKED'

export interface ComponentHealth {
  component: HealthComponent
  level: HealthLevel
  detail: string
  checkedAt: string
}

const HEALTH_RANK: Record<HealthLevel, number> = { HEALTHY: 0, RECOVERING: 1, DEGRADED: 2, BLOCKED: 3 }

/** The runtime is as healthy as its worst component. Recovery in progress outranks healthy, and is outranked by a fault. */
export function overallHealth(components: readonly ComponentHealth[]): HealthLevel {
  return components.reduce<HealthLevel>((worst, c) => (HEALTH_RANK[c.level] > HEALTH_RANK[worst] ? c.level : worst), 'HEALTHY')
}

// ───────────────────────────── notifications ─────────────────────────────

export const NOTIFICATION_KINDS = ['milestone_completed', 'quota_paused', 'quota_resumed', 'program_blocked', 'workload_blocked', 'arena_regression', 'overnight_completed', 'security_high', 'work_item_failed', 'schedule_started', 'boundary_request', 'isolation_failure'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export interface NotificationRecord {
  kind: NotificationKind
  /** What it is about; two notifications of one kind about one subject within the quiet period are one. */
  subject: string
  at: number
}

/** The shortest time between two notifications of the same kind about the same subject. */
export const NOTIFICATION_QUIET_MS = 10 * 60_000
/** No more than this many notifications of any kind in a quarter of an hour. */
export const NOTIFICATION_BURST = 4
export const NOTIFICATION_BURST_WINDOW_MS = 15 * 60_000

/** Whether a notification may be shown, given what was shown before. Restraint is the rule, not the exception. */
export function mayNotify(candidate: NotificationRecord, shown: readonly NotificationRecord[]): boolean {
  const recent = shown.filter((n) => candidate.at - n.at < NOTIFICATION_BURST_WINDOW_MS && n.at <= candidate.at)
  if (recent.some((n) => n.kind === candidate.kind && n.subject === candidate.subject && candidate.at - n.at < NOTIFICATION_QUIET_MS)) return false
  return recent.length < NOTIFICATION_BURST
}

// ───────────────────────────── read model ─────────────────────────────

export interface ControlPlaneOverview {
  health: { level: HealthLevel; components: ComponentHealth[] }
  limits: ControlLimits
  /** Agent sessions running now, and the limit. */
  agents: { active: number; max: number }
  claudeAvailable: boolean
  active: (GlobalWorkItem & { activeAgents: number; allowance: number })[]
  waiting: (GlobalWorkItem & { reason: string })[]
  scheduled: GlobalWorkItem[]
  /** The newest finished items. */
  finished: GlobalWorkItem[]
  schedules: Schedule[]
  /** The newest incidents: failures, blocks, recoveries. */
  incidents: { at: string; summary: string; itemId: string | null }[]
  bootedAt: string
  /** True while the user paused the start of new work. */
  dispatchPaused: boolean
  /** Worker processes: how many exist, how many hold a session, and the limit. Null when sessions run in the runtime itself. */
  workers: { live: number; busy: number; max: number } | null
}

export const EnqueueInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('program'), programId: z.string().min(1).max(64), priority: PrioritySchema.optional() }).strict(),
  z.object({ type: z.literal('arena'), campaignId: z.string().min(1).max(64), priority: PrioritySchema.optional() }).strict(),
  z.object({ type: z.literal('workspace_mission'), missionId: z.string().min(1).max(64), priority: PrioritySchema.optional() }).strict(),
  z.object({ type: z.literal('scheduled_audit'), projectId: z.string().min(1).max(64), kind: BackgroundJobKindSchema, priority: PrioritySchema.optional() }).strict(),
])
export type EnqueueInput = z.infer<typeof EnqueueInputSchema>
