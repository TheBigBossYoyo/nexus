import { isErrorLevel } from './levels.js'

/** Per-service statistics, busiest service first (ties broken by name). */
export function serviceTable(events) {
  const names = [...new Set(events.map((event) => event.service))]
  const rows = names.map((name) => {
    const mine = events.filter((event) => event.service === name)
    const totalLatency = mine.reduce((sum, event) => sum + event.latencyMs, 0)
    return {
      service: name,
      count: mine.length,
      errors: mine.filter((event) => isErrorLevel(event.level)).length,
      avgLatencyMs: totalLatency / mine.length,
      maxLatencyMs: Math.max(...mine.map((event) => event.latencyMs)),
    }
  })
  return rows.sort((a, b) => b.count - a.count || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0))
}
