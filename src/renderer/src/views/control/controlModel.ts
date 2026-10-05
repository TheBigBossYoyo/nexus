import {
  describeRule,
  WORK_ITEM_TYPE_LABEL,
  type ControlPlaneOverview,
  type GlobalWorkItem,
  type HealthLevel,
  type Priority,
  type Schedule,
  type ScheduleAction,
  type ScheduleInput,
  type WorkItemState,
  type WorkItemType,
} from '@shared/control-plane'
import { BACKGROUND_JOB_KINDS, type BackgroundJobKind } from '@shared/program'
import type { Tone } from '../../lib/status'

/** DOM-free model of the Control Center: every label and every enabled/disabled decision is made here and tested. */

export const HEALTH_LABEL: Record<HealthLevel, { tone: Tone; label: string }> = {
  HEALTHY: { tone: 'success', label: 'Runtime healthy' },
  RECOVERING: { tone: 'waiting', label: 'Runtime recovering' },
  DEGRADED: { tone: 'warning', label: 'Runtime degraded' },
  BLOCKED: { tone: 'danger', label: 'Runtime blocked' },
}

export const COMPONENT_LABEL: Record<string, string> = {
  database: 'Database',
  scheduler: 'Global scheduler',
  workers: 'Worker manager',
  providers: 'Providers',
  git: 'Git',
  usage: 'Usage',
  power_supervisor: 'Power',
  ipc: 'IPC',
  schedules: 'Schedules',
}

export const STATE_LABEL: Record<WorkItemState, { tone: Tone; label: string }> = {
  QUEUED: { tone: 'neutral', label: 'Queued' },
  READY: { tone: 'neutral', label: 'Ready' },
  RUNNING: { tone: 'active', label: 'Running' },
  PAUSED: { tone: 'neutral', label: 'Paused' },
  QUOTA_WAIT: { tone: 'waiting', label: 'Waiting for usage' },
  BLOCKED: { tone: 'warning', label: 'Blocked' },
  SCHEDULED: { tone: 'neutral', label: 'Scheduled' },
  FINALIZING: { tone: 'active', label: 'Finalizing' },
  COMPLETED: { tone: 'success', label: 'Completed' },
  FAILED: { tone: 'danger', label: 'Failed' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
}

export const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'P0', label: 'P0 · urgent' },
  { value: 'P1', label: 'P1 · high' },
  { value: 'P2', label: 'P2 · normal' },
  { value: 'P3', label: 'P3 · low' },
]

/** An item as the overview delivers it: active items carry sessions, waiting items carry a reason. */
export type ControlItem = GlobalWorkItem & {
  activeAgents?: number
  allowance?: number
  reason?: string
}

export function capacityLine(
  o: Pick<ControlPlaneOverview, 'agents' | 'active' | 'limits' | 'claudeAvailable'>,
): string {
  const base = `${o.agents.active} of ${o.agents.max} agents in use · ${o.active.length} of ${o.limits.maxActiveItems} workloads running`
  return o.claudeAvailable
    ? base
    : `${base} · waiting for the Claude usage limit: nothing new starts`
}

/** A running item whose first session has not shown up yet reads "Starting…" for this long. */
export const STARTING_WINDOW_MS = 60_000

export function itemLine(item: ControlItem, nowMs?: number): string {
  const type = WORK_ITEM_TYPE_LABEL[item.type]
  if (item.activeAgents === undefined || item.allowance === undefined) return type
  if (item.activeAgents === 0 && isStarting(item, nowMs)) return `${type} · Starting…`
  return `${type} · ${item.activeAgents} agent${item.activeAgents === 1 ? '' : 's'} running, may hold ${item.allowance}`
}

/** Just started: running, no session yet, nothing else explains the silence (an approval wait, a note from the engine). */
export function isStarting(
  item: Pick<GlobalWorkItem, 'state' | 'startedAt' | 'detail'> & { activeAgents?: number },
  nowMs: number = Date.now(),
): boolean {
  if (item.state !== 'RUNNING' || (item.activeAgents ?? 0) > 0 || item.detail) return false
  if (!item.startedAt) return false
  const age = nowMs - Date.parse(item.startedAt)
  return Number.isFinite(age) && age < STARTING_WINDOW_MS
}

