export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array')
  }
  for (const row of rows) {
    if (!isPlainObject(row)) {
      throw new TypeError('every row must be a plain object')
    }
  }
  return rows
}
