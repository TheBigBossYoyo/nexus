import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, StoreError } from '../src/index.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kvlog-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('set, get, delete and incr', (t) => {
  const store = openStore(tempDir(t))
  store.set('a', { n: 1 })
  assert.deepEqual(store.get('a'), { n: 1 })
  assert.equal(store.has('a'), true)
  assert.equal(store.incr('hits'), 1)
  assert.equal(store.incr('hits', 4), 5)
  assert.equal(store.delete('a'), true)
  assert.equal(store.delete('a'), false)
  assert.deepEqual(store.keys(), ['hits'])
  assert.equal(store.size, 1)
  store.close()
})

test('rejects bad input', (t) => {
  const store = openStore(tempDir(t))
  assert.throws(() => store.set('', 1), TypeError)
  assert.throws(() => store.set('k', undefined), TypeError)
  store.set('s', 'text')
  assert.throws(() => store.incr('s'), TypeError)
  store.close()
})

test('data survives a clean close and reopen', (t) => {
  const dir = tempDir(t)
  const first = openStore(dir)
  first.set('a', 1)
  first.set('b', [1, 2])
  first.incr('n', 3)
  first.delete('a')
  first.close()
  const second = openStore(dir)
  assert.deepEqual(second.keys(), ['b', 'n'])
  assert.equal(second.get('n'), 3)
  assert.equal(second.stats().seq, 4)
  second.close()
})

test('snapshot keeps the data and empties the journal', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  store.set('a', 1)
  store.incr('n', 2)
  store.snapshot()
  assert.equal(store.stats().journalRecords, 0)
  store.set('b', 2)
  store.close()
  const reopened = openStore(dir)
  assert.deepEqual(reopened.keys(), ['a', 'b', 'n'])
  assert.equal(reopened.get('n'), 2)
  reopened.close()
})

test('automatic snapshots happen every snapshotEvery records', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir, { snapshotEvery: 3 })
  for (let i = 0; i < 7; i++) store.incr('n')
  assert.equal(store.stats().snapshotSeq, 6)
  assert.equal(store.stats().journalRecords, 1)
  store.close()
  const reopened = openStore(dir)
  assert.equal(reopened.get('n'), 7)
  reopened.close()
})

test('a directory can only be opened once at a time', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  assert.throws(() => openStore(dir), (error) => error instanceof StoreError && error.code === 'LOCKED')
  store.close()
  assert.equal(existsSync(join(dir, 'LOCK')), false)
  openStore(dir).close()
})

test('a closed store refuses work', (t) => {
  const store = openStore(tempDir(t))
  store.close()
  store.close()
  assert.throws(() => store.get('a'), (error) => error.code === 'CLOSED')
})
