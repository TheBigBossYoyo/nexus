import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { loadStore, StoreError } from '../src/index.js'
import { withTempDir, file } from './helpers.mjs'

const v1 = {
  version: 1,
  records: [
    { id: '1', name: 'Ada Lovelace', email: 'ada@example.com', created: 1700000000000, tags: 'vip, speaker' },
    { id: '2', name: 'Alan Turing', created: 1700000100000, tags: '' },
  ],
}

test('loadStore reads all records', () =>
  withTempDir(async (dir) => {
    await writeFile(file(dir), JSON.stringify(v1))
    const store = await loadStore(file(dir))
    assert.equal(store.records.length, 2)
  }))

test('loadStore returns an empty store for a missing file', () =>
  withTempDir(async (dir) => {
    const store = await loadStore(file(dir))
    assert.deepEqual(store.records, [])
  }))

test('loadStore rejects garbage with CORRUPT_FILE', () =>
  withTempDir(async (dir) => {
    await writeFile(file(dir), '{not json')
    await assert.rejects(loadStore(file(dir)), (err) => err instanceof StoreError && err.code === 'CORRUPT_FILE')
  }))
