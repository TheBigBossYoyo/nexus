import { assertRows } from './rows.js'

const SORTS = new Set(['key', 'total', 'count'])
const ORDERS = new Set(['asc', 'desc'])

export function groupSummary(rows, options) {
  assertRows(rows)
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('options must be an object')
  }
  const { by, sum, sort = 'key', order = 'asc', limit } = options
  if (typeof by !== 'string' || by === '') throw new TypeError('by must be a non-empty string')
  if (typeof sum !== 'string' || sum === '') throw new TypeError('sum must be a non-empty string')
  if (!SORTS.has(sort)) throw new RangeError(`unknown sort: ${String(sort)}`)
  if (!ORDERS.has(order)) throw new RangeError(`unknown order: ${String(order)}`)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new RangeError('limit must be a positive integer')
  }

  const groups = new Map()
  for (const row of rows) {
    const key = row[by] ?? null
    let group = groups.get(key)
    if (!group) {
      group = { key, count: 0, total: 0 }
      groups.set(key, group)
    }
    group.count += 1
    const value = row[sum]
    if (typeof value === 'number' && Number.isFinite(value)) group.total += value
  }

  const direction = order === 'desc' ? -1 : 1
  const compare = (a, b) => {
    const left = sort === 'key' ? String(a.key) : a[sort]
    const right = sort === 'key' ? String(b.key) : b[sort]
    return left < right ? -direction : left > right ? direction : 0
  }
  // Array.prototype.sort is stable, so ties keep first-appearance order for both directions.
  const sorted = [...groups.values()].sort(compare)
  return limit === undefined ? sorted : sorted.slice(0, limit)
}
