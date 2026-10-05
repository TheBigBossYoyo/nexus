/**
 * Apply one journal record to the in-memory map.
 * Records: { seq, op: 'set', key, value } | { seq, op: 'delete', key } | { seq, op: 'incr', key, by }
 */
export function applyRecord(data, record) {
  switch (record.op) {
    case 'set':
      data.set(record.key, record.value)
      break
    case 'delete':
      data.delete(record.key)
      break
    case 'incr':
      data.set(record.key, (data.get(record.key) ?? 0) + record.by)
      break
    default:
      throw new Error(`unknown journal operation: ${record.op}`)
  }
}
