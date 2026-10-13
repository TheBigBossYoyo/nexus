import type { Database } from 'better-sqlite3'
import type { NetworkOutage } from '@shared/connectivity'
import type { OutageStore } from './outage-store'

/**
 * The outage log in NEXUS's database (table `network_outages`, migration 020): one row per outage, the record
 * as JSON, written again each time the outage gains a fact. A database without the table (an older one that is
 * being looked at) keeps nothing and breaks nothing.
 */
export function sqliteOutageStore(db: Database): OutageStore {
  const iso = (ms: number | null | undefined): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null)
  const has = (): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'network_outages'").get() !== undefined
  return {
    save(outage) {
      if (!has()) return
      const o = outage as NetworkOutage & { id: string; startedAt: number; endedAt?: number | null }
      db.prepare('INSERT INTO network_outages (id, started_at, ended_at, record_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, record_json = excluded.record_json').run(o.id, iso(o.startedAt) ?? new Date().toISOString(), iso(o.endedAt ?? null), JSON.stringify(outage))
    },
    recent(limit) {
      if (!has()) return []
      const rows = db.prepare('SELECT record_json FROM network_outages ORDER BY started_at DESC LIMIT ?').all(Math.min(Math.max(1, limit), 500)) as { record_json: string }[]
      return rows.flatMap((r) => {
        try {
          return [JSON.parse(r.record_json) as NetworkOutage]
        } catch {
          return []
        }
      })
    },
  }
}
