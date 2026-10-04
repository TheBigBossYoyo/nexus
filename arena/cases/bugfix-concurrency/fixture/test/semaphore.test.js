import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Semaphore, deferred } from '../src/index.js'
import { flush } from './helpers.mjs'

test('permits are handed out up to capacity, then callers wait in FIFO order', async () => {
  const sem = new Semaphore(2)
  const order = []
  await sem.acquire()
  await sem.acquire()
  assert.equal(sem.available, 0)
  const a = sem.acquire().then(() => order.push('a'))
  const b = sem.acquire().then(() => order.push('b'))
  assert.equal(sem.waiting, 2)
  sem.release()
  await a
  sem.release()
  await b
  assert.deepEqual(order, ['a', 'b'])
})

test('run holds a permit for the duration of the task', async () => {
  const sem = new Semaphore(1)
  const gate = deferred()
  const running = sem.run(() => gate.promise)
  await flush()
  assert.equal(sem.available, 0)
  gate.resolve('done')
  assert.equal(await running, 'done')
  assert.equal(sem.available, 1)
})

test('constructor validates permits', () => {
  assert.throws(() => new Semaphore(0), RangeError)
})
