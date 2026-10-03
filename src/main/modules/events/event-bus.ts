import type { EventType, NewEvent, RunEvent } from '@shared/events'

export type EventListener = (event: RunEvent) => void

/** The slice of the persistence layer the bus needs (satisfied by `Repositories.events` / `.transaction`). */
export interface EventStore {
  insert<T extends EventType>(event: NewEvent<T>): RunEvent<T>
}
export type RunInTransaction = <T>(fn: () => T) => T

/**
 * Persist-then-notify event bus. `emit` writes the run_events row first, then notifies subscribers
 * synchronously. Inside `transaction()` the row joins the caller's DB transaction and notifications are
 * held back until the outermost transaction commits (and dropped if it rolls back), so listeners never
 * observe an event that does not exist in the database.
 *
 * Emitting inside a raw `repos.transaction()` (not `bus.transaction()`) notifies immediately; use the bus's.
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>()
  private readonly queue: RunEvent[] = []
  private depth = 0
  private draining = false

  constructor(
    private readonly store: EventStore,
    private readonly runInTransaction: RunInTransaction,
    private readonly onListenerError: (error: unknown, event: RunEvent) => void = (error, event) => {
      console.error(`[event-bus] listener failed for ${event.type}`, error)
    },
  ) {}

  emit<T extends EventType>(event: NewEvent<T>): RunEvent<T> {
    const persisted = this.store.insert(event)
    this.queue.push(persisted)
    this.drain()
    return persisted
  }

  /** Subscribes to every event. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeRun(runId: string, listener: EventListener): () => void {
    return this.subscribe((event) => {
      if (event.runId === runId) listener(event)
    })
  }

  /** Atomic DB transaction whose emitted events are broadcast only after the outermost commit. */
  transaction<T>(fn: () => T): T {
    const mark = this.queue.length
    this.depth++
    try {
      const result = this.runInTransaction(fn)
      this.depth--
      this.drain()
      return result
    } catch (e) {
      this.depth--
      // An inner failure rolls back only its savepoint; the outer transaction may still commit.
      this.queue.length = mark
      throw e
    }
  }

  private drain(): void {
    // Held while a transaction is open, and while an outer drain is delivering (keeps delivery order).
    if (this.depth > 0 || this.draining) return
    this.draining = true
    try {
      for (let event = this.queue.shift(); event; event = this.queue.shift()) {
        for (const listener of [...this.listeners]) {
          try {
            listener(event)
          } catch (e) {
            try {
              this.onListenerError(e, event)
            } catch {
              // A failing error handler must not break delivery to the remaining listeners.
            }
          }
        }
      }
    } finally {
      this.draining = false
    }
  }
}
