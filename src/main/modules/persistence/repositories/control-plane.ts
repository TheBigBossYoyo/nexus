import { TERMINAL_WORK_ITEM_STATES, type GlobalWorkItem, type Schedule, type WorkItemType } from '@shared/control-plane'
import type { Database } from '../database'
import { prepare, Table, type Codec } from '../table'

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

const itemCodec: Codec<GlobalWorkItem> = {
  table: 'global_work_items',
  fields: {
    id: 'text',
    type: 'text',
    refId: 'text',
    title: 'text',
    priority: 'text',
    position: 'num',
    state: 'text',
    requestedAgents: 'num',
    deadlineAt: 'text',
    notBefore: 'text',
    scheduleId: 'text',
    heldByUser: 'bool',
    payload: 'json',
    detail: 'text',
    createdAt: 'text',
    updatedAt: 'text',
    startedAt: 'text',
    finishedAt: 'text',
  },
}

/** v0.7: the global queue. */
export class WorkItemStore extends Table<GlobalWorkItem> {
  constructor(db: Database) {
    super(db, itemCodec, 'work item')
  }

  listOpen(): GlobalWorkItem[] {
    return this.query(`WHERE state NOT IN (${marks(TERMINAL_WORK_ITEM_STATES.length)}) ORDER BY position, created_at, rowid`, [...TERMINAL_WORK_ITEM_STATES])
  }

  listFinished(limit = 20): GlobalWorkItem[] {
    return this.query(`WHERE state IN (${marks(TERMINAL_WORK_ITEM_STATES.length)}) ORDER BY finished_at DESC, rowid DESC LIMIT ?`, [...TERMINAL_WORK_ITEM_STATES, Math.min(Math.max(1, limit), 200)])
  }

  findOpenByRef(type: WorkItemType, refId: string): GlobalWorkItem | null {
    return this.query(`WHERE type = ? AND ref_id = ? AND state NOT IN (${marks(TERMINAL_WORK_ITEM_STATES.length)}) LIMIT 1`, [type, refId, ...TERMINAL_WORK_ITEM_STATES])[0] ?? null
  }

  maxPosition(): number {
    return (prepare(this.db, 'SELECT COALESCE(MAX(position), 0) AS p FROM global_work_items').get() as { p: number }).p
  }
}

const scheduleCodec: Codec<Schedule> = {
  table: 'control_schedules',
  fields: { id: 'text', name: 'text', rule: 'json', action: 'json', priority: 'text', enabled: 'bool', nextRunAt: 'text', lastRunAt: 'text', lastResult: 'text', createdAt: 'text', updatedAt: 'text' },
}

/** v0.7: durable schedules. */
export class ControlScheduleStore extends Table<Schedule> {
  constructor(db: Database) {
    super(db, scheduleCodec, 'schedule')
  }

  list(): Schedule[] {
    return this.query('ORDER BY created_at, rowid', [])
  }
}

interface Incident {
  id: string
  at: string
  summary: string
  itemId: string | null
}

const incidentCodec: Codec<Incident> = { table: 'control_incidents', fields: { id: 'text', at: 'text', summary: 'text', itemId: 'text' } }

/** v0.7: what the control plane recorded: failures, blocks, restarts. */
export class ControlIncidentStore extends Table<Incident> {
  constructor(db: Database) {
    super(db, incidentCodec, 'incident')
  }

  recent(limit = 20): Incident[] {
    return this.query('ORDER BY at DESC, rowid DESC LIMIT ?', [Math.min(Math.max(1, limit), 200)])
  }
}
