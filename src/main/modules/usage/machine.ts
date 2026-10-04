import {
  DISPATCH_BLOCKED_STATUSES,
  type Availability,
  type UsageStatus,
} from '@shared/v3'
import type { UsageSettings } from '@shared/v3'
import { APPROACHING_PERCENT, type UsageSignal } from './classify'

/**
 * The status machine of the usage service. Pure and total: every (state, event) pair returns a state, and
 * nothing here reads a clock, a database or the runtime. See docs/V0_3_DESIGN.md "Status machine".
 */

export interface UsageMachineState {
  status: UsageStatus
  /** Epoch ms the status was entered. */
  since: number
  availability: Availability
  limitType: string | null
  /** Known reset (epoch ms), from the runtime. Null = unknown. */
  resetAt: number | null
  /** A percentage the runtime supplied (0-100). Never derived from tokens. */
  utilizationPercent: number | null
  retryAfterMs: number | null
  lastLimitAt: number | null
  /** When the account last became available again after a wait (the ramp-up starts here). */
  resumedAt: number | null
}

export type UsageMachineEvent =
  | { type: 'signal'; signal: UsageSignal }
  /** The runtime's no-prompt usage report (percentages are runtime-supplied). */
  | { type: 'report'; windows: { limitType: string; utilizationPercent: number | null; resetsAt: string | null }[] }
  /** A session ended successfully: the account works. */
  | { type: 'session_ok' }
  /** A quota pause row was written (the run is checkpointed). */
  | { type: 'quota_checkpointed' }
  /** Startup: an open wait was found in the database. */
  | { type: 'restore_wait'; resetAt: number | null; limitType: string | null }
  | { type: 'probe_started' }
  | { type: 'probe_result'; outcome: 'available' | 'limited' | 'auth' | 'runtime'; resetAt: number | null }
  /** The wait was given up (deadline, user). The account is optimistically treated as available. */
  | { type: 'wait_ended' }
  /** An account check succeeded. */
  | { type: 'account_ok' }
  | { type: 'tick'; hasLiveWait: boolean }

export const THROTTLE_DECAY_MS = 120_000
/** A QUOTA_PAUSED status that no controller picked up (no run paused) falls back after this long. */
export const ORPHAN_QUOTA_MS = 30_000
/** One new session at a time for this long after a resume. */
export const RAMP_MS = 60_000

export function initialUsageState(now: number): UsageMachineState {
  return {
    status: 'AVAILABLE',
    since: now,
    availability: 'AVAILABLE',
    limitType: null,
    resetAt: null,
    utilizationPercent: null,
    retryAfterMs: null,
    lastLimitAt: null,
    resumedAt: null,
  }
}

export const isDispatchBlocked = (status: UsageStatus): boolean => DISPATCH_BLOCKED_STATUSES.includes(status)

const waiting = (s: UsageMachineState): boolean => s.status === 'WAITING_FOR_RESET' || s.status === 'PROBING'

function enter(s: UsageMachineState, status: UsageStatus, now: number, patch: Partial<UsageMachineState> = {}): UsageMachineState {
  const availability: Availability =
    status === 'AVAILABLE' || status === 'LIMIT_APPROACHING'
      ? 'AVAILABLE'
      : status === 'THROTTLED'
        ? 'THROTTLED'
        : status === 'AUTH_REQUIRED'
          ? 'AUTH_REQUIRED'
          : status === 'RUNTIME_UNAVAILABLE'
            ? 'RUNTIME_UNAVAILABLE'
            : 'QUOTA_EXHAUSTED'
  return { ...s, ...patch, status, availability, since: s.status === status ? s.since : now }
}

