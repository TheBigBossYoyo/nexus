import type { DisturbanceEvent, DisturbanceKind, PresentationCompatibility, PresentationMode } from '@shared/presentation'
import type { Database } from '../persistence/database'
import { guard, prepare, type Row } from '../persistence/table'

/** 0.9.1: the disturbance events and the presentation evidence (migration 024). */

const MAX_EVENTS = 20_000
/** Kinds that count against the targets of a mission (C17). */
export const COUNTED: readonly DisturbanceKind[] = ['VISIBLE_WINDOW', 'CONSOLE_FLASH', 'SYSTEM_DIALOG', 'FOREGROUND_STEAL']

export interface PresentationStore {
  record(event: DisturbanceEvent): void
  counts(runId: string): Record<DisturbanceKind, number>
  recent(runId: string, limit: number): DisturbanceEvent[]
  saveCompatibility(c: PresentationCompatibility): void
  compatibility(projectId: string, appKey: string): PresentationCompatibility[]
}

const zero = (): Record<DisturbanceKind, number> => ({ VISIBLE_WINDOW: 0, CONSOLE_FLASH: 0, SYSTEM_DIALOG: 0, FOREGROUND_STEAL: 0, FOCUSED_LATER: 0, NEXUS_CONFIRMATION: 0 })

export class SqlitePresentationStore implements PresentationStore {
  private inserts = 0
  constructor(private readonly db: Database) {}

  record(e: DisturbanceEvent): void {
    guard(() => {
      const seq = Number(prepare(this.db, 'INSERT INTO user_disturbance_events (at, kind, process, window_class, run_ids_json) VALUES (?, ?, ?, ?, ?)').run(e.at, e.kind, e.process, e.windowClass, JSON.stringify(e.runIds)).lastInsertRowid)
      for (const runId of e.runIds.slice(0, 20)) prepare(this.db, 'INSERT OR IGNORE INTO user_disturbance_runs (run_id, event_seq, kind) VALUES (?, ?, ?)').run(runId, seq, e.kind)
    })
    if (++this.inserts % 200 === 0) {
      const total = (prepare(this.db, 'SELECT COUNT(*) AS n FROM user_disturbance_events').get() as { n: number }).n
      if (total > MAX_EVENTS) {
        const cut = (prepare(this.db, 'SELECT seq FROM user_disturbance_events ORDER BY seq LIMIT 1 OFFSET ?').get(total - MAX_EVENTS) as { seq: number } | undefined)?.seq
        if (cut !== undefined) {
          prepare(this.db, 'DELETE FROM user_disturbance_events WHERE seq < ?').run(cut)
          prepare(this.db, 'DELETE FROM user_disturbance_runs WHERE event_seq < ?').run(cut)
        }
      }
    }
  }

  counts(runId: string): Record<DisturbanceKind, number> {
    const out = zero()
    for (const row of prepare(this.db, 'SELECT kind, COUNT(*) AS n FROM user_disturbance_runs WHERE run_id = ? GROUP BY kind').all(runId) as { kind: DisturbanceKind; n: number }[]) out[row.kind] = row.n
    return out
  }

  recent(runId: string, limit: number): DisturbanceEvent[] {
    const rows = prepare(this.db, 'SELECT e.* FROM user_disturbance_events e JOIN user_disturbance_runs r ON r.event_seq = e.seq WHERE r.run_id = ? ORDER BY e.seq DESC LIMIT ?').all(runId, Math.min(Math.max(1, limit), 200)) as Row[]
    return rows
      .map((row) => {
        let runIds: string[]
        try {
          runIds = JSON.parse(String(row['run_ids_json'])) as string[]
        } catch {
          runIds = []
        }
        return { at: String(row['at']), kind: String(row['kind']) as DisturbanceKind, process: String(row['process']), windowClass: String(row['window_class']), runIds }
      })
      .reverse()
  }

  saveCompatibility(c: PresentationCompatibility): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO presentation_compatibility (project_id, app_key, mode, verdict, measured_at, evidence_json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, app_key, mode) DO UPDATE SET verdict = excluded.verdict, measured_at = excluded.measured_at, evidence_json = excluded.evidence_json`,
      ).run(c.projectId, c.appKey, c.mode, c.verdict, c.measuredAt, JSON.stringify(c)),
    )
  }

  compatibility(projectId: string, appKey: string): PresentationCompatibility[] {
    return (prepare(this.db, 'SELECT evidence_json FROM presentation_compatibility WHERE project_id = ? AND app_key = ?').all(projectId, appKey) as Row[])
      .map((row) => {
        try {
          return JSON.parse(String(row['evidence_json'])) as PresentationCompatibility
        } catch {
          return null
        }
      })
      .filter((c): c is PresentationCompatibility => c !== null)
  }
}

export class MemoryPresentationStore implements PresentationStore {
  readonly events: DisturbanceEvent[] = []
  readonly evidence: PresentationCompatibility[] = []
  record(e: DisturbanceEvent): void {
    this.events.push(e)
  }
  counts(runId: string): Record<DisturbanceKind, number> {
    const out = zero()
    for (const e of this.events) if (e.runIds.includes(runId)) out[e.kind]++
    return out
  }
  recent(runId: string, limit: number): DisturbanceEvent[] {
    return this.events.filter((e) => e.runIds.includes(runId)).slice(-limit)
  }
  saveCompatibility(c: PresentationCompatibility): void {
    const i = this.evidence.findIndex((x) => x.projectId === c.projectId && x.appKey === c.appKey && x.mode === c.mode)
    if (i >= 0) this.evidence[i] = c
    else this.evidence.push(c)
  }
  compatibility(projectId: string, appKey: string): PresentationCompatibility[] {
    return this.evidence.filter((c) => c.projectId === projectId && c.appKey === appKey)
  }
}

export type { PresentationMode }
