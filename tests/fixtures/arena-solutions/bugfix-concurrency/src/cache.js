/** Async read-through cache with an optional TTL and an injectable clock. */
export class AsyncCache {
  #entries = new Map()
  #inflight = new Map()
  #ttlMs
  #now

  constructor({ ttlMs = Infinity, now = () => Date.now() } = {}) {
    this.#ttlMs = ttlMs
    this.#now = now
  }

  get size() {
    this.#purgeExpired()
    return this.#entries.size
  }

  get(key, loader) {
    const hit = this.#entries.get(key)
    if (hit && hit.expiresAt > this.#now()) return Promise.resolve(hit.value)
    const existing = this.#inflight.get(key)
    if (existing) return existing.promise
    const flight = {}
    this.#inflight.set(key, flight)
    flight.promise = this.#load(key, loader, flight)
    return flight.promise
  }

  async #load(key, loader, flight) {
    try {
      const value = await loader(key)
      if (this.#inflight.get(key) === flight) {
        this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs })
      }
      return value
    } finally {
      if (this.#inflight.get(key) === flight) this.#inflight.delete(key)
    }
  }

  invalidate(key) {
    const hadFlight = this.#inflight.delete(key)
    return this.#entries.delete(key) || hadFlight
  }

  clear() {
    this.#entries.clear()
    this.#inflight.clear()
  }

  #purgeExpired() {
    const now = this.#now()
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key)
  }
}