const parseIso = (iso: string | null): number | null => {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function onSignal(s: UsageMachineState, signal: UsageSignal, now: number): UsageMachineState {
  const resetMs = parseIso(signal.resetAt)
  // Only a documented percentage counts; a 'raw' utilization is kept for audit elsewhere, never here.
  const percent = signal.utilizationUnit === 'percent' ? signal.utilization : null
  if (signal.eventType === 'usage_report') return s // handled through the 'report' event

  // During a wait only a probe (or the end of the wait) changes the status. A newer reset time is still learned.
  if (waiting(s)) {
    if (signal.availability === 'QUOTA_EXHAUSTED' && resetMs !== null) return { ...s, resetAt: resetMs, limitType: signal.limitType ?? s.limitType }
    return s
  }

  switch (signal.availability) {
    case 'QUOTA_EXHAUSTED': {
      // The SDK reports one limit twice: a rate_limit_event with the reset, then an assistant error with none.
      // A later signal without a reset never erases a known one (nor the limit type) of the same pause.
      const same = s.status === 'QUOTA_PAUSED'
      return enter(s, 'QUOTA_PAUSED', now, {
        limitType: signal.limitType ?? (same ? s.limitType : null),
        resetAt: resetMs ?? (same ? s.resetAt : null),
        retryAfterMs: signal.retryAfterMs ?? (same ? s.retryAfterMs : null),
        lastLimitAt: now,
        ...(percent !== null ? { utilizationPercent: percent } : {}),
      })
    }
    case 'THROTTLED':
      if (s.status === 'AVAILABLE' || s.status === 'LIMIT_APPROACHING') {
        return enter(s, 'THROTTLED', now, { retryAfterMs: signal.retryAfterMs })
      }
      return s
    case 'AUTH_REQUIRED':
      return s.status === 'QUOTA_PAUSED' ? s : enter(s, 'AUTH_REQUIRED', now)
    case 'RUNTIME_UNAVAILABLE':
      return s.status === 'QUOTA_PAUSED' || s.status === 'AUTH_REQUIRED' ? s : enter(s, 'RUNTIME_UNAVAILABLE', now)
    case 'AVAILABLE': {
      const keep = {
        limitType: signal.limitType ?? s.limitType,
        ...(percent !== null ? { utilizationPercent: percent } : {}),
        ...(resetMs !== null ? { resetAt: resetMs } : {}),
      }
      // Approaching: only a runtime allowed_warning, or a runtime percentage at or above the threshold.
      const approaching = signal.eventType === 'limit_warning' || (percent !== null && percent >= APPROACHING_PERCENT)
      if (s.status === 'QUOTA_PAUSED') return s
      if (approaching) return enter(s, 'LIMIT_APPROACHING', now, keep)
      if (s.status === 'LIMIT_APPROACHING' || s.status === 'THROTTLED' || s.status === 'AUTH_REQUIRED' || s.status === 'RUNTIME_UNAVAILABLE') {
        return enter(s, 'AVAILABLE', now, { ...keep, retryAfterMs: null })
      }
      return { ...s, ...keep }
    }
    case 'UNKNOWN':
      return s
  }
}

function onReport(
  s: UsageMachineState,
  windows: { limitType: string; utilizationPercent: number | null; resetsAt: string | null }[],
  now: number,
): UsageMachineState {
  let top: { limitType: string; percent: number; resetAt: number | null } | null = null
  for (const w of windows) {
    if (w.utilizationPercent === null) continue
    if (!top || w.utilizationPercent > top.percent) top = { limitType: w.limitType, percent: w.utilizationPercent, resetAt: parseIso(w.resetsAt) }
  }
  if (!top) return s
  const patch: Partial<UsageMachineState> = { utilizationPercent: top.percent, limitType: top.limitType }
  if (s.status === 'AVAILABLE' || s.status === 'LIMIT_APPROACHING') {
    // A report can say "100%" with no session having failed; it still only warns (nothing is paused here).
    if (top.percent >= APPROACHING_PERCENT) return enter(s, 'LIMIT_APPROACHING', now, { ...patch, resetAt: top.resetAt })
    if (s.status === 'LIMIT_APPROACHING') return enter(s, 'AVAILABLE', now, { ...patch, resetAt: null })
  }
  return { ...s, utilizationPercent: top.percent }
}

/** The transition function. Total: unknown combinations return the state unchanged. */
export function reduceUsage(state: UsageMachineState, event: UsageMachineEvent, now: number): UsageMachineState {
  switch (event.type) {
    case 'signal':
      return onSignal(state, event.signal, now)
    case 'report':
      return onReport(state, event.windows, now)
    case 'session_ok':
      if (state.status === 'THROTTLED' || state.status === 'AUTH_REQUIRED' || state.status === 'RUNTIME_UNAVAILABLE') {
        return enter(state, 'AVAILABLE', now, { retryAfterMs: null })
      }
      return state
    case 'quota_checkpointed':
      if (state.status === 'PROBING' || state.status === 'WAITING_FOR_RESET') return state
      return enter(state, 'WAITING_FOR_RESET', now)
    case 'restore_wait':
      return enter(state, 'WAITING_FOR_RESET', now, { resetAt: event.resetAt, limitType: event.limitType ?? state.limitType })
    case 'probe_started':
      if (state.status === 'WAITING_FOR_RESET' || state.status === 'AUTH_REQUIRED' || state.status === 'RUNTIME_UNAVAILABLE') {
        return enter(state, 'PROBING', now)
      }
      return state
    case 'probe_result': {
      if (state.status !== 'PROBING' && state.status !== 'WAITING_FOR_RESET') return state
      if (event.outcome === 'available') {
        return enter(state, 'AVAILABLE', now, { resetAt: null, retryAfterMs: null, resumedAt: now, utilizationPercent: state.utilizationPercent })
      }
      if (event.outcome === 'auth') return enter(state, 'AUTH_REQUIRED', now)
      if (event.outcome === 'runtime') return enter(state, 'RUNTIME_UNAVAILABLE', now)
      return enter(state, 'WAITING_FOR_RESET', now, { resetAt: event.resetAt ?? state.resetAt })
    }
    case 'wait_ended':
      if (!waiting(state) && state.status !== 'QUOTA_PAUSED' && state.status !== 'AUTH_REQUIRED' && state.status !== 'RUNTIME_UNAVAILABLE') return state
      return enter(state, 'AVAILABLE', now, { resetAt: null, retryAfterMs: null })
    case 'account_ok':
      if (state.status === 'AUTH_REQUIRED' || state.status === 'RUNTIME_UNAVAILABLE') return enter(state, 'AVAILABLE', now)
      return state
    case 'tick': {
      if (state.status === 'THROTTLED' && now - state.since >= THROTTLE_DECAY_MS) return enter(state, 'AVAILABLE', now, { retryAfterMs: null })
      if (state.status === 'LIMIT_APPROACHING' && state.resetAt !== null && now >= state.resetAt) {
        return enter(state, 'AVAILABLE', now, { resetAt: null, utilizationPercent: null })
      }
      // A closed status nobody owns (no quota row, no overnight wait) must not stay closed: self-heal.
      if ((state.status === 'QUOTA_PAUSED' || state.status === 'WAITING_FOR_RESET' || state.status === 'PROBING') && !event.hasLiveWait && now - state.since >= ORPHAN_QUOTA_MS) {
        return enter(state, 'AVAILABLE', now, { resetAt: null })
      }
      return state
    }
  }
}

// ───────────────────────────── waiting plan ─────────────────────────────

export interface QuotaWaitInput {
  now: number
  /** Known reset (epoch ms) or null. */
  resetAt: number | null
  /** Probes already made for this wait. */
  probes: number
  settings: UsageSettings
  /** Mission deadline (epoch ms) for Overnight runs, else null. */
  deadline: number | null
  pausedAt: number
}

export type QuotaWaitPlan =
  | { action: 'wait'; checkAt: number; basis: 'reset' | 'backoff' }
  | { action: 'end'; why: string }

/** Interval (minutes) before probe number `index` (0-based) when no reset time is usable: base, doubling, capped. */
export function backoffMinutes(index: number, settings: Pick<UsageSettings, 'unknownResetProbeMinutes' | 'unknownResetProbeMaxMinutes'>): number {
  const base = settings.unknownResetProbeMinutes
  const cap = Math.max(base, settings.unknownResetProbeMaxMinutes)
  return Math.min(cap, base * 2 ** Math.max(0, Math.min(index, 20)))
}

/**
 * When to look at the account next. Known reset: shortly after it. Unknown, or a reset that already
 * passed without the probe finding capacity: a bounded exponential backoff. Ends when the next check
 * would fall at or after the mission deadline, or past the configured maximum wait.
 */
export function planQuotaWait(input: QuotaWaitInput): QuotaWaitPlan {
  const { now, resetAt, probes, settings, deadline, pausedAt } = input
  let checkAt: number
  let basis: 'reset' | 'backoff'
  if (resetAt !== null && (resetAt > now || probes === 0)) {
    checkAt = Math.max(resetAt, now) + settings.resumeDelaySeconds * 1000
    basis = 'reset'
  } else {
    // Unknown reset: probe n waits base * 2^n. A passed reset whose probe failed continues the same schedule.
    const index = resetAt === null ? probes : Math.max(0, probes - 1)
    checkAt = now + backoffMinutes(index, settings) * 60_000
    basis = 'backoff'
  }
  if (deadline !== null && checkAt >= deadline) {
    return { action: 'end', why: basis === 'reset' ? 'The usage limit resets after the mission deadline.' : 'The next availability check would fall after the mission deadline.' }
  }
  if (settings.maxQuotaWaitMinutes > 0 && checkAt - pausedAt > settings.maxQuotaWaitMinutes * 60_000) {
    return { action: 'end', why: `The usage limit wait would exceed the configured maximum of ${settings.maxQuotaWaitMinutes} minutes.` }
  }
  return { action: 'wait', checkAt, basis }
}

/** New sessions allowed in parallel `sinceResumeMs` after a resume: one for the first minute, then the normal limit. */
export function rampLimit(sinceResumeMs: number, normalLimit: number): number {
  if (sinceResumeMs < RAMP_MS) return Math.min(1, normalLimit)
  return normalLimit
}

