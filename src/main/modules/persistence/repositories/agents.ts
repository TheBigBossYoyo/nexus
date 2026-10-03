import {
  ACTIVE_AGENT_STATES,
  type Agent,
  type AgentOutput,
  type AgentOutputKind,
  type AgentSession,
  type Message,
  type ToolEvent,
  type ToolEventStatus,
} from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import type { Database } from '../database'
import { Table, guard, prepare, type Codec, type SqlValue } from '../table'

const agentCodec: Codec<Agent> = {
  table: 'agents',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    role: 'text',
    purpose: 'text',
    label: 'text',
    state: 'text',
    model: 'text',
    activity: 'text',
    metrics: 'json',
    error: 'text',
    createdAt: 'text',
    startedAt: 'text',
    stoppedAt: 'text',
  },
}

export class AgentRepository extends Table<Agent> {
  constructor(db: Database) {
    super(db, agentCodec, 'agent')
  }

  listByRun(runId: string): Agent[] {
    return this.byRun(runId)
  }

  listByTask(taskId: string): Agent[] {
    return this.query('WHERE task_id = ? ORDER BY created_at, rowid', [taskId])
  }

  /** Agents in a live state (starting/working/waiting/blocked/stopping), optionally limited to one run. */
  listActive(runId?: string): Agent[] {
    const states: SqlValue[] = [...ACTIVE_AGENT_STATES]
    const marks = states.map(() => '?').join(', ')
    return runId === undefined
      ? this.query(`WHERE state IN (${marks}) ORDER BY created_at, rowid`, states)
      : this.query(`WHERE run_id = ? AND state IN (${marks}) ORDER BY created_at, rowid`, [runId, ...states])
  }
}

const sessionCodec: Codec<AgentSession> = {
  table: 'agent_sessions',
  fields: {
    id: 'text',
    agentId: 'text',
    sdkSessionId: 'text',
    model: 'text',
    state: 'text',
    endReason: 'text',
    handoff: 'json',
    startedAt: 'text',
    endedAt: 'text',
  },
}

export class SessionRepository extends Table<AgentSession> {
  constructor(db: Database) {
    super(db, sessionCodec, 'agent session')
  }

  /** Oldest first. */
  listByAgent(agentId: string): AgentSession[] {
    return this.query('WHERE agent_id = ? ORDER BY started_at, rowid', [agentId])
  }

  latestForAgent(agentId: string): AgentSession | null {
    return this.one('WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC', [agentId])
  }
}

const messageCodec: Codec<Message> = {
  table: 'agent_messages',
  fields: {
    id: 'text',
    runId: 'text',
    type: 'text',
    severity: 'text',
    fromAgentId: 'text',
    fromTaskId: 'text',
    fromLabel: 'text',
    toTaskId: 'text',
    toRole: 'text',
    toLabel: 'text',
    subject: 'text',
    body: 'text',
    createdAt: 'text',
  },
}

export interface MessageRecipient {
  taskId: string
  deliveredAt: string | null
}

export class MessageRepository extends Table<Message> {
  constructor(db: Database) {
    super(db, messageCodec, 'message')
  }

  /** Stores the message and one undelivered recipient row per task (for per-task delivery tracking), atomically. */
  override insert(message: Message, recipientTaskIds: readonly string[] = []): Message {
    guard(() =>
      this.db.transaction(() => {
        super.insert(message)
        const stmt = prepare(this.db, 'INSERT INTO message_recipients (message_id, task_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
        for (const taskId of recipientTaskIds) stmt.run(message.id, taskId)
      })(),
    )
    return message
  }

  listByRun(runId: string): Message[] {
    return this.byRun(runId)
  }

  /** Messages addressed to the task that have not yet been delivered to it, oldest first. */
  listUndeliveredForTask(taskId: string): Message[] {
    return this.query(
      'WHERE id IN (SELECT message_id FROM message_recipients WHERE task_id = ? AND delivered_at IS NULL) ORDER BY created_at, rowid',
      [taskId],
    )
  }

  markDelivered(taskId: string, messageIds: readonly string[], at: string = nowIso()): void {
    const stmt = prepare(
      this.db,
      'UPDATE message_recipients SET delivered_at = ? WHERE task_id = ? AND message_id = ? AND delivered_at IS NULL',
    )
    this.db.transaction(() => {
      for (const id of messageIds) stmt.run(at, taskId, id)
    })()
  }

  listRecipients(messageId: string): MessageRecipient[] {
    const rows = prepare(this.db, 'SELECT task_id, delivered_at FROM message_recipients WHERE message_id = ? ORDER BY task_id').all(
      messageId,
    ) as { task_id: string; delivered_at: string | null }[]
    return rows.map((r) => ({ taskId: r.task_id, deliveredAt: r.delivered_at }))
  }
}

const outputCodec: Codec<AgentOutput> = {
  table: 'agent_output',
  fields: { id: 'text', agentId: 'text', seq: 'num', kind: 'text', content: 'text', createdAt: 'text' },
}

export class OutputRepository extends Table<AgentOutput> {
  constructor(db: Database) {
    super(db, outputCodec, 'agent output')
  }

  /** Appends a transcript item with the agent's next seq (1-based, gapless per agent). */
  append(agentId: string, kind: AgentOutputKind, content: string): AgentOutput {
    return guard(() =>
      this.db.transaction(() => {
        const row = prepare(this.db, 'SELECT COALESCE(MAX(seq), 0) AS m FROM agent_output WHERE agent_id = ?').get(agentId) as {
          m: number
        }
        return super.insert({ id: newId(), agentId, seq: row.m + 1, kind, content, createdAt: nowIso() })
      })(),
    )
  }

  listByAgent(agentId: string, afterSeq = 0, limit = 1000): AgentOutput[] {
    return this.query('WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?', [agentId, afterSeq, limit])
  }
}

const toolEventCodec: Codec<ToolEvent> = {
  table: 'tool_events',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    toolUseId: 'text',
    toolName: 'text',
    input: 'json',
    status: 'text',
    outputPreview: 'text',
    startedAt: 'text',
    completedAt: 'text',
  },
}

export class ToolEventRepository extends Table<ToolEvent> {
  constructor(db: Database) {
    super(db, toolEventCodec, 'tool event')
  }

  /** Finishes the started event for `toolUseId`. Returns null when no such tool use was recorded. */
  complete(
    toolUseId: string,
    status: Exclude<ToolEventStatus, 'started'>,
    outputPreview: string | null = null,
    completedAt: string = nowIso(),
  ): ToolEvent | null {
    const existing = this.one('WHERE tool_use_id = ? ORDER BY started_at DESC, rowid DESC', [toolUseId])
    if (!existing) return null
    return this.update(existing.id, { status, outputPreview, completedAt })
  }

  listByAgent(agentId: string): ToolEvent[] {
    return this.query('WHERE agent_id = ? ORDER BY started_at, rowid', [agentId])
  }

  listByRun(runId: string): ToolEvent[] {
    return this.byRun(runId, 'started_at, rowid')
  }
}
