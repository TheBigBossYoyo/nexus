import { isPlausibleProfileName, type ConnectivitySnapshot, type NetworkRecoveryPolicy, type ReconnectAttempt } from '@shared/connectivity'
import type { ConnectivityEvent } from './supervisor'
import { backoffDelay, type ConnectivityLogger, type Timers } from './timers'
import { disconnectInitiator } from './wlan-reasons'
import type { SavedProfile, WlanAdapter, WlanEvent, WlanInterfaceStatus } from './wlan'

/** The part of the supervisor the manager uses. */
export interface RecoverySupervisor {
  subscribe(listener: (event: ConnectivityEvent) => void): () => void
  recordReconnectAttempt(attempt: ReconnectAttempt): void
  notifyNetworkChange(): Promise<void>
}

export interface NetworkRecoveryManagerOptions {
  wlan: WlanAdapter
  supervisor: RecoverySupervisor
  /** Read at every decision, so a change in Settings takes effect on the next attempt. */
  policy: () => NetworkRecoveryPolicy
  timers: Timers
  random?: () => number
  logger?: ConnectivityLogger
  /** Windows' own auto-connect and any "disconnected by user" notification get this long before NEXUS acts. Default 20 s. */
  initialDelayMs?: number
  /** After a connect request is accepted, how long to wait before looking whether the interface is connected. Default 15 s. */
  verifyDelayMs?: number
  /** How often the interface is looked at during that time. Default 2 s. */
  verifyPollMs?: number
}

/**
 * Ordinary operational recovery from a Wi-Fi disconnect: ask Windows to connect a profile it has ALREADY saved.
 * It is not an approval and does not create one; it depends on no approval or boundary machinery.
 *
 * What it will name: the primary profile (the one connected when the work began), then the approved backup
 * profiles in order, and only those that Windows lists as saved right now and that are secured. What it will
 * not do: connect to an open network, to an unknown network, or to anything not on those lists; create, edit,
 * export or delete a profile; read or pass a key. It does nothing when the policy is off, when the machine is
 * not in WLAN_DISCONNECTED (a wired connection with Internet is ONLINE), or when the user disconnected the
 * Wi-Fi themselves; it makes at most `maxAttempts` requests for an outage, with a bounded backoff between them.
 */
export class NetworkRecoveryManager {
  private readonly random: () => number
  private readonly initialDelayMs: number
  private readonly verifyDelayMs: number
  private readonly verifyPollMs: number
  private unsubscribe: Array<() => void> = []
  private captured: string | null = null
  private runId = 0
  private active = false
  private wake: (() => void) | null = null
  private sleepTimer: unknown = null
  /** Requests made for the outage in progress. Reset when the network is back. */
  private attemptsThisOutage = 0
  private userDisconnect: { at: number; reasonCode: number | null } | null = null
  private skipReported = false

  constructor(private readonly o: NetworkRecoveryManagerOptions) {
    this.random = o.random ?? Math.random
    this.initialDelayMs = o.initialDelayMs ?? 20_000
    this.verifyDelayMs = o.verifyDelayMs ?? 15_000
    this.verifyPollMs = Math.max(250, o.verifyPollMs ?? 2_000)
  }

  start(): void {
    if (this.unsubscribe.length > 0) return
    this.unsubscribe = [this.o.supervisor.subscribe((e) => this.onSupervisor(e)), this.o.wlan.subscribe((e) => this.onWlan(e))]
  }

  stop(): void {
    for (const u of this.unsubscribe) u()
    this.unsubscribe = []
    this.cancel()
  }

  /**
   * Called when supervised work begins: remembers the profile that is connected now as the primary one, unless the
   * policy names one. Returns the primary profile in force (null when there is none), so the runtime can store it.
   */
  async capturePrimary(): Promise<string | null> {
    try {
      const connected = (await this.o.wlan.status()).find((i) => i.state === 'connected' && i.profileName !== null)
      if (connected?.profileName != null && isPlausibleProfileName(connected.profileName)) this.captured = connected.profileName
    } catch (e) {
      this.o.logger?.(`recovery: could not read the connected profile: ${errText(e)}`)
    }
    return this.o.policy().primaryProfile ?? this.captured
  }

  // ---- events ----------------------------------------------------------------------------------------------------

  private onWlan(event: WlanEvent): void {
    if (event.kind === 'connected') {
      this.userDisconnect = null
      return
    }
    if (event.kind === 'disconnected' && disconnectInitiator(event.reasonCode) === 'USER') this.userDisconnect = { at: this.o.timers.now(), reasonCode: event.reasonCode }
  }

  private onSupervisor(event: ConnectivityEvent): void {
    if (event.type === 'restored') {
      this.attemptsThisOutage = 0
      this.userDisconnect = null
      this.skipReported = false
      this.cancel()
      return
    }
    if (event.type !== 'state') return
    if (event.snapshot.state !== 'WLAN_DISCONNECTED') {
      // Any other state is not this manager's to act on (the link is up, or the network is back).
      this.cancel()
      return
    }
    if (!this.active) void this.run(event.snapshot)
  }

  // ---- the loop --------------------------------------------------------------------------------------------------

