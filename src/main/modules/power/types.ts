import { MAX_SHUTDOWN_DELAY_SECONDS, type PowerCommandResult } from '@shared/overnight'
import { NexusError } from '@shared/result'

export interface ShutdownRequest {
  /** Seconds until Windows shuts down. */
  delaySeconds: number
  /** Close applications without waiting. Windows implies this for every delay above zero. */
  force: boolean
  /** Which fixed message Windows shows; the text itself is chosen by the controller, never by a caller. */
  purpose: 'failsafe' | 'final' | 'smoke'
}

export interface PendingShutdown {
  purpose: ShutdownRequest['purpose']
  scheduledAt: string
  deadline: string
  forced: boolean
}

export interface PowerState {
  /** The shutdown this controller scheduled and has not cancelled. Not a query of the operating system. */
  pending: PendingShutdown | null
}

/**
 * The only door to the operating system's power state. Callers choose an operation and a validated
 * delay; they never supply an executable, an argument or message text.
 *
 * Only the OvernightSupervisor may hold a PowerController (see tests/unit/power/isolation.test.ts).
 */
export interface PowerController {
  scheduleShutdown(request: ShutdownRequest): Promise<PowerCommandResult>
  /** Abort the pending shutdown timer. */
  cancelShutdown(): Promise<PowerCommandResult>
  sleep(): Promise<PowerCommandResult>
  hibernate(): Promise<PowerCommandResult>
  getState(): PowerState
}

export function assertDelay(delaySeconds: number): void {
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_SHUTDOWN_DELAY_SECONDS) {
    throw new NexusError('invalid_input', `Invalid shutdown delay: ${String(delaySeconds)}`)
  }
}

/** Fixed, application-owned shutdown messages. Nothing from a run, an agent or the renderer ends up in them. */
export const SHUTDOWN_MESSAGES: Record<ShutdownRequest['purpose'], string> = {
  failsafe: 'NEXUS Overnight Mode failsafe: this PC shuts down when the timer ends. Open NEXUS to cancel.',
  final: 'NEXUS Overnight Mode: the mission has ended and its report is saved. This PC is shutting down. Open NEXUS to cancel.',
  smoke: 'NEXUS power smoke test: this timer is cancelled immediately.',
}

/**
 * Arguments for shutdown.exe. Pure, so tests can pin the exact command line.
 * `/f` is added only when the caller asked for a forced close.
 */
export function buildShutdownArgs(request: ShutdownRequest): string[] {
  assertDelay(request.delaySeconds)
  const message = SHUTDOWN_MESSAGES[request.purpose]
  if (message === undefined) throw new NexusError('invalid_input', 'Unknown shutdown purpose')
  return ['/s', ...(request.force ? ['/f'] : []), '/t', String(request.delaySeconds), '/c', message]
}

export const CANCEL_SHUTDOWN_ARGS: readonly string[] = ['/a']
export const HIBERNATE_ARGS: readonly string[] = ['/h']
/** Suspend (not hibernate) without forcing and without disabling wake events. */
export const SLEEP_POWERSHELL_ARGS: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
]

/** Windows closes applications without waiting whenever a shutdown has a delay, with or without /f. */
export function isEffectivelyForced(request: Pick<ShutdownRequest, 'delaySeconds' | 'force'>): boolean {
  return request.force || request.delaySeconds > 0
}
