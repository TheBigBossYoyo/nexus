import type { ConnectivityLogger, Timers } from './timers'

export type AutonomousWorkKind = 'OVERNIGHT' | 'PROGRAM' | 'WORKSPACE_RUN' | 'LONG_MISSION'

/** What an autonomous piece of work is doing, as far as staying awake is concerned. */
export type AutonomousWorkStatus =
  | 'WORKING'
  | 'WAITING_FOR_NETWORK'
  | 'WAITING_FOR_PROVIDER'
  | 'PAUSED_BY_USER'
  | 'WAITING_FOR_USER'
  | 'WAITING_FOR_USER_BOUNDARY'
  | 'FINISHED'

export interface AutonomousWorkItem {
  id: string
  kind: AutonomousWorkKind
  status: AutonomousWorkStatus
  /** The last time this work moved forward (a task finished, a step completed). Time spent waiting does not count. */
  lastProgressAt: number
}

export interface KeepAwakeDecision {
  hold: boolean
  reason: string
}

export const DEFAULT_MAX_HOLD_WITHOUT_PROGRESS_MS = 6 * 60 * 60 * 1000

/** Work that will resume by itself: it is going on, or it waits for the network or the provider to come back. */
const RESUMES_BY_ITSELF = new Set<AutonomousWorkStatus>(['WORKING', 'WAITING_FOR_NETWORK', 'WAITING_FOR_PROVIDER'])

/**
 * Whether the machine should be kept from idle-sleeping, from what autonomous work there is. Pure.
 *
 * Yes while an Overnight run, a Program, a Workspace run or a long-running mission is working or is waiting for
 * the network or the provider with work that will resume, and has made progress within `maxHoldMs`. No when
 * nothing autonomous is active, when everything is paused by the user, when everything that is left waits on the
 * user (or on a boundary the user must decide), and when the work has not moved for longer than `maxHoldMs`:
 * waiting for ever is not a reason to keep a laptop awake.
 */
export function decideKeepAwake(items: readonly AutonomousWorkItem[], now: number, maxHoldMs = DEFAULT_MAX_HOLD_WITHOUT_PROGRESS_MS): KeepAwakeDecision {
  const open = items.filter((i) => i.status !== 'FINISHED')
  if (open.length === 0) return { hold: false, reason: 'nothing autonomous is active' }
  const resuming = open.filter((i) => RESUMES_BY_ITSELF.has(i.status))
  if (resuming.length === 0) {
    const paused = open.every((i) => i.status === 'PAUSED_BY_USER')
    return { hold: false, reason: paused ? 'everything is paused by the user' : open.some((i) => i.status === 'PAUSED_BY_USER') ? 'everything is paused by the user or waits on the user' : 'all remaining work waits on the user' }
  }
  const fresh = resuming.filter((i) => now - i.lastProgressAt <= maxHoldMs)
  if (fresh.length === 0) {
    const longest = Math.max(...resuming.map((i) => now - i.lastProgressAt))
    return { hold: false, reason: `no progress for ${Math.floor(longest / 60_000)} min, which is over the maximum holding time of ${Math.floor(maxHoldMs / 60_000)} min` }
  }
  return { hold: true, reason: `${fresh.map((i) => `${i.kind} ${i.id} ${i.status.toLowerCase().replace(/_/g, ' ')}`).join('; ')}` }
}

export interface PowerLogEntry {
  at: number
  action: 'ACQUIRE' | 'RELEASE'
  reason: string
}

export interface OvernightPowerGuardOptions {
  /**
   * The runtime's existing mechanism, built on Electron's powerSaveBlocker 'prevent-app-suspension'. That blocker
   * asks Windows only that the system not go to sleep because it is IDLE (the "system required" request); the
   * display may still turn off, and a sleep the user asks for (the Sleep command, closing the lid, the power
   * button, a low-battery action) is not blocked. This module builds no other mechanism.
   */
  setKeepAwake: (on: boolean) => void
  timers: Timers
  /** Receives every acquire and release, for the runtime's log. */
  sink?: (entry: PowerLogEntry) => void
  logger?: ConnectivityLogger
  maxHoldMs?: number
  /** How many entries the in-memory log keeps. Default 100. */
  keepLog?: number
}

/**
 * Holds the idle-sleep request while it is needed and drops it the moment it is not. The runtime calls
 * `update` with the autonomous work it knows about whenever any of it changes; the guard also re-decides on its
 * own when the longest-waiting item would pass the maximum holding time, so a stalled run releases the machine
 * without anyone calling it. It never holds "for ever": after `maxHoldMs` without progress it releases and
 * records why, and it does not take the request again until some work has made progress.
 */
export class OvernightPowerGuard {
  private items: readonly AutonomousWorkItem[] = []
  private held = false
  private lastReason: string | null = null
  private readonly log: PowerLogEntry[] = []
  private timer: unknown = null
  private readonly maxHoldMs: number

  constructor(private readonly o: OvernightPowerGuardOptions) {
    this.maxHoldMs = o.maxHoldMs ?? DEFAULT_MAX_HOLD_WITHOUT_PROGRESS_MS
  }

  get isHeld(): boolean {
    return this.held
  }

  get reason(): string | null {
    return this.lastReason
  }

  entries(): PowerLogEntry[] {
    return this.log.map((e) => ({ ...e }))
  }

  update(items: readonly AutonomousWorkItem[]): KeepAwakeDecision {
    this.items = items.map((i) => ({ ...i }))
    return this.evaluate()
  }

  /** Releases at once and forgets the work (shutdown). */
  dispose(): void {
    this.items = []
    this.evaluate()
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer)
    this.timer = null
  }

  private evaluate(): KeepAwakeDecision {
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer)
    this.timer = null
    const now = this.o.timers.now()
    const decision = decideKeepAwake(this.items, now, this.maxHoldMs)
    this.lastReason = decision.reason
    if (decision.hold !== this.held) this.apply(decision, now)
    if (decision.hold) {
      // Come back when the work that has been still the longest would run out of time.
      const resuming = this.items.filter((i) => RESUMES_BY_ITSELF.has(i.status))
      const expiry = Math.max(...resuming.map((i) => i.lastProgressAt)) + this.maxHoldMs
      this.timer = this.o.timers.setTimeout(() => {
        this.timer = null
        this.evaluate()
      }, Math.max(1, expiry - now + 1))
    }
    return decision
  }

  private apply(decision: KeepAwakeDecision, now: number): void {
    try {
      this.o.setKeepAwake(decision.hold)
    } catch (e) {
      // If the request could not be made or dropped, the guard does not claim a state it does not have.
      this.o.logger?.(`keep-awake could not be ${decision.hold ? 'taken' : 'released'}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    this.held = decision.hold
    const entry: PowerLogEntry = { at: now, action: decision.hold ? 'ACQUIRE' : 'RELEASE', reason: decision.reason }
    this.log.push(entry)
    while (this.log.length > (this.o.keepLog ?? 100)) this.log.shift()
    try {
      this.o.sink?.({ ...entry })
    } catch {
      // A broken sink must not keep the machine awake or asleep.
    }
  }
}
