import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncCache } from '../src/index.js'

test('get loads once and then serves from the cache', async () => {
  const cache = new AsyncCache()
  let calls = 0
  const loader = async (key) => key + ':' + ++calls
  assert.equal(await cache.get('a', loader), 'a:1')
  assert.equal(await cache.get('a', loader), 'a:1')
  assert.equal(calls, 1)
  assert.equal(cache.size, 1)
})

test('entries expire after the ttl', async () => {
  let t = 1000
  const cache = new AsyncCache({ ttlMs: 50, now: () => t })
  let calls = 0
  const loader = async () => ++calls
  await cache.get('k', loader)
  t += 49
  await cache.get('k', loader)
  assert.equal(calls, 1)
  t += 1
  await cache.get('k', loader)
  assert.equal(calls, 2)
})

test('invalidate and clear drop cached values', async () => {
  const cache = new AsyncCache()
  let calls = 0
  const loader = async () => ++calls
  await cache.get('k', loader)
  assert.equal(cache.invalidate('k'), true)
  await cache.get('k', loader)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(calls, 2)
})

test('a failing loader rejects and is not cached', async () => {
  const cache = new AsyncCache()
  await assert.rejects(cache.get('k', async () => { throw new Error('boom') }), /boom/)
  assert.equal(await cache.get('k', async () => 'ok'), 'ok')
})
