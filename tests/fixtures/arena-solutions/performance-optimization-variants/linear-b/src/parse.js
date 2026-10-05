import { DEFAULT_LEVELS } from './levels.js'

const patterns = new Map()

function patternFor(levels) {
  const key = levels.join('|')
  let pattern = patterns.get(key)
  if (!pattern) {
    pattern = new RegExp(`^(\\S+)\\s+(${key})\\s+([\\w.-]+)\\s+(\\d+)ms(?:\\s+(.*))?$`)
    patterns.set(key, pattern)
  }
  return pattern
}

/**
 * Parse one log line. Returns null when the line is malformed.
 * `levels` is the list of level names the log may use.
 */
export function parseLine(line, levels = DEFAULT_LEVELS) {
  const match = patternFor(levels).exec(line.trim())
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
  const events = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue
    const event = parseLine(raw, levels)
    if (event) events.push(event)
    else skipped++
  }
  return { events, skipped }
}
