import { CronError } from './errors.js'
import { parseField } from './field.js'
import { DAY_NAMES, MONTH_NAMES } from './names.js'

const ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
]

/**
 * Parse a five-field cron expression (or an @alias) into a schedule:
 * { minute, hour, dom, month, dow, domAny, dowAny } where the first five are sorted integer lists.
 * Day-of-week 7 is Sunday and is normalised to 0.
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') throw new CronError('cron expression must be a string')
  const trimmed = expression.trim()
  const source = ALIASES[trimmed.toLowerCase()] ?? trimmed
  const parts = source.split(/\s+/)
  if (parts.length !== 5) throw new CronError(`expected 5 fields, got ${parts.length}`)
  const [minute, hour, dom, month, rawDow] = FIELDS.map((spec, i) => parseField(parts[i], spec))
  const dow = [...new Set(rawDow.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b)
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domAny: parts[2].startsWith('*'),
    dowAny: parts[4].startsWith('*'),
  }
}

/** How many times a day that matches the schedule runs. */
export function runsPerDay(schedule) {
  return schedule.minute.length * schedule.hour.length
}
