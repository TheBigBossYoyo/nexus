import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Semaphore, JobQueue, AsyncCache, mapLimit, deferred } from '../src/index.js'

// Every test gets a hard timeout so a hang fails fast instead of stalling the run.
const t = (name, fn) => test(name, { timeout: 3000 }, fn)

// Deterministic scheduling helper: lets every queued microtask / callback run.
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Tracks a promise without ever awaiting it, so a hang becomes an assertion failure, not a timeout. */
function track(promise) {
  const state = { done: false, value: undefined, error: undefined }
  promise.then(
    (v) => { state.done = true; state.value = v },
    (e) => { state.done = true; state.error = e },
  )
  return state
}

const boom = () => new Error('boom')

// ------------------------------------------------------------------ AsyncCache

t('cache: concurrent gets for a missing key share one loader call', async () => {
  const cache = new AsyncCache()
  const gate = deferred()
  let calls = 0
  const loader = () => { calls++; return gate.promise }
  const results = [cache.get('k', loader), cache.get('k', loader), cache.get('k', loader)]
  await flush()
  assert.equal(calls, 1)
  gate.resolve('v')
  assert.deepEqual(await Promise.all(results), ['v', 'v', 'v'])
  assert.equal(await cache.get('k', loader), 'v')
  assert.equal(calls, 1)
})

t('cache: many concurrent callers, different keys load independently', async () => {
  const cache = new AsyncCache()
  const gates = { a: deferred(), b: deferred() }
  const calls = { a: 0, b: 0 }
  const loader = (key) => { calls[key]++; return gates[key].promise }
  const ps = []
  for (let i = 0; i < 25; i++) ps.push(cache.get('a', loader), cache.get('b', loader))
  await flush()
  assert.deepEqual(calls, { a: 1, b: 1 })
  gates.b.resolve('B')
  gates.a.resolve('A')
  const out = await Promise.all(ps)
  assert.equal(out.filter((v) => v === 'A').length, 25)
  assert.equal(out.filter((v) => v === 'B').length, 25)
})

t('cache: a rejected load rejects every waiter and is not cached', async () => {
  const cache = new AsyncCache()
  const gate = deferred()
  let calls = 0
  const first = [cache.get('k', () => { calls++; return gate.promise }), cache.get('k', () => { calls++; return gate.promise })]
  const settled = Promise.allSettled(first)
  await flush()
  const err = boom()
  gate.reject(err)
  const out = await settled
  assert.deepEqual(out.map((o) => o.status), ['rejected', 'rejected'])
  assert.equal(out[0].reason, err)
  assert.equal(calls, 1)
  // the failure must not stick: a later get runs the loader again
  assert.equal(await cache.get('k', async () => { calls++; return 'recovered' }), 'recovered')
  assert.equal(calls, 2)
  assert.equal(await cache.get('k', async () => { calls++; return 'unused' }), 'recovered')
  assert.equal(calls, 2)
})

t('cache: a synchronously throwing loader does not poison the key', async () => {
  const cache = new AsyncCache()
  await assert.rejects(cache.get('k', () => { throw boom() }), /boom/)
  assert.equal(cache.size, 0)
  assert.equal(await cache.get('k', async () => 'fine'), 'fine')
})

t('cache: invalidate during an in-flight load discards that result for caching only', async () => {
  const cache = new AsyncCache()
  const g1 = deferred()
  let calls = 0
  const stale = cache.get('k', () => { calls++; return g1.promise })
  await flush()
  cache.invalidate('k')
  g1.resolve('old')
  assert.equal(await stale, 'old', 'the original caller still receives its value')
  assert.equal(cache.size, 0)
  assert.equal(await cache.get('k', async () => { calls++; return 'new' }), 'new')
  assert.equal(calls, 2)
})

t('cache: a stale load finishing after a newer one never overwrites it', async () => {
  const cache = new AsyncCache()
  const g1 = deferred()
  const g2 = deferred()
  let calls = 0
  const loader1 = () => { calls++; return g1.promise }
  const loader2 = () => { calls++; return g2.promise }
  const p1 = cache.get('k', loader1)
  await flush()
  cache.invalidate('k')
  const p2 = cache.get('k', loader2)
  await flush()
  assert.equal(calls, 2, 'a get after invalidate must start a fresh load, not join the stale one')
  g2.resolve('new')
  assert.equal(await p2, 'new')
  g1.resolve('old')
  assert.equal(await p1, 'old')
  assert.equal(await cache.get('k', async () => { calls++; return 'never' }), 'new')
  assert.equal(calls, 2)
})

