import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deepMerge, loadConfig } from '../src/index.js'

test('deepMerge merges nested objects and replaces arrays and scalars', () => {
  const merged = deepMerge({ a: { x: 1, y: 2 }, list: [1, 2], keep: true }, { a: { y: 3, z: 4 }, list: [9] })
  assert.deepEqual(merged, { a: { x: 1, y: 3, z: 4 }, list: [9], keep: true })
})

test('loadConfig layers a JSON document over the defaults without touching them', () => {
  const defaults = { server: { port: 80, host: 'localhost' }, debug: false }
  const config = loadConfig('{"server":{"port":8080},"debug":true}', defaults)
  assert.deepEqual(config, { server: { port: 8080, host: 'localhost' }, debug: true })
  assert.equal(defaults.server.port, 80)
})

test('loadConfig reports invalid JSON', () => {
  assert.throws(() => loadConfig('{nope'), SyntaxError)
})
