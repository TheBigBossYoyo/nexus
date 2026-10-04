import { Semaphore } from './semaphore.js'
import { deferred } from './deferred.js'

/** Runs async jobs with bounded concurrency. */
export class JobQueue {
  #semaphore
  #pending = 0
  #idleWaiters = []

  constructor({ concurrency = 2 } = {}) {
    this.#semaphore = new Semaphore(concurrency)
  }

  /** Jobs that were added and have not finished yet (queued or running). */
  get pending() {
    return this.#pending
  }

  add(job, { signal } = {}) {
    this.#pending++
    return this.#semaphore.run(job, { signal }).then(
      (value) => {
        this.#settled()
        return value
      },
      (error) => {
        this.#settled()
        throw error
      },
    )
  }

  onIdle() {
    if (this.#pending === 0) return Promise.resolve()
    const waiter = deferred()
    this.#idleWaiters.push(waiter)
    return waiter.promise
  }

  #settled() {
    this.#pending--
    if (this.#pending === 0) {
      const waiters = this.#idleWaiters
      this.#idleWaiters = []
      for (const w of waiters) w.resolve()
    }
  }
}
