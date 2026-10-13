import { describe, expect, it } from 'vitest'
import { CONNECTIVITY_STATES, DEFAULT_RECOVERY_POLICY, describeNetworkWait, isNetworkOutageState, isPlausibleProfileName, normalizeRecoveryPolicy, progressWaitFor, workAllowed, type ConnectivityState, type NetworkOutage } from '@shared/connectivity'
import { PROGRESS_WAITS } from '@shared/progress'
import { classifyConnectivity } from '@main/modules/connectivity/classifier'
import { diagnoseOutage } from '@main/modules/connectivity/diagnosis'
import { InMemoryOutageStore } from '@main/modules/connectivity/outage-store'
import { createConnectivityProbe, type ProbeIo } from '@main/modules/connectivity/probes'
import { backoffDelay } from '@main/modules/connectivity/timers'
import { reasonCodeName, disconnectInitiator } from '@main/modules/connectivity/wlan-reasons'
import { FakeWlanAdapter } from '@main/modules/connectivity/wlan'
import { bad, FakeClock, raw, wlanDown } from './fakes'

describe('which work can go on in which state', () => {
  const offline: ConnectivityState[] = ['WLAN_DISCONNECTED', 'WLAN_ASSOCIATED_NO_INTERNET', 'DNS_FAILURE', 'INTERNET_UNREACHABLE']

  it('lets local work go on in every state', () => {
    for (const s of CONNECTIVITY_STATES) expect(workAllowed(s).LOCAL, s).toBe(true)
  })

  it('lets model work, research and installs go on when ONLINE', () => {
    expect(workAllowed('ONLINE')).toEqual({ LOCAL: true, MODEL: true, RESEARCH: true, DEPENDENCY_INSTALL: true })
  })

  it('blocks model, research and installs in every offline state', () => {
    for (const s of offline) expect(workAllowed(s), s).toEqual({ LOCAL: true, MODEL: false, RESEARCH: false, DEPENDENCY_INSTALL: false })
  })

  it('blocks only model work while the provider is unreachable or quota-limited: the Internet is fine', () => {
    for (const s of ['PROVIDER_UNREACHABLE', 'PROVIDER_QUOTA_WAIT'] as const) expect(workAllowed(s), s).toEqual({ LOCAL: true, MODEL: false, RESEARCH: true, DEPENDENCY_INSTALL: true })
  })

  it('blocks only research and installs when only the general Internet is missing', () => {
    expect(workAllowed('RESEARCH_ONLY_UNAVAILABLE')).toEqual({ LOCAL: true, MODEL: true, RESEARCH: false, DEPENDENCY_INSTALL: false })
  })

  it('counts a quota wait as a provider wait and not as a network outage', () => {
    expect(isNetworkOutageState('PROVIDER_QUOTA_WAIT')).toBe(false)
    expect(isNetworkOutageState('ONLINE')).toBe(false)
    for (const s of CONNECTIVITY_STATES.filter((x) => x !== 'ONLINE' && x !== 'PROVIDER_QUOTA_WAIT')) expect(isNetworkOutageState(s), s).toBe(true)
  })
})

