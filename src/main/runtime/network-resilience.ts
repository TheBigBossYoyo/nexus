import { existsSync } from 'node:fs'
import type { Run } from '@shared/domain'
import { DEFAULT_RECOVERY_POLICY, isNetworkOutageState, normalizeRecoveryPolicy, progressWaitFor, type ConnectivitySnapshot, type NetworkOutage, type NetworkRecoveryPolicy } from '@shared/connectivity'
import { errorMessage } from '@shared/result'
import {
  ConnectivitySupervisor,
  FakeWlanAdapter,
  InMemoryOutageStore,
  NativeWlanAdapter,
  NetworkRecoveryManager,
  OvernightPowerGuard,
  classifyTransportError,
  createConnectivityProbe,
  realTimers,
  type AutonomousWorkItem,
  type OutageStore,
  type WlanAdapter,
} from '../modules/connectivity'

/**
 * 0.9: network resilience, as the runtime uses it. A mission whose provider cannot be reached waits and is
 * resumed; the saved Wi-Fi profile that was in use is reconnected; the machine is kept from idle sleep while
 * autonomous work is active or will resume. Nothing here asks the user anything.
 *
 * The supervisor looks at the network only while there is autonomous work: with nothing going on, NEXUS makes
 * no connectivity check at all.
 */

export interface NetworkResilienceDeps {
  /** The compiled Wi-Fi helper (out/native/nexus-wlan.exe, or resources/bin in a package). Absent or missing: no Wi-Fi recovery, the rest works. */
  wlanHelperPath?: string
  /** Host names of the model providers in use. */
  providerHosts: () => string[]
  quota: () => { limited: boolean; resetAt: number | null } | null
  /** Runs that are not finished, as they are now. */
  openRuns: () => Run[]
  /** What kind of autonomous work a run belongs to, and when it last moved forward. */
  workOf: (run: Run) => { kind: AutonomousWorkItem['kind']; lastProgressAt: number; waitsOnBoundary: boolean } | null
  resumeRun: (runId: string) => Promise<unknown>
  setKeepAwake: (on: boolean) => void
  policy: () => unknown
  store?: OutageStore
  /** Told when the state changed or an outage ended: for the window, the progress and the Director Line. */
  onState?: (snapshot: ConnectivitySnapshot) => void
  onRestored?: (outage: NetworkOutage, diagnosis: string) => void
  logger: (line: string) => void
  /** Tests replace the adapter and the probe. */
  wlan?: WlanAdapter
  probe?: Parameters<typeof createConnectivityProbe>[0]['io']
  /** Tests shorten the supervisor's waits. */
  timing?: { quietIntervalMs?: number; confirmMs?: number; backoffInitialMs?: number; backoffMaxMs?: number; errorProbeMinGapMs?: number }
}

export interface NetworkResilience {
  /** Whether a session that ended with this error ended because the network or the provider could not be reached. */
  networkLoss: (error: string) => boolean
  /** What the progress of a run should say it waits on, when it waits on the network. */
  waitOf: () => { kind: 'WAITING_FOR_NETWORK' | 'WAITING_FOR_PROVIDER'; detail: string } | null
  snapshot: () => ConnectivitySnapshot | null
  isOnline: () => boolean
  policy: () => NetworkRecoveryPolicy
  status: () => Promise<{ snapshot: ConnectivitySnapshot | null; policy: NetworkRecoveryPolicy; savedProfiles: { name: string; security: string; autoConnect: boolean }[]; recentOutages: NetworkOutage[]; keepAwake: { held: boolean; reason: string }; wifiRecovery: 'available' | 'no helper' }>
  /** Called whenever autonomous work began, ended or changed state. */
  workChanged: () => void
  stop: () => Promise<void>
}

const STATE_TEXT: Record<string, string> = {
  WLAN_DISCONNECTED: 'Wi-Fi is disconnected',
  WLAN_ASSOCIATED_NO_INTERNET: 'Wi-Fi is connected and the Internet is not reached',
  DNS_FAILURE: 'names are not being looked up (DNS)',
  INTERNET_UNREACHABLE: 'the Internet is not reached',
  PROVIDER_UNREACHABLE: 'the provider is not reached; the Internet is',
  PROVIDER_QUOTA_WAIT: 'the provider is reached and its usage limit is in force',
  RESEARCH_ONLY_UNAVAILABLE: 'research sources are not reached',
}

