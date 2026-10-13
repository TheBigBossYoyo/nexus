import { describe, expect, it, vi } from 'vitest'
import type { RawProbes } from '@main/modules/connectivity/classifier'
import { InMemoryOutageStore, type OutageStore } from '@main/modules/connectivity/outage-store'
import { ConnectivitySupervisor, type ConnectivityEvent } from '@main/modules/connectivity/supervisor'
import { FakeWlanAdapter } from '@main/modules/connectivity/wlan'
import { bad, FakeClock, ok, raw, wlanDown } from './fakes'

function harness(opts: { random?: number; store?: OutageStore; confirmMs?: number } = {}) {
  const clock = new FakeClock()
  const wlan = new FakeWlanAdapter()
  const store = opts.store ?? new InMemoryOutageStore()
  let current: RawProbes = raw()
  const probe = vi.fn(async () => ({ ...current, at: clock.now() }))
  const logs: string[] = []
  let ids = 0
  const sup = new ConnectivitySupervisor({ probe, timers: clock, wlan, store, random: () => opts.random ?? 1, logger: (l) => logs.push(l), newId: () => `outage-${++ids}`, confirmMs: opts.confirmMs })
  const events: ConnectivityEvent[] = []
  sup.subscribe((e) => events.push(e))
  const ofType = <T extends ConnectivityEvent['type']>(type: T): Array<Extract<ConnectivityEvent, { type: T }>> => events.filter((e): e is Extract<ConnectivityEvent, { type: T }> => e.type === type)
  return { clock, wlan, store, sup, probe, events, logs, ofType, set: (r: RawProbes) => (current = r) }
}

