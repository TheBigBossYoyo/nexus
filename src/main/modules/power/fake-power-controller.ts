import { appendFileSync } from 'node:fs'
import type { PowerCommandResult } from '@shared/overnight'
import { nowIso } from '@shared/ids'
import {
  buildShutdownArgs,
  CANCEL_SHUTDOWN_ARGS,
  HIBERNATE_ARGS,
  isEffectivelyForced,
  SLEEP_POWERSHELL_ARGS,
  type PendingShutdown,
  type PowerController,
  type PowerState,
  type ShutdownRequest,
} from './types'

export interface FakePowerCall {
  operation: 'scheduleShutdown' | 'cancelShutdown' | 'sleep' | 'hibernate'
  args: string[]
  request: ShutdownRequest | null
  at: string
  ok: boolean
}

export interface FakePowerOptions {
  /** Append every call as a JSON line (end-to-end tests read it from outside the app). */
  logFile?: string
  now?: () => number
}

/**
 * Stand-in for the operating system in every automated test: it records calls and models Windows'
 * single shutdown timer (a second schedule is refused with 1190, an abort without a timer with 1116).
 * It never touches the machine.
 */
export class FakePowerController implements PowerController {
  readonly calls: FakePowerCall[] = []
  private pending: PendingShutdown | null = null
  /** Make the next calls of an operation fail (simulated OS refusal). */
  readonly failNext: Partial<Record<FakePowerCall['operation'], number>> = {}

  constructor(private readonly options: FakePowerOptions = {}) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private record(operation: FakePowerCall['operation'], args: readonly string[], request: ShutdownRequest | null, ok: boolean, exitCode: number, output: string): PowerCommandResult {
    const at = this.options.now ? new Date(this.now()).toISOString() : nowIso()
    const call: FakePowerCall = { operation, args: [...args], request, at, ok }
    this.calls.push(call)
    if (this.options.logFile) {
      try {
        appendFileSync(this.options.logFile, `${JSON.stringify(call)}\n`)
      } catch {
        // The log is a test aid; a failed write must not change behaviour.
      }
    }
    return { ok, exitCode, output, executable: `fake:${operation}`, args: [...args], at }
  }

  private shouldFail(operation: FakePowerCall['operation']): boolean {
    const left = this.failNext[operation] ?? 0
    if (left <= 0) return false
    this.failNext[operation] = left - 1
    return true
  }

  async scheduleShutdown(request: ShutdownRequest): Promise<PowerCommandResult> {
    const args = buildShutdownArgs(request)
    if (this.shouldFail('scheduleShutdown')) return this.record('scheduleShutdown', args, request, false, 5, 'Access is denied.(5)')
    if (this.pending) return this.record('scheduleShutdown', args, request, false, 1190, 'A system shutdown has already been scheduled.(1190)')
    const result = this.record('scheduleShutdown', args, request, true, 0, '')
    this.pending = {
      purpose: request.purpose,
      scheduledAt: result.at,
      deadline: new Date(Date.parse(result.at) + request.delaySeconds * 1000).toISOString(),
      forced: isEffectivelyForced(request),
    }
    return result
  }

  async cancelShutdown(): Promise<PowerCommandResult> {
    if (this.shouldFail('cancelShutdown')) return this.record('cancelShutdown', CANCEL_SHUTDOWN_ARGS, null, false, 5, 'Access is denied.(5)')
    if (!this.pending) return this.record('cancelShutdown', CANCEL_SHUTDOWN_ARGS, null, false, 1116, 'Unable to abort the system shutdown because no shutdown was in progress.(1116)')
    this.pending = null
    return this.record('cancelShutdown', CANCEL_SHUTDOWN_ARGS, null, true, 0, '')
  }

  async sleep(): Promise<PowerCommandResult> {
    const ok = !this.shouldFail('sleep')
    return this.record('sleep', SLEEP_POWERSHELL_ARGS, null, ok, ok ? 0 : 1, '')
  }

  async hibernate(): Promise<PowerCommandResult> {
    const ok = !this.shouldFail('hibernate')
    return this.record('hibernate', HIBERNATE_ARGS, null, ok, ok ? 0 : 1, '')
  }

  getState(): PowerState {
    return { pending: this.pending }
  }

  /** The simulated OS timer vanished (Windows restarted). */
  simulateReboot(): void {
    this.pending = null
  }

  /** Something outside NEXUS scheduled a shutdown. */
  simulateForeignShutdown(delaySeconds: number): void {
    const at = new Date(this.now()).toISOString()
    this.pending = { purpose: 'failsafe', scheduledAt: at, deadline: new Date(this.now() + delaySeconds * 1000).toISOString(), forced: true }
  }

  callsOf(operation: FakePowerCall['operation']): FakePowerCall[] {
    return this.calls.filter((c) => c.operation === operation)
  }
}