describe('mapping onto the progress waits', () => {
  it('maps every state to one of the progress module\'s waits or to nothing', () => {
    for (const s of CONNECTIVITY_STATES) {
      const w = progressWaitFor(s)
      if (w !== null) expect(PROGRESS_WAITS).toContain(w)
    }
    expect(progressWaitFor('ONLINE')).toBeNull()
    expect(progressWaitFor('WLAN_DISCONNECTED')).toBe('WAITING_FOR_NETWORK')
    expect(progressWaitFor('DNS_FAILURE')).toBe('WAITING_FOR_NETWORK')
    expect(progressWaitFor('PROVIDER_UNREACHABLE')).toBe('WAITING_FOR_PROVIDER')
    expect(progressWaitFor('PROVIDER_QUOTA_WAIT')).toBe('WAITING_FOR_PROVIDER')
  })

  it('says a run waits only when nothing that is left can go on', () => {
    const snap = { state: 'WLAN_DISCONNECTED' as const, since: 99 }
    expect(describeNetworkWait(snap, ['MODEL', 'RESEARCH'])).toMatchObject({ wait: 'WAITING_FOR_NETWORK', since: 99, waitingKinds: ['MODEL', 'RESEARCH'], continuingKinds: [] })
    const partial = describeNetworkWait(snap, ['LOCAL', 'MODEL'])
    expect(partial).toMatchObject({ wait: null, waitingKinds: ['MODEL'], continuingKinds: ['LOCAL'] })
    expect(partial.text).toBe('model work wait for the network; local work go on.')
  })

  it('reports no wait when what is left does not need the network', () => {
    expect(describeNetworkWait({ state: 'WLAN_DISCONNECTED', since: 1 }, ['LOCAL'])).toMatchObject({ wait: null, since: null, waitingKinds: [] })
    expect(describeNetworkWait({ state: 'ONLINE', since: 1 }, ['MODEL'])).toMatchObject({ wait: null, waitingKinds: [] })
  })

  it('names the provider, not the network, when the provider is what is missing', () => {
    const w = describeNetworkWait({ state: 'PROVIDER_QUOTA_WAIT', since: 5 }, ['MODEL'])
    expect(w.wait).toBe('WAITING_FOR_PROVIDER')
    expect(w.text).toContain('model provider')
  })

  it('treats missing research while the model works as a network wait for the research tasks only', () => {
    const w = describeNetworkWait({ state: 'RESEARCH_ONLY_UNAVAILABLE', since: 5 }, ['RESEARCH'])
    expect(w).toMatchObject({ wait: 'WAITING_FOR_NETWORK', waitingKinds: ['RESEARCH'] })
  })
})

describe('recovery policy settings', () => {
  it('keeps defaults for a missing or hostile input', () => {
    for (const input of [undefined, null, 'x', 42, [], {}]) expect(normalizeRecoveryPolicy(input), String(input)).toEqual(DEFAULT_RECOVERY_POLICY)
  })

  it('accepts a primary, ordered backups, and bounds the numbers', () => {
    const p = normalizeRecoveryPolicy({ enabled: false, primaryProfile: 'Home', approvedBackupProfiles: ['B', 'A', 'B', 'Home'], maxAttempts: 9999, backoffInitialMs: 1, backoffMaxMs: 5 })
    expect(p).toEqual({ enabled: false, primaryProfile: 'Home', approvedBackupProfiles: ['B', 'A'], maxAttempts: 20, backoffInitialMs: 1_000, backoffMaxMs: 1_000 })
  })

  it('drops names that are not plausible profile names, and caps the list', () => {
    const p = normalizeRecoveryPolicy({ approvedBackupProfiles: ['ok', 'a\nb', '', 'x'.repeat(256), 5, ...Array.from({ length: 20 }, (_, i) => `n${i}`)] })
    expect(p.approvedBackupProfiles).toHaveLength(8)
    expect(p.approvedBackupProfiles[0]).toBe('ok')
    expect(p.approvedBackupProfiles).not.toContain('a\nb')
  })

  it('accepts only real booleans for "enabled"', () => {
    expect(normalizeRecoveryPolicy({ enabled: 'false' }).enabled).toBe(true)
    expect(normalizeRecoveryPolicy({ enabled: false }).enabled).toBe(false)
  })

  it('checks profile names for length and control characters only', () => {
    expect(isPlausibleProfileName('a"b & --c')).toBe(true)
    expect(isPlausibleProfileName('a'.repeat(255))).toBe(true)
    expect(isPlausibleProfileName('a'.repeat(256))).toBe(false)
    expect(isPlausibleProfileName('a\u007fb')).toBe(false)
  })
})

