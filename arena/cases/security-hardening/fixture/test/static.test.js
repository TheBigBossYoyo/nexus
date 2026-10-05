import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolveStaticPath, readStaticFile } from '../src/index.js'
import { withTempDir } from './helpers.mjs'

test('resolveStaticPath maps request paths below the root', () => {
  const root = path.join(path.resolve('.'), 'public')
  assert.equal(resolveStaticPath(root, '/assets/app.js'), path.join(root, 'assets', 'app.js'))
  assert.equal(resolveStaticPath(root, '/docs/a%20b.txt?v=3'), path.join(root, 'docs', 'a b.txt'))
})

test('readStaticFile reads files and index.html for directories', () =>
  withTempDir(async (dir) => {
    const root = path.join(dir, 'public')
    await mkdir(path.join(root, 'docs'), { recursive: true })
    await writeFile(path.join(root, 'index.html'), '<h1>home</h1>')
    await writeFile(path.join(root, 'docs', 'notes.txt'), 'hello')
    const home = await readStaticFile(root, '/')
    assert.equal(home.body.toString(), '<h1>home</h1>')
    assert.equal(home.contentType, 'text/html; charset=utf-8')
    const notes = await readStaticFile(root, '/docs/notes.txt')
    assert.equal(notes.body.toString(), 'hello')
    await assert.rejects(readStaticFile(root, '/missing.txt'), { code: 'ENOENT' })
  }))