export function startNetworkResilience(deps: NetworkResilienceDeps): NetworkResilience {
  const log = (line: string): void => deps.logger(`network: ${line}`)
  const helper = deps.wlanHelperPath !== undefined && existsSync(deps.wlanHelperPath) ? deps.wlanHelperPath : null
  // Without the helper there is no Wi-Fi to look at or to reconnect: an adapter that reports nothing. The probes
  // of names and hosts still tell a lost network from a lost provider.
  const wlan: WlanAdapter = deps.wlan ?? (helper !== null ? new NativeWlanAdapter({ helperPath: helper, logger: log }) : new FakeWlanAdapter())
  const policy = (): NetworkRecoveryPolicy => normalizeRecoveryPolicy(deps.policy() ?? DEFAULT_RECOVERY_POLICY)
  const store = deps.store ?? new InMemoryOutageStore()
  const probe = createConnectivityProbe({ wlan, timers: realTimers, providerHosts: deps.providerHosts, quota: deps.quota, ...(deps.probe !== undefined ? { io: deps.probe } : {}) })
  const supervisor = new ConnectivitySupervisor({ probe, timers: realTimers, wlan, store, logger: log, ...(deps.timing ?? {}) })
  const recovery = new NetworkRecoveryManager({ wlan, supervisor, policy, timers: realTimers, logger: log })
  const guard = new OvernightPowerGuard({ setKeepAwake: deps.setKeepAwake, timers: realTimers, logger: log })
  let running = false
  let stopped = false
  let last: ConnectivitySnapshot | null = null
  /** Runs this module paused the wait of: resumed when the network is back, once. */
  const resuming = new Set<string>()

  const offline = (): boolean => last !== null && isNetworkOutageState(last.state)

  const resumeWaiting = (): void => {
    for (const run of deps.openRuns()) {
      if (run.state !== 'paused' || run.pauseReason !== 'network' || resuming.has(run.id)) continue
      resuming.add(run.id)
      log(`the network is back: resuming mission ${run.id.slice(0, 8)}`)
      void deps
        .resumeRun(run.id)
        .catch((e: unknown) => log(`resuming ${run.id.slice(0, 8)} failed: ${errorMessage(e)}`))
        .finally(() => resuming.delete(run.id))
    }
  }

  supervisor.subscribe((event) => {
    if (event.type === 'state') {
      last = event.snapshot
      try {
        deps.onState?.(event.snapshot)
      } catch (e) {
        log(`listener: ${errorMessage(e)}`)
      }
      // Back online by whatever way (an outage that was never long enough to be recorded as one included).
      if (!isNetworkOutageState(event.snapshot.state)) resumeWaiting()
      workChanged()
    } else if (event.type === 'restored') {
      log(`restored: ${event.diagnosis}`)
      try {
        deps.onRestored?.(event.outage, event.diagnosis)
      } catch (e) {
        log(`listener: ${errorMessage(e)}`)
      }
      resumeWaiting()
    }
  })

  function workItems(): AutonomousWorkItem[] {
    const items: AutonomousWorkItem[] = []
    for (const run of deps.openRuns()) {
      const work = deps.workOf(run)
      if (work === null) continue
      let status: AutonomousWorkItem['status'] = 'WORKING'
      if (run.state === 'paused') status = run.pauseReason === 'network' ? 'WAITING_FOR_NETWORK' : run.pauseReason === 'quota' || run.pauseReason === 'capacity' ? 'WAITING_FOR_PROVIDER' : run.pauseReason === 'user' ? 'PAUSED_BY_USER' : 'WORKING'
      else if (run.state === 'awaiting_approval') status = 'WAITING_FOR_USER'
      else if (work.waitsOnBoundary) status = 'WAITING_FOR_USER_BOUNDARY'
      items.push({ id: run.id, kind: work.kind, status, lastProgressAt: work.lastProgressAt })
    }
    return items
  }

  function workChanged(): void {
    if (stopped) return
    const items = workItems()
    try {
      guard.update(items)
    } catch (e) {
      log(`keep-awake: ${errorMessage(e)}`)
    }
    // The network is watched while there is autonomous work that is going on or will resume, and not otherwise.
    const wanted = items.some((i) => i.status === 'WORKING' || i.status === 'WAITING_FOR_NETWORK' || i.status === 'WAITING_FOR_PROVIDER')
    if (wanted && !running) {
      running = true
      void recovery.capturePrimary().catch(() => null)
      void supervisor
        .start()
        .then(() => recovery.start())
        .catch((e: unknown) => log(`could not start: ${errorMessage(e)}`))
    } else if (!wanted && running) {
      running = false
      last = null
      try {
        recovery.stop()
      } catch {
        // Already stopped.
      }
      void Promise.resolve(supervisor.stop()).catch(() => undefined)
    }
  }

  return {
    networkLoss(error) {
      const classified = classifyTransportError({ error })
      if (classified.kind === 'NETWORK' || classified.kind === 'PROVIDER_OUTAGE') {
        // The supervisor looks at once; what it sees decides the next sessions. This one ended on a network
        // error and is a wait whatever the next look says: a task is not failed for a connection that dropped.
        supervisor.notifyNetworkError(classified)
        return true
      }
      // An error that does not say "network" while the network is known to be down is the network all the same
      // (a provider process that only reports "crashed").
      return offline()
    },
    waitOf() {
      if (last === null) return null
      const kind = progressWaitFor(last.state)
      return kind === null ? null : { kind, detail: `${STATE_TEXT[last.state] ?? last.state}, since ${new Date(last.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }
    },
    snapshot: () => last,
    isOnline: () => !offline(),
    policy,
    async status() {
      const saved = await Promise.resolve(wlan.profiles()).catch(() => [])
      return {
        snapshot: last ?? supervisor.snapshot(),
        policy: policy(),
        savedProfiles: saved.map((p) => ({ name: p.name, security: p.security, autoConnect: p.autoConnect })),
        recentOutages: await Promise.resolve(supervisor.recentOutages(20)).catch(() => []),
        keepAwake: { held: guard.isHeld, reason: guard.reason ?? '' },
        wifiRecovery: helper !== null || deps.wlan !== undefined ? 'available' : 'no helper',
      }
    },
    workChanged,
    async stop() {
      stopped = true
      try {
        recovery.stop()
      } catch {
        // Already stopped.
      }
      await Promise.resolve(supervisor.stop()).catch(() => undefined)
      guard.dispose()
    },
  }
}
