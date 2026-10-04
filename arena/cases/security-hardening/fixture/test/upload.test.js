import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { isAllowedUpload, saveUpload } from '../src/index.js'
import { withTempDir } from './helpers.mjs'

test('isAllowedUpload accepts the supported types', () => {
  for (const name of ['photo.png', 'Scan.PDF', 'notes.txt', 'a.b.jpeg']) assert.equal(isAllowedUpload(name), true, name)
  for (const name of ['run.exe', 'page.html', 'script.js']) assert.equal(isAllowedUpload(name), false, name)
})

test('saveUpload stores the file in the upload directory', () =>
  withTempDir(async (dir) => {
    const uploads = path.join(dir, 'uploads')
    const saved = await saveUpload(uploads, 'photo.png', Buffer.from([1, 2, 3]))
    assert.equal(saved.name, 'photo.png')
    assert.equal(saved.path, path.join(uploads, 'photo.png'))
    assert.deepEqual([...(await readFile(saved.path))], [1, 2, 3])
  }))

test('saveUpload refuses unsupported types', () =>
  withTempDir(async (dir) => {
    await assert.rejects(saveUpload(path.join(dir, 'u'), 'tool.exe', 'x'), /not allowed/)
  }))
