import { isErrorLevel } from './levels.js'

/**
 * For every event, count the events in the window (ts - windowMs, ts] (the event itself and any
 * event sharing its timestamp included) and how many of them are errors.
 * `events` must be sorted by `ts` ascending. A window of 0 contains no events.
 */
export function rollingErrorRate(events, windowMs) {
  return events.map((event) => {
    const inWindow = events.filter((other) => other.ts <= event.ts && other.ts > event.ts - windowMs)
    const errors = inWindow.filter((other) => isErrorLevel(other.level)).length
    return {
      ts: event.ts,
      total: inWindow.length,
      errors,
      rate: inWindow.length === 0 ? 0 : errors / inWindow.length,
    }
  })
}
