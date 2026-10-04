/** Async read-through cache with an optional TTL and an injectable clock. */
export class AsyncCache {
  #entries = new Map()
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

  async get(key, loader) {
    const hit = this.#entries.get(key)
    if (hit && hit.expiresAt > this.#now()) return hit.value
    const value = await loader(key)
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs })
    return value
  }

  invalidate(key) {
    return this.#entries.delete(key)
  }

  clear() {
    this.#entries.clear()
  }

  #purgeExpired() {
    const now = this.#now()
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key)
  }
}
