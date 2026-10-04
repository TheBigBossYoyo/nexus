import { isErrorLevel } from './levels.js'

/** Per-service statistics, busiest service first (ties broken by name). */
export function serviceTable(events) {
  const byName = new Map()
  for (const event of events) {
    let row = byName.get(event.service)
    if (!row) {
      row = { service: event.service, count: 0, errors: 0, totalLatency: 0, maxLatencyMs: -Infinity }
      byName.set(event.service, row)
    }
    row.count++
    if (isErrorLevel(event.level)) row.errors++
    row.totalLatency += event.latencyMs
    if (event.latencyMs > row.maxLatencyMs) row.maxLatencyMs = event.latencyMs
  }
  const rows = [...byName.values()].map((row) => ({
    service: row.service,
    count: row.count,
    errors: row.errors,
    avgLatencyMs: row.totalLatency / row.count,
    maxLatencyMs: row.maxLatencyMs,
  }))
  return rows.sort((a, b) => b.count - a.count || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0))
}
