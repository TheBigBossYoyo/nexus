export function defaultKey(event) {
  return `${event.ts}|${event.service}|${event.message}`
}

/** Variant B: an object used as a set (null prototype), reads the key through a local helper. */
export function dedupeEvents(events, keyOf = defaultKey) {
  const seen = Object.create(null)
  const unique = []
  for (let i = 0; i < events.length; i++) {
    const key = String(keyOf(events[i]))
    if (seen[key] === true) continue
    seen[key] = true
    unique.push(events[i])
  }
  return unique
}
