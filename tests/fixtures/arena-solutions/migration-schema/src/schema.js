/** Version of the on-disk document this code reads and writes. */
export const CURRENT_VERSION = 2

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** v1 stores tags as one comma separated string. */
export function splitTags(text) {
  return String(text ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}
