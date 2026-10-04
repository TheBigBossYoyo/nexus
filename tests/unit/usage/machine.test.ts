import { describe, expect, it } from 'vitest'
import { DEFAULT_USAGE_SETTINGS, USAGE_STATUSES, type UsageSettings } from '@shared/v3'
import {
  classifyUsageSignal,
  initialUsageState,
  isDispatchBlocked,
  planQuotaWait,
  rampLimit,
  reduceUsage,
  type UsageMachineEvent,
  type UsageMachineState,
  type UsageSignal,
} from '@main/modules/usage'

const T0 = Date.UTC(2026, 9, 4, 22, 0, 0)
const MIN = 60_000

const rateLimit = (status: 'allowed' | 'allowed_warning' | 'rejected', extra: { resetsAt?: number | null; utilization?: number | null } = {}): UsageSignal =>
  classifyUsageSignal({ kind: 'rate_limit', status, resetsAt: extra.resetsAt ?? null, limitType: 'five_hour', utilization: extra.utilization ?? null }, T0) as UsageSignal

const sig = (signal: UsageSignal | null): UsageMachineEvent => ({ type: 'signal', signal: signal as UsageSignal })

function run(events: UsageMachineEvent[], start: UsageMachineState = initialUsageState(T0), at = T0): UsageMachineState {
  let s = start
  for (const e of events) s = reduceUsage(s, e, at)
  return s
}

const quotaPaused = (resetAt: number | null = null) =>
  run([sig(rateLimit('rejected', { resetsAt: resetAt === null ? null : Math.floor(resetAt / 1000) }))])
const waiting = (resetAt: number | null = null) => run([{ type: 'quota_checkpointed' }], quotaPaused(resetAt))
const probing = () => run([{ type: 'probe_started' }], waiting())

