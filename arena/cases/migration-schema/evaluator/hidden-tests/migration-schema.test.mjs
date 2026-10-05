import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStore, saveStore, migrateV1ToV2 } from '../src/store.js'
import { addContact, search, listByTag, displayName } from '../src/contacts.js'
import { CURRENT_VERSION } from '../src/schema.js'

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'migration-schema-'))
  try {
    return await fn(dir, join(dir, 'contacts.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const exists = (p) => access(p).then(() => true, () => false)

function v1Doc() {
  return {
    version: 1,
    records: [
      { id: '1', name: 'Ada Lovelace', email: 'ada@example.com', created: 1700000000123, updated: 1700000500000, tags: 'vip, speaker', notes: 'met at conf' },
      { id: '2', name: '  Mary   Ann  Smith ', created: 1700000100000, tags: ' a, b ,,c ,' },
      { id: '3', name: 'Plato', created: 0, tags: '' },
      { id: '4', name: 'Alan Turing', created: 1700000200000 },
    ],
  }
}

test('CURRENT_VERSION is 2', () => assert.equal(CURRENT_VERSION, 2))

test('v1 records are converted field by field', () =>
  withDir(async (dir, file) => {
    await writeFile(file, JSON.stringify(v1Doc()))
    const store = await loadStore(file)
    assert.equal(store.version, 2)
    assert.equal(store.records.length, 4)
    assert.deepEqual(store.quarantine, [])
    const [ada, mary, plato, alan] = store.records
    assert.equal(ada.id, '1')
    assert.equal(ada.firstName, 'Ada')
    assert.equal(ada.lastName, 'Lovelace')
    assert.equal(ada.created, '2023-11-14T22:13:20.123Z')
    assert.equal(ada.updated, '2023-11-14T22:21:40.000Z')
    assert.deepEqual(ada.tags, ['vip', 'speaker'])
    assert.equal(ada.email, 'ada@example.com')
    assert.equal(ada.notes, 'met at conf', 'unknown fields must survive')
    assert.equal('name' in ada, false)
    assert.equal(mary.firstName, 'Mary Ann')
    assert.equal(mary.lastName, 'Smith')
    assert.deepEqual(mary.tags, ['a', 'b', 'c'])
    assert.equal(plato.firstName, 'Plato')
    assert.equal(plato.lastName, '')
    assert.equal(plato.created, '1970-01-01T00:00:00.000Z', 'epoch 0 is a valid date')
    assert.deepEqual(plato.tags, [])
    assert.deepEqual(alan.tags, [])
    assert.equal('updated' in alan, false)
  }))

test('migration is written back, atomically, with a byte-exact .bak of the v1 file', () =>
  withDir(async (dir, file) => {
    const original = JSON.stringify(v1Doc(), null, 4) + '\r\n'
    await writeFile(file, original)
    const store = await loadStore(file)
    assert.equal(await readFile(`${file}.bak`, 'utf8'), original)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), JSON.parse(JSON.stringify(store)))
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2)
    assert.deepEqual((await readdir(dir)).sort(), ['contacts.json', 'contacts.json.bak'])
  }))

test('loading is idempotent and does not touch the backup again', () =>
  withDir(async (dir, file) => {
    const original = JSON.stringify(v1Doc())
    await writeFile(file, original)
    const first = await loadStore(file)
    const onDisk = await readFile(file, 'utf8')
    const second = await loadStore(file)
    const third = await loadStore(file)
    assert.deepEqual(second, first)
    assert.deepEqual(third, first)
    assert.equal(await readFile(file, 'utf8'), onDisk)
    assert.equal(await readFile(`${file}.bak`, 'utf8'), original, 'the backup must stay the v1 original')
  }))

test('an existing v2 file is returned as is, without rewrite or backup', () =>
  withDir(async (dir, file) => {
    const v2 = {
      version: 2,
      records: [{ id: '9', firstName: 'Grace', lastName: 'Hopper', created: '2020-01-01T00:00:00.000Z', tags: ['navy'] }],
      quarantine: [{ index: 3, reason: 'bad', raw: { id: 7 } }],
    }
    const text = JSON.stringify(v2)
    await writeFile(file, text)
    const store = await loadStore(file)
    assert.deepEqual(store, v2)
    assert.equal(await readFile(file, 'utf8'), text)
    assert.equal(await exists(`${file}.bak`), false)
  }))

test('unknown versions are refused with a clear error and the file is untouched', () =>
  withDir(async (dir, file) => {
    for (const version of [3, 99]) {
      const text = JSON.stringify({ version, records: [{ id: '1', whatever: true }] })
      await writeFile(file, text)
      await assert.rejects(loadStore(file), (err) => {
        assert.equal(err.code, 'UNSUPPORTED_VERSION')
        assert.match(err.message, new RegExp(String(version)))
        return true
      })
      assert.equal(await readFile(file, 'utf8'), text)
      assert.equal(await exists(`${file}.bak`), false)
    }
    await writeFile(file, JSON.stringify({ records: [] }))
    await assert.rejects(loadStore(file), (err) => err.code === 'UNSUPPORTED_VERSION')
  }))

