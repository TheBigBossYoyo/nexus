import { describe, expect, it } from 'vitest'
import { DEFAULT_RECOVERY_POLICY, workAllowed } from '@shared/connectivity'
import { createConnectivityProbe, type ProbeIo } from '@main/modules/connectivity/probes'
import { NetworkRecoveryManager } from '@main/modules/connectivity/recovery'
import { ConnectivitySupervisor, type ConnectivityEvent } from '@main/modules/connectivity/supervisor'
import { FakeWlanAdapter } from '@main/modules/connectivity/wlan'
import { FakeClock, GUID } from '../../unit/connectivity/fakes'

/** A machine whose Wi-Fi decides everything: fake Windows state in, real probe, supervisor and recovery on top, fake time. */
function machine() {
  const clock = new FakeClock()
  const wlan = new FakeWlanAdapter()
  wlan.saved = [{ name: 'Home', security: 'secured', autoConnect: false }, { name: 'Cafe', security: 'open', autoConnect: true }]
  wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'connected', profileName: 'Home' })]
  const connected = (): boolean => wlan.interfaces.some((i) => i.state === 'connected')
  const io: ProbeIo = {
    lookup: async () => {
      if (!connected()) throw Object.assign(new Error('x'), { code: 'ENETUNREACH' })
      return '1.2.3.4'
    },
    tlsReach: async () => {
      if (!connected()) throw Object.assign(new Error('x'), { code: 'ENETUNREACH' })
    },
    localAddresses: () => [],
  }
  const probe = createConnectivityProbe({ wlan, timers: clock, io, providerHosts: () => ['api.provider.test'], quota: () => null })
  const supervisor = new ConnectivitySupervisor({ probe, timers: clock, wlan, random: () => 1 })
  const recovery = new NetworkRecoveryManager({ wlan, supervisor, policy: () => ({ ...DEFAULT_RECOVERY_POLICY, primaryProfile: 'Home' }), timers: clock, random: () => 1 })
  wlan.onConnect = (name) => {
    wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'connected', profileName: name })]
    // Windows tells everyone when the connection completes.
    queueMicrotask(() => wlan.emit({ kind: 'connected', interfaceGuid: GUID, profileName: name }))
    return { requested: true, reasonCode: 0, detail: 'connected' }
  }
  const events: ConnectivityEvent[] = []
  supervisor.subscribe((e) => events.push(e))
  const drop = (reasonCode: number | null): void => {
    wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'disconnected', lastReasonCode: reasonCode })]
    wlan.emit({ kind: 'disconnected', interfaceGuid: GUID, profileName: 'Home', reasonCode })
  }
  return { clock, wlan, supervisor, recovery, events, drop }
}

describe('an outage from end to end (fake Windows, real supervisor, probe and recovery)', () => {
  it('detects a Wi-Fi drop, reconnects the saved primary profile, and records one outage with the attempt', async () => {
    const m = machine()
    await m.supervisor.start()
    m.recovery.start()
    expect(await m.recovery.capturePrimary()).toBe('Home')

    m.drop(0x3800b)
    await m.clock.flush()
    expect(m.supervisor.snapshot()?.state).toBe('WLAN_DISCONNECTED')
    expect(workAllowed(m.supervisor.snapshot()!.state)).toEqual({ LOCAL: true, MODEL: false, RESEARCH: false, DEPENDENCY_INSTALL: false })

    await m.clock.advance(20_000)
    expect(m.wlan.connectCalls).toEqual([{ profileName: 'Home', interfaceGuid: GUID }])
    await m.clock.advance(60_000)

    const types = m.events.map((e) => e.type)
    expect(types.filter((t) => t === 'outage-started')).toHaveLength(1)
    expect(types.filter((t) => t === 'restored')).toHaveLength(1)
    expect(m.supervisor.snapshot()?.state).toBe('ONLINE')
    const restored = m.events.find((e) => e.type === 'restored')
    if (restored?.type !== 'restored') throw new Error('no restored event')
    expect(restored.outage.reasonCodes).toEqual([0x3800b])
    expect(restored.outage.attempts.map((a) => [a.profileName, a.outcome])).toEqual([['Home', 'CONNECTED']])
    expect((await m.supervisor.recentOutages(5))).toHaveLength(1)
  })

  it('leaves a Wi-Fi the user disconnected alone for the whole outage, and records that it did', async () => {
    const m = machine()
    await m.supervisor.start()
    m.recovery.start()
    m.drop(0)
    await m.clock.advance(3_600_000)
    expect(m.wlan.connectCalls).toEqual([])
    expect(m.supervisor.snapshot()?.state).toBe('WLAN_DISCONNECTED')
    expect(m.supervisor.currentOutage()?.attempts.map((a) => a.outcome)).toEqual(['SKIPPED_USER_DISCONNECT'])
    // The user connects by hand later: the outage ends and nothing else was done.
    m.wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'connected', profileName: 'Home' })]
    m.wlan.emit({ kind: 'connected', interfaceGuid: GUID, profileName: 'Home' })
    await m.clock.advance(30_000)
    expect(m.supervisor.snapshot()?.state).toBe('ONLINE')
    expect(m.wlan.connectCalls).toEqual([])
  })

  it('gives up after the attempts are used and keeps waiting for the network without failing anything', async () => {
    const m = machine()
    m.wlan.onConnect = () => ({ requested: true, reasonCode: 0, detail: null })
    await m.supervisor.start()
    m.recovery.start()
    m.drop(0x3800b)
    await m.clock.advance(6 * 3_600_000)
    expect(m.wlan.connectCalls).toHaveLength(DEFAULT_RECOVERY_POLICY.maxAttempts)
    expect(m.supervisor.snapshot()?.state).toBe('WLAN_DISCONNECTED')
    // Probing goes on, bounded by the cap.
    expect(m.clock.nextIn as number).toBeLessThanOrEqual(300_000)
  })
})
