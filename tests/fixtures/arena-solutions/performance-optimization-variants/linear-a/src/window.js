import { isErrorLevel } from './levels.js'

/**
 * For every event, count the events in the window (ts - windowMs, ts] (the event itself and any
 * event sharing its timestamp included) and how many of them are errors.
 * `events` must be sorted by `ts` ascending. A window of 0 contains no events.
 */
export function rollingErrorRate(events, windowMs) {
  const n = events.length
  const stamps = new Array(n)
  // prefix[i] = number of errors among the first i events
  const prefix = new Array(n + 1)
  prefix[0] = 0
  for (let i = 0; i < n; i++) {
    const event = events[i]
    stamps[i] = event.ts
    prefix[i + 1] = prefix[i] + (isErrorLevel(event.level) ? 1 : 0)
  }
  const rows = new Array(n)
  let lo = 0 // first index with ts > t - windowMs
  let hi = 0 // first index with ts > t
  for (let i = 0; i < n; i++) {
    const t = stamps[i]
    while (hi < n && stamps[hi] <= t) hi++
    while (lo < n && stamps[lo] <= t - windowMs) lo++
    const total = Math.max(0, hi - lo)
    const errors = total === 0 ? 0 : prefix[hi] - prefix[lo]
    rows[i] = { ts: t, total, errors, rate: total === 0 ? 0 : errors / total }
  }
  return rows
}
