import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RECOVERY_POLICY, type ConnectivitySnapshot, type NetworkRecoveryPolicy, type ReconnectAttempt } from '@shared/connectivity'
import { classifyConnectivity } from '@main/modules/connectivity/classifier'
import { NetworkRecoveryManager } from '@main/modules/connectivity/recovery'
import type { ConnectivityEvent } from '@main/modules/connectivity/supervisor'
import { FakeWlanAdapter, type SavedProfile } from '@main/modules/connectivity/wlan'
import { FakeClock, GUID, raw, wlanDown } from './fakes'

const secured = (name: string): SavedProfile => ({ name, security: 'secured', autoConnect: false })
const open = (name: string): SavedProfile => ({ name, security: 'open', autoConnect: false })

function harness(policy: Partial<NetworkRecoveryPolicy> = {}, saved: SavedProfile[] = [secured('Home'), secured('Office'), secured('Phone')]) {
  const clock = new FakeClock()
  const wlan = new FakeWlanAdapter()
  wlan.saved = saved
  wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'disconnected' })]
  let current: NetworkRecoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, primaryProfile: 'Home', ...policy }
  const attempts: ReconnectAttempt[] = []
  const listeners = new Set<(e: ConnectivityEvent) => void>()
  let changes = 0
  const supervisor = {
    subscribe: (l: (e: ConnectivityEvent) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    recordReconnectAttempt: (a: ReconnectAttempt) => attempts.push(a),
    notifyNetworkChange: async () => {
      changes++
    },
  }
  const manager = new NetworkRecoveryManager({ wlan, supervisor, policy: () => current, timers: clock, random: () => 1 })
  manager.start()
  const fire = (e: ConnectivityEvent): void => listeners.forEach((l) => l(e))
  const down = (snapshot: ConnectivitySnapshot = classifyConnectivity(wlanDown())): void => fire({ type: 'state', snapshot, previous: 'ONLINE' })
  const online = (): void => fire({ type: 'state', snapshot: classifyConnectivity(raw()), previous: 'WLAN_DISCONNECTED' })
  const connectsOnRequest = (name: string): void => {
    wlan.onConnect = (n) => {
      if (n === name) wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'connected', profileName: n })]
      return { requested: true, reasonCode: null, detail: null }
    }
  }
  return { clock, wlan, manager, attempts, fire, down, online, connectsOnRequest, setPolicy: (p: Partial<NetworkRecoveryPolicy>) => (current = { ...current, ...p }), changes: () => changes }
}

const names = (h: ReturnType<typeof harness>): string[] => h.wlan.connectCalls.map((c) => c.profileName)

describe('network recovery: what it will ask Windows to connect', () => {
  it('reconnects the primary saved profile after the grace time, with no approval object anywhere', async () => {
    const h = harness()
    h.connectsOnRequest('Home')
    h.down()
    await h.clock.advance(19_999)
    expect(h.wlan.connectCalls).toEqual([])
    await h.clock.advance(1)
    expect(h.wlan.connectCalls).toEqual([{ profileName: 'Home', interfaceGuid: GUID }])
    await h.clock.advance(15_000)
    expect(h.attempts.map((a) => [a.profileName, a.outcome])).toEqual([['Home', 'CONNECTED']])
    expect(h.changes()).toBe(1)
  })

  it('takes no dependency on any approval or boundary machinery', () => {
    const source = readFileSync(join(__dirname, '../../../src/main/modules/connectivity/recovery.ts'), 'utf8')
    const imports = source.split('\n').filter((l) => l.startsWith('import '))
    expect(imports.join('\n')).not.toMatch(/approval|boundary|consent|permission/i)
    expect(source.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/createApproval|requestApproval|boundaryRequest/i)
  })

  it('takes the profile connected when the work began as the primary one when the policy names none', async () => {
    const h = harness({ primaryProfile: null })
    h.wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'connected', profileName: 'Office' })]
    expect(await h.manager.capturePrimary()).toBe('Office')
    h.wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'disconnected' })]
    h.connectsOnRequest('Office')
    h.down()
    await h.clock.advance(20_000)
    expect(names(h)).toEqual(['Office'])
  })

  it('lets the policy primary win over the captured one', async () => {
    const h = harness({ primaryProfile: 'Home' })
    h.wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'connected', profileName: 'Office' })]
    expect(await h.manager.capturePrimary()).toBe('Home')
  })

  it('tries the approved backups in order, then starts over, until the attempts are used', async () => {
    const h = harness({ approvedBackupProfiles: ['Office', 'Phone'], maxAttempts: 5 })
    h.down()
    await h.clock.advance(20_000)
    for (let i = 0; i < 6; i++) await h.clock.advance(15_000 + 130_000)
    expect(names(h)).toEqual(['Home', 'Office', 'Phone', 'Home', 'Office'])
    expect(h.attempts.every((a) => a.outcome === 'NOT_CONNECTED')).toBe(true)
  })

  it('stops at the profile that connects and does not try the rest', async () => {
    const h = harness({ approvedBackupProfiles: ['Office', 'Phone'] })
    h.connectsOnRequest('Office')
    h.down()
    await h.clock.advance(20_000 + 15_000 + 130_000 + 15_000)
    expect(names(h)).toEqual(['Home', 'Office'])
    expect(h.attempts.map((a) => a.outcome)).toEqual(['NOT_CONNECTED', 'CONNECTED'])
  })

  it('never names a profile that Windows does not list as saved, even when it is the primary or approved', async () => {
    const h = harness({ primaryProfile: 'Gone', approvedBackupProfiles: ['AlsoGone', 'Office'] })
    h.down()
    await h.clock.advance(20_000)
    expect(names(h)).toEqual(['Office'])
  })

  it('does nothing and records why when no approved profile is saved', async () => {
    const h = harness({ primaryProfile: 'Gone' })
    h.down()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
    expect(h.attempts.map((a) => a.outcome)).toEqual(['SKIPPED_NO_CANDIDATE'])
  })

  it('never names a saved profile that is not the primary and not approved', async () => {
    const h = harness({ primaryProfile: 'Gone', approvedBackupProfiles: [] })
    h.down()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
  })

  it('never connects an open network, even when it is the primary or on the approved list', async () => {
    const h = harness({ primaryProfile: 'CafeFree', approvedBackupProfiles: ['AirportFree', 'Office'] }, [open('CafeFree'), open('AirportFree'), secured('Office')])
    h.down()
    await h.clock.advance(20_000 + 600_000)
    expect(new Set(names(h))).toEqual(new Set(['Office']))
  })

  it('never connects a profile whose security Windows could not tell', async () => {
    const h = harness({}, [{ name: 'Home', security: 'unknown', autoConnect: false }])
    h.down()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
  })

  it('has no way to create, edit, export or read a key: the adapter interface offers none', () => {
    const adapter = new FakeWlanAdapter()
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).sort()).toEqual(['connect', 'constructor', 'emit', 'listenerCount', 'profiles', 'status', 'subscribe'])
    const source = readFileSync(join(__dirname, '../../../src/main/modules/connectivity/recovery.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(source).not.toMatch(/setProfile|deleteProfile|exportProfile|keyMaterial|password|passphrase|plaintext/i)
  })
})

