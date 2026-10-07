/** Own complete advisory operations, including retrieval, model stages and durable outcome writes. */
export class IntelligenceOperations {
  private accepting = true
  private readonly pending = new Set<Promise<unknown>>()
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