export interface ItemActions {
  pause: boolean
  resume: boolean
  cancel: boolean
  reorder: boolean
}

/** What the user can do with an item now. A held item is released; a blocked one is resolved in its own page. */
export function itemActions(
  item: Pick<GlobalWorkItem, 'state' | 'heldByUser' | 'type'>,
): ItemActions {
  const terminal =
    item.state === 'COMPLETED' || item.state === 'FAILED' || item.state === 'CANCELLED'
  const live = item.state === 'RUNNING' || item.state === 'QUOTA_WAIT'
  return {
    // A background job cannot be paused, only cancelled.
    pause:
      !terminal &&
      !item.heldByUser &&
      (live || item.state === 'QUEUED' || item.state === 'READY') &&
      item.type !== 'background_job' &&
      item.type !== 'scheduled_audit',
    resume: !terminal && (item.heldByUser || item.state === 'PAUSED'),
    cancel: !terminal,
    reorder: item.state === 'QUEUED' || item.state === 'READY' || item.state === 'PAUSED',
  }
}

/** One verb pair everywhere: Hold and Release. */
export const HOLD_LABEL = 'Hold'
export const RELEASE_LABEL = 'Release'

/** The button label for cancelling: an item that never started is only taken off the queue. */
export function cancelLabel(item: Pick<GlobalWorkItem, 'state' | 'startedAt' | 'heldByUser'>): string {
  return hasStarted(item) ? 'Cancel' : 'Remove'
}

// ───────────────────────────── cancel and delete confirmation ─────────────────────────────

/**
 * Whether the workload behind an item has started, as the control plane sees it. The service cancels the
 * workload itself only when it has started (`service.ts` cancel); a never-started item is only taken off the queue.
 */
export function hasStarted(
  item: Pick<GlobalWorkItem, 'state' | 'startedAt' | 'heldByUser'>,
): boolean {
  if (item.startedAt) return true
  if (item.state === 'RUNNING' || item.state === 'QUOTA_WAIT' || item.state === 'FINALIZING' || item.state === 'BLOCKED') return true
  // Paused by the system (a restart, a usage wait) means it was running; a hold on a queued item is not a start.
  return item.state === 'PAUSED' && !item.heldByUser
}

export interface Confirmation {
  title: string
  /** What stops. */
  lines: string[]
  /** What is kept and what is lost: stated per workload type. */
  preserved: string[]
  confirmLabel: string
  /** The safe choice. */
  keepLabel: string
}

/**
 * What a cancel of each workload type does, read from the engines (the sources are named in the report that
 * came with this change; keep them in step when an engine changes):
 * - mission: `Orchestrator.cancelRun` marks the run and its open tasks cancelled and stops the sessions.
 *   It removes no worktree and no branch: `cleanupRun` is a separate action on a finished run.
 * - program: `ProgramEngine.cancel` cancels the current run, marks unfinished milestones cancelled and rejects a plan revision that waits.
 * - arena: `ArenaCampaignEngine.cancel` cancels queued trials and stops running trials.
 * - workspace mission: `WorkspaceEngine.cancelMission` cancels live runs and marks every task that is not completed cancelled.
 * - background job / audit: `BackgroundJobs.cancel` cancels the analysis run; its findings are only recorded from a completed run.
 */
