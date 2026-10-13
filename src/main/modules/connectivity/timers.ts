/** The clock and timers the module runs on. Injected, so that tests drive time by hand and wait for nothing. */
export interface Timers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // A pending probe must not keep the app from exiting.
    handle.unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export type ConnectivityLogger = (line: string) => void

/** Exponential delay with a hard upper bound and jitter that only shortens the delay, so the bound always holds. */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number, random: () => number): number {
  const raw = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 30))
  return Math.max(1, Math.round(raw * (0.75 + 0.25 * random())))
}
