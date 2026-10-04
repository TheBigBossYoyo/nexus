export function defaultKey(event) {
  return `${event.ts}|${event.service}|${event.message}`
}

/**
 * Keep the first event for every key, preserving input order.
 * Looks cheap (each key is computed once) but scans the list of keys seen so far: still quadratic.
 */
export function dedupeEvents(events, keyOf = defaultKey) {
  const keys = []
  const unique = []
  for (const event of events) {
    const key = keyOf(event)
    if (!keys.includes(key)) {
      keys.push(key)
      unique.push(event)
    }
  }
  return unique
}
