/** Own complete advisory operations, including retrieval, model stages and durable outcome writes. */
export class IntelligenceOperations {
  private accepting = true
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lanes = new Map<string, Promise<unknown>>()
  /** User amendments to one entity observe every preceding admitted amendment. */
  serial<T>(key: string, work: () => T | Promise<T>): Promise<T> {
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const next = this.run(() => previous.catch(() => undefined).then(work))
    this.lanes.set(key, next)
    return next.finally(() => { if (this.lanes.get(key) === next) this.lanes.delete(key) })
  }
  run<T>(work: () => T | Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new Error('Intelligence admission is closed while the runtime stops'))
    const promise = Promise.resolve().then(work)
    this.pending.add(promise)
    return promise.finally(() => this.pending.delete(promise))
  }
  closeAdmission(): void {
    this.accepting = false
  }
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}
