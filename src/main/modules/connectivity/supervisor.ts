import { randomUUID } from 'node:crypto'
import { isNetworkOutageState, type ConnectivityEvidence, type ConnectivitySnapshot, type ConnectivityState, type NetworkOutage, type ReconnectAttempt } from '@shared/connectivity'
import { classifyConnectivity, type ClassifiedTransportError, type RawProbes } from './classifier'
import { diagnoseOutage } from './diagnosis'
import { InMemoryOutageStore, type OutageStore } from './outage-store'
import { backoffDelay, type ConnectivityLogger, type Timers } from './timers'
import type { WlanAdapter, WlanEvent } from './wlan'

export type ConnectivityEvent =
  /** Every published change of state. Always the first event of a change. */
  | { type: 'state'; snapshot: ConnectivitySnapshot; previous: ConnectivityState | null }
  /** The network went down. The record is open and gains facts until `restored`. */
  | { type: 'outage-started'; outage: NetworkOutage }
  /** The network is back. Emitted once per outage, with the closed record and the text made from it. */
  | { type: 'restored'; outage: NetworkOutage; diagnosis: string }

export interface ConnectivitySupervisorOptions {
  /** Runs every probe once (the Wi-Fi status, DNS, the two endpoints, the providers) and returns what they found. */
  probe: () => Promise<RawProbes>
  timers: Timers
  /** Hears Windows' connection notifications; without it the supervisor works from probes alone. */
  wlan?: Pick<WlanAdapter, 'subscribe'>
  store?: OutageStore
  logger?: ConnectivityLogger
  random?: () => number
  newId?: () => string
  /** Probe interval while the network is fine. Default 60 s. */
  quietIntervalMs?: number
  /** How long a changed state must hold, over probes that agree, before it is published. Default 5 s. */
  confirmMs?: number
  /** Re-probe delay while offline: starts here (default 5 s), doubles, stops at the cap. */
  backoffInitialMs?: number
  /** Default 5 min. */
  backoffMaxMs?: number
  /** Probes asked for by provider errors are at least this far apart. Default 5 s. */
  errorProbeMinGapMs?: number
}

/** Reason codes seen just before an outage was confirmed still belong to it. */
const REASON_LOOKBACK_MS = 60_000

/**
 * Owns the connectivity state machine. It probes on a quiet interval while the network is fine, at once when it
 * is told something changed (a Windows notification, a network-classified error from a provider), and on a
 * bounded, jittered backoff while the network is down. A change of state is published only after it has held
 * for a short confirmation, so a flapping link is not a series of outages; the one exception is a hard Wi-Fi
 * disconnect event while ONLINE, which is published as soon as the probe after it agrees. Each outage is
 * recorded with the facts it rests on and handed to the store; the text that explains it is made from those
 * facts alone (diagnosis.ts).
 */
export class ConnectivitySupervisor {
  private readonly o: Required<Pick<ConnectivitySupervisorOptions, 'quietIntervalMs' | 'confirmMs' | 'backoffInitialMs' | 'backoffMaxMs' | 'errorProbeMinGapMs'>> & ConnectivitySupervisorOptions
  private readonly store: OutageStore
  private readonly random: () => number
  private readonly listeners = new Set<(event: ConnectivityEvent) => void>()
  private published: ConnectivitySnapshot | null = null
  private candidate: { state: ConnectivityState; firstSeen: number; snapshot: ConnectivitySnapshot } | null = null
  private outage: NetworkOutage | null = null
  private timer: unknown = null
  private probing: Promise<void> | null = null
  private rerun = false
  private rerunHard = false
  private backoffAttempt = 0
  private lastErrorProbeAt = Number.NEGATIVE_INFINITY
  private recentReasons: Array<{ code: number; at: number }> = []
  private unsubscribeWlan: (() => void) | null = null
  private running = false

  constructor(options: ConnectivitySupervisorOptions) {
    // An option left undefined means the default, not "no value".
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as unknown as ConnectivitySupervisorOptions
    this.o = { quietIntervalMs: 60_000, confirmMs: 5_000, backoffInitialMs: 5_000, backoffMaxMs: 300_000, errorProbeMinGapMs: 5_000, ...given }
    this.store = options.store ?? new InMemoryOutageStore()
    this.random = options.random ?? Math.random
  }

