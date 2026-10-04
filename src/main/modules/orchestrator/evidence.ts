import type { Task } from '@shared/domain'
import type { OrchestrationEvidence } from '@main/modules/context/context-builder'
import type { Repositories } from '@main/modules/persistence'

/**
 * What the repository cannot show about a task, read from durable state: messages its agents sent
 * (repair children included), decisions they recorded and graph proposals they made. A null task
 * means the whole run (the mission verifier).
 */
export function gatherEvidence(repos: Repositories, runId: string, task: Task | null): OrchestrationEvidence {
  const taskIds = task ? new Set([task.id, ...repos.tasks.listByParent(task.id).map((t) => t.id)]) : null
  const agentIds = new Set(
    repos.agents
      .listByRun(runId)
      .filter((a) => taskIds === null || (a.taskId !== null && taskIds.has(a.taskId)))
      .map((a) => a.id),
  )
  const mine = (taskId: string | null, agentId: string | null): boolean =>
    taskIds === null ? true : (taskId !== null && taskIds.has(taskId)) || (agentId !== null && agentIds.has(agentId))
  return {
    ...messageEvidence(repos, runId, taskIds, mine),
    decisions: repos.decisions
      .listByRun(runId)
      .filter((d) => mine(d.taskId, d.agentId))
      .map((d) => ({ id: d.id, title: d.title, at: d.createdAt })),
    proposals: repos.graphProposals
      .listByRun(runId)
      .filter((p) => mine(p.taskId, p.proposedByAgentId))
      .map((p) => ({
        id: p.id,
        type: p.type,
        status: p.status,
        title: p.changes.tasks.length > 0 ? p.changes.tasks.map((t) => t.title).join('; ') : (p.changes.targetTask ?? '(none)'),
        at: p.createdAt,
      })),
  }
}

/** Longest list of message records the mission verifier gets. */
const MISSION_MESSAGE_CAP = 60

function messageEvidence(
  repos: Repositories,
  runId: string,
  taskIds: ReadonlySet<string> | null,
  mine: (taskId: string | null, agentId: string | null) => boolean,
): Pick<OrchestrationEvidence, 'messages' | 'omittedMessages'> {
  // Messages from the user and the orchestrator's own review findings are not an agent's coordination.
  const agentMessages = repos.messages.listByRun(runId).filter((m) => m.type !== 'review_finding' && m.type !== 'user_instruction')
  const record = (m: (typeof agentMessages)[number], direction: 'sent' | 'received'): OrchestrationEvidence['messages'][number] => ({
    id: m.id,
    direction,
    type: m.type,
    from: m.fromLabel,
    to: m.toLabel,
    subject: m.subject,
    at: m.createdAt,
  })
  if (taskIds === null) {
    // Whole run: most recent first, bounded, with the count of what was left out.
    const all = agentMessages.map((m) => record(m, 'sent')).sort((a, b) => b.at.localeCompare(a.at))
    return { messages: all.slice(0, MISSION_MESSAGE_CAP), omittedMessages: Math.max(0, all.length - MISSION_MESSAGE_CAP) }
  }
  const sent = agentMessages.filter((m) => mine(m.fromTaskId, m.fromAgentId)).map((m) => record(m, 'sent'))
  const received = agentMessages
    .filter((m) => !mine(m.fromTaskId, m.fromAgentId))
    .filter((m) => (m.toTaskId !== null && taskIds.has(m.toTaskId)) || repos.messages.listRecipients(m.id).some((r) => taskIds.has(r.taskId)))
    .map((m) => record(m, 'received'))
  return { messages: [...sent, ...received] }
}
