import test from 'node:test'
import assert from 'node:assert/strict'
import { paginate, pageCount, describePage, pageWindow, pageFromQuery } from '../src/index.js'

const range = (n) => Array.from({ length: n }, (_, i) => i + 1)

test('pageCount handles exact multiples and larger remainders', () => {
  assert.equal(pageCount(0, 5), 0)
  assert.equal(pageCount(10, 5), 2)
  assert.equal(pageCount(12, 5), 3)
  assert.equal(pageCount(14, 5), 3)
})

test('pageCount rejects bad sizes', () => {
  assert.throws(() => pageCount(10, 0), RangeError)
  assert.throws(() => pageCount(-1, 5), RangeError)
})

test('paginate returns the requested slice and metadata', () => {
  const result = paginate(range(12), { page: 2, pageSize: 5 })
  assert.deepEqual(result.items, [6, 7, 8, 9, 10])
  assert.equal(result.totalPages, 3)
  assert.equal(result.hasPrev, true)
  assert.equal(result.hasNext, true)
})

test('paginate clamps pages past the end', () => {
  const result = paginate(range(12), { page: 9, pageSize: 5 })
  assert.equal(result.page, 3)
  assert.deepEqual(result.items, [11, 12])
  assert.equal(result.hasNext, false)
})

test('paginate on an empty list', () => {
  const result = paginate([], { page: 1, pageSize: 5 })
  assert.deepEqual(result.items, [])
  assert.equal(result.totalPages, 0)
  assert.equal(describePage(result), 'No results')
})

test('paginate validates its arguments', () => {
  assert.throws(() => paginate('abc'), TypeError)
  assert.throws(() => paginate([1], { page: 0 }), RangeError)
})

test('describePage shows the visible range', () => {
  assert.equal(describePage(paginate(range(45), { page: 2, pageSize: 10 })), 'Showing 11-20 of 45')
})

test('pageWindow collapses gaps', () => {
  assert.deepEqual(pageWindow(1, 3), [1, 2, 3])
  assert.deepEqual(pageWindow(5, 10), [1, '...', 4, 5, 6, '...', 10])
  assert.deepEqual(pageWindow(1, 0), [])
})

test('pageFromQuery reads and clamps the page', () => {
  assert.equal(pageFromQuery('?page=2', 5), 2)
  assert.equal(pageFromQuery('?page=99', 5), 5)
  assert.equal(pageFromQuery('?page=abc', 5), 1)
  assert.equal(pageFromQuery('', 5), 1)
})