describe('network recovery: when it does nothing', () => {
  it('does nothing when the user turned it off, and reads the setting again at every attempt', async () => {
    const h = harness({ enabled: false })
    h.down()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
    expect(h.attempts).toEqual([])
    const g = harness({ approvedBackupProfiles: ['Office'] })
    g.down()
    await g.clock.advance(20_000)
    expect(names(g)).toEqual(['Home'])
    g.setPolicy({ enabled: false })
    await g.clock.advance(15_000 + 130_000 + 130_000)
    expect(names(g)).toEqual(['Home'])
  })

  it('does nothing while a wired link has an address', async () => {
    const h = harness()
    h.down(classifyConnectivity(wlanDown({ wiredLinkUp: true })))
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
  })

  it('acts only in WLAN_DISCONNECTED, not in any other state', async () => {
    const h = harness()
    for (const probes of [raw(), raw({ quota: { limited: true, resetAt: null } }), raw({ providers: { p: { target: 'p', ok: false, code: 'ETIMEDOUT', ms: 1 } } })]) {
      h.fire({ type: 'state', snapshot: classifyConnectivity(probes), previous: null })
    }
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
  })

  it('respects a disconnect the user made: no reconnect, and it records that', async () => {
    const h = harness()
    h.wlan.emit({ kind: 'disconnected', interfaceGuid: GUID, reasonCode: 0 })
    h.down()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
    expect(h.attempts.map((a) => a.outcome)).toEqual(['SKIPPED_USER_DISCONNECT'])
    expect(h.attempts[0]?.detail).toMatch(/user/)
  })

  it('respects a user disconnect that arrives during the grace time', async () => {
    const h = harness()
    h.down()
    await h.clock.advance(10_000)
    h.wlan.emit({ kind: 'disconnected', reasonCode: 0 })
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
  })

  it('respects the user when only the interface status carries the user reason code', async () => {
    const h = harness()
    h.wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'disconnected', lastReasonCode: 0x38004 })]
    h.down()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
  })

  it('reconnects after a disconnect Windows made (network not available), and says so only once recorded', async () => {
    const h = harness()
    h.wlan.emit({ kind: 'disconnected', reasonCode: 0x3800b })
    h.down()
    await h.clock.advance(20_000)
    expect(names(h)).toEqual(['Home'])
  })

  it('does not reconnect once the user connected by hand or Windows connected by itself', async () => {
    const h = harness()
    h.down()
    await h.clock.advance(5_000)
    h.wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'connected', profileName: 'Phone' })]
    await h.clock.advance(15_000)
    expect(h.wlan.connectCalls).toEqual([])
    expect(h.changes()).toBe(1)
  })

  it('stops waiting when the network is back before its turn', async () => {
    const h = harness()
    h.down()
    await h.clock.advance(10_000)
    h.online()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
  })

  it('does not carry the user disconnect over to a later outage once the network has been restored', async () => {
    const h = harness()
    h.wlan.emit({ kind: 'disconnected', reasonCode: 0 })
    h.down()
    await h.clock.advance(30_000)
    expect(h.wlan.connectCalls).toEqual([])
    h.fire({ type: 'restored', outage: {} as never, diagnosis: '' })
    h.down()
    await h.clock.advance(30_000)
    expect(names(h)).toEqual(['Home'])
  })
})

