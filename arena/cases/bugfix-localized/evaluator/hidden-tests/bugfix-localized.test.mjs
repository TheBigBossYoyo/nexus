import test from 'node:test'
import assert from 'node:assert/strict'
import { paginate, pageCount, describePage, pageWindow, pageFromQuery } from '../src/index.js'

const range = (n) => Array.from({ length: n }, (_, i) => i + 1)

test('a single item still needs a page', () => {
  assert.equal(pageCount(1, 10), 1)
  assert.equal(pageCount(1, 1), 1)
  const result = paginate(['only'], { page: 1, pageSize: 10 })
  assert.deepEqual(result.items, ['only'])
  assert.equal(result.totalPages, 1)
  assert.equal(result.hasNext, false)
})

test('a final page holding exactly one item is not dropped', () => {
  assert.equal(pageCount(11, 5), 3)
  assert.equal(pageCount(101, 100), 2)
  assert.equal(pageCount(6, 5), 2)
  const last = paginate(range(11), { page: 3, pageSize: 5 })
  assert.deepEqual(last.items, [11])
  assert.equal(last.totalPages, 3)
  assert.equal(last.hasNext, false)
  assert.equal(last.hasPrev, true)
})

test('every item is reachable by walking the pages', () => {
  for (const total of [1, 2, 5, 6, 7, 10, 11, 21, 31]) {
    for (const pageSize of [1, 2, 5, 10]) {
      const items = range(total)
      const first = paginate(items, { page: 1, pageSize })
      const seen = []
      for (let page = 1; page <= first.totalPages; page += 1) {
        seen.push(...paginate(items, { page, pageSize }).items)
      }
      assert.deepEqual(seen, items, `total=${total} pageSize=${pageSize}`)
    }
  }
})

test('exact multiples and larger remainders keep working', () => {
  assert.equal(pageCount(0, 5), 0)
  assert.equal(pageCount(10, 5), 2)
  assert.equal(pageCount(12, 5), 3)
  assert.equal(pageCount(5, 5), 1)
  assert.equal(pageCount(4, 5), 1)
})

test('requests past the end clamp onto a one-item last page', () => {
  const result = paginate(range(21), { page: 50, pageSize: 10 })
  assert.equal(result.page, 3)
  assert.deepEqual(result.items, [21])
  assert.equal(describePage(result), 'Showing 21-21 of 21')
})

test('consumers of the page count agree on one-item last pages', () => {
  assert.deepEqual(pageWindow(1, pageCount(11, 5)), [1, 2, 3])
  assert.equal(pageFromQuery('?page=3', pageCount(11, 5)), 3)
  assert.equal(pageFromQuery('?page=4', pageCount(11, 5)), 3)
  assert.equal(pageFromQuery('?page=2', pageCount(6, 5)), 2)
})