test('structurally broken files still report CORRUPT_FILE', () =>
  withDir(async (dir, file) => {
    for (const text of ['{oops', '[]', 'null', JSON.stringify({ version: 1, records: 'nope' }), JSON.stringify({ version: 2 })]) {
      await writeFile(file, text)
      await assert.rejects(loadStore(file), (err) => err.code === 'CORRUPT_FILE', text)
      assert.equal(await readFile(file, 'utf8'), text)
    }
  }))

test('corrupt entries are reported in quarantine and never lost', () =>
  withDir(async (dir, file) => {
    const doc = {
      version: 1,
      records: [
        { id: '1', name: 'Good One', created: 1700000000000, tags: 'x' },
        null,
        'a string',
        { id: '3', created: 1700000000000, tags: '' },
        { id: '4', name: '   ', created: 1700000000000 },
        { id: '5', name: 'Bad Date', created: 'yesterday' },
        { id: '6', name: 'Huge Date', created: 1e20 },
        { id: '7', name: 'Bad Tags', created: 1700000000000, tags: { a: 1 } },
        { name: 'No Id', created: 1700000000000 },
        { id: '9', name: 'Fine Too', created: 1700000300000, tags: 'y,z' },
      ],
    }
    await writeFile(file, JSON.stringify(doc))
    const store = await loadStore(file)
    assert.deepEqual(store.records.map((r) => r.id), ['1', '9'])
    assert.equal(store.records.length + store.quarantine.length, doc.records.length)
    assert.deepEqual(store.quarantine.map((q) => q.index), [1, 2, 3, 4, 5, 6, 7, 8])
    for (const q of store.quarantine) {
      assert.equal(typeof q.reason, 'string')
      assert.ok(q.reason.length > 0)
      assert.deepEqual(q.raw, doc.records[q.index])
    }
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(onDisk.quarantine, store.quarantine)
    assert.equal(onDisk.records.length, 2)
    // the quarantine survives later loads
    assert.deepEqual((await loadStore(file)).quarantine, store.quarantine)
  }))

test('migrateV1ToV2 is pure and does not mutate its input', () => {
  const doc = v1Doc()
  doc.records.push({ id: 'x', name: '', created: 1 })
  const frozen = JSON.parse(JSON.stringify(doc))
  const out = migrateV1ToV2(doc)
  assert.deepEqual(doc, frozen)
  assert.equal(out.version, 2)
  assert.equal(out.records.length, 4)
  assert.equal(out.quarantine.length, 1)
  assert.equal(out.quarantine[0].index, 4)
  assert.throws(() => migrateV1ToV2({ version: 2, records: [] }), (err) => err.code === 'UNSUPPORTED_VERSION')
})

test('a missing file yields an empty current-version store', () =>
  withDir(async (dir, file) => {
    const store = await loadStore(file)
    assert.equal(store.version, 2)
    assert.deepEqual(store.records, [])
    assert.deepEqual(store.quarantine, [])
  }))

test('saveStore writes only version 2 documents and leaves no temp files', () =>
  withDir(async (dir, file) => {
    await assert.rejects(saveStore(file, { version: 1, records: [] }), (err) => err.code === 'UNSUPPORTED_VERSION')
    assert.equal(await exists(file), false)
    const doc = { version: 2, records: [{ id: '1', firstName: 'A', lastName: 'B', created: '2020-01-01T00:00:00.000Z', tags: [] }], quarantine: [] }
    await saveStore(file, doc)
    await saveStore(file, doc)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), doc)
    assert.deepEqual(await readdir(dir), ['contacts.json'])
  }))

test('contacts API works on a v1 file and on the migrated file', () =>
  withDir(async (dir, file) => {
    await writeFile(file, JSON.stringify(v1Doc()))
    assert.deepEqual((await search(file, 'lovelace')).map(displayName), ['Ada Lovelace'])
    assert.deepEqual((await search(file, 'mary')).map(displayName), ['Mary Ann Smith'])
    assert.deepEqual((await search(file, 'plato')).map(displayName), ['Plato'])
    assert.deepEqual((await listByTag(file, 'SPEAKER')).map((r) => r.id), ['1'])
    assert.deepEqual((await listByTag(file, 'b')).map((r) => r.id), ['2'])
    assert.deepEqual(await listByTag(file, 'vi'), [])
  }))

test('addContact on a v1 file migrates first and stores a v2 record', () =>
  withDir(async (dir, file) => {
    await writeFile(file, JSON.stringify(v1Doc()))
    const rec = await addContact(file, { name: 'Grace Brewster Hopper', email: 'g@navy.mil', tags: ['navy', 'cobol'] }, { now: () => 1700000900000 })
    assert.equal(rec.id, '5')
    assert.equal(rec.firstName, 'Grace Brewster')
    assert.equal(rec.lastName, 'Hopper')
    assert.equal(rec.created, '2023-11-14T22:28:20.000Z')
    assert.deepEqual(rec.tags, ['navy', 'cobol'])
    assert.equal(displayName(rec), 'Grace Brewster Hopper')
    assert.equal(await exists(`${file}.bak`), true)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.equal(onDisk.records.length, 5)
    assert.deepEqual((await listByTag(file, 'cobol')).map((r) => r.id), ['5'])
    assert.deepEqual(await readdir(dir).then((n) => n.sort()), ['contacts.json', 'contacts.json.bak'])
  }))