  // ---- reading ---------------------------------------------------------------------------------------------------

  snapshot(): ConnectivitySnapshot | null {
    return this.published
  }

  /** The open outage, or null. */
  currentOutage(): NetworkOutage | null {
    return this.outage === null ? null : structuredClone(this.outage)
  }

  async recentOutages(limit = 20): Promise<NetworkOutage[]> {
    return await this.store.recent(limit)
  }

  diagnosis(outage: NetworkOutage): string {
    return diagnoseOutage(outage)
  }

  subscribe(listener: (event: ConnectivityEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---- life ------------------------------------------------------------------------------------------------------

  /** Starts listening and runs the first probe. Resolves when that probe has been judged. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.unsubscribeWlan = this.o.wlan?.subscribe((e) => this.onWlanEvent(e)) ?? null
    await this.runProbe(false)
  }

  stop(): void {
    this.running = false
    this.unsubscribeWlan?.()
    this.unsubscribeWlan = null
    this.clearTimer()
  }

  // ---- being told ------------------------------------------------------------------------------------------------

  /** Something about the network changed (an adapter came up, a route changed): probe now and start the backoff over. */
  notifyNetworkChange(): Promise<void> {
    this.backoffAttempt = 0
    return this.requestProbe(false)
  }

  /** A provider call failed in a way that looks like the network (classifyTransportError said NETWORK). Probes at once, at most once per gap. */
  notifyNetworkError(_error?: ClassifiedTransportError): Promise<void> {
    const now = this.o.timers.now()
    if (now - this.lastErrorProbeAt < this.o.errorProbeMinGapMs) return this.probing ?? Promise.resolve()
    this.lastErrorProbeAt = now
    return this.requestProbe(false)
  }

  /** For a "check now" action: probes and resolves when the answer has been judged. */
  probeNow(): Promise<void> {
    return this.requestProbe(false)
  }

  /** The recovery manager reports what it asked Windows to do, so that the outage record shows it. */
  recordReconnectAttempt(attempt: ReconnectAttempt): void {
    if (this.outage === null) return
    this.outage.attempts.push(attempt)
    if (attempt.reasonCode !== null && attempt.reasonCode !== 0) this.addReason(attempt.reasonCode)
    this.persist()
  }

  // ---- probing ---------------------------------------------------------------------------------------------------

  private onWlanEvent(event: WlanEvent): void {
    if (event.reasonCode !== null && (event.kind === 'disconnected' || event.kind === 'attempt_failed')) {
      this.recentReasons.push({ code: event.reasonCode, at: this.o.timers.now() })
      this.recentReasons = this.recentReasons.slice(-16)
      if (this.outage !== null) {
        this.addReason(event.reasonCode)
        this.persist()
      }
    }
    this.backoffAttempt = 0
    void this.requestProbe(event.kind === 'disconnected')
  }

  private requestProbe(hardDisconnect: boolean): Promise<void> {
    if (!this.running) return Promise.resolve()
    if (this.probing !== null) {
      // A probe in flight may have started before the change; one more runs after it.
      this.rerun = true
      this.rerunHard ||= hardDisconnect
      return this.probing
    }
    return this.runProbe(hardDisconnect)
  }

  private runProbe(hard: boolean): Promise<void> {
    this.clearTimer()
    const run = (async () => {
      let first = true
      while (first || this.rerun) {
        const wasHard = first ? hard : this.rerunHard
        this.rerun = false
        this.rerunHard = false
        first = false
        let raw: RawProbes | null = null
        try {
          raw = await this.o.probe()
        } catch (e) {
          this.o.logger?.(`connectivity probe failed to run: ${e instanceof Error ? e.message : String(e)}`)
        }
        if (!this.running) return
        if (raw !== null) this.apply(classifyConnectivity(raw), wasHard)
      }
    })().finally(() => {
      this.probing = null
      if (this.running) this.schedule()
    })
    this.probing = run
    return run
  }

  private clearTimer(): void {
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    this.clearTimer()
    const now = this.o.timers.now()
    let delay: number
    if (this.candidate !== null) delay = Math.max(1, this.o.confirmMs - (now - this.candidate.firstSeen))
    else if (this.published !== null && isNetworkOutageState(this.published.state)) delay = backoffDelay(this.backoffAttempt++, this.o.backoffInitialMs, this.o.backoffMaxMs, this.random)
    else delay = this.o.quietIntervalMs
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = null
      void this.requestProbe(false)
    }, delay)
  }

