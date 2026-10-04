import { abortError } from './abort.js'

/** Counting semaphore with FIFO hand-over and AbortSignal support. */
export class Semaphore {
  #permits
  #waiters = []

  constructor(permits) {
    if (!Number.isInteger(permits) || permits < 1) throw new RangeError('permits must be a positive integer')
    this.capacity = permits
    this.#permits = permits
  }

  get available() {
    return this.#permits
  }

  get waiting() {
    return this.#waiters.length
  }

  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (this.#permits > 0) {
      this.#permits--
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve })
      signal?.addEventListener('abort', () => reject(abortError(signal)), { once: true })
    })
  }

  release() {
    const next = this.#waiters.shift()
    if (next) next.resolve()
    else this.#permits++
  }

  /** Runs fn while holding a permit. */
  async run(fn, options) {
    await this.acquire(options)
    const result = await fn()
    this.release()
    return result
  }
}
