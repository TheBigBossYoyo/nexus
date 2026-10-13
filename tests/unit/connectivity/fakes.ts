import type { ProbeResult } from '@shared/connectivity'
import type { RawProbes } from '@main/modules/connectivity/classifier'
import type { Timers } from '@main/modules/connectivity/timers'

/** Time by hand: nothing here waits. `advance` runs every timer that falls due, in order, and lets the promises they start settle. */
export class FakeClock implements Timers {
  private time: number
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()

  constructor(start = 1_000_000) {
    this.time = start
  }

  now(): number {
    return this.time
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.time + ms, fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  get pending(): number {
    return this.timers.size
  }

  /** The delay until the next timer, or null. */
  get nextIn(): number | null {
    const ats = [...this.timers.values()].map((t) => t.at)
    return ats.length === 0 ? null : Math.min(...ats) - this.time
  }

  async flush(): Promise<void> {
    for (let i = 0; i < 80; i++) await Promise.resolve()
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    await this.flush()
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (due === undefined) break
      this.timers.delete(due[0])
      this.time = Math.max(this.time, due[1].at)
      due[1].fn()
      await this.flush()
    }
    this.time = target
    await this.flush()
  }
}

export const ok = (target: string): ProbeResult => ({ target, ok: true, code: null, ms: 20 })
export const bad = (target: string, code = 'ETIMEDOUT'): ProbeResult => ({ target, ok: false, code, ms: 4000 })

export const GUID = '11111111-2222-3333-4444-555555555555'

/** Probes of a healthy machine on Wi-Fi; a test overrides what it wants to break. */
export function raw(over: Partial<RawProbes> = {}, at = 0): RawProbes {
  return {
    at,
    wlan: [{ guid: GUID, state: 'connected', profileName: 'Home', lastReasonCode: null }],
    wiredLinkUp: false,
    dns: ok('www.cloudflare.com'),
    endpoints: [ok('www.cloudflare.com'), ok('www.google.com')],
    addresses: [ok('1.1.1.1'), ok('8.8.8.8')],
    providers: { 'api.provider.test': ok('api.provider.test') },
    quota: null,
    ...over,
  }
}

export const wlanDown = (over: Partial<RawProbes> = {}): RawProbes =>
  raw({
    wlan: [{ guid: GUID, state: 'disconnected', profileName: null, lastReasonCode: null }],
    dns: bad('www.cloudflare.com', 'ENETUNREACH'),
    endpoints: [bad('a', 'ENETUNREACH'), bad('b', 'ENETUNREACH')],
    addresses: [bad('1.1.1.1', 'ENETUNREACH'), bad('8.8.8.8', 'ENETUNREACH')],
    providers: { 'api.provider.test': bad('api.provider.test', 'ENETUNREACH') },
    ...over,
  })
