import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { ConnectionPhase, ConnectionState, RuntimeIdentity } from '@shared/runtime-protocol'
import { connectionAnnouncement, connectionDiagnostics, connectionView, needsResync } from '../../../src/renderer/src/lib/connectionModel'
import { createPushHandler } from '../../../src/renderer/src/lib/push'
import { useConnectionStore } from '../../../src/renderer/src/store/connection'
import { useUiStore } from '../../../src/renderer/src/store/ui'

const runtime = (bootId = 'boot-1'): RuntimeIdentity => ({ protocol: 1, version: '0.7.0', pid: 4242, bootId, startedAt: '2026-01-01T00:00:00Z' })
const state = (phase: ConnectionPhase, over: Partial<ConnectionState> = {}): ConnectionState => ({ phase, detail: `detail of ${phase}`, runtime: runtime(), attempt: 0, since: '2026-01-01T00:00:00Z', ...over })

describe('what the window shows for each connection phase', () => {
  it('shows a calm startup state before the first READY, with the phase and the detail', () => {
    for (const phase of ['STARTING_RUNTIME', 'CONNECTING'] as const) {
      const v = connectionView(state(phase), false)
      expect(v).toMatchObject({ screen: 'startup', stale: false, detail: `detail of ${phase}` })
      expect(v.title.length).toBeGreaterThan(0)
    }
    expect(connectionView(state('STARTING_RUNTIME'), false).title).not.toBe(connectionView(state('CONNECTING'), false).title)
  })

  it('shows nothing when ready, or when there is no bridge (no state)', () => {
    expect(connectionView(state('READY'), true).screen).toBe('none')
    expect(connectionView(null, false)).toMatchObject({ screen: 'none', stale: false })
  })

  it('keeps the app usable while recovering and says what is being reconciled', () => {
    const v = connectionView(state('RECOVERING', { detail: 'Recovering 3 workloads; reconciling 2 workers' }), true)
    expect(v).toMatchObject({ screen: 'recovering', stale: false, detail: 'Recovering 3 workloads; reconciling 2 workers' })
  })

  it('marks the data stale and offers Retry when the connection was lost', () => {
    const lost = connectionView(state('DISCONNECTED'), true)
    expect(lost).toMatchObject({ screen: 'lost', stale: true, canRetry: true, retrying: true, kicker: 'Control plane disconnected', title: 'NEXUS lost contact with its background runtime', detail: 'NEXUS is attempting to reconnect.', cause: 'detail of DISCONNECTED' })
    // After a READY, starting or connecting again is a lost connection, not a startup.
    expect(connectionView(state('CONNECTING'), true)).toMatchObject({ screen: 'lost', stale: true })
    expect(connectionView(state('STARTING_RUNTIME'), true)).toMatchObject({ screen: 'lost', stale: true })
  })

  it('treats an incompatible runtime as stale, with its own detail and no promise to reconnect', () => {
    const v = connectionView(state('INCOMPATIBLE', { detail: 'The runtime speaks protocol 2; this window speaks 1.' }), true)
    expect(v).toMatchObject({ screen: 'lost', stale: true, canRetry: true, retrying: false, kicker: 'Control plane incompatible', cause: 'The runtime speaks protocol 2; this window speaks 1.' })
    expect(v.title).toContain('cannot work with')
    expect(connectionView(state('INCOMPATIBLE'), false).stale).toBe(true)
  })

  it('lists the diagnostics: phase, detail, attempts, since, pid, boot id, version, protocol', () => {
    const rows = Object.fromEntries(connectionDiagnostics(state('DISCONNECTED', { attempt: 3 })).map((r) => [r.label, r.value]))
    expect(rows).toMatchObject({ Phase: 'DISCONNECTED', Attempts: '3', 'Last runtime PID': '4242', 'Boot id': 'boot-1', 'Runtime version': '0.7.0', Protocol: '1' })
    expect(connectionDiagnostics(state('CONNECTING', { runtime: null })).find((r) => r.label === 'Boot id')?.value).toBe('—')
  })
})

describe('when everything is read again', () => {
  it('after a lost connection comes back, or the runtime restarted', () => {
    expect(needsResync(state('DISCONNECTED'), state('READY'))).toBe(true)
    expect(needsResync(state('RECOVERING'), state('READY'))).toBe(true)
    expect(needsResync(state('READY', { runtime: runtime('boot-1') }), state('READY', { runtime: runtime('boot-2') }))).toBe(true)
  })

  it('not for the first state, a steady READY, or a state that is not READY', () => {
    expect(needsResync(null, state('READY'))).toBe(false)
    expect(needsResync(state('READY'), state('READY'))).toBe(false)
    expect(needsResync(state('READY'), state('DISCONNECTED'))).toBe(false)
  })

  it('announces the loss, and the return with a refresh', () => {
    expect(connectionAnnouncement(state('DISCONNECTED'), true, false)).toContain('NEXUS lost contact with its background runtime')
    expect(connectionAnnouncement(state('DISCONNECTED', { detail: 'The pipe closed.' }), true, false)).toContain('The pipe closed.')
    expect(connectionAnnouncement(state('READY'), true, true)).toContain('Reconnected')
    expect(connectionAnnouncement(state('READY'), true, false)).toBe('')
    expect(connectionAnnouncement(null, false, false)).toBe('')
  })
})

describe('push handling of the connection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useConnectionStore.setState({ state: null, everReady: false, resyncs: 0 })
  })
  afterEach(() => vi.useRealTimers())
  const live = { append: vi.fn(), clear: vi.fn() }

  it('re-reads every query when the connection returns, and remembers it was ready', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const h = createPushHandler(qc, { live })
    h.handle({ kind: 'connection', state: state('READY') })
    expect(spy).not.toHaveBeenCalled()
    h.handle({ kind: 'connection', state: state('DISCONNECTED') })
    expect(useConnectionStore.getState().everReady).toBe(true)
    expect(connectionView(useConnectionStore.getState().state, true).stale).toBe(true)
    h.handle({ kind: 'connection', state: state('READY', { runtime: runtime('boot-2') }) })
    expect(spy).toHaveBeenCalledWith()
    expect(useConnectionStore.getState().resyncs).toBe(1)
    h.dispose()
  })

  it('invalidates runtime and control queries on a runtime push, and opens the Control Center on a desktop push', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const h = createPushHandler(qc, { debounceMs: 10, live })
    h.handle({ kind: 'runtime' })
    vi.advanceTimersByTime(10)
    const keys = spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey))
    expect(keys).toContain(JSON.stringify(['runtime']))
    expect(keys).toContain(JSON.stringify(['control']))
    useUiStore.setState({ view: 'home' })
    h.handle({ kind: 'desktop', action: 'show', view: 'control' })
    expect(useUiStore.getState().view).toBe('control')
    useUiStore.setState({ view: 'home' })
    h.handle({ kind: 'desktop', action: 'show', view: null })
    expect(useUiStore.getState().view).toBe('home')
    h.dispose()
  })
})
