import { dayMatches } from './matches.js'

const MINUTE = 60000

/**
 * The first scheduled minute strictly after `from` (UTC), or null when none exists within
 * `limitYears` years (e.g. 30 February).
 */
export function nextRun(schedule, from, { limitYears = 5 } = {}) {
  const start = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE
  const limit = start + limitYears * 366 * 24 * 60 * MINUTE
  let t = start
  while (t <= limit) {
    const d = new Date(t)
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth()
    const day = d.getUTCDate()
    if (!schedule.month.includes(month + 1)) {
      t = Date.UTC(year, month + 1, 1)
    } else if (!dayMatches(schedule, d)) {
      t = Date.UTC(year, month, day + 1)
    } else if (!schedule.hour.includes(d.getUTCHours())) {
      t = Date.UTC(year, month, day, d.getUTCHours() + 1)
    } else if (!schedule.minute.includes(d.getUTCMinutes())) {
      t += MINUTE
    } else {
      return d
    }
  }
  return null
}

/** The next `count` scheduled minutes after `from`, fewer if the schedule runs out. */
export function upcoming(schedule, from, count) {
  const runs = []
  let cursor = from
  for (let i = 0; i < count; i++) {
    const next = nextRun(schedule, cursor)
    if (!next) break
    runs.push(next)
    cursor = next
  }
  return runs
}
