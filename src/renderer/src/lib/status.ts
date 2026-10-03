import type { AgentState, RunState, Severity, TaskState } from '@shared/domain'
import { assertNever } from '@shared/result'

/** One tone per state family; mapped to CSS tokens (--color-tone-*) in styles.css. */
export type Tone = 'neutral' | 'active' | 'waiting' | 'review' | 'success' | 'danger' | 'warning'

export interface StatusInfo {
  label: string
  tone: Tone
}

// Class names are spelled out in full so Tailwind can see them.
export const TONE_CLASSES: Record<Tone, { dot: string; text: string; border: string; soft: string }> = {
  neutral: { dot: 'bg-tone-neutral', text: 'text-tone-neutral', border: 'border-tone-neutral', soft: 'bg-tone-neutral/12' },
  active: { dot: 'bg-tone-active', text: 'text-tone-active', border: 'border-tone-active', soft: 'bg-tone-active/12' },
  waiting: { dot: 'bg-tone-waiting', text: 'text-tone-waiting', border: 'border-tone-waiting', soft: 'bg-tone-waiting/12' },
  review: { dot: 'bg-tone-review', text: 'text-tone-review', border: 'border-tone-review', soft: 'bg-tone-review/12' },
  success: { dot: 'bg-tone-success', text: 'text-tone-success', border: 'border-tone-success', soft: 'bg-tone-success/12' },
  danger: { dot: 'bg-tone-danger', text: 'text-tone-danger', border: 'border-tone-danger', soft: 'bg-tone-danger/12' },
  warning: { dot: 'bg-tone-warning', text: 'text-tone-warning', border: 'border-tone-warning', soft: 'bg-tone-warning/12' },
}

export function taskStatus(state: TaskState): StatusInfo {
  switch (state) {
    case 'draft':
      return { label: 'Draft', tone: 'neutral' }
    case 'ready':
      return { label: 'Ready', tone: 'neutral' }
    case 'blocked':
      return { label: 'Blocked', tone: 'warning' }
    case 'queued':
      return { label: 'Queued', tone: 'neutral' }
    case 'assigned':
      return { label: 'Assigned', tone: 'active' }
    case 'running':
      return { label: 'Running', tone: 'active' }
    case 'waiting':
      return { label: 'Waiting', tone: 'waiting' }
    case 'review':
      return { label: 'Review', tone: 'review' }
    case 'verification':
      return { label: 'Verification', tone: 'review' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    case 'completed':
      return { label: 'Completed', tone: 'success' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' }
    default:
      return assertNever(state, 'task state')
  }
}

export function agentStatus(state: AgentState): StatusInfo {
  switch (state) {
    case 'idle':
      return { label: 'Idle', tone: 'neutral' }
    case 'starting':
      return { label: 'Starting', tone: 'active' }
    case 'working':
      return { label: 'Working', tone: 'active' }
    case 'waiting':
      return { label: 'Waiting', tone: 'waiting' }
    case 'blocked':
      return { label: 'Blocked', tone: 'warning' }
    case 'stopping':
      return { label: 'Stopping', tone: 'warning' }
    case 'stopped':
      return { label: 'Stopped', tone: 'neutral' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    default:
      return assertNever(state, 'agent state')
  }
}

export function runStatus(state: RunState): StatusInfo {
  switch (state) {
    case 'planning':
      return { label: 'Planning', tone: 'active' }
    case 'awaiting_approval':
      return { label: 'Awaiting approval', tone: 'waiting' }
    case 'executing':
      return { label: 'Executing', tone: 'active' }
    case 'testing':
      return { label: 'Testing', tone: 'active' }
    case 'reviewing':
      return { label: 'Reviewing', tone: 'review' }
    case 'verifying':
      return { label: 'Verifying', tone: 'review' }
    case 'repairing':
      return { label: 'Repairing', tone: 'warning' }
    case 'paused':
      return { label: 'Paused', tone: 'waiting' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    case 'completed':
      return { label: 'Completed', tone: 'success' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' }
    default:
      return assertNever(state, 'run state')
  }
}

export function severityStatus(severity: Severity): StatusInfo {
  switch (severity) {
    case 'critical':
      return { label: 'Critical', tone: 'danger' }
    case 'high':
      return { label: 'High', tone: 'warning' }
    case 'medium':
      return { label: 'Medium', tone: 'waiting' }
    case 'low':
      return { label: 'Low', tone: 'active' }
    case 'nit':
      return { label: 'Nit', tone: 'neutral' }
    default:
      return assertNever(severity, 'severity')
  }
}
