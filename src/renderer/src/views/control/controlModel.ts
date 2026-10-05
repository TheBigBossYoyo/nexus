import {
  describeRule,
  WORK_ITEM_TYPE_LABEL,
  type ControlPlaneOverview,
  type GlobalWorkItem,
  type HealthLevel,
  type Priority,
  type Schedule,
  type ScheduleAction,
  type WorkItemState,
} from '@shared/control-plane'
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
  scheduler: 'Scheduler',
  workers: 'Agent sessions',
  providers: 'Providers',
  git: 'Git',
  usage: 'Usage',
  power_supervisor: 'Overnight supervisor',
  ipc: 'Window connection',
}

export const STATE_LABEL: Record<WorkItemState, { tone: Tone; label: string }> = {
  QUEUED: { tone: 'neutral', label: 'Queued' },
  READY: { tone: 'neutral', label: 'Ready' },
  RUNNING: { tone: 'active', label: 'Running' },
  PAUSED: { tone: 'neutral', label: 'Paused' },
  QUOTA_WAIT: { tone: 'waiting', label: 'Waiting for usage' },
  BLOCKED: { tone: 'warning', label: 'Blocked' },
  SCHEDULED: { tone: 'neutral', label: 'Scheduled' },
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

export function capacityLine(
  o: Pick<ControlPlaneOverview, 'agents' | 'active' | 'limits' | 'claudeAvailable'>,
): string {
  const base = `${o.agents.active} of ${o.agents.max} agents in use · ${o.active.length} of ${o.limits.maxActiveItems} workloads running`
  return o.claudeAvailable
    ? base
    : `${base} · waiting for the Claude usage limit: nothing new starts`
}

export function itemLine(
  item: GlobalWorkItem & { activeAgents?: number; allowance?: number },
): string {
  const type = WORK_ITEM_TYPE_LABEL[item.type]
  if (item.activeAgents === undefined || item.allowance === undefined) return type
  return `${type} · ${item.activeAgents} agent${item.activeAgents === 1 ? '' : 's'} running, may hold ${item.allowance}`
}

export interface ItemActions {
  pause: boolean
  resume: boolean
  cancel: boolean
  reorder: boolean
}

/** What the user can do with an item now. A held item is released with Resume; a blocked one is resumed in its own page. */
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

export interface ScheduleForm {
  name: string
  kind: 'daily' | 'weekly'
  day: 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'
  time: string
  programId: string
  priority: Priority
}

export const EMPTY_SCHEDULE_FORM: ScheduleForm = {
  name: '',
  kind: 'daily',
  day: 'sunday',
  time: '22:00',
  programId: '',
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
  if (form.programId === '') errors.programId = 'Choose the program to continue.'
  return { ok: Object.keys(errors).length === 0, errors }
}

export function scheduleInput(form: ScheduleForm) {
  return {
    name: form.name.trim(),
    rule:
      form.kind === 'daily'
        ? ({ kind: 'daily', time: form.time } as const)
        : ({ kind: 'weekly', day: form.day, time: form.time } as const),
    action: { type: 'program', programId: form.programId } as const,
    priority: form.priority,
    enabled: true,
  }
}