export const CANCEL_PRESERVATION: Record<WorkItemType, string[]> = {
  mission: [
    'Tasks that already finished keep their results and branches.',
    'Tasks still open are cancelled and nothing of them is merged.',
    'NEXUS does not delete the run’s worktrees or branches when it is cancelled; they stay until you clean them up.',
  ],
  program: [
    'The current mission is cancelled as above. Milestones that already completed keep their work.',
    'Every milestone that is not finished is marked cancelled, and a plan revision that waits for your decision is rejected.',
    'Worktrees and branches are not deleted.',
  ],
  arena: [
    'Trials that already finished keep their results.',
    'Trials that have not started are cancelled; trials in progress are stopped and end as cancelled.',
  ],
  workspace_mission: [
    'Tasks that already completed keep their work in their repositories.',
    'Every task that is not completed is marked cancelled and nothing more is integrated.',
    'Worktrees and branches are not deleted.',
  ],
  background_job: ['The analysis is cancelled and records no findings.'],
  scheduled_audit: ['The analysis is cancelled and records no findings.'],
}

/**
 * The cancel rule. An item that never started is only taken off the queue: nothing runs, nothing is lost and it can be
 * queued again, so it is removed without a question. Anything that started (running, waiting for usage, blocked,
 * paused by the system or held after running) asks first, because its sessions are stopped, not drained.
 */
export function cancelConfirmation(item: ControlItem): Confirmation | null {
  if (!hasStarted(item)) return null
  const type = WORK_ITEM_TYPE_LABEL[item.type]
  const agents = item.activeAgents
  const stops =
    agents === undefined || item.state === 'BLOCKED' || item.state === 'PAUSED'
      ? 'Any agent session it is running is stopped at once; it is not allowed to finish.'
      : agents === 0
        ? 'No agent session is running at this moment.'
        : `${agents} running agent session${agents === 1 ? '' : 's'} will be stopped at once; ${agents === 1 ? 'it is' : 'they are'} not allowed to finish.`
  return {
    title: `Cancel “${item.title}”?`,
    lines: [`${type}: ${item.title}`, stops, 'A cancelled workload cannot be resumed.'],
    preserved: CANCEL_PRESERVATION[item.type],
    confirmLabel: 'Cancel workload',
    keepLabel: item.state === 'RUNNING' || item.state === 'QUOTA_WAIT' ? 'Keep it running' : 'Keep it',
  }
}

/** Deleting a schedule always asks. Work the schedule already queued is not touched. */
export function scheduleDeleteConfirmation(
  schedule: Pick<Schedule, 'id' | 'name' | 'enabled'>,
  items: readonly Pick<GlobalWorkItem, 'scheduleId' | 'title' | 'state'>[],
): Confirmation {
  const open = items.filter(
    (i) =>
      i.scheduleId === schedule.id &&
      i.state !== 'COMPLETED' &&
      i.state !== 'FAILED' &&
      i.state !== 'CANCELLED',
  )
  return {
    title: `Delete the schedule “${schedule.name}”?`,
    lines: [
      'It will not queue work again. This cannot be undone.',
      schedule.enabled
        ? 'To stop it for a while without losing it, switch it off instead.'
        : 'It is switched off now.',
    ],
    preserved:
      open.length === 0
        ? ['No work from this schedule is on the queue now.']
        : [
            `${open.length === 1 ? 'The workload' : `${open.length} workloads`} it already queued (${open
              .slice(0, 3)
              .map((i) => `“${i.title}”`)
              .join(', ')}${open.length > 3 ? ', …' : ''}) stay${open.length === 1 ? 's' : ''} on the queue and ${open.length === 1 ? 'is' : 'are'} not cancelled.`,
          ],
    confirmLabel: 'Delete schedule',
    keepLabel: 'Keep schedule',
  }
}

// ───────────────────────────── blocked and failed ─────────────────────────────

export type Emphasis = 'normal' | 'attention' | 'failure'

export interface ItemPresentation {
  emphasis: Emphasis
  tone: Tone
  /** The badge text; never colour alone. */
  label: string
  /** "Blocked because" / "Failed because" / null for ordinary items. */
  reasonLabel: string | null
  reasonText: string | null
  /** What the user can do about it. */
  hint: string | null
}

const OWN_PAGE: Record<WorkItemType, string> = {
  mission: 'the run page',
  program: 'the Programs page',
  arena: 'the Arena page',
  workspace_mission: 'the Workspaces page',
  background_job: 'its own page',
  scheduled_audit: 'its own page',
}

