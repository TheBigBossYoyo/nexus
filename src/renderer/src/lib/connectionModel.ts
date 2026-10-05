import type { ConnectionState, ConnectionPhase } from '@shared/runtime-protocol'

/** DOM-free model of the window's connection to the runtime: what is shown for each phase, and when to re-sync. */

export type ConnectionScreen =
  /** Nothing to show: the connection is fine, or there is no bridge (a browser). */
  | 'none'
  /** Before the first READY: a calm full-window startup state. */
  | 'startup'
  /** Usable, with a banner saying what is being reconciled. */
  | 'recovering'
  /** Lost or refused: a prominent banner, and the data on screen is stale. */
  | 'lost'

export interface ConnectionView {
  screen: ConnectionScreen
  phase: ConnectionPhase | null
  /** Short heading. */
  title: string
  detail: string
  /** The content region must be dimmed and inert: it would show old state as if it were live. */
  stale: boolean
  /** Whether Retry is offered. */
  canRetry: boolean
  /** Whether the user is told NEXUS keeps trying by itself. */
  retrying: boolean
}

export const STARTUP_TITLE: Record<'STARTING_RUNTIME' | 'CONNECTING', string> = {
  STARTING_RUNTIME: 'Starting the NEXUS runtime',
  CONNECTING: 'Connecting to the NEXUS runtime',
}

const NONE: ConnectionView = { screen: 'none', phase: null, title: '', detail: '', stale: false, canRetry: false, retrying: false }

/**
 * `everReady` is true once this window has seen READY. Before that, STARTING_RUNTIME and CONNECTING are startup;
 * after it they mean the connection was lost and is being rebuilt, which is as stale as DISCONNECTED.
 */
export function connectionView(state: ConnectionState | null, everReady: boolean): ConnectionView {
  if (!state) return NONE
  switch (state.phase) {
    case 'READY':
      return { ...NONE, phase: 'READY' }
    case 'RECOVERING':
      return { screen: 'recovering', phase: state.phase, title: 'Runtime recovering', detail: state.detail, stale: false, canRetry: false, retrying: false }
    case 'STARTING_RUNTIME':
    case 'CONNECTING':
      if (!everReady) return { screen: 'startup', phase: state.phase, title: STARTUP_TITLE[state.phase], detail: state.detail, stale: false, canRetry: false, retrying: false }
      return { screen: 'lost', phase: state.phase, title: 'CONTROL PLANE RECONNECTING', detail: state.detail || 'NEXUS is attempting to reconnect.', stale: true, canRetry: true, retrying: true }
    case 'DISCONNECTED':
      return { screen: 'lost', phase: state.phase, title: 'CONTROL PLANE DISCONNECTED', detail: 'NEXUS is attempting to reconnect.', stale: true, canRetry: true, retrying: true }
    case 'INCOMPATIBLE':
      return { screen: 'lost', phase: state.phase, title: 'CONTROL PLANE INCOMPATIBLE', detail: state.detail, stale: true, canRetry: true, retrying: false }
  }
}

/** Whether a change of connection state means every cached query is out of date. */
export function needsResync(previous: ConnectionState | null, next: ConnectionState): boolean {
  if (next.phase !== 'READY') return false
  if (!previous) return false
  // Anything fetched while the runtime was not ready failed or is old.
  if (previous.phase !== 'READY') return true
  // READY to READY: only a different runtime start changes what the data means.
  return previous.runtime?.bootId !== undefined && next.runtime?.bootId !== undefined && previous.runtime.bootId !== next.runtime.bootId
}

/** What a screen reader hears. */
export function connectionAnnouncement(state: ConnectionState | null, everReady: boolean, resynced: boolean): string {
  if (!state) return ''
  if (resynced && state.phase === 'READY') return 'Reconnected to the NEXUS runtime. The data was refreshed.'
  const v = connectionView(state, everReady)
  if (v.screen === 'none') return ''
  return `${v.title}. ${v.detail}`.trim()
}

export interface DiagnosticRow {
  label: string
  value: string
}

const when = (iso: string | null | undefined): string => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : '—')

export function connectionDiagnostics(state: ConnectionState): DiagnosticRow[] {
  const r = state.runtime
  return [
    { label: 'Phase', value: state.phase },
    { label: 'Detail', value: state.detail || '—' },
    { label: 'Attempts', value: String(state.attempt) },
    { label: 'Since', value: when(state.since) },
    { label: 'Last runtime PID', value: r ? String(r.pid) : '—' },
    { label: 'Boot id', value: r ? r.bootId : '—' },
    { label: 'Runtime version', value: r ? r.version : '—' },
    { label: 'Protocol', value: r ? String(r.protocol) : '—' },
  ]
}