describe('connectivity supervisor', () => {
  it('publishes the first probe at once and then probes only on the quiet interval while ONLINE', async () => {
    const h = harness()
    await h.sup.start()
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
    expect(h.ofType('state')).toHaveLength(1)
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.clock.nextIn).toBe(60_000)
    await h.clock.advance(59_999)
    expect(h.probe).toHaveBeenCalledTimes(1)
    await h.clock.advance(1)
    expect(h.probe).toHaveBeenCalledTimes(2)
    await h.clock.advance(60_000)
    expect(h.probe).toHaveBeenCalledTimes(3)
    expect(h.ofType('state')).toHaveLength(1)
    expect(h.ofType('outage-started')).toHaveLength(0)
  })

  it('holds a new state for the confirmation time before publishing it, then opens an outage with the evidence', async () => {
    const h = harness()
    await h.sup.start()
    await h.clock.advance(60_000)
    h.set(wlanDown())
    await h.clock.advance(60_000)
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
    expect(h.clock.nextIn).toBe(5_000)
    await h.clock.advance(4_999)
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
    await h.clock.advance(1)
    expect(h.sup.snapshot()?.state).toBe('WLAN_DISCONNECTED')
    const started = h.ofType('outage-started')
    expect(started).toHaveLength(1)
    expect(started[0]?.outage.evidenceAtStart).toMatchObject({ wlanAssociated: false, wlanState: 'disconnected' })
    expect(started[0]?.outage.endedAt).toBeNull()
    // The outage began when the state was first seen, not when it was confirmed.
    expect(h.sup.snapshot()?.since).toBe(started[0]?.outage.startedAt)
    expect((await h.store.recent(5))[0]?.id).toBe('outage-1')
  })

  it('does not publish a flap that ends before it was confirmed', async () => {
    const h = harness()
    await h.sup.start()
    h.set(wlanDown())
    await h.clock.advance(60_000)
    h.set(raw())
    await h.clock.advance(5_000)
    await h.clock.advance(120_000)
    expect(h.ofType('state')).toHaveLength(1)
    expect(h.ofType('outage-started')).toHaveLength(0)
    expect(h.ofType('restored')).toHaveLength(0)
  })

  it('does not publish a return to ONLINE that falls back inside the confirmation time, and publishes it once it holds', async () => {
    const h = harness()
    h.set(wlanDown())
    await h.sup.start()
    h.set(raw())
    await h.clock.advance(5_000)
    expect(h.sup.snapshot()?.state).toBe('WLAN_DISCONNECTED')
    h.set(wlanDown())
    await h.clock.advance(5_000)
    expect(h.ofType('restored')).toHaveLength(0)
    expect(h.sup.snapshot()?.state).toBe('WLAN_DISCONNECTED')
    h.set(raw())
    await h.clock.advance(300_000)
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
    expect(h.ofType('restored')).toHaveLength(1)
    expect(h.ofType('outage-started')).toHaveLength(1)
  })

  it('publishes a hard Wi-Fi disconnect while ONLINE without the confirmation time', async () => {
    const h = harness()
    await h.sup.start()
    h.set(wlanDown())
    h.wlan.emit({ kind: 'disconnected', reasonCode: 0x3800b })
    await h.clock.flush()
    expect(h.sup.snapshot()?.state).toBe('WLAN_DISCONNECTED')
    const outage = h.ofType('outage-started')[0]?.outage
    expect(outage?.reasonCodes).toContain(0x3800b)
  })

  it('still debounces a probe that finds a wired fallback after a Wi-Fi disconnect event', async () => {
    const h = harness()
    await h.sup.start()
    h.set(raw({ wlan: [{ guid: 'g', state: 'disconnected', profileName: null, lastReasonCode: null }], wiredLinkUp: true }))
    h.wlan.emit({ kind: 'disconnected', reasonCode: null })
    await h.clock.flush()
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
    expect(h.ofType('outage-started')).toHaveLength(0)
  })

  it('backs off 5 s, 10 s, 20 s ... and never beyond 5 min while offline', async () => {
    const h = harness({ random: 1 })
    h.set(wlanDown())
    await h.sup.start()
    const delays: number[] = []
    for (let i = 0; i < 10; i++) {
      const d = h.clock.nextIn as number
      delays.push(d)
      await h.clock.advance(d)
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000])
  })

  it('shortens a backoff delay with jitter but never lengthens it past the cap', async () => {
    const h = harness({ random: 0 })
    h.set(wlanDown())
    await h.sup.start()
    const first = h.clock.nextIn as number
    expect(first).toBeGreaterThanOrEqual(3_750)
    expect(first).toBeLessThanOrEqual(5_000)
    for (let i = 0; i < 12; i++) await h.clock.advance(h.clock.nextIn as number)
    expect(h.clock.nextIn as number).toBeLessThanOrEqual(300_000)
  })

  it('resets the backoff and probes at once when told of a network change', async () => {
    const h = harness({ random: 1 })
    h.set(wlanDown())
    await h.sup.start()
    for (let i = 0; i < 4; i++) await h.clock.advance(h.clock.nextIn as number)
    expect(h.clock.nextIn).toBe(80_000)
    const before = h.probe.mock.calls.length
    await h.sup.notifyNetworkChange()
    expect(h.probe.mock.calls.length).toBe(before + 1)
    expect(h.clock.nextIn).toBe(5_000)
  })

  it('treats a Windows connection notification as a network change', async () => {
    const h = harness({ random: 1 })
    h.set(wlanDown())
    await h.sup.start()
    for (let i = 0; i < 3; i++) await h.clock.advance(h.clock.nextIn as number)
    const before = h.probe.mock.calls.length
    h.set(raw())
    h.wlan.emit({ kind: 'connected', profileName: 'Home' })
    await h.clock.flush()
    expect(h.probe.mock.calls.length).toBe(before + 1)
    await h.clock.advance(5_000)
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
  })

  it('emits "restored" once, with the closed outage record and a diagnosis made from its facts', async () => {
    const h = harness()
    h.set(wlanDown({ wlan: [{ guid: 'g', state: 'disconnected', profileName: null, lastReasonCode: 0x3800b }] }))
    await h.sup.start()
    h.sup.recordReconnectAttempt({ at: h.clock.now(), profileName: 'Home', outcome: 'NOT_CONNECTED', reasonCode: null, detail: null })
    await h.clock.advance(10_000)
    h.set(raw())
    await h.clock.advance(60_000)
    const restored = h.ofType('restored')
    expect(restored).toHaveLength(1)
    const outage = restored[0]!.outage
    expect(outage.endedAt).not.toBeNull()
    expect(outage.states.map((s) => s.state)).toEqual(['WLAN_DISCONNECTED'])
    expect(outage.attempts).toHaveLength(1)
    expect(outage.reasonCodes).toEqual([0x3800b])
    expect(outage.evidenceAtEnd?.wlanAssociated).toBe(true)
    expect(restored[0]!.diagnosis).toContain('WLAN_REASON_CODE_NETWORK_NOT_AVAILABLE')
    expect(restored[0]!.diagnosis).toContain('The cause beyond these observations was not determined.')
    expect(restored[0]!.diagnosis).not.toMatch(/router|ISP|provider of Internet|modem/i)
    expect(h.sup.currentOutage()).toBeNull()
    expect((await h.store.recent(5))[0]?.endedAt).toBe(outage.endedAt)
  })

  it('does not emit "restored" twice when change notifications arrive together and the network is steady', async () => {
    const h = harness()
    h.set(wlanDown())
    await h.sup.start()
    h.set(raw())
    await h.clock.advance(5_000)
    await Promise.all([h.sup.notifyNetworkChange(), h.sup.notifyNetworkChange(), h.sup.probeNow()])
    await h.clock.advance(5_000)
    await h.clock.advance(300_000)
    expect(h.ofType('restored')).toHaveLength(1)
    expect(h.ofType('outage-started')).toHaveLength(1)
  })

  it('keeps one outage across several offline states and records each state it passed through', async () => {
    const h = harness()
    h.set(wlanDown())
    await h.sup.start()
    h.set(raw({ dns: bad('d', 'ENOTFOUND'), endpoints: [bad('a'), bad('b')], addresses: [bad('1.1.1.1'), bad('8.8.8.8')], providers: { p: bad('p') } }))
    await h.clock.advance(5_000)
    await h.clock.advance(5_000)
    expect(h.sup.snapshot()?.state).toBe('WLAN_ASSOCIATED_NO_INTERNET')
    h.set(raw())
    await h.clock.advance(20_000)
    await h.clock.advance(5_000)
    expect(h.ofType('outage-started')).toHaveLength(1)
    expect(h.ofType('restored')[0]?.outage.states.map((s) => s.state)).toEqual(['WLAN_DISCONNECTED', 'WLAN_ASSOCIATED_NO_INTERNET'])
  })

  it('treats a quota wait as a state but not as a network outage', async () => {
    const h = harness()
    await h.sup.start()
    h.set(raw({ quota: { limited: true, resetAt: h.clock.now() + 3_600_000 } }))
    await h.clock.advance(60_000)
    await h.clock.advance(5_000)
    expect(h.sup.snapshot()?.state).toBe('PROVIDER_QUOTA_WAIT')
    expect(h.ofType('outage-started')).toHaveLength(0)
    expect(h.clock.nextIn).toBe(60_000)
    h.set(raw())
    await h.clock.advance(60_000)
    await h.clock.advance(5_000)
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
    expect(h.ofType('restored')).toHaveLength(0)
  })

  it('closes an open outage when the network returns into a quota wait', async () => {
    const h = harness()
    h.set(wlanDown())
    await h.sup.start()
    h.set(raw({ quota: { limited: true, resetAt: null } }))
    await h.clock.advance(5_000)
    await h.clock.advance(5_000)
    expect(h.sup.snapshot()?.state).toBe('PROVIDER_QUOTA_WAIT')
    expect(h.ofType('restored')).toHaveLength(1)
  })

  it('probes at once on a network-classified provider error, at most once per gap', async () => {
    const h = harness()
    await h.sup.start()
    await h.sup.notifyNetworkError()
    expect(h.probe).toHaveBeenCalledTimes(2)
    await h.sup.notifyNetworkError()
    await h.sup.notifyNetworkError()
    expect(h.probe).toHaveBeenCalledTimes(2)
    await h.clock.advance(5_000)
    await h.sup.notifyNetworkError()
    expect(h.probe).toHaveBeenCalledTimes(3)
  })

  it('runs one more probe after a change that arrives while a probe is in flight', async () => {
    const h = harness()
    await h.sup.start()
    let release: (r: RawProbes) => void = () => undefined
    h.probe.mockImplementationOnce(() => new Promise<RawProbes>((resolve) => (release = resolve)))
    const first = h.sup.probeNow()
    await h.clock.flush()
    const second = h.sup.notifyNetworkChange()
    expect(h.probe).toHaveBeenCalledTimes(2)
    release(raw())
    await Promise.all([first, second])
    expect(h.probe).toHaveBeenCalledTimes(3)
  })

  it('keeps its state and tries again when a probe fails to run', async () => {
    const h = harness()
    await h.sup.start()
    h.probe.mockRejectedValueOnce(new Error('boom'))
    await h.clock.advance(60_000)
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
    expect(h.logs.some((l) => l.includes('boom'))).toBe(true)
    expect(h.clock.nextIn).toBe(60_000)
  })

  it('goes on when the outage store throws or rejects', async () => {
    const store: OutageStore = { save: () => { throw new Error('disk full') }, recent: () => [] }
    const h = harness({ store })
    h.set(wlanDown())
    await h.sup.start()
    expect(h.sup.snapshot()?.state).toBe('WLAN_DISCONNECTED')
    expect(h.logs.some((l) => l.includes('disk full'))).toBe(true)
    const rejecting: OutageStore = { save: () => Promise.reject(new Error('locked')), recent: () => [] }
    const g = harness({ store: rejecting })
    g.set(wlanDown())
    await g.sup.start()
    await g.clock.flush()
    expect(g.logs.some((l) => l.includes('locked'))).toBe(true)
  })

  it('goes on when a listener throws', async () => {
    const h = harness()
    h.sup.subscribe(() => { throw new Error('listener bug') })
    await h.sup.start()
    expect(h.sup.snapshot()?.state).toBe('ONLINE')
    expect(h.logs.some((l) => l.includes('listener bug'))).toBe(true)
  })

  it('attaches Windows reason codes seen just before the outage and ones that arrive during it, once each', async () => {
    const h = harness()
    await h.sup.start()
    h.wlan.emit({ kind: 'attempt_failed', reasonCode: 0x38002 })
    h.set(wlanDown())
    await h.clock.flush()
    h.wlan.emit({ kind: 'attempt_failed', reasonCode: 0x38002 })
    h.wlan.emit({ kind: 'disconnected', reasonCode: 0x3800d })
    await h.clock.flush()
    expect(h.sup.currentOutage()?.reasonCodes.sort()).toEqual([0x38002, 0x3800d])
  })

  it('records reconnect attempts into the open outage and ignores them when there is none', async () => {
    const h = harness()
    await h.sup.start()
    h.sup.recordReconnectAttempt({ at: 1, profileName: 'Home', outcome: 'CONNECTED', reasonCode: null, detail: null })
    expect(h.sup.currentOutage()).toBeNull()
    h.set(wlanDown())
    h.wlan.emit({ kind: 'disconnected' })
    await h.clock.flush()
    h.sup.recordReconnectAttempt({ at: 2, profileName: 'Home', outcome: 'REQUEST_FAILED', reasonCode: 0x38009, detail: 'x' })
    const stored = (await h.store.recent(1))[0]
    expect(stored?.attempts).toHaveLength(1)
    expect(stored?.reasonCodes).toContain(0x38009)
  })

  it('stops probing after stop() and hears no more Windows events', async () => {
    const h = harness()
    await h.sup.start()
    h.sup.stop()
    expect(h.clock.pending).toBe(0)
    expect(h.wlan.listenerCount).toBe(0)
    await h.sup.notifyNetworkChange()
    expect(h.probe).toHaveBeenCalledTimes(1)
  })

  it('never lets the stored record be changed through the copy it handed out', async () => {
    const h = harness()
    h.set(wlanDown())
    await h.sup.start()
    const copy = h.sup.currentOutage()
    copy?.states.push({ state: 'ONLINE', at: 0 })
    expect(h.sup.currentOutage()?.states).toHaveLength(1)
    expect(ok('x').ok).toBe(true)
  })
})
