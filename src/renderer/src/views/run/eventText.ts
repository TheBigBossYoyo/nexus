import type { EventPayloads, EventType, RunEvent } from '@shared/events'
import type { Tone } from '../../lib/status'

export const EVENT_CATEGORIES = ['run', 'task', 'agent', 'git', 'review', 'verification', 'approval'] as const
export type EventCategory = (typeof EVENT_CATEGORIES)[number]

export function eventCategory(type: EventType): EventCategory {
  const family = type.split('.')[0]
  switch (family) {
    case 'task':
      return 'task'
    case 'agent':
    case 'message':
      return 'agent'
    case 'git':
      return 'git'
    case 'review':
      return 'review'
    case 'verification':
    case 'checks':
      return 'verification'
    case 'approval':
      return 'approval'
    default:
      // run, plan, user, decision, criterion, memory
      return 'run'
  }
}

const trunc = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

type Renderers = { [K in EventType]: (p: EventPayloads[K]) => string }

/** One human-readable sentence per event type. Exhaustive: adding an event type fails to compile until it is described. */
const RENDER: Renderers = {
  'run.created': (p) => `Run created (${p.mode}, ${p.preset})`,
  'run.state_changed': (p) => `Run ${p.from} → ${p.to}${p.reason ? ` (${trunc(p.reason)})` : ''}`,
  'run.started': () => 'Run started',
  'run.paused': (p) => `Run paused (${p.reason})${p.detail ? `: ${trunc(p.detail)}` : ''}`,
  'run.resumed': () => 'Run resumed',
  'run.completed': (p) => `Run completed: ${trunc(p.summary)}`,
  'run.failed': (p) => `Run failed: ${trunc(p.error)}`,
  'run.cancelled': () => 'Run cancelled',
  'run.recovered': (p) => `Run recovered (${p.action}), ${plural(p.staleAgents, 'stale agent')}`,

  'plan.proposed': (p) => `Plan proposed: ${plural(p.taskCount, 'task')} (attempt ${p.attempt})`,
  'plan.invalid': (p) => `Plan invalid (attempt ${p.attempt}): ${trunc(p.errors.join('; '))}`,
  'plan.approved': () => 'Plan approved',
  'plan.rejected': (p) => `Plan sent back for replanning: ${trunc(p.feedback)}`,

  'task.created': (p) => `Task ${p.key} created: ${trunc(p.title)} (${p.role}, ${p.kind})`,
  'task.state_changed': (p) => `Task ${p.from} → ${p.to}${p.reason ? ` (${trunc(p.reason)})` : ''}`,
  'task.ready': () => 'Task ready',
  'task.assigned': (p) => `Task assigned to agent ${p.agentId.slice(0, 8)}`,
  'task.started': (p) => `Task started (attempt ${p.attempt})`,
  'task.blocked': (p) => `Task blocked: ${trunc(p.reason)}`,
  'task.completed': (p) => `Task completed: ${trunc(p.summary)}`,
  'task.failed': (p) =>
    `Task failed: ${trunc(p.what)}${p.where ? ` at ${p.where}` : ''}${p.why ? `, ${trunc(p.why)}` : ''}${p.retryable ? ' (retryable)' : ''}`,
  'task.cancelled': () => 'Task cancelled',
  'task.retry': (p) => `Task retry, attempt ${p.attempt}: ${trunc(p.reason)}`,
  'task.escalated': (p) => `Task escalated to the ${p.toTier} model tier`,
  'task.updated': (p) => `Task updated (${p.fields.join(', ')})`,
  'task.lease_expired': (p) => `Task lease expired${p.owner ? ` (owner ${p.owner.slice(0, 8)})` : ''}`,
  'task.serialized': (p) => `Task serialized behind ${p.conflictsWith} (${plural(p.files.length, 'shared file')})`,

  'agent.started': (p) => `Agent started: ${p.role}${p.model ? ` on ${p.model}` : ''}`,
  'agent.state_changed': (p) => `Agent ${p.from} → ${p.to}`,
  'agent.message': (p) => `Agent: ${trunc(p.preview)}`,
  'agent.tool.started': (p) => `${p.toolName}: ${trunc(p.summary)}`,
  'agent.tool.completed': (p) => `${p.toolName} ${p.isError ? 'failed' : 'finished'}`,
  'agent.tool.denied': (p) => `${p.toolName} denied: ${trunc(p.reason)}`,
  'agent.waiting': (p) => `Agent waiting: ${trunc(p.reason)}`,
  'agent.failed': (p) => `Agent failed: ${trunc(p.error)}`,
  'agent.stopped': (p) => `Agent stopped: ${trunc(p.reason)}`,
  'agent.rotated': (p) => `Agent session rotated after ${plural(p.turns, 'turn')}`,
  'agent.usage': (p) => `Usage: ${p.inputTokens} in, ${p.outputTokens} out, $${p.costUsd.toFixed(4)}`,
  'agent.rate_limited': (p) =>
    `Rate limited (${p.status}${p.limitType ? `, ${p.limitType}` : ''})${p.resetsAt ? `, resets ${new Date(p.resetsAt * 1000).toLocaleTimeString()}` : ''}`,

  'git.worktree.created': (p) => `Worktree created on ${p.branch}`,
  'git.worktree.removed': (p) => `Worktree removed: ${p.path}`,
  'git.commit.created': (p) => `Commit ${p.commit.slice(0, 8)} on ${p.branch}: ${trunc(p.message)}`,
  'git.merged': (p) => `Merged ${p.branch} into ${p.into} (${p.commit.slice(0, 8)})`,
  'git.conflict': (p) => `Merge conflict, ${p.branch} into ${p.into}: ${p.files.join(', ')}`,

  'checks.started': (p) => `Checks started: ${p.commands.join(', ')}`,
  'checks.completed': (p) => (p.passed ? 'Checks passed' : `Checks failed: ${p.failed.join(', ')}`),

  'review.started': (p) => `Review started (attempt ${p.attempt})`,
  'review.finding': (p) => `Finding [${p.severity}] ${trunc(p.title)}${p.file ? ` in ${p.file}` : ''}`,
  'review.completed': (p) => `Review ${p.verdict === 'approved' ? 'approved' : 'requested changes'} (${plural(p.findings, 'finding')})`,

  'verification.started': (p) => `Verification started (attempt ${p.attempt})`,
  'verification.failed': (p) => `Verification failed (${plural(p.failures, 'failure')}): ${trunc(p.summary)}`,
  'verification.passed': (p) => `Verification passed: ${trunc(p.summary)}`,

  'approval.requested': (p) => `Approval requested: ${p.action} (${p.risk} risk)`,
  'approval.granted': () => 'Approval granted',
  'approval.denied': (p) => `Approval denied${p.note ? `: ${trunc(p.note)}` : ''}`,
  'approval.resolved': (p) => `Approval ${p.status}`,

  'message.sent': (p) => `${p.from} → ${p.to}: ${p.type.replace(/_/g, ' ')}`,
  'memory.proposed': (p) => `Memory proposed: ${trunc(p.title)}`,
  'memory.promoted': () => 'Memory promoted',
  'decision.recorded': (p) => `Decision recorded: ${trunc(p.title)}`,
  'criterion.updated': (p) => `Criterion marked ${p.status}`,
  'user.intervention': (p) => `User: ${p.action}${p.detail ? ` (${trunc(p.detail)})` : ''}`,
}