describe('diagnosis from facts only', () => {
  const outage = (over: Partial<NetworkOutage> = {}): NetworkOutage => {
    const evidence = classifyConnectivity({ ...wlanDown({ wlan: [{ guid: 'g', state: 'disconnected', profileName: null, lastReasonCode: 0x3800b }] }), at: 5000 }).evidence
    return { id: 'o', startedAt: 5000, endedAt: 65_000, states: [{ state: 'WLAN_DISCONNECTED', at: 5000 }], attempts: [], reasonCodes: [0x3800b], evidenceAtStart: evidence, evidenceAtEnd: null, ...over }
  }

  it('states duration, states, evidence and reason code, and says the cause was not determined', () => {
    const t = diagnoseOutage(outage())
    expect(t).toContain('(60 s)')
    expect(t).toContain('States seen: WLAN_DISCONNECTED.')
    expect(t).toContain('No Wi-Fi interface was associated')
    expect(t).toContain('WLAN_REASON_CODE_NETWORK_NOT_AVAILABLE')
    expect(t).toContain('NEXUS made no reconnect attempt.')
    expect(t.endsWith('The cause beyond these observations was not determined.')).toBe(true)
  })

  it('never names a cause it has no evidence for', () => {
    const states: ConnectivityState[] = ['WLAN_DISCONNECTED', 'WLAN_ASSOCIATED_NO_INTERNET', 'DNS_FAILURE', 'INTERNET_UNREACHABLE', 'PROVIDER_UNREACHABLE', 'RESEARCH_ONLY_UNAVAILABLE']
    for (const state of states) {
      const t = diagnoseOutage(outage({ states: [{ state, at: 5000 }], evidenceAtStart: { ...outage().evidenceAtStart, providers: { 'api.x': bad('api.x', 'ECONNREFUSED') } } }))
      expect(t, state).not.toMatch(/router|\bISP\b|modem|outage at|their side|your provider's fault|firewall/i)
    }
  })

  it('shows reconnect attempts with their outcomes, and an open outage as still down', () => {
    const t = diagnoseOutage(outage({ endedAt: null, attempts: [{ at: 6000, profileName: 'Home', outcome: 'NOT_CONNECTED', reasonCode: null, detail: null }] }))
    expect(t).toContain('still down')
    expect(t).toContain('"Home": NOT_CONNECTED')
  })

  it('quotes a profile name so that it cannot pass for text of its own', () => {
    const t = diagnoseOutage(outage({ attempts: [{ at: 1, profileName: 'x"; the cause was the router', outcome: 'NOT_CONNECTED', reasonCode: null, detail: null }] }))
    expect(t).toContain(JSON.stringify('x"; the cause was the router'))
  })
})

describe('reason codes and who disconnected', () => {
  it('names known codes and writes unknown ones in hex', () => {
    expect(reasonCodeName(0x3800b)).toBe('WLAN_REASON_CODE_NETWORK_NOT_AVAILABLE')
    expect(reasonCodeName(0x12345678)).toBe('0x12345678')
  })

  it('treats a completed deliberate disconnect and the user\'s own refusals as the user\'s, Windows losing the network as the system\'s, anything else as unknown', () => {
    expect(disconnectInitiator(0)).toBe('USER')
    expect(disconnectInitiator(0x38004)).toBe('USER')
    expect(disconnectInitiator(0x3800e)).toBe('USER')
    expect(disconnectInitiator(0x3800b)).toBe('SYSTEM')
    expect(disconnectInitiator(0x38002)).toBe('SYSTEM')
    expect(disconnectInitiator(null)).toBe('UNKNOWN')
    expect(disconnectInitiator(987654321)).toBe('UNKNOWN')
  })
})

describe('backoff and the store', () => {
  it('doubles up to the cap and never exceeds it, whatever the jitter', () => {
    for (const r of [0, 0.5, 1]) {
      const delays = Array.from({ length: 40 }, (_, n) => backoffDelay(n, 5_000, 300_000, () => r))
      expect(Math.max(...delays)).toBeLessThanOrEqual(300_000)
      expect(Math.min(...delays)).toBeGreaterThan(0)
    }
    expect(backoffDelay(0, 5_000, 300_000, () => 1)).toBe(5_000)
    expect(backoffDelay(3, 5_000, 300_000, () => 1)).toBe(40_000)
    expect(backoffDelay(1_000_000, 5_000, 300_000, () => 1)).toBe(300_000)
  })

  it('keeps the newest records, newest first, as copies', () => {
    const store = new InMemoryOutageStore(2)
    const base = classifyConnectivity(raw()).evidence
    const make = (id: string, startedAt: number): NetworkOutage => ({ id, startedAt, endedAt: null, states: [], attempts: [], reasonCodes: [], evidenceAtStart: base, evidenceAtEnd: null })
    store.save(make('a', 1))
    store.save(make('b', 2))
    store.save(make('c', 3))
    const got = store.recent(10)
    expect(got.map((o) => o.id)).toEqual(['c', 'b'])
    got[0]!.reasonCodes.push(1)
    expect(store.recent(1)[0]?.reasonCodes).toEqual([])
  })
})

describe('the real probe, with fake IO', () => {
  function io(over: Partial<ProbeIo> = {}): ProbeIo {
    return { lookup: async () => '1.2.3.4', tlsReach: async () => undefined, localAddresses: () => [], ...over }
  }
  const make = (probeIo: ProbeIo, wlan = new FakeWlanAdapter()) => createConnectivityProbe({ wlan, timers: new FakeClock(), io: probeIo, providerHosts: () => ['api.provider.test', 'api.provider.test'], quota: () => null })

  it('collects Wi-Fi state, the DNS result, two endpoints, two addresses and each provider once', async () => {
    const wlan = new FakeWlanAdapter()
    wlan.interfaces = [FakeWlanAdapter.iface({ state: 'connected', profileName: 'Home' })]
    const probes = await make(io(), wlan)()
    expect(probes.wlan[0]).toMatchObject({ state: 'connected', profileName: 'Home' })
    expect(probes.dns?.ok).toBe(true)
    expect(probes.endpoints).toHaveLength(2)
    expect(probes.addresses).toHaveLength(2)
    expect(Object.keys(probes.providers)).toEqual(['api.provider.test'])
    expect(classifyConnectivity(probes).state).toBe('ONLINE')
  })

  it('records the error code of each failure, and a failed Wi-Fi read leaves the Internet checks to decide', async () => {
    const wlan = new FakeWlanAdapter()
    wlan.status = async () => { throw new Error('helper missing') }
    const down = io({ lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }, tlsReach: async () => { throw Object.assign(new Error('x'), { code: 'ENETUNREACH' }) } })
    const probes = await make(down, wlan)()
    expect(probes.wlan).toEqual([])
    expect(probes.dns).toMatchObject({ ok: false, code: 'ENOTFOUND' })
    expect(probes.endpoints.every((p) => p.code === 'ENETUNREACH')).toBe(true)
    expect(classifyConnectivity(probes).state).toBe('WLAN_DISCONNECTED')
  })

  it('recognises a wired link by an address on an adapter that is not the Wi-Fi one, not virtual and not link-local', async () => {
    const wlan = new FakeWlanAdapter()
    wlan.interfaces = [FakeWlanAdapter.iface({ alias: 'Wi-Fi' })]
    const cases: Array<[Array<[string, string]>, boolean]> = [
      [[['Ethernet', '192.168.1.5']], true],
      [[['Wi-Fi', '192.168.1.5']], false],
      [[['vEthernet (WSL)', '172.20.0.1']], false],
      [[['Ethernet', '169.254.3.4']], false],
      [[['VirtualBox Host-Only Network', '192.168.56.1']], false],
      [[], false],
    ]
    for (const [addresses, wired] of cases) expect((await make(io({ localAddresses: () => addresses }), wlan)()).wiredLinkUp, JSON.stringify(addresses)).toBe(wired)
  })
})
