import { isErrorLevel } from './levels.js'

/**
 * Variant B: n log n. Binary search for the window start and end, prefix sums for the error count, and the
 * event is read several times (no attempt to minimise property reads).
 */
export function rollingErrorRate(events, windowMs) {
  const prefix = [0]
  for (const event of events) prefix.push(prefix[prefix.length - 1] + (isErrorLevel(event.level) ? 1 : 0))
  // first index whose ts is greater than `limit`
  const upper = (limit) => {
    let lo = 0
    let hi = events.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (events[mid].ts <= limit) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  return events.map((event) => {
    const end = upper(event.ts)
    const start = upper(event.ts - windowMs)
    const total = Math.max(0, end - start)
    const errors = total === 0 ? 0 : prefix[end] - prefix[start]
    return { ts: event.ts, total, errors, rate: total === 0 ? 0 : errors / total }
  })
}