describe('usage machine: transitions', () => {
  it('starts AVAILABLE', () => {
    expect(initialUsageState(T0)).toMatchObject({ status: 'AVAILABLE', availability: 'AVAILABLE', resetAt: null, utilizationPercent: null })
  })

  it('AVAILABLE -allowed_warning-> LIMIT_APPROACHING -allowed-> AVAILABLE', () => {
    const warned = run([sig(rateLimit('allowed_warning'))])
    expect(warned.status).toBe('LIMIT_APPROACHING')
    expect(isDispatchBlocked(warned.status)).toBe(false)
    expect(run([sig(rateLimit('allowed'))], warned).status).toBe('AVAILABLE')
  })

  it('AVAILABLE -transient throttle-> THROTTLED -next success-> AVAILABLE; it never blocks dispatch', () => {
    const t = run([sig(classifyUsageSignal({ kind: 'assistant_error', error: 'overloaded' }, T0))])
    expect(t.status).toBe('THROTTLED')
    expect(isDispatchBlocked(t.status)).toBe(false)
    expect(run([{ type: 'session_ok' }], t).status).toBe('AVAILABLE')
  })

  it('THROTTLED decays on its own after two minutes without another throttle', () => {
    const t = run([sig(classifyUsageSignal({ kind: 'assistant_error', error: 'server_error' }, T0))])
    expect(reduceUsage(t, { type: 'tick', hasLiveWait: false }, T0 + MIN).status).toBe('THROTTLED')
    expect(reduceUsage(t, { type: 'tick', hasLiveWait: false }, T0 + 2 * MIN).status).toBe('AVAILABLE')
  })

  it('AVAILABLE -rejected-> QUOTA_PAUSED (reset kept) -checkpoint-> WAITING_FOR_RESET', () => {
    const reset = T0 + 60 * MIN
    const q = quotaPaused(reset)
    expect(q).toMatchObject({ status: 'QUOTA_PAUSED', availability: 'QUOTA_EXHAUSTED', resetAt: reset, limitType: 'five_hour', lastLimitAt: T0 })
    expect(isDispatchBlocked(q.status)).toBe(true)
    expect(run([{ type: 'quota_checkpointed' }], q).status).toBe('WAITING_FOR_RESET')
  })

  it('a billing/rate_limit assistant error also pauses, with an unknown reset', () => {
    const q = run([sig(classifyUsageSignal({ kind: 'assistant_error', error: 'billing_error' }, T0))])
    expect(q).toMatchObject({ status: 'QUOTA_PAUSED', resetAt: null })
  })

  it('WAITING_FOR_RESET -probe_started-> PROBING -available-> AVAILABLE with a ramp start', () => {
    const p = probing()
    expect(p.status).toBe('PROBING')
    const ok = reduceUsage(p, { type: 'probe_result', outcome: 'available', resetAt: null }, T0 + 5 * MIN)
    expect(ok).toMatchObject({ status: 'AVAILABLE', resetAt: null, resumedAt: T0 + 5 * MIN })
  })

  it('PROBING -still limited-> WAITING_FOR_RESET, learning a newer reset', () => {
    const later = T0 + 120 * MIN
    const w = reduceUsage(probing(), { type: 'probe_result', outcome: 'limited', resetAt: later }, T0)
    expect(w).toMatchObject({ status: 'WAITING_FOR_RESET', resetAt: later })
    expect(reduceUsage(probing(), { type: 'probe_result', outcome: 'limited', resetAt: null }, T0).status).toBe('WAITING_FOR_RESET')
  })

  it('a probe that finds an auth or runtime failure enters AUTH_REQUIRED / RUNTIME_UNAVAILABLE', () => {
    expect(reduceUsage(probing(), { type: 'probe_result', outcome: 'auth', resetAt: null }, T0).status).toBe('AUTH_REQUIRED')
    expect(reduceUsage(probing(), { type: 'probe_result', outcome: 'runtime', resetAt: null }, T0).status).toBe('RUNTIME_UNAVAILABLE')
  })

  it('AUTH_REQUIRED and RUNTIME_UNAVAILABLE are entered from errors and left on a successful account check', () => {
    const auth = run([sig(classifyUsageSignal({ kind: 'assistant_error', error: 'authentication_failed' }, T0))])
    expect(auth.status).toBe('AUTH_REQUIRED')
    expect(isDispatchBlocked(auth.status)).toBe(true)
    expect(run([{ type: 'account_ok' }], auth).status).toBe('AVAILABLE')
    const down = run([sig(classifyUsageSignal({ kind: 'turn_outcome', outcome: 'crashed' }, T0))])
    expect(down.status).toBe('RUNTIME_UNAVAILABLE')
    expect(run([{ type: 'account_ok' }], down).status).toBe('AVAILABLE')
    expect(run([{ type: 'session_ok' }], down).status).toBe('AVAILABLE')
  })

  it('an auth error does not mask a quota pause, and a runtime error does not mask auth', () => {
    const q = quotaPaused()
    expect(run([sig(classifyUsageSignal({ kind: 'assistant_error', error: 'authentication_failed' }, T0))], q).status).toBe('QUOTA_PAUSED')
    const auth = run([sig(classifyUsageSignal({ kind: 'turn_outcome', outcome: 'auth' }, T0))])
    expect(run([sig(classifyUsageSignal({ kind: 'turn_outcome', outcome: 'crashed' }, T0))], auth).status).toBe('AUTH_REQUIRED')
  })

  it('during a wait only a probe changes the status: allowed signals and successes are ignored', () => {
    for (const s of [waiting(), probing()]) {
      expect(run([sig(rateLimit('allowed')), { type: 'session_ok' }, { type: 'account_ok' }, sig(rateLimit('allowed_warning'))], s).status).toBe(s.status)
    }
  })

  it('a rejection during a wait only teaches a newer reset time', () => {
    const w = run([sig(rateLimit('rejected', { resetsAt: Math.floor((T0 + 10 * MIN) / 1000) }))], waiting())
    expect(w).toMatchObject({ status: 'WAITING_FOR_RESET', resetAt: T0 + 10 * MIN })
  })

  it('wait_ended opens the gate again (the runs stay paused for the person)', () => {
    for (const s of [quotaPaused(), waiting(), probing()]) expect(reduceUsage(s, { type: 'wait_ended' }, T0).status).toBe('AVAILABLE')
  })

  it('restore_wait (startup) enters WAITING_FOR_RESET with the stored reset', () => {
    const s = run([{ type: 'restore_wait', resetAt: T0 + 5 * MIN, limitType: 'seven_day' }])
    expect(s).toMatchObject({ status: 'WAITING_FOR_RESET', resetAt: T0 + 5 * MIN, limitType: 'seven_day' })
  })

  it('quota_checkpointed without a prior signal (a planning pause) also waits; PROBING is not disturbed', () => {
    expect(run([{ type: 'quota_checkpointed' }]).status).toBe('WAITING_FOR_RESET')
    expect(run([{ type: 'quota_checkpointed' }], probing()).status).toBe('PROBING')
  })

  it('a QUOTA_PAUSED status nobody picked up falls back after 30 s (no run paused)', () => {
    const q = quotaPaused()
    expect(reduceUsage(q, { type: 'tick', hasLiveWait: false }, T0 + 29_000).status).toBe('QUOTA_PAUSED')
    expect(reduceUsage(q, { type: 'tick', hasLiveWait: false }, T0 + 30_000).status).toBe('AVAILABLE')
    expect(reduceUsage(q, { type: 'tick', hasLiveWait: true }, T0 + 5 * MIN).status).toBe('QUOTA_PAUSED')
  })

  it('probe results outside a wait are ignored', () => {
    expect(run([{ type: 'probe_result', outcome: 'available', resetAt: null }]).status).toBe('AVAILABLE')
    expect(run([{ type: 'probe_started' }]).status).toBe('AVAILABLE')
  })

  it('is total: every (status, event) pair returns a valid status', () => {
    const states: UsageMachineState[] = [
      initialUsageState(T0),
      run([sig(rateLimit('allowed_warning'))]),
      run([sig(classifyUsageSignal({ kind: 'assistant_error', error: 'overloaded' }, T0))]),
      quotaPaused(),
      waiting(),
      probing(),
      run([sig(classifyUsageSignal({ kind: 'assistant_error', error: 'authentication_failed' }, T0))]),
      run([sig(classifyUsageSignal({ kind: 'turn_outcome', outcome: 'crashed' }, T0))]),
    ]
    const events: UsageMachineEvent[] = [
      sig(rateLimit('allowed')),
      sig(rateLimit('allowed_warning')),
      sig(rateLimit('rejected')),
      sig(classifyUsageSignal({ kind: 'assistant_error', error: 'overloaded' }, T0)),
      sig(classifyUsageSignal({ kind: 'assistant_error', error: 'authentication_failed' }, T0)),
      sig(classifyUsageSignal({ kind: 'turn_outcome', outcome: 'crashed' }, T0)),
      { type: 'report', windows: [{ limitType: 'five_hour', utilizationPercent: 95, resetsAt: null }] },
      { type: 'report', windows: [] },
      { type: 'session_ok' },
      { type: 'quota_checkpointed' },
      { type: 'restore_wait', resetAt: null, limitType: null },
      { type: 'probe_started' },
      { type: 'probe_result', outcome: 'available', resetAt: null },
      { type: 'probe_result', outcome: 'limited', resetAt: null },
      { type: 'probe_result', outcome: 'auth', resetAt: null },
      { type: 'probe_result', outcome: 'runtime', resetAt: null },
      { type: 'wait_ended' },
      { type: 'account_ok' },
      { type: 'tick', hasLiveWait: true },
      { type: 'tick', hasLiveWait: false },
    ]
    for (const s of states) {
      for (const e of events) {
        const next = reduceUsage(s, e, T0 + MIN)
        expect(USAGE_STATUSES).toContain(next.status)
      }
    }
  })
})

