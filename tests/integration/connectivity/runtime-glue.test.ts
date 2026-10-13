import { describe, expect, it } from 'vitest'
import type { Run } from '@shared/domain'
import { FakeWlanAdapter } from '@main/modules/connectivity'
import { startNetworkResilience } from '@main/runtime/network-resilience'

// 0.9: the network loss of a mission, end to end through the runtime's glue with a simulated network: the
// provider disappears, the session's error is judged a wait, the saved Wi-Fi profile is reconnected, the
// network comes back, and the mission that waited is resumed once. No real network is touched.
const until = async (what: () => boolean, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function setup() {
  let up = true
  const wlan = new FakeWlanAdapter()
  wlan.saved = [{ name: 'Home', security: 'secured', autoConnect: false }, { name: 'CoffeeShop', security: 'open', autoConnect: false }]
  wlan.interfaces = [FakeWlanAdapter.iface({ state: 'connected', profileName: 'Home', ssid: 'Home', signal: 80 })]
  wlan.onConnect = (profileName) => {
    // The reconnect works: the interface is associated again, and with it the Internet.
    wlan.interfaces = [FakeWlanAdapter.iface({ state: 'connected', profileName, ssid: profileName, signal: 70 })]
    up = true
    return { requested: true, reasonCode: 0, detail: 'connected' }
  }
  const fail = (): never => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
  }
  const runs: Run[] = [{ id: 'run-00000001', projectId: 'p', state: 'executing', pauseReason: null, startedAt: new Date().toISOString(), createdAt: new Date().toISOString() } as unknown as Run]
  const resumed: string[] = []
  const awake: boolean[] = []
  const states: string[] = []
  const log: string[] = []
  const net = startNetworkResilience({
    wlan,
    probe: { lookup: async () => (up ? '93.184.216.34' : fail()), tlsReach: async () => (up ? undefined : fail()), localAddresses: () => [] },
    providerHosts: () => ['api.provider.test'],
    quota: () => null,
    openRuns: () => runs.filter((r) => !['completed', 'failed', 'cancelled'].includes(r.state)),
    workOf: () => ({ kind: 'LONG_MISSION', lastProgressAt: Date.now(), waitsOnBoundary: false }),
    resumeRun: async (id) => {
      resumed.push(id)
      const run = runs.find((r) => r.id === id) as Run
      run.state = 'executing'
      run.pauseReason = null
    },
    setKeepAwake: (on) => awake.push(on),
    policy: () => null,
    onState: (s) => states.push(s.state),
    logger: (line) => log.push(line),
    timing: { quietIntervalMs: 400, confirmMs: 60, backoffInitialMs: 80, backoffMaxMs: 300, errorProbeMinGapMs: 20 },
  })
  return { net, wlan, runs, resumed, awake, states, log, down: () => { up = false; wlan.interfaces = [FakeWlanAdapter.iface({ state: 'disconnected', lastReasonCode: 5 })]; wlan.emit({ kind: 'disconnected', reasonCode: 5 }) } }
}

describe('network loss of a mission, through the runtime (0.9)', () => {
  it('a lost Wi-Fi is a wait: the session error is judged a network loss, the saved profile is reconnected without a question, and the mission is resumed once', async () => {
    const w = setup()
    try {
      w.net.workChanged()
      await until(() => w.states.includes('ONLINE'))
      // Autonomous work is active: the idle-sleep request is held.
      expect(w.awake.at(-1)).toBe(true)
      expect(w.net.waitOf()).toBeNull()

      w.down()
      // The session of the mission dies on the connection; the orchestrator asks what that was.
      expect(w.net.networkLoss('API Error: fetch failed (getaddrinfo ENOTFOUND api.provider.test)')).toBe(true)
      const run = w.runs[0] as Run
      run.state = 'paused'
      run.pauseReason = 'network'
      w.net.workChanged()
      await until(() => w.states.some((s) => s === 'WLAN_DISCONNECTED'))
      expect(w.net.isOnline()).toBe(false)
      expect(w.net.waitOf()).toMatchObject({ kind: 'WAITING_FOR_NETWORK' })
      expect(w.net.waitOf()?.detail).toContain('Wi-Fi is disconnected')
      // Still held: the work will resume by itself.
      expect(w.awake.at(-1)).toBe(true)

      // The recovery reconnects the profile that was in use; the mission is resumed when the network is seen again.
      await until(() => w.resumed.length > 0, 60_000)
      expect(w.wlan.connectCalls.map((c) => c.profileName)).toEqual(['Home'])
      expect(w.resumed).toEqual(['run-00000001'])
      expect(w.net.isOnline()).toBe(true)
      expect(w.net.waitOf()).toBeNull()
      // Never the open network, though it is saved.
      expect(w.wlan.connectCalls.some((c) => c.profileName === 'CoffeeShop')).toBe(false)
      // And not resumed a second time by the next look at the network.
      await new Promise((r) => setTimeout(r, 900))
      expect(w.resumed).toEqual(['run-00000001'])
      const status = await w.net.status()
      expect(status.recentOutages.length).toBeGreaterThanOrEqual(1)
      expect(status.recentOutages[0]?.endedAt).not.toBeNull()
      expect(status.savedProfiles.map((p) => p.name)).toEqual(['Home', 'CoffeeShop'])
    } finally {
      await w.net.stop()
    }
  }, 90_000)

  it('an error that is not the network, with the network up, is not a wait; and with no autonomous work nothing is watched and nothing is held', async () => {
    const w = setup()
    try {
      w.net.workChanged()
      await until(() => w.states.includes('ONLINE'))
      expect(w.net.networkLoss('TypeError: cannot read properties of undefined')).toBe(false)
      expect(w.net.networkLoss('The model returned an invalid structured output')).toBe(false)
      // The mission ends: the request is released and the watching stops.
      ;(w.runs[0] as Run).state = 'completed'
      w.net.workChanged()
      expect(w.awake.at(-1)).toBe(false)
      const seen = w.states.length
      await new Promise((r) => setTimeout(r, 1200))
      expect(w.states.length).toBe(seen)
      expect(w.net.snapshot()).toBeNull()
    } finally {
      await w.net.stop()
    }
  }, 60_000)

  it('a mission paused by the user is not kept awake for, and is not resumed by the network coming back', async () => {
    const w = setup()
    try {
      const run = w.runs[0] as Run
      run.state = 'paused'
      run.pauseReason = 'user'
      w.net.workChanged()
      await new Promise((r) => setTimeout(r, 600))
      expect(w.awake.includes(true)).toBe(false)
      expect(w.resumed).toEqual([])
    } finally {
      await w.net.stop()
    }
  }, 30_000)
})