/** How an item is shown: BLOCKED and FAILED are never styled like an ordinary queued job. */
export function itemPresentation(item: ControlItem): ItemPresentation {
  const base = STATE_LABEL[item.state]
  const reason = (item.reason ?? item.detail ?? '').trim()
  if (item.state === 'BLOCKED') {
    return {
      emphasis: 'attention',
      tone: 'warning',
      label: 'Blocked',
      reasonLabel: 'Blocked because',
      reasonText: reason || 'No reason was recorded.',
      hint: `It does not start by itself. Resolve the cause on ${OWN_PAGE[item.type]}.`,
    }
  }
  if (item.state === 'FAILED') {
    return {
      emphasis: 'failure',
      tone: 'danger',
      label: 'Failed',
      reasonLabel: 'Failed because',
      reasonText: reason || 'No reason was recorded.',
      hint: `Look at it on ${OWN_PAGE[item.type]}.`,
    }
  }
  return {
    emphasis: 'normal',
    tone: base.tone,
    label: item.heldByUser && item.state !== 'RUNNING' ? 'Held' : base.label,
    reasonLabel: null,
    reasonText: reason || null,
    hint: null,
  }
}

// ───────────────────────────── load and mutation errors ─────────────────────────────

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message: unknown }).message
    if (typeof m === 'string' && m) return m
  }
  return 'Something went wrong and no reason was given.'
}

export type LoadState =
  | { kind: 'loading' }
  /** Nothing to show: say why and offer Retry. */
  | { kind: 'error'; message: string }
  /** `stale` is set when a refresh failed and the page shows the last data it had. */
  | { kind: 'ready'; stale: string | null }

/** Never a permanent "Loading…": a failed first load is an error state, a failed refresh is a notice above the data. */
export function loadState(q: { hasData: boolean; isError: boolean; error: unknown }): LoadState {
  if (q.hasData) return { kind: 'ready', stale: q.isError ? describeError(q.error) : null }
  if (q.isError) return { kind: 'error', message: describeError(q.error) }
  return { kind: 'loading' }
}

/** The text a screen reader hears when the queue changes; empty when nothing changed that matters. */
export function queueAnnouncement(
  previous: ReadonlyMap<string, WorkItemState> | null,
  items: readonly Pick<GlobalWorkItem, 'id' | 'title' | 'state'>[],
): string {
  if (!previous) return ''
  const parts: string[] = []
  for (const i of items) {
    const before = previous.get(i.id)
    if (before === i.state) continue
    parts.push(`${i.title}: ${before ? 'now ' : 'added, '}${STATE_LABEL[i.state].label.toLowerCase()}`)
  }
  return parts.slice(0, 4).join('. ')
}

// ───────────────────────────── inspector ─────────────────────────────

export interface InspectorFact {
  label: string
  value: string
}

export interface Inspector {
  presentation: ItemPresentation
  type: string
  /** "Why is this waiting?" in a sentence; null when the item is not waiting. */
  why: string | null
  facts: InspectorFact[]
  events: { at: string; summary: string }[]
}

const iso = (value: string | null): string | null =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : null

/**
 * What the inspector shows, from the data the overview already holds. Fields the overview does not carry (the
 * provider, a usage note) say so instead of being left out.
 */
