import { DEFAULT_LEVELS } from './levels.js'

/**
 * Parse one log line. Returns null when the line is malformed.
 * `levels` is the list of level names the log may use.
 */
export function parseLine(line, levels = DEFAULT_LEVELS) {
  const pattern = new RegExp(`^(\\S+)\\s+(${levels.join('|')})\\s+([\\w.-]+)\\s+(\\d+)ms(?:\\s+(.*))?$`)
  const match = pattern.exec(line.trim())
  if (!match) return null
  const ts = Date.parse(match[1])
  if (Number.isNaN(ts)) return null
  return {
    ts,
    level: match[2],
    service: match[3],
    latencyMs: Number(match[4]),
    message: match[5] ?? '',
  }
}

/** Parse a whole log. Blank lines are ignored, malformed lines are counted in `skipped`. */
export function parseLog(text, options = {}) {
  const levels = options.levels ?? DEFAULT_LEVELS
  let events = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue
    const event = parseLine(raw, levels)
    if (event) events = events.concat([event])
    else skipped++
  }
  return { events, skipped }
}
