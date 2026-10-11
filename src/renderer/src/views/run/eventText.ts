import type { EventPayloads, EventType, RunEvent } from '@shared/events'
import type { Tone } from '../../lib/status'

export const EVENT_CATEGORIES = ['run', 'task', 'agent', 'git', 'review', 'verification', 'approval', 'graph'] as const
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
    case 'graph':
    case 'planning':
    case 'routing':
      return 'graph'
    default:
      // run, plan, user, decision, criterion, memory, intelligence, context, overnight, checkpoint
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
  'capacity.waiting': (p) => `Waiting for provider capacity${p.provider ? ` (${p.provider})` : ''}: ${trunc(p.reasons.join('; '))}`,
  'agent.failed': (p) => `Agent failed: ${trunc(p.error)}`,
  'agent.stopped': (p) => `Agent stopped: ${trunc(p.reason)}`,
  'agent.rotated': (p) => `Agent session rotated after ${plural(p.turns, 'turn')}`,
  'agent.usage': (p) => `Usage: ${p.inputTokens} in, ${p.outputTokens} out, est. $${p.costUsd.toFixed(4)}`,
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
  'graph.proposed': (p) => `Graph change proposed by ${p.proposedBy}: ${p.type.replace(/_/g, ' ').toLowerCase()}`,
  'graph.revised': (p) => `Plan revised to v${p.version}: ${trunc(p.summary)}`,
  'graph.rejected': (p) => `Graph change rejected: ${trunc(p.errors.join('; '))}`,
  'planning.candidate': (p) => `Candidate plan ${p.label}: ${p.valid ? 'valid' : 'invalid'}`,
  'planning.critique': (p) => `Plan critique: ${plural(p.findings, 'finding')}, prefers ${p.preferred}`,
  'planning.synthesized': (p) => `Plan synthesized from ${p.validCandidates} valid of ${plural(p.candidates, 'candidate')}`,
  'routing.decided': (p) =>
    `Model routing: ${p.role} → ${p.policy}${p.model ? ` (${p.model})` : ' (runtime default)'}${p.reasons.length > 0 ? `: ${trunc(p.reasons.join('; '))}` : ''}`,
  'intelligence.refreshed': (p) => `Repository intelligence refreshed: ${plural(p.facts, 'fact')}, ${p.stale} stale`,
  'context.composed': (p) =>
    `Context composed: ${p.included} included, ${p.excluded} excluded, ${p.chars.toLocaleString()} chars`,
  'overnight.started': (p) =>
    `Overnight mode started: end action ${p.endAction}, deadline ${p.deadlineAt}${p.failsafeDeadline ? `, failsafe ${p.failsafeDeadline}` : ', no failsafe'}`,
  'overnight.state_changed': (p) => `Overnight ${p.from} → ${p.to}${p.detail ? ` (${trunc(p.detail)})` : ''}`,
  'overnight.failsafe': (p) => {
    const when = p.deadline ? ` (${p.deadline})` : ''
    const outcome = p.ok ? '' : ' FAILED'
    switch (p.action) {
      case 'armed':
        return `Failsafe shutdown armed${when}${outcome}`
      case 'cancelled':
        return `Failsafe shutdown cancelled${outcome}`
      case 'rearmed':
        return `Failsafe shutdown re-armed${when}${outcome}`
      case 'lost':
        return 'Failsafe shutdown lost (Windows restarted)'
      case 'failed':
        return `Failsafe shutdown could not be armed${outcome}`
    }
  },
  'overnight.quota': (p) => {
    switch (p.action) {
      case 'waiting':
        return `Usage limit reached: waiting${p.resumeAt ? `, resumes ${p.resumeAt}` : ''}`
      case 'resumed':
        return 'Usage limit reset: run resumed'
      case 'exhausted':
        return 'Usage limit exhausted: run ended'
    }
  },
  'overnight.watchdog': (p) => `Watchdog ${p.stage}: ${trunc(p.detail)}`,
  'overnight.report': (p) => `Final report written (${p.chars.toLocaleString()} chars)${p.path ? ` to ${p.path}` : ''}`,
  'overnight.power': (p) => `Power ${p.operation} (${p.action}): ${p.ok ? 'ok' : 'failed'}${p.executeAt ? `, at ${p.executeAt}` : ''}, ${trunc(p.detail)}`,
  'overnight.amended': (p) => `Overnight policy changed by the user: ${trunc(p.change)}`,
  'overnight.approval': (p) => `Unattended ${p.kind} approval ${p.decision}`,
  'checkpoint.saved': (p) => `Checkpoint saved (${trunc(p.reason)})`,
  'usage.quota_paused': (p) =>
    `Paused for the Claude usage limit${p.resetAt ? `; reset reported for ${p.resetAt}` : '; reset time not reported'}${p.nextCheckAt ? `; next check ${p.nextCheckAt}` : ''}`,
  'usage.probe': (p) => `Availability check (${p.method.replace(/_/g, ' ')}): ${p.result.replace(/_/g, ' ')}`,
  'usage.quota_resumed': (p) => `Resumed automatically after the usage limit (waited ${Math.round(p.waitedMs / 60000)} min)`,
  'usage.wait_ended': (p) => `Stopped waiting for the usage limit: ${trunc(p.reason)}`,
  'strategy.selected': (p) =>
    `Strategy ${p.resolved}${p.requested !== p.resolved ? ` (requested ${p.requested})` : ''}: ${trunc(p.reason)}`,
  'policy.decided': (p) =>
    `Policy v${p.policyVersion} chose ${p.strategy} (${p.exploration ? 'exploration' : p.layer})`,
  'speculative.started': (p) => `Speculative candidates ${p.candidates.join(', ')} started from ${p.baseCommit.slice(0, 8)}`,
  'speculative.candidate': (p) =>
    `Candidate ${p.label}: ${p.implemented ? 'implemented' : 'no result'}${p.checksPassed === null ? '' : p.checksPassed ? ', checks passed' : ', checks failed'}`,
  'speculative.decided': (p) =>
    p.winner ? `Tournament: candidate ${p.winner} selected (${p.confidence}; ranking ${p.ranking.join(' > ')})` : 'Tournament: no candidate could be selected',
  'outcome.recorded': (p) => `Mission outcome recorded (${p.strategy}, ${p.success ? 'success' : 'not successful'})`,
  'review.arbitrated': (p) => `Findings arbitrated: ${p.accepted} accepted, ${p.rejected} rejected`,
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
  'graph.rejected',
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

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', openai: 'ChatGPT', gemini: 'Gemini' }