  private cancel(): void {
    this.runId++
    this.active = false
    if (this.sleepTimer !== null) this.o.timers.clearTimeout(this.sleepTimer)
    this.sleepTimer = null
    const w = this.wake
    this.wake = null
    w?.()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve
      this.sleepTimer = this.o.timers.setTimeout(() => {
        this.sleepTimer = null
        this.wake = null
        resolve()
      }, ms)
    })
  }

  private report(attempt: Omit<ReconnectAttempt, 'at'>): void {
    this.o.supervisor.recordReconnectAttempt({ at: this.o.timers.now(), ...attempt })
  }

  private async run(start: ConnectivitySnapshot): Promise<void> {
    const id = ++this.runId
    const live = (): boolean => this.runId === id
    // A wired link with an address is not a disconnect to repair.
    if (start.evidence.wiredLinkUp) return
    this.active = true
    try {
      await this.sleep(this.initialDelayMs)
      while (live()) {
        const policy = this.o.policy()
        if (!policy.enabled) {
          this.o.logger?.('recovery: switched off in the settings; nothing is done')
          return
        }
        if (this.attemptsThisOutage >= policy.maxAttempts) {
          this.o.logger?.(`recovery: gave up after ${this.attemptsThisOutage} attempts`)
          return
        }
        let interfaces: WlanInterfaceStatus[]
        let saved: SavedProfile[]
        try {
          interfaces = await this.o.wlan.status()
          saved = await this.o.wlan.profiles()
        } catch (e) {
          this.o.logger?.(`recovery: could not read Wi-Fi state: ${errText(e)}`)
          this.attemptsThisOutage++
          this.report({ profileName: null, outcome: 'REQUEST_FAILED', reasonCode: null, detail: 'Wi-Fi state could not be read' })
          await this.sleep(this.delay(policy))
          continue
        }
        if (!live()) return
        // Connected by itself (Windows auto-connect, or the user): the network may be back, so look.
        if (interfaces.some((i) => i.state === 'connected')) {
          void this.o.supervisor.notifyNetworkChange()
          return
        }
        if (this.respectsUser(interfaces)) {
          if (!this.skipReported) {
            this.skipReported = true
            this.report({ profileName: null, outcome: 'SKIPPED_USER_DISCONNECT', reasonCode: this.userDisconnect?.reasonCode ?? interfaces.map((i) => i.lastReasonCode).find((c) => c !== null) ?? null, detail: 'Wi-Fi was disconnected by the user; not reconnected' })
          }
          return
        }
        const candidates = this.candidates(policy, saved)
        if (candidates.length === 0) {
          this.report({ profileName: null, outcome: 'SKIPPED_NO_CANDIDATE', reasonCode: null, detail: 'no saved, secured, approved profile to connect' })
          return
        }
        const iface = interfaces.find((i) => i.state === 'disconnected') ?? interfaces[0]
        if (iface === undefined) {
          this.report({ profileName: null, outcome: 'SKIPPED_NO_INTERFACE', reasonCode: null, detail: 'no Wi-Fi interface' })
          return
        }
        const name = candidates[this.attemptsThisOutage % candidates.length] as string
        this.attemptsThisOutage++
        let requested = false
        try {
          const result = await this.o.wlan.connect(name, iface.guid)
          requested = result.requested
          if (!requested) this.report({ profileName: name, outcome: 'REQUEST_FAILED', reasonCode: result.reasonCode, detail: result.detail })
        } catch (e) {
          this.report({ profileName: name, outcome: 'REQUEST_FAILED', reasonCode: null, detail: errText(e) })
        }
        if (!live()) return
        if (requested) {
          // Windows accepts the request at once and associates later; look every few seconds, so that a success is recorded
          // before the supervisor has confirmed the return of the network and closed the outage.
          let after: WlanInterfaceStatus[] = []
          for (let waited = 0; waited < this.verifyDelayMs && live(); ) {
            const step = Math.min(this.verifyPollMs, this.verifyDelayMs - waited)
            await this.sleep(step)
            waited += step
            if (!live()) return
            after = await this.safeStatus()
            if (after.some((i) => i.state === 'connected')) break
          }
          if (!live()) return
          const connected = after.find((i) => i.state === 'connected')
          if (connected !== undefined) {
            const same = connected.profileName === name
            this.report({ profileName: name, outcome: same ? 'CONNECTED' : 'NOT_CONNECTED', reasonCode: null, detail: same ? null : 'the interface connected through a different saved profile' })
            void this.o.supervisor.notifyNetworkChange()
            return
          }
          this.report({ profileName: name, outcome: 'NOT_CONNECTED', reasonCode: after.map((i) => i.lastReasonCode).find((c) => c !== null) ?? null, detail: null })
        }
        if (this.attemptsThisOutage >= this.o.policy().maxAttempts) continue
        await this.sleep(this.delay(this.o.policy()))
      }
    } finally {
      if (live()) this.active = false
    }
  }

  private delay(policy: NetworkRecoveryPolicy): number {
    return backoffDelay(Math.max(0, this.attemptsThisOutage - 1), policy.backoffInitialMs, policy.backoffMaxMs, this.random)
  }

  private async safeStatus(): Promise<WlanInterfaceStatus[]> {
    try {
      return await this.o.wlan.status()
    } catch {
      return []
    }
  }

  private respectsUser(interfaces: WlanInterfaceStatus[]): boolean {
    if (this.userDisconnect !== null) return true
    return interfaces.some((i) => disconnectInitiator(i.lastReasonCode) === 'USER')
  }

  /** The names that may be asked for, in the order they are tried: primary, then approved backups; saved, secured, once each. */
  private candidates(policy: NetworkRecoveryPolicy, saved: SavedProfile[]): string[] {
    const wanted = [policy.primaryProfile ?? this.captured, ...policy.approvedBackupProfiles]
    const out: string[] = []
    for (const name of wanted) {
      if (name === null || out.includes(name) || !isPlausibleProfileName(name)) continue
      const entry = saved.find((p) => p.name === name)
      // Not saved: never named. Open or unknown security: never named, even if it is on the approved list.
      if (entry === undefined || entry.security !== 'secured') continue
      out.push(name)
    }
    return out
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