describe('usage machine: LIMIT_APPROACHING only from runtime figures', () => {
  it('never from observed token counts: nothing in the event vocabulary carries them', () => {
    // A session with enormous token use produces no machine event at all; only a runtime signal can warn.
    const s = run([{ type: 'session_ok' }, { type: 'tick', hasLiveWait: false }, { type: 'session_ok' }])
    expect(s.status).toBe('AVAILABLE')
  })

  it('a raw (undocumented-unit) utilization never causes it, however large', () => {
    const s = run([sig(rateLimit('allowed', { utilization: 99 })), sig(rateLimit('allowed', { utilization: 0.99 }))])
    expect(s.status).toBe('AVAILABLE')
    expect(s.utilizationPercent).toBeNull()
  })

  it('a runtime allowed_warning causes it', () => {
    expect(run([sig(rateLimit('allowed_warning'))]).status).toBe('LIMIT_APPROACHING')
  })

  it('a runtime percentage at or above 90 causes it, below does not', () => {
    const report = (p: number): UsageMachineEvent => ({ type: 'report', windows: [{ limitType: 'five_hour', utilizationPercent: p, resetsAt: null }] })
    expect(run([report(89.9)]).status).toBe('AVAILABLE')
    expect(run([report(90)]).status).toBe('LIMIT_APPROACHING')
    expect(run([report(100)]).status).toBe('LIMIT_APPROACHING') // a report alone never pauses anything
    expect(run([report(50)], run([report(95)])).status).toBe('AVAILABLE')
    expect(run([report(95)]).utilizationPercent).toBe(95)
  })

  it('a report without percentages changes nothing', () => {
    expect(run([{ type: 'report', windows: [{ limitType: 'five_hour', utilizationPercent: null, resetsAt: null }] }]).utilizationPercent).toBeNull()
  })

  it('a usage_report signal of the classifier is routed through the report event, not the signal path', () => {
    const s = classifyUsageSignal({ kind: 'usage_report', report: { rateLimitsAvailable: true, subscriptionType: null, windows: [{ limitType: 'five_hour', utilizationPercent: 99, resetsAt: null }] } }, T0)
    expect(run([sig(s)]).status).toBe('AVAILABLE')
  })

  it('LIMIT_APPROACHING falls back once its reset time passes', () => {
    const s = run([{ type: 'report', windows: [{ limitType: 'five_hour', utilizationPercent: 95, resetsAt: new Date(T0 + 10 * MIN).toISOString() }] }])
    expect(reduceUsage(s, { type: 'tick', hasLiveWait: false }, T0 + 9 * MIN).status).toBe('LIMIT_APPROACHING')
    expect(reduceUsage(s, { type: 'tick', hasLiveWait: false }, T0 + 10 * MIN).status).toBe('AVAILABLE')
  })
})

