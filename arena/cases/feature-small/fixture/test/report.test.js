import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, renderTable, toCsv, sum, mean, formatNumber } from '../src/index.js'

const rows = [
  { region: 'north', rep: 'Ada', amount: 1200 },
  { region: 'south', rep: 'Bo', amount: 800 },
  { region: 'north', rep: 'Cy', amount: 450.5 },
]

test('stats helpers ignore non-numbers', () => {
  assert.equal(sum([1, 2, 'x', NaN, 3]), 6)
  assert.equal(mean([]), 0)
  assert.equal(mean([2, 4]), 3)
})

test('formatNumber groups thousands', () => {
  assert.equal(formatNumber(1234567.25), '1,234,567.25')
  assert.equal(formatNumber(-1000), '-1,000')
  assert.equal(formatNumber(null), '')
})

test('buildReport selects columns and totals numeric ones', () => {
  const report = buildReport(rows, { columns: ['rep', { field: 'amount', label: 'Amount' }], title: 'Sales' })
  assert.deepEqual(report.headers, ['rep', 'Amount'])
  assert.deepEqual(report.totals, [null, 2450.5])
  assert.equal(report.rows.length, 3)
})

test('buildReport validates input', () => {
  assert.throws(() => buildReport('x', { columns: ['a'] }), TypeError)
  assert.throws(() => buildReport([1], { columns: ['a'] }), TypeError)
  assert.throws(() => buildReport([], { columns: [] }), TypeError)
})

test('renderTable aligns columns and adds totals', () => {
  const text = renderTable(buildReport(rows, { columns: ['rep', 'amount'], title: 'Sales' }))
  assert.equal(text.split('\n')[0], 'Sales')
  assert.match(text, /Total\s+2,450\.5$/)
})

test('toCsv quotes awkward fields', () => {
  const report = buildReport([{ name: 'a,b', note: 'say "hi"' }], { columns: ['name', 'note'] })
  assert.equal(toCsv(report), 'name,note\n"a,b","say ""hi"""\n')
})
