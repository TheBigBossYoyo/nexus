import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '@shared/settings'
import type { EventType, NewEvent, RunEvent } from '@shared/events'
import { newId, nowIso } from '@shared/ids'
import type { Database } from '../database'
import { decode, guard, prepare, type Codec, type Row } from '../table'

const eventCodec: Codec<RunEvent> = {
  table: 'run_events',
  fields: {
    id: 'text',
    seq: 'num',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    type: 'text',
    payload: 'json',
    createdAt: 'text',
  },
}

const EVENT_COLUMNS = 'seq, id, run_id, task_id, agent_id, type, payload, created_at'

export class EventRepository {
  constructor(private readonly db: Database) {}

  /** Assigns the next global seq. Joins the caller's transaction when one is open. */
  insert<T extends EventType>(event: NewEvent<T>): RunEvent<T> {
    const id = newId()
    const createdAt = nowIso()
    const taskId = event.taskId ?? null
    const agentId = event.agentId ?? null
    const info = guard(() =>
      prepare(
        this.db,
        'INSERT INTO run_events (id, run_id, task_id, agent_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, event.runId, taskId, agentId, event.type, JSON.stringify(event.payload), createdAt),
    )
    return {
      id,
      seq: Number(info.lastInsertRowid),
      runId: event.runId,
      taskId,
      agentId,
      type: event.type,
      payload: event.payload,
      createdAt,
    }
  }

  get(id: string): RunEvent | null {
    const row = prepare(this.db, `SELECT ${EVENT_COLUMNS} FROM run_events WHERE id = ?`).get(id) as Row | undefined
    return row ? decode(eventCodec, row) : null
  }

  /** Events with seq > afterSeq in ascending order. */
  listByRun(runId: string, afterSeq = 0, limit = 1000): RunEvent[] {
    const rows = prepare(
      this.db,
      `SELECT ${EVENT_COLUMNS} FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    ).all(runId, afterSeq, limit) as Row[]
    return rows.map((r) => decode(eventCodec, r))
  }
}

const SETTINGS_KEY = 'app'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Objects merge recursively; arrays and primitives from `over` replace the base value. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v
  return out
}

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  /** Stored settings merged over DEFAULT_SETTINGS; any invalid or unreadable stored value falls back to defaults. */
  get(): Settings {
    const stored = this.getValue<unknown>(SETTINGS_KEY)
    const parsed = SettingsSchema.safeParse(deepMerge(DEFAULT_SETTINGS, stored))
    return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS)
  }

  /** Validates before writing; throws a ZodError for invalid settings. */
  set(settings: Settings): Settings {
    const valid = SettingsSchema.parse(settings)
    this.setValue(SETTINGS_KEY, valid)
    return valid
  }

  /** Raw key/value access for small internal flags (e.g. last clean shutdown). */
  getValue<T>(key: string): T | null {
    const row = prepare(this.db, 'SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value) as T
    } catch {
      return null
    }
  }

  setValue(key: string, value: unknown): void {
    guard(() =>
      prepare(
        this.db,
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(key, JSON.stringify(value), nowIso()),
    )
  }

  deleteValue(key: string): void {
    prepare(this.db, 'DELETE FROM settings WHERE key = ?').run(key)
  }
}