t('cache: clear() also discards loads that are still in flight', async () => {
  const cache = new AsyncCache()
  const g = deferred()
  const p = cache.get('k', () => g.promise)
  await flush()
  cache.clear()
  g.resolve('v')
  await p
  assert.equal(cache.size, 0)
  let calls = 0
  assert.equal(await cache.get('k', async () => { calls++; return 'fresh' }), 'fresh')
  assert.equal(calls, 1)
})

t('cache: ttl is measured from when the value arrived and expired entries reload', async () => {
  let t = 1000
  const cache = new AsyncCache({ ttlMs: 100, now: () => t })
  const g = deferred()
  const p = cache.get('k', () => g.promise)
  t += 500 // the load itself takes a long time
  g.resolve('v1')
  await p
  t += 99
  let calls = 0
  assert.equal(await cache.get('k', async () => { calls++; return 'v2' }), 'v1')
  t += 1
  assert.equal(await cache.get('k', async () => { calls++; return 'v2' }), 'v2')
  assert.equal(calls, 1)
})

// ------------------------------------------------------------------ Semaphore

t('semaphore: run releases its permit when the task rejects or throws synchronously', async () => {
  const sem = new Semaphore(1)
  await assert.rejects(sem.run(async () => { throw boom() }), /boom/)
  assert.equal(sem.available, 1)
  await assert.rejects(sem.run(() => { throw boom() }), /boom/)
  assert.equal(sem.available, 1)
  const ok = track(sem.run(async () => 'ok'))
  await flush()
  assert.deepEqual([ok.done, ok.value], [true, 'ok'])
})

t('semaphore: failures never leak permits, even under contention', async () => {
  const sem = new Semaphore(2)
  let running = 0
  let peak = 0
  const gates = Array.from({ length: 6 }, () => deferred())
  const runs = gates.map((g, i) =>
    sem.run(async () => {
      running++
      peak = Math.max(peak, running)
      try {
        await g.promise
        if (i % 2 === 0) throw boom()
        return i
      } finally {
        running--
      }
    }),
  )
  const all = Promise.allSettled(runs)
  for (const g of gates) { g.resolve(); await flush() }
  const out = await all
  assert.equal(out.filter((o) => o.status === 'rejected').length, 3)
  assert.equal(peak, 2)
  assert.equal(sem.available, 2)
  assert.equal(sem.waiting, 0)
})

t('semaphore: an aborted waiter is removed and does not swallow a permit', async () => {
  const sem = new Semaphore(1)
  await sem.acquire()
  const ac = new AbortController()
  const waiter = track(sem.acquire({ signal: ac.signal }))
  await flush()
  assert.equal(sem.waiting, 1)
  ac.abort()
  await flush()
  assert.equal(waiter.done, true)
  assert.equal(waiter.error?.name, 'AbortError')
  assert.equal(sem.waiting, 0)
  sem.release()
  assert.equal(sem.available, 1, 'the permit must come back, not be handed to the cancelled waiter')
  const next = track(sem.acquire())
  await flush()
  assert.equal(next.done, true)
  assert.equal(sem.available, 0)
})

t('semaphore: FIFO order is kept around a cancelled waiter', async () => {
  const sem = new Semaphore(1)
  await sem.acquire()
  const order = []
  const ac = new AbortController()
  const w1 = sem.acquire().then(() => order.push('w1'))
  const w2 = sem.acquire({ signal: ac.signal }).then(() => order.push('w2'), () => order.push('w2-aborted'))
  const w3 = sem.acquire().then(() => order.push('w3'))
  ac.abort()
  await flush()
  sem.release()
  await w1
  sem.release()
  await w3
  await w2
  assert.deepEqual(order, ['w2-aborted', 'w1', 'w3'])
  assert.equal(sem.available, 0)
})

t('semaphore: aborting after the permit was granted changes nothing', async () => {
  const sem = new Semaphore(1)
  await sem.acquire()
  const ac = new AbortController()
  const granted = sem.acquire({ signal: ac.signal })
  sem.release()
  await granted
  ac.abort()
  await flush()
  assert.equal(sem.available, 0, 'the holder still owns the permit')
  sem.release()
  assert.equal(sem.available, 1)
})

