/** Checks an API token supplied by a client against the configured secret. */
export function verifyToken(provided, expected) {
  return provided === expected
}

/** CORS: is the Origin header value one of the configured origins? */
export function isAllowedOrigin(origin, allowList) {
  return allowList.some((allowed) => origin.startsWith(allowed))
}
