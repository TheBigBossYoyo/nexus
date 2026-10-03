/**
 * Unbounded FIFO that is also a single-consumer AsyncIterable. `close()` lets the consumer drain what
 * is already queued and then finish; pushes after close are dropped.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: ((r: IteratorResult<T>) => void) | null = null
  private closed = false

  get isClosed(): boolean {
    return this.closed
  }

  push(item: T): boolean {
    if (this.closed) return false
    const w = this.waiter
    if (w) {
      this.waiter = null
      w({ value: item, done: false })
    } else {
      this.items.push(item)
    }
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const w = this.waiter
    if (w) {
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve
        })
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