t('semaphore: a signal that is already aborted rejects without consuming a permit', async () => {
  const sem = new Semaphore(1)
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(sem.acquire({ signal: ac.signal }), (e) => e.name === 'AbortError')
  assert.equal(sem.available, 1)
  let ran = false
  await assert.rejects(sem.run(async () => { ran = true }, { signal: ac.signal }), (e) => e.name === 'AbortError')
  assert.equal(ran, false)
  assert.equal(sem.available, 1)
})

// ------------------------------------------------------------------ JobQueue

t('queue: onIdle resolves after failing jobs and pending returns to zero', async () => {
  const queue = new JobQueue({ concurrency: 2 })
  const gates = [deferred(), deferred(), deferred()]
  const jobs = gates.map((g, i) => queue.add(async () => { await g.promise; if (i === 1) throw boom(); return i }))
  const settled = Promise.allSettled(jobs)
  const idle = track(queue.onIdle())
  assert.equal(queue.pending, 3)
  for (const g of gates) { g.resolve(); await flush() }
  const out = await settled
  assert.deepEqual(out.map((o) => o.status), ['fulfilled', 'rejected', 'fulfilled'])
  assert.equal(idle.done, true, 'onIdle must not hang after a failure')
  assert.equal(queue.pending, 0)
})

t('queue: a failing job does not stall the jobs behind it', async () => {
  const queue = new JobQueue({ concurrency: 1 })
  const failing = queue.add(async () => { throw boom() })
  const after = track(queue.add(async () => 'after'))
  await assert.rejects(failing, /boom/)
  await flush()
  assert.deepEqual([after.done, after.value], [true, 'after'])
})

t('queue: a job that throws synchronously is reported and releases its slot', async () => {
  const queue = new JobQueue({ concurrency: 1 })
  await assert.rejects(queue.add(() => { throw boom() }), /boom/)
  const next = track(queue.add(async () => 1))
  await flush()
  assert.equal(next.done, true)
  assert.equal(queue.pending, 0)
})

t('queue: cancelled queued jobs never run and do not block onIdle', async () => {
  const queue = new JobQueue({ concurrency: 1 })
  const gate = deferred()
  const ac = new AbortController()
  let ran = false
  const first = queue.add(() => gate.promise)
  const second = queue.add(async () => { ran = true }, { signal: ac.signal })
  const third = queue.add(async () => 'third')
  await flush()
  ac.abort()
  await assert.rejects(second, (e) => e.name === 'AbortError')
  const idle = track(queue.onIdle())
  gate.resolve('first')
  assert.equal(await first, 'first')
  assert.equal(await third, 'third')
  await flush()
  assert.equal(ran, false)
  assert.equal(idle.done, true)
  assert.equal(queue.pending, 0)
})

t('queue: onIdle without work resolves and several waiters all resolve', async () => {
  const queue = new JobQueue({ concurrency: 3 })
  const empty = track(queue.onIdle())
  await flush()
  assert.equal(empty.done, true)
  const gate = deferred()
  queue.add(() => gate.promise)
  const waiters = [track(queue.onIdle()), track(queue.onIdle())]
  await flush()
  assert.deepEqual(waiters.map((w) => w.done), [false, false])
  gate.resolve()
  await flush()
  assert.deepEqual(waiters.map((w) => w.done), [true, true])
})

// ------------------------------------------------------------------ mapLimit

t('mapLimit: respects the limit and keeps result order', async () => {
  const gates = Array.from({ length: 5 }, () => deferred())
  let running = 0
  let peak = 0
  const result = mapLimit([0, 1, 2, 3, 4], 2, async (n) => {
    running++
    peak = Math.max(peak, running)
    await gates[n].promise
    running--
    return n * 2
  })
  await flush()
  assert.equal(running, 2)
  for (const i of [3, 1, 0, 4, 2]) { gates[i].resolve(); await flush() }
  assert.deepEqual(await result, [0, 2, 4, 6, 8])
  assert.equal(peak, 2)
  assert.deepEqual(await mapLimit([], 3, async (x) => x), [])
})

t('mapLimit: stops starting new items after the first failure and rejects with it', async () => {
  const gates = Array.from({ length: 6 }, () => deferred())
  const started = []
  const err = boom()
  const result = mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
    started.push(n)
    await gates[n].promise
    if (n === 0) throw err
    return n
  })
  const state = track(result)
  await flush()
  assert.deepEqual(started, [0, 1])
  gates[0].resolve()
  await flush()
  assert.equal(state.done, true)
  assert.equal(state.error, err)
  gates[1].resolve()
  await flush()
  for (const g of gates) g.resolve()
  await flush()
  assert.deepEqual(started, [0, 1], 'no item after the failure may be started')
})