/** One provider's part of a capacity wait, in words. Only what was observed: a time is given when the provider gave one. */
function providerWaitLine(p: NonNullable<EventPayloads['capacity.waiting']['waitingOn']>['providers'][number], formatTime: (ms: number) => string): string | null {
  const name = PROVIDER_LABEL[p.provider] ?? p.provider
  const until = p.resetAt !== null ? ` Its limit resets at ${formatTime(p.resetAt)}.` : ''
  switch (p.state) {
    case 'QUOTA_PAUSED':
    case 'WAITING_FOR_RESET':
      return `${name} has reached its usage limit.${until || ' It gave no reset time; it is tried again later.'}`
    case 'THROTTLED':
      return `${name} is slowing requests down.${until}`
    case 'AUTH_REQUIRED':
      return `${name} needs you to sign in again (Providers page).`
    case 'RUNTIME_UNAVAILABLE':
      return `${name} does not answer on this machine (Providers page).`
    default:
      return p.usable ? null : `${name} cannot take this kind of session with its current settings.`
  }
}

/**
 * What a run that waits for capacity is waiting on: the latest wait on record, as lines for the user. Empty when
 * the run has no such event (an older run) or the event carries no detail.
 */
export function capacityWaitLines(events: readonly RunEvent[], formatTime: (ms: number) => string = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e || e.type !== 'capacity.waiting') continue
    const detail = (e.payload as EventPayloads['capacity.waiting']).waitingOn
    if (!detail) return []
    const lines = detail.providers.map((p) => providerWaitLine(p, formatTime)).filter((l): l is string => l !== null)
    if (detail.slotsFull) lines.push('Every agent slot of this machine is in use (the limit is set in Control). The mission continues when one is free.')
    if (lines.length === 0) lines.push('The slot was taken by another session at the same moment. The mission is tried again shortly.')
    return lines
  }
  return []
}
