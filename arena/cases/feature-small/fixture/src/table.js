import { formatNumber } from './format.js'

const cell = (value) => (typeof value === 'number' ? formatNumber(value) : value === null ? '' : String(value))

/** Aligned text table: numbers right aligned, everything else left aligned. */
export function renderTable(report) {
  const grid = [report.headers, ...report.rows.map((row) => row.map(cell))]
  const widths = report.headers.map((_, col) => Math.max(...grid.map((line) => line[col].length)))
  const numeric = report.headers.map((_, col) => report.rows.length > 0 && report.rows.every((row) => typeof row[col] === 'number'))
  const line = (cells) =>
    cells.map((text, col) => (numeric[col] ? text.padStart(widths[col]) : text.padEnd(widths[col]))).join('  ').trimEnd()
  const out = [report.title, line(grid[0]), widths.map((w) => '-'.repeat(w)).join('  ')]
  for (const row of grid.slice(1)) out.push(line(row))
  if (report.totals.some((total) => total !== null)) {
    out.push(line(report.totals.map((total, col) => (col === 0 && total === null ? 'Total' : total === null ? '' : formatNumber(total)))))
  }
  return out.join('\n')
}
