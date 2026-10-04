import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (value) => createHash('sha256').update(value, 'utf8').digest()

/** Checks an API token supplied by a client against the configured secret in constant time. */
export function verifyToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
  // Hashing both sides gives equal-length buffers, so neither length nor content leaks through timing.
  return timingSafeEqual(digest(provided), digest(expected))
}

/** CORS: is the Origin header value exactly one of the configured origins? */
export function isAllowedOrigin(origin, allowList) {
  if (typeof origin !== 'string' || origin === '' || !Array.isArray(allowList)) return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.origin === 'null' || parsed.origin !== origin.replace(/\/+$/, '').toLowerCase()) return false
  return allowList.some((allowed) => {
    try {
      return new URL(allowed).origin === parsed.origin
    } catch {
      return false
    }
  })
}