  // ---- judging ---------------------------------------------------------------------------------------------------

  private apply(snapshot: ConnectivitySnapshot, hard: boolean): void {
    const now = this.o.timers.now()
    const current = this.published
    if (current === null) {
      this.publish(snapshot)
      return
    }
    if (snapshot.state === current.state) {
      // Same state: the newest evidence replaces the old, the state keeps its own start.
      this.candidate = null
      this.published = { state: current.state, since: current.since, evidence: snapshot.evidence }
      return
    }
    if (hard && current.state === 'ONLINE' && isNetworkOutageState(snapshot.state)) {
      this.publish({ ...snapshot, since: now })
      return
    }
    if (this.candidate === null || this.candidate.state !== snapshot.state) this.candidate = { state: snapshot.state, firstSeen: now, snapshot }
    else this.candidate.snapshot = snapshot
    if (now - this.candidate.firstSeen >= this.o.confirmMs) this.publish({ ...snapshot, since: this.candidate.firstSeen })
  }

  private publish(snapshot: ConnectivitySnapshot): void {
    const previous = this.published?.state ?? null
    this.published = snapshot
    this.candidate = null
    this.backoffAttempt = 0
    let opened = false
    let closed: NetworkOutage | null = null
    if (isNetworkOutageState(snapshot.state)) {
      if (this.outage === null) {
        this.outage = this.openOutage(snapshot)
        opened = true
      } else {
        const last = this.outage.states[this.outage.states.length - 1]
        if (last?.state !== snapshot.state) this.outage.states.push({ state: snapshot.state, at: snapshot.since })
        if (snapshot.evidence.lastReasonCode !== null) this.addReason(snapshot.evidence.lastReasonCode)
      }
      this.persist()
    } else if (this.outage !== null) {
      this.outage.endedAt = snapshot.since
      this.outage.evidenceAtEnd = snapshot.evidence
      closed = this.outage
      this.persist()
      this.outage = null
    }
    this.emit({ type: 'state', snapshot, previous })
    if (opened && this.outage !== null) this.emit({ type: 'outage-started', outage: structuredClone(this.outage) })
    if (closed !== null) this.emit({ type: 'restored', outage: structuredClone(closed), diagnosis: diagnoseOutage(closed) })
  }

  private openOutage(snapshot: ConnectivitySnapshot): NetworkOutage {
    const evidence: ConnectivityEvidence = snapshot.evidence
    const codes = new Set<number>()
    if (evidence.lastReasonCode !== null) codes.add(evidence.lastReasonCode)
    for (const r of this.recentReasons) if (r.at >= snapshot.since - REASON_LOOKBACK_MS) codes.add(r.code)
    return {
      id: (this.o.newId ?? randomUUID)(),
      startedAt: snapshot.since,
      endedAt: null,
      states: [{ state: snapshot.state, at: snapshot.since }],
      attempts: [],
      reasonCodes: [...codes],
      evidenceAtStart: evidence,
      evidenceAtEnd: null,
    }
  }

  private addReason(code: number): void {
    if (this.outage !== null && !this.outage.reasonCodes.includes(code)) this.outage.reasonCodes.push(code)
  }

  private persist(): void {
    if (this.outage === null) return
    const copy = structuredClone(this.outage)
    try {
      const done = this.store.save(copy)
      if (done instanceof Promise) done.catch((e: unknown) => this.o.logger?.(`outage store failed: ${e instanceof Error ? e.message : String(e)}`))
    } catch (e) {
      this.o.logger?.(`outage store failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private emit(event: ConnectivityEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event)
      } catch (e) {
        this.o.logger?.(`connectivity listener threw: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
}
