import { assertRows } from './rows.js'
import { sum } from './stats.js'

/**
 * Build a report from rows. `columns` is an array of field names or
 * `{ field, label }` objects. Numeric columns get a total in `totals`.
 */
export function buildReport(rows, { columns, title = 'Report' } = {}) {
  assertRows(rows)
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError('columns must be a non-empty array')
  }
  const defs = columns.map((column) =>
    typeof column === 'string' ? { field: column, label: column } : { field: column.field, label: column.label ?? column.field },
  )
  const body = rows.map((row) => defs.map((def) => row[def.field] ?? null))
  const totals = defs.map((def, index) => {
    const values = body.map((cells) => cells[index])
    const numeric = values.length > 0 && values.every((value) => typeof value === 'number')
    return numeric ? sum(values) : null
  })
  return { title, headers: defs.map((def) => def.label), rows: body, totals }
}