export function inspectorOf(
  item: ControlItem,
  overview: Pick<ControlPlaneOverview, 'schedules' | 'incidents'>,
): Inspector {
  const presentation = itemPresentation(item)
  const schedule = item.scheduleId
    ? (overview.schedules.find((s) => s.id === item.scheduleId) ?? null)
    : null
  const waiting = ['QUEUED', 'READY', 'PAUSED', 'QUOTA_WAIT', 'BLOCKED', 'SCHEDULED'].includes(item.state)
  const why = !waiting
    ? null
    : item.reason ||
      (item.state === 'SCHEDULED' && item.notBefore
        ? `Scheduled for ${iso(item.notBefore)}.`
        : item.heldByUser
          ? 'Held by you.'
          : (item.detail ?? null))
  const agents =
    item.activeAgents === undefined
      ? `${item.requestedAgents} requested`
      : `${item.activeAgents} running · ${item.allowance ?? item.activeAgents} granted · ${item.requestedAgents} requested`
  const facts: InspectorFact[] = [
    { label: 'State', value: presentation.label },
    { label: 'Priority', value: PRIORITY_OPTIONS.find((p) => p.value === item.priority)?.label ?? item.priority },
    { label: 'Agents', value: agents },
    { label: 'Provider', value: 'Not reported by the queue' },
    { label: 'Usage', value: 'Not reported per workload' },
    { label: 'Deadline', value: iso(item.deadlineAt) ?? 'None' },
    {
      label: 'Schedule',
      value: item.scheduleId
        ? schedule
          ? `${schedule.name} · ${describeRule(schedule.rule)}`
          : 'A schedule that no longer exists'
        : 'Not created by a schedule',
    },
    { label: 'Added', value: iso(item.createdAt) ?? '—' },
    { label: 'Started', value: iso(item.startedAt) ?? 'Not started' },
  ]
  if (item.finishedAt) facts.push({ label: 'Finished', value: iso(item.finishedAt) ?? '—' })
  return {
    presentation,
    type: WORK_ITEM_TYPE_LABEL[item.type],
    why,
    facts,
    events: overview.incidents
      .filter((e) => e.itemId === item.id)
      .slice(0, 10)
      .map((e) => ({ at: e.at, summary: e.summary })),
  }
}

// ───────────────────────────── schedules ─────────────────────────────