export function describeEvent(event: RunEvent): string {
  const render = RENDER[event.type] as (p: EventPayloads[EventType]) => string
  return render(event.payload)
}

const DANGER: ReadonlySet<EventType> = new Set<EventType>([
  'run.failed',
  'task.failed',
  'agent.failed',
  'agent.tool.denied',
  'git.conflict',
  'verification.failed',
  'approval.denied',
  'plan.invalid',
])

export function eventTone(event: RunEvent): Tone {
  if (DANGER.has(event.type)) return 'danger'
  switch (event.type) {
    case 'run.completed':
    case 'task.completed':
    case 'verification.passed':
    case 'git.merged':
    case 'approval.granted':
    case 'plan.approved':
      return 'success'
    case 'task.blocked':
    case 'task.lease_expired':
    case 'agent.rate_limited':
    case 'run.paused':
    case 'agent.waiting':
      return 'waiting'
    case 'checks.completed':
      return (event.payload as EventPayloads['checks.completed']).passed ? 'success' : 'danger'
    case 'review.completed':
      return (event.payload as EventPayloads['review.completed']).verdict === 'approved' ? 'success' : 'warning'
    case 'agent.tool.completed':
      return (event.payload as EventPayloads['agent.tool.completed']).isError ? 'danger' : 'neutral'
    default:
      return 'neutral'
  }
}

export interface ToolActivityRow {
  key: string
  at: string
  agentId: string | null
  taskId: string | null
  toolName: string
  summary: string
  status: 'running' | 'ok' | 'error' | 'denied'
}

/** Pairs agent.tool.started / completed (by toolUseId) and denials into one row per tool call. */
export function toolActivityFromEvents(events: readonly RunEvent[]): ToolActivityRow[] {
  const rows: ToolActivityRow[] = []
  const open = new Map<string, ToolActivityRow>()
  for (const e of events) {
    if (e.type === 'agent.tool.started') {
      const p = e.payload as EventPayloads['agent.tool.started']
      const row: ToolActivityRow = {
        key: e.id,
        at: e.createdAt,
        agentId: e.agentId,
        taskId: e.taskId,
        toolName: p.toolName,
        summary: p.summary,
        status: 'running',
      }
      open.set(p.toolUseId, row)
      rows.push(row)
    } else if (e.type === 'agent.tool.completed') {
      const p = e.payload as EventPayloads['agent.tool.completed']
      const row = open.get(p.toolUseId)
      if (row) {
        row.status = p.isError ? 'error' : 'ok'
        open.delete(p.toolUseId)
      }
    } else if (e.type === 'agent.tool.denied') {
      const p = e.payload as EventPayloads['agent.tool.denied']
      rows.push({
        key: e.id,
        at: e.createdAt,
        agentId: e.agentId,
        taskId: e.taskId,
        toolName: p.toolName,
        summary: p.reason,
        status: 'denied',
      })
    }
  }
  return rows
}

/** Latest pause explanation: the run.paused detail, else the reason of the last transition into paused. */
export function pauseDetailFromEvents(events: readonly RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e) continue
    if (e.type === 'run.paused') return (e.payload as EventPayloads['run.paused']).detail ?? null
    if (e.type === 'run.state_changed') {
      const p = e.payload as EventPayloads['run.state_changed']
      if (p.to === 'paused') return p.reason ?? null
    }
  }
  return null
}

/** Merge a fetched page into the accumulated list, ordered by seq, without duplicates. */
export function mergeEvents(existing: readonly RunEvent[], incoming: readonly RunEvent[]): RunEvent[] {
  const seen = new Set(existing.map((e) => e.seq))
  const fresh = incoming.filter((e) => !seen.has(e.seq))
  if (fresh.length === 0) return existing as RunEvent[]
  return [...existing, ...fresh].sort((a, b) => a.seq - b.seq)
}
