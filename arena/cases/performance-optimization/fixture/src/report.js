import { parseLog } from './parse.js'
import { dedupeEvents } from './dedupe.js'
import { rollingErrorRate } from './window.js'
import { serviceTable } from './services.js'
import { latencySummary } from './percentile.js'

/**
 * Build a report from raw log text.
 * options: { levels, keyOf, windowMs (default 60000), percentiles (default [50, 90, 99]) }
 */
export function buildReport(text, options = {}) {
  const { events: parsed, skipped } = parseLog(text, { levels: options.levels })
  const events = dedupeEvents(parsed, options.keyOf)
  const ordered = [...events].sort((a, b) => a.ts - b.ts)
  const windows = rollingErrorRate(ordered, options.windowMs ?? 60000)
  return {
    total: parsed.length,
    unique: events.length,
    skipped,
    services: serviceTable(events),
    latency: latencySummary(events, options.percentiles),
    peakErrorRate: windows.reduce((peak, w) => Math.max(peak, w.rate), 0),
  }
}