export function scheduleLine(schedule: Schedule, now: Date): string {
  const rule =
    schedule.rule.kind === 'once'
      ? `Once on ${new Date(schedule.rule.at).toLocaleString()}`
      : describeRule(schedule.rule)
  if (!schedule.enabled) return `${rule} · off`
  if (!schedule.nextRunAt) return `${rule} · no further run`
  const next = new Date(schedule.nextRunAt)
  const sameDay = next.toDateString() === now.toDateString()
  return `${rule} · next ${sameDay ? 'today' : next.toLocaleDateString(undefined, { weekday: 'long' })} ${next.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export function actionLine(action: ScheduleAction, names: { program?: string | null }): string {
  switch (action.type) {
    case 'program':
      return `Continue the program ${names.program ? `"${names.program}"` : action.programId}`
    case 'arena':
      return 'Run the Arena campaign'
    case 'workspace_mission':
      return 'Continue the workspace mission'
    case 'scheduled_audit':
      return `Run a ${action.kind.replace(/_/g, ' ')}`
  }
}

export type ScheduleActionType = ScheduleAction['type']

export const SCHEDULE_ACTION_OPTIONS: { value: ScheduleActionType; label: string; target: string }[] = [
  { value: 'program', label: 'Continue a program', target: 'Program' },
  { value: 'arena', label: 'Run an Arena campaign', target: 'Campaign' },
  { value: 'workspace_mission', label: 'Continue a workspace mission', target: 'Workspace mission' },
  { value: 'scheduled_audit', label: 'Run a background analysis', target: 'Project' },
]

export const AUDIT_KIND_OPTIONS: { value: BackgroundJobKind; label: string }[] =
  BACKGROUND_JOB_KINDS.map((k) => ({
    value: k,
    label: `${k[0]?.toUpperCase()}${k.slice(1).replace(/_/g, ' ')}`,
  }))

export interface ScheduleForm {
  name: string
  actionType: ScheduleActionType
  /** The program, campaign, workspace mission or project the action targets. */
  targetId: string
  auditKind: BackgroundJobKind
  kind: 'daily' | 'weekly'
  day: 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'
  time: string
  priority: Priority
}

export const EMPTY_SCHEDULE_FORM: ScheduleForm = {
  name: '',
  actionType: 'program',
  targetId: '',
  auditKind: 'dependency_audit',
  kind: 'daily',
  day: 'sunday',
  time: '22:00',
  priority: 'P2',
}

export function validateScheduleForm(form: ScheduleForm): {
  ok: boolean
  errors: Partial<Record<keyof ScheduleForm, string>>
} {
  const errors: Partial<Record<keyof ScheduleForm, string>> = {}
  if (form.name.trim().length === 0) errors.name = 'Give the schedule a name.'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time))
    errors.time = 'A time as HH:MM, for example 22:00.'
  if (form.targetId === '')
    errors.targetId = `Choose the ${SCHEDULE_ACTION_OPTIONS.find((o) => o.value === form.actionType)?.target.toLowerCase() ?? 'target'}.`
  return { ok: Object.keys(errors).length === 0, errors }
}

export function scheduleInput(form: ScheduleForm): ScheduleInput {
  const action: ScheduleAction =
    form.actionType === 'program'
      ? { type: 'program', programId: form.targetId }
      : form.actionType === 'arena'
        ? { type: 'arena', campaignId: form.targetId }
        : form.actionType === 'workspace_mission'
          ? { type: 'workspace_mission', missionId: form.targetId }
          : { type: 'scheduled_audit', projectId: form.targetId, kind: form.auditKind }
  return {
    name: form.name.trim(),
    rule:
      form.kind === 'daily'
        ? { kind: 'daily', time: form.time }
        : { kind: 'weekly', day: form.day, time: form.time },
    action,
    priority: form.priority,
    enabled: true,
  }
}

// ───────────────────────────── runtime strip, dispatch, long lists ─────────────────────────────

export const RUNTIME_LEVEL_LABEL: Record<HealthLevel, string> = {
  HEALTHY: 'Healthy',
  RECOVERING: 'Recovering',
  DEGRADED: 'Degraded',
  BLOCKED: 'Blocked',
}

/** "Workers 4 / 6", or the plain fact that sessions run inside the runtime when there are no worker processes. */
export function workersLine(workers: ControlPlaneOverview['workers']): { value: string; detail: string } {
  if (!workers)
    return {
      value: 'Inside the runtime',
      detail: 'Agent sessions run inside the runtime process, not in workers.',
    }
  return { value: `${workers.live} / ${workers.max}`, detail: `${workers.busy} busy` }
}

export function claudeLine(available: boolean): string {
  return available ? 'Available' : 'Waiting for the usage limit'
}

export interface DispatchView {
  state: string
  button: string
  /** Shown while paused: what the pause does and does not do. */
  notice: string | null
  /** The value the button sets. */
  next: boolean
}

export const DISPATCH_PAUSED_NOTICE =
  'Dispatch is paused: nothing new starts and no capacity is granted. Work that is running continues.'

export function dispatchView(paused: boolean): DispatchView {
  return paused
    ? { state: 'Paused', button: 'Resume dispatch', notice: DISPATCH_PAUSED_NOTICE, next: false }
    : { state: 'Running', button: 'Pause dispatch', notice: null, next: true }
}

export const AGING_HINT =
  'Fairness: a waiting item is treated as one priority higher for every this many minutes it waits, so low-priority work is not kept out for good. 0 switches it off.'
export const AGING_OPTIONS = [0, 5, 15, 30, 60, 120, 240, 720, 1440]

/** Long queues are cut here with a "Show more", so 100 items do not make the page slow. */
export const ROW_LIMIT = 50

export function visibleRows<T>(
  rows: readonly T[],
  expanded: boolean,
  limit = ROW_LIMIT,
): { rows: T[]; hidden: number } {
  if (expanded || rows.length <= limit) return { rows: [...rows], hidden: 0 }
  return { rows: rows.slice(0, limit), hidden: rows.length - limit }
}

/** One scheduler decision as a line: when, what, why. */
export function describeDecision(d: { at: string; decision: string; reason: string }): {
  at: string
  label: string
  reason: string
} {
  const flat = d.decision.replace(/[_.]+/g, ' ').trim().toLowerCase()
  return {
    at: d.at,
    label: flat ? `${flat[0]?.toUpperCase()}${flat.slice(1)}` : 'Decision',
    reason: d.reason,
  }
}