describe('network recovery: bounds and failures', () => {
  it('makes at most maxAttempts requests for one outage, however long it lasts or however often the state is published', async () => {
    const h = harness({ maxAttempts: 3 })
    h.down()
    for (let i = 0; i < 30; i++) {
      await h.clock.advance(200_000)
      h.down()
    }
    expect(h.wlan.connectCalls).toHaveLength(3)
  })

  it('spaces the attempts by a backoff that doubles and stops at the cap', async () => {
    const h = harness({ maxAttempts: 6, backoffInitialMs: 10_000, backoffMaxMs: 30_000 })
    h.wlan.onConnect = () => ({ requested: false, reasonCode: 0x38009, detail: 'no' })
    h.down()
    const times: number[] = []
    h.wlan.onConnect = () => {
      times.push(h.clock.now())
      return { requested: false, reasonCode: 0x38009, detail: null }
    }
    await h.clock.advance(20_000 + 10_000 + 20_000 + 30_000 + 30_000 + 30_000 + 1_000)
    expect(times.slice(1).map((t, i) => t - (times[i] as number))).toEqual([10_000, 20_000, 30_000, 30_000, 30_000])
  })

  it('records a refused request with the reason code Windows gave', async () => {
    const h = harness({ maxAttempts: 1 })
    h.wlan.onConnect = () => ({ requested: false, reasonCode: 0x38009, detail: 'WlanConnect returned 87' })
    h.down()
    await h.clock.advance(20_000)
    expect(h.attempts).toEqual([expect.objectContaining({ profileName: 'Home', outcome: 'REQUEST_FAILED', reasonCode: 0x38009 })])
  })

  it('records a thrown adapter error as a failed request and keeps going within the bound', async () => {
    const h = harness({ maxAttempts: 2 })
    h.wlan.onConnect = () => {
      throw new Error('helper missing')
    }
    h.down()
    await h.clock.advance(20_000 + 130_000)
    expect(h.attempts.map((a) => a.outcome)).toEqual(['REQUEST_FAILED', 'REQUEST_FAILED'])
    expect(h.attempts[0]?.detail).toContain('helper missing')
  })

  it('does not call the interface connected through another profile a success of the requested one', async () => {
    const h = harness()
    h.wlan.onConnect = () => {
      h.wlan.interfaces = [FakeWlanAdapter.iface({ guid: GUID, state: 'connected', profileName: 'Phone' })]
      return { requested: true, reasonCode: null, detail: null }
    }
    h.down()
    await h.clock.advance(35_000)
    expect(h.attempts[0]).toMatchObject({ profileName: 'Home', outcome: 'NOT_CONNECTED' })
  })

  it('records that no Wi-Fi interface exists instead of inventing one', async () => {
    const h = harness()
    h.wlan.interfaces = []
    h.down()
    await h.clock.advance(20_000)
    expect(h.wlan.connectCalls).toEqual([])
    expect(h.attempts.map((a) => a.outcome)).toEqual(['SKIPPED_NO_INTERFACE'])
  })

  it('stops for good on stop()', async () => {
    const h = harness()
    h.down()
    h.manager.stop()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
    expect(h.clock.pending).toBe(0)
  })
})

describe('network recovery: hostile profile names', () => {
  const hostile = ['a"b', 'x & calc.exe', '--flag', '-/?', 'Café ☃', 'back\\slash\\', "it's", '$(whoami)', '%PATH%']

  it('passes each as the exact, single name it was saved under', async () => {
    for (const name of hostile) {
      const h = harness({ primaryProfile: name }, [secured(name)])
      h.down()
      await h.clock.advance(20_000)
      expect(h.wlan.connectCalls, name).toEqual([{ profileName: name, interfaceGuid: GUID }])
    }
  })

  it('refuses a name with a line break or a control character, and a name of 300 characters, even when a broken adapter lists it', async () => {
    const bad = ['line\nbreak', 'tab\there', 'nul\u0000x', 'a'.repeat(300), '']
    for (const name of bad) {
      const h = harness({ primaryProfile: name }, [secured(name)])
      h.down()
      await h.clock.advance(600_000)
      expect(h.wlan.connectCalls, JSON.stringify(name.slice(0, 20))).toEqual([])
    }
  })

  it('does not treat a name that differs from a saved one by case or by whitespace as saved', async () => {
    const h = harness({ primaryProfile: 'home', approvedBackupProfiles: ['Home '] })
    h.down()
    await h.clock.advance(600_000)
    expect(h.wlan.connectCalls).toEqual([])
  })
})
