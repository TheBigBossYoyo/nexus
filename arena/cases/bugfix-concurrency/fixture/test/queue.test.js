import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JobQueue, mapLimit, deferred } from '../src/index.js'
import { flush } from './helpers.mjs'

test('queue never exceeds its concurrency', async () => {
  const queue = new JobQueue({ concurrency: 2 })
  let running = 0
  let peak = 0
  const gates = [deferred(), deferred(), deferred(), deferred()]
  const results = gates.map((gate) =>
    queue.add(async () => {
      running++
      peak = Math.max(peak, running)
      await gate.promise
      running--
    }),
  )
  await flush()
  assert.equal(running, 2)
  for (const gate of gates) {
    gate.resolve()
    await flush()
  }
  await Promise.all(results)
  assert.equal(peak, 2)
  await queue.onIdle()
  assert.equal(queue.pending, 0)
})

test('mapLimit keeps the input order', async () => {
  const out = await mapLimit([1, 2, 3, 4], 2, async (n) => n * 10)
  assert.deepEqual(out, [10, 20, 30, 40])
})
