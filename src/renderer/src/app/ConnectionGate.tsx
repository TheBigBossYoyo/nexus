import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/bridge'
import {
  connectionAnnouncement,
  connectionDiagnostics,
  connectionView,
} from '../lib/connectionModel'
import { useConnectionStore } from '../store/connection'
import type { ConnectionState } from '@shared/runtime-protocol'
import { Button } from '../components/ui'

/** Screen-reader announcements for connection changes; always mounted so the region exists before it speaks. */
function Announcer() {
  const { state, everReady, resyncs } = useConnectionStore()
  const [seen, setSeen] = useState(resyncs)
  const [text, setText] = useState('')
  useEffect(() => {
    setText(connectionAnnouncement(state, everReady, resyncs !== seen))
    setSeen(resyncs)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- announce on a new state only
  }, [state])
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="connection-announcer">
      {text}
    </div>
  )
}

/** After this long in the startup state, say so and offer Retry and Diagnostics. */
export const STARTUP_SLOW_MS = 15_000

function DiagnosticsList({ state }: { state: ConnectionState }) {
  return (
    <dl
      id="connection-diagnostics-panel"
      className="m-0 grid gap-x-4 gap-y-1 rounded-md border bg-surface px-3 py-2 text-left text-small"
      style={{ gridTemplateColumns: '10rem minmax(0,1fr)' }}
      data-testid="connection-diagnostics-panel"
    >
      {connectionDiagnostics(state).map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-text-muted">{r.label}</dt>
          <dd className="m-0 min-w-0 break-words font-mono text-code">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Asks the window's main process to connect again; the answer is the new state. */
function useReconnect() {
  const apply = useConnectionStore((s) => s.apply)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retry = (): void => {
    setBusy(true)
    setError(null)
    api
      .invoke('desktop.reconnect', {})
      .then((next) => {
        apply(next)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  return { busy, error, retry }
}

/** The calm full-window state before the first READY. Never a frozen blank window. */
export function StartupState() {
  const { state, everReady } = useConnectionStore()
  const view = connectionView(state, everReady)
  const active = view.screen === 'startup'
  const [slow, setSlow] = useState(false)
  const [open, setOpen] = useState(false)
  const { busy, error, retry } = useReconnect()
  useEffect(() => {
    if (!active) {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), STARTUP_SLOW_MS)
    return () => clearTimeout(t)
  }, [active])
  if (!active || !state) return null
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-2 bg-background px-6 text-center"
      role="status"
      data-testid="startup-state"
      data-phase={view.phase ?? ''}
      data-slow={slow}
    >
      <p className="m-0 text-title text-text-primary">{view.title}</p>
      <p className="m-0 text-text-secondary" data-testid="startup-detail">
        {view.detail || 'This takes a few seconds.'}
      </p>
      {slow ? (
        <div className="mt-3 flex max-w-xl flex-col items-center gap-3" data-testid="startup-slow">
          <p className="m-0 font-medium text-text-primary">Taking longer than usual</p>
          <div className="flex gap-2">
            <Button variant="primary" loading={busy} onClick={retry} data-testid="startup-retry">
              Retry
            </Button>
            <Button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="connection-diagnostics-panel" data-testid="startup-diagnostics">
              Diagnostics
            </Button>
          </div>
          {error ? (
            <p className="m-0 text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {open ? <DiagnosticsList state={state} /> : null}
        </div>
      ) : null}
    </div>
  )
}

/** The banner above the page: recovering (usable) or lost (the page below is stale and inert). */
export function ConnectionBanner() {
  const { state, everReady } = useConnectionStore()
  const [open, setOpen] = useState(false)
  const { busy, error, retry } = useReconnect()
  const view = connectionView(state, everReady)
  if (!state || (view.screen !== 'recovering' && view.screen !== 'lost')) return null
  const lost = view.screen === 'lost'
  return (
    <div
      className={
        lost
          ? 'shrink-0 border-b-2 border-danger bg-danger-subtle px-4 py-3'
          : 'shrink-0 border-b border-warning/40 bg-warning-subtle px-4 py-2'
      }
      role={lost ? 'alert' : 'status'}
      data-testid="connection-banner"
      data-phase={state.phase}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className={`m-0 text-caption font-semibold uppercase tracking-wide ${lost ? 'text-danger' : 'text-text-secondary'}`} data-testid="connection-kicker">
            {view.kicker}
          </p>
          <p className="m-0 font-semibold text-text-primary" data-testid="connection-title">
            {view.title}
          </p>
          {view.cause ? (
            <p className="m-0 text-text-primary" data-testid="connection-cause">
              {view.cause}
            </p>
          ) : null}
          <p className="m-0 text-text-primary" data-testid="connection-detail">
            {view.detail}
          </p>
          {lost ? <p className="m-0 text-small text-text-secondary">The page below shows the last state NEXUS knew and cannot be used until the connection is back.</p> : null}
        </div>
        {lost ? (
          <div className="flex shrink-0 items-center gap-2">
            {view.canRetry ? (
              <Button variant="primary" loading={busy} onClick={retry} data-testid="connection-retry">
                Retry
              </Button>
            ) : null}
            <Button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="connection-diagnostics-panel" data-testid="connection-diagnostics">
              Diagnostics
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="m-0 mt-1 text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {lost && open ? <div className="mt-3"><DiagnosticsList state={state} /></div> : null}
    </div>
  )
}

/** Wraps the page: dims it and makes it inert while the connection is lost, so stale state is never taken for live. */
export function ConnectionContent({ children }: { children: ReactNode }) {
  const { state, everReady } = useConnectionStore()
  const view = connectionView(state, everReady)
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col ${view.stale ? 'pointer-events-none opacity-50 saturate-50' : ''}`}
      // `inert` takes the stale content out of the tab order and the accessibility tree, so only the banner is operable.
      inert={view.stale}
      data-stale={view.stale}
      data-testid="connection-content"
    >
      {children}
    </div>
  )
}

export { Announcer as ConnectionAnnouncer }
