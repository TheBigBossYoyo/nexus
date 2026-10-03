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
    messages: repos.messages
      .listByRun(runId)
      // Messages from the user and the orchestrator's own review findings are not an agent's coordination.
      .filter((m) => m.type !== 'review_finding' && m.type !== 'user_instruction' && mine(m.fromTaskId, m.fromAgentId))
      .map((m) => ({ type: m.type, to: m.toLabel, subject: m.subject, at: m.createdAt })),
    decisions: repos.decisions
      .listByRun(runId)
      .filter((d) => mine(d.taskId, d.agentId))
      .map((d) => ({ title: d.title, decision: d.decision, at: d.createdAt })),
    proposals: repos.graphProposals
      .listByRun(runId)
      .filter((p) => mine(p.taskId, p.proposedByAgentId))
      .map((p) => ({ type: p.type, status: p.status, reason: p.reason, at: p.createdAt })),
  }
}