describe('planQuotaWait', () => {
  const settings: UsageSettings = { ...DEFAULT_USAGE_SETTINGS }
  const plan = (over: Partial<Parameters<typeof planQuotaWait>[0]>) => planQuotaWait({ now: T0, resetAt: null, probes: 0, settings, deadline: null, pausedAt: T0, ...over })

  it('known reset: max(reset, now) + resumeDelay', () => {
    expect(plan({ resetAt: T0 + 30 * MIN })).toEqual({ action: 'wait', checkAt: T0 + 30 * MIN + 60_000, basis: 'reset' })
    // a reset already past: now + delay
    expect(plan({ resetAt: T0 - 5 * MIN })).toEqual({ action: 'wait', checkAt: T0 + 60_000, basis: 'reset' })
    expect(plan({ resetAt: T0 + 30 * MIN, settings: { ...settings, resumeDelaySeconds: 120 } })).toMatchObject({ checkAt: T0 + 32 * MIN })
  })

  it('unknown reset: 5, 10, 20, 30, 30 minutes', () => {
    const minutes = [0, 1, 2, 3, 4, 5, 9].map((probes) => {
      const p = plan({ probes })
      return p.action === 'wait' ? (p.checkAt - T0) / MIN : null
    })
    expect(minutes).toEqual([5, 10, 20, 30, 30, 30, 30])
    expect(plan({ probes: 0 })).toMatchObject({ basis: 'backoff' })
  })

  it('the base and maximum are configurable (and the maximum never undercuts the base)', () => {
    const s = { ...settings, unknownResetProbeMinutes: 10, unknownResetProbeMaxMinutes: 25 }
    expect([0, 1, 2, 3].map((probes) => ((plan({ probes, settings: s }) as { checkAt: number }).checkAt - T0) / MIN)).toEqual([10, 20, 25, 25])
    const odd = { ...settings, unknownResetProbeMinutes: 20, unknownResetProbeMaxMinutes: 5 }
    expect(((plan({ probes: 3, settings: odd }) as { checkAt: number }).checkAt - T0) / MIN).toBe(20)
  })

  it('after a failed probe, a known reset already in the past continues on the backoff schedule', () => {
    const minutes = [1, 2, 3, 4].map((probes) => ((plan({ resetAt: T0 - MIN, probes }) as { checkAt: number }).checkAt - T0) / MIN)
    expect(minutes).toEqual([5, 10, 20, 30])
    // a reset that moved into the future again is a reset-based wait
    expect(plan({ resetAt: T0 + 40 * MIN, probes: 2 })).toMatchObject({ basis: 'reset', checkAt: T0 + 41 * MIN })
  })

  it('ends when the next check would fall at or after the deadline', () => {
    expect(plan({ resetAt: T0 + 30 * MIN, deadline: T0 + 31 * MIN })).toMatchObject({ action: 'end' }) // exactly at the deadline
    expect(plan({ resetAt: T0 + 30 * MIN, deadline: T0 + 31 * MIN + 1 })).toMatchObject({ action: 'wait' })
    expect(plan({ resetAt: T0 + 3 * 60 * MIN, deadline: T0 + 60 * MIN })).toMatchObject({ action: 'end' })
    expect(plan({ probes: 0, deadline: T0 + 5 * MIN })).toMatchObject({ action: 'end' })
    expect(plan({ probes: 0, deadline: T0 + 5 * MIN + 1 })).toMatchObject({ action: 'wait' })
    expect(plan({ probes: 3, deadline: T0 + 30 * MIN })).toMatchObject({ action: 'end' })
  })

  it('unknown reset probes until the deadline, then ends', () => {
    const deadline = T0 + 60 * MIN
    let now = T0
    const checks: number[] = []
    for (let probes = 0; probes < 20; probes++) {
      const p = planQuotaWait({ now, resetAt: null, probes, settings, deadline, pausedAt: T0 })
      if (p.action === 'end') break
      checks.push((p.checkAt - T0) / MIN)
      now = p.checkAt
    }
    expect(checks).toEqual([5, 15, 35]) // the next would be 65 >= 60
    expect(checks.every((c) => T0 + c * MIN < deadline)).toBe(true)
  })

  it('maxQuotaWaitMinutes bounds the whole wait; 0 means no limit of its own', () => {
    const s = { ...settings, maxQuotaWaitMinutes: 60 }
    expect(plan({ resetAt: T0 + 90 * MIN, settings: s })).toMatchObject({ action: 'end' })
    expect(plan({ resetAt: T0 + 59 * MIN, settings: s })).toMatchObject({ action: 'wait' }) // 60 min exactly is allowed
    expect(plan({ resetAt: T0 + 59 * MIN + 1, settings: s })).toMatchObject({ action: 'end' })
    expect(plan({ resetAt: T0 + 90 * MIN, settings: { ...settings, maxQuotaWaitMinutes: 0 } })).toMatchObject({ action: 'wait' })
    // measured from the pause, not from now
    expect(plan({ now: T0 + 55 * MIN, pausedAt: T0, probes: 1, settings: s })).toMatchObject({ action: 'end' })
  })
})

describe('rampLimit', () => {
  it('one new session for the first 60 s after a resume, then the normal limit', () => {
    expect(rampLimit(0, 4)).toBe(1)
    expect(rampLimit(59_999, 4)).toBe(1)
    expect(rampLimit(60_000, 4)).toBe(4)
    expect(rampLimit(10 * MIN, 4)).toBe(4)
  })

  it('never raises a limit that is already below the ramp', () => {
    expect(rampLimit(0, 1)).toBe(1)
    expect(rampLimit(0, 0)).toBe(0)
  })
})
