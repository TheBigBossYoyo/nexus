import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { addContact, search, listByTag, displayName, formatContactLine } from '../src/index.js'
import { withTempDir, file } from './helpers.mjs'

const v1 = {
  version: 1,
  records: [
    { id: '1', name: 'Ada Lovelace', email: 'ada@example.com', created: 1700000000000, tags: 'vip, speaker' },
    { id: '2', name: 'Alan Turing', created: 1700000100000, tags: 'speaker' },
  ],
}

test('search matches names and emails case-insensitively', () =>
  withTempDir(async (dir) => {
    await writeFile(file(dir), JSON.stringify(v1))
    assert.deepEqual((await search(file(dir), 'LOVE')).map((r) => r.id), ['1'])
    assert.deepEqual((await search(file(dir), 'example.com')).map((r) => r.id), ['1'])
  }))

test('listByTag finds exact tags', () =>
  withTempDir(async (dir) => {
    await writeFile(file(dir), JSON.stringify(v1))
    assert.deepEqual((await listByTag(file(dir), 'Speaker')).map((r) => r.id), ['1', '2'])
    assert.deepEqual((await listByTag(file(dir), 'vip')).map((r) => r.id), ['1'])
    assert.deepEqual(await listByTag(file(dir), 'vi'), [])
  }))

test('addContact persists and assigns the next id', () =>
  withTempDir(async (dir) => {
    await writeFile(file(dir), JSON.stringify(v1))
    const rec = await addContact(file(dir), { name: ' Grace Hopper ', tags: ['navy', 'vip'] }, { now: () => 1700000200000 })
    assert.equal(rec.id, '3')
    assert.equal(displayName(rec), 'Grace Hopper')
    assert.deepEqual((await listByTag(file(dir), 'navy')).map((r) => r.id), ['3'])
    assert.deepEqual((await search(file(dir), 'hopper')).map(displayName), ['Grace Hopper'])
  }))

test('addContact validates input and formatContactLine renders', async () => {
  await assert.rejects(addContact('unused.json', { name: '  ' }), /name is required/)
})

test('formatContactLine renders id, name and email', () =>
  withTempDir(async (dir) => {
    await writeFile(file(dir), JSON.stringify(v1))
    const [ada] = await search(file(dir), 'ada')
    assert.equal(formatContactLine(ada), '#1 Ada Lovelace <ada@example.com>')
  }))
