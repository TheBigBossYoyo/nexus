export function defaultKey(event) {
  return `${event.ts}|${event.service}|${event.message}`
}

/**
 * Keep the first event for every key, preserving input order.
 * `keyOf` maps an event to its identity; it may be expensive (callers use it to normalise messages).
 */
export function dedupeEvents(events, keyOf = defaultKey) {
  const seen = new Set()
  const unique = []
  for (const event of events) {
    const key = keyOf(event)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(event)
  }
  return unique
}
