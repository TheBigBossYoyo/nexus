import { isErrorLevel } from './levels.js'

/** Variant B: reduce into a Map of immutable-looking rows, then map and sort. */
export function serviceTable(events) {
  const byName = events.reduce((map, event) => {
    const prev = map.get(event.service) ?? { count: 0, errors: 0, total: 0, max: -Infinity }
    map.set(event.service, {
      count: prev.count + 1,
      errors: prev.errors + (isErrorLevel(event.level) ? 1 : 0),
      total: prev.total + event.latencyMs,
      max: Math.max(prev.max, event.latencyMs),
    })
    return map
  }, new Map())
  return Array.from(byName, ([service, r]) => ({
    service,
    count: r.count,
    errors: r.errors,
    avgLatencyMs: r.total / r.count,
    maxLatencyMs: r.max,
  })).sort((a, b) => b.count - a.count || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0))
}
