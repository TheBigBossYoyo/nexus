export function defaultKey(event) {
  return `${event.ts}|${event.service}|${event.message}`
}

/** Variant A: an object-free Map of first positions, then a filter by position. */
export function dedupeEvents(events, keyOf = defaultKey) {
  const firstIndex = new Map()
  events.forEach((event, i) => {
    const key = keyOf(event)
    if (!firstIndex.has(key)) firstIndex.set(key, i)
  })
  const keep = new Set(firstIndex.values())
  return events.filter((_, i) => keep.has(i))
}
