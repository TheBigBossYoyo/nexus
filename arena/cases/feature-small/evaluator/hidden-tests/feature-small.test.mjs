import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.js'

const { groupSummary } = api

const rows = [
  { region: 'north', amount: 100 },
  { region: 'south', amount: 300 },
  { region: 'north', amount: 50 },
  { region: 'east', amount: 150 },
  { region: 'south', amount: 'n/a' },
  { amount: 7 },
  { region: null, amount: 3 },
]

test('groupSummary is exported', () => {
  assert.equal(typeof groupSummary, 'function')
})

test('groups, counts and totals; default sort is by key ascending', () => {
  const result = groupSummary(rows, { by: 'region', sum: 'amount' })
  assert.deepEqual(result, [
    { key: 'east', count: 1, total: 150 },
    { key: 'north', count: 2, total: 150 },
    { key: null, count: 2, total: 10 },
    { key: 'south', count: 2, total: 300 },
  ])
})

test('non-numeric values count but add nothing to the total', () => {
  const [south] = groupSummary(rows, { by: 'region', sum: 'amount', sort: 'key', order: 'desc' })
  assert.deepEqual(south, { key: 'south', count: 2, total: 300 })
})

test('sort by total descending breaks ties by first appearance', () => {
  const tied = [
    { k: 'b', v: 5 },
    { k: 'a', v: 5 },
    { k: 'c', v: 9 },
    { k: 'd', v: 5 },
  ]
  assert.deepEqual(groupSummary(tied, { by: 'k', sum: 'v', sort: 'total', order: 'desc' }).map((g) => g.key), ['c', 'b', 'a', 'd'])
  assert.deepEqual(groupSummary(tied, { by: 'k', sum: 'v', sort: 'total', order: 'asc' }).map((g) => g.key), ['b', 'a', 'd', 'c'])
})

test('sort by count with ties in first-seen order', () => {
  const data = [{ g: 'x', n: 1 }, { g: 'y', n: 1 }, { g: 'y', n: 1 }, { g: 'z', n: 1 }, { g: 'z', n: 1 }]
  assert.deepEqual(groupSummary(data, { by: 'g', sum: 'n', sort: 'count', order: 'desc' }).map((r) => r.key), ['y', 'z', 'x'])
  assert.deepEqual(groupSummary(data, { by: 'g', sum: 'n', sort: 'count' }).map((r) => r.key), ['x', 'y', 'z'])
})

test('limit applies after sorting', () => {
  const result = groupSummary(rows, { by: 'region', sum: 'amount', sort: 'total', order: 'desc', limit: 2 })
  assert.deepEqual(result.map((r) => r.key), ['south', 'north'])
  assert.equal(groupSummary(rows, { by: 'region', sum: 'amount', limit: 100 }).length, 4)
})

test('empty input yields an empty array', () => {
  assert.deepEqual(groupSummary([], { by: 'region', sum: 'amount' }), [])
  assert.deepEqual(groupSummary([], { by: 'region', sum: 'amount', sort: 'total', order: 'desc', limit: 3 }), [])
})

test('does not modify its input', () => {
  const input = structuredClone(rows)
  Object.freeze(input)
  for (const row of input) Object.freeze(row)
  assert.doesNotThrow(() => groupSummary(input, { by: 'region', sum: 'amount', sort: 'total', order: 'desc' }))
  assert.deepEqual(input, rows)
})

test('invalid arguments throw TypeError', () => {
  assert.throws(() => groupSummary('rows', { by: 'a', sum: 'b' }), TypeError)
  assert.throws(() => groupSummary([1], { by: 'a', sum: 'b' }), TypeError)
  assert.throws(() => groupSummary([], {}), TypeError)
  assert.throws(() => groupSummary([], { by: '', sum: 'b' }), TypeError)
  assert.throws(() => groupSummary([], { by: 'a', sum: 5 }), TypeError)
  assert.throws(() => groupSummary([]), TypeError)
})

test('invalid sort, order or limit throw RangeError', () => {
  assert.throws(() => groupSummary([], { by: 'a', sum: 'b', sort: 'name' }), RangeError)
  assert.throws(() => groupSummary([], { by: 'a', sum: 'b', order: 'up' }), RangeError)
  assert.throws(() => groupSummary([], { by: 'a', sum: 'b', limit: 0 }), RangeError)
  assert.throws(() => groupSummary([], { by: 'a', sum: 'b', limit: 1.5 }), RangeError)
  assert.throws(() => groupSummary(rows, { by: 'region', sum: 'amount', limit: -2 }), RangeError)
})

test('existing exports are untouched', () => {
  for (const name of ['buildReport', 'renderTable', 'toCsv', 'sum', 'mean', 'formatNumber']) {
    assert.equal(typeof api[name], 'function', name)
  }
})
