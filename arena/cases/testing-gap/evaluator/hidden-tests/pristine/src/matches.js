/**
 * Day-of-month and day-of-week follow the classic cron rule: when both fields are restricted a day
 * matches if EITHER matches; when one of them starts with "*" the other one decides alone.
 */
export function dayMatches(schedule, date) {
  const domOk = schedule.dom.includes(date.getUTCDate())
  const dowOk = schedule.dow.includes(date.getUTCDay())
  if (schedule.domAny || schedule.dowAny) return domOk && dowOk
  return domOk || dowOk
}

/** True when `date` (interpreted in UTC, seconds ignored) is a scheduled minute. */
export function matches(schedule, date) {
  if (!schedule.month.includes(date.getUTCMonth() + 1)) return false
  if (!schedule.hour.includes(date.getUTCHours())) return false
  if (!schedule.minute.includes(date.getUTCMinutes())) return false
  return dayMatches(schedule, date)
}
