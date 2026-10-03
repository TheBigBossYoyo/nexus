import {
  TERMINAL_TASK_STATES,
  type AgentRole,
  type Message,
  type MessageType,
  type Severity,
  type Task,
} from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { dependantsOf } from '@main/modules/task-graph'
import type { OrchestratorDeps } from './deps'

export interface SendMessageInput {
  runId: string
  type: MessageType
  severity: Severity | null
  subject: string
  body: string
  fromAgentId: string | null
  fromTaskId: string | null
  fromLabel: string
  /** Planner task key or task id of an explicit recipient. */
  toTask: string | null
  toRole: AgentRole | null
}

/** Tries to hand a message to a live session of the task. Returns true when it was delivered. */
export type LiveDelivery = (taskId: string, message: Message) => boolean

export function renderMessage(message: Message): string {
  const severity = message.severity ? ` · ${message.severity.toUpperCase()}` : ''
  return [
    `[Message from ${message.fromLabel}] ${message.type.toUpperCase()}${severity}`,
    message.subject,
    '',
    message.body,
  ].join('\n')
}

/**
 * Persisted, routed inter-agent messaging. A message reaches only the tasks it is routed to:
 * an explicit task, every open task of a role, or (by default) the sender's direct dependants.
 */
export class MessageService {
  private liveDelivery: LiveDelivery = () => false

  constructor(private readonly deps: Pick<OrchestratorDeps, 'repos' | 'bus'>) {}

  setLiveDelivery(deliver: LiveDelivery): void {
    this.liveDelivery = deliver
  }

  send(input: SendMessageInput): { message: Message; recipients: Task[] } {
    const { repos, bus } = this.deps
    const tasks = repos.tasks.listByRun(input.runId)
    const recipients = this.route(input, tasks)
    const toLabel =
      recipients.length > 0
        ? recipients.map((t) => t.key).join(', ')
        : input.toRole
          ? input.toRole
          : 'Orchestrator'

    const message = bus.transaction(() => {
      const row = repos.messages.insert(
        {
          id: newId(),
          runId: input.runId,
          type: input.type,
          severity: input.severity,
          fromAgentId: input.fromAgentId,
          fromTaskId: input.fromTaskId,
          fromLabel: input.fromLabel,
          toTaskId: recipients.length === 1 ? (recipients[0]?.id ?? null) : null,
          toRole: input.toRole,
          toLabel,
          subject: input.subject,
          body: input.body,
          createdAt: nowIso(),
        },
        recipients.map((t) => t.id),
      )
      bus.emit({
        runId: input.runId,
        taskId: input.fromTaskId,
        agentId: input.fromAgentId,
        type: 'message.sent',
        payload: { messageId: row.id, type: row.type, from: row.fromLabel, to: toLabel },
      })
      return row
    })

    for (const task of recipients) {
      if (this.liveDelivery(task.id, message)) repos.messages.markDelivered(task.id, [message.id])
    }
    return { message, recipients }
  }

  /** Undelivered messages for a task, marked delivered. Called when building its next context pack. */
  takeForTask(taskId: string): Message[] {
    const { repos } = this.deps
    const messages = repos.messages.listUndeliveredForTask(taskId)
    if (messages.length > 0) {
      repos.messages.markDelivered(
        taskId,
        messages.map((m) => m.id),
      )
    }
    return messages
  }

  /** Only the user's undelivered instructions for a task, marked delivered. Other messages stay queued. */
  takeInstructions(taskId: string): Message[] {
    const { repos } = this.deps
    const instructions = repos.messages.listUndeliveredForTask(taskId).filter((m) => m.type === 'user_instruction')
    if (instructions.length > 0) {
      repos.messages.markDelivered(
        taskId,
        instructions.map((m) => m.id),
      )
    }
    return instructions
  }

  private route(input: SendMessageInput, tasks: Task[]): Task[] {
    const { repos } = this.deps
    const open = tasks.filter(
      (t) => !TERMINAL_TASK_STATES.includes(t.state) && t.id !== input.fromTaskId,
    )
    if (input.toTask) {
      const target = tasks.find((t) => t.key === input.toTask || t.id === input.toTask)
      return target ? [target] : []
    }
    if (input.toRole) return open.filter((t) => t.role === input.toRole)
    if (!input.fromTaskId) return []
    const dependantIds = new Set(dependantsOf(repos.dependencies.listByRun(input.runId), input.fromTaskId))
    return open.filter((t) => dependantIds.has(t.id))
  }
}
