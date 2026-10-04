import { normalizeEpochMs } from '@shared/overnight'
import type { Availability, Confidence, UsageEventType, UsageSource } from '@shared/v3'
import type { RuntimeUsageReport, TurnOutcome } from '../agent-runtime/types'

/**
 * What one runtime signal means for usage, with its provenance. Pure: no I/O, no clock beyond `now`.
 *
 * Units: `rate_limit_info.utilization` has no documented unit, so it is stored verbatim as 'raw' and never
 * shown as a percentage. The usage report documents 0-100, so only that is 'percent'.
 */
export interface UsageSignal {
  availability: Availability
  eventType: UsageEventType
  limitType: string | null
  utilization: number | null
  utilizationUnit: 'percent' | 'raw' | null
  /** ISO time the runtime gave for the window reset. */
  resetAt: string | null
  retryAfterMs: number | null
  source: UsageSource
  confidence: Confidence
  /** The runtime's own words (status, error kind), for audit. */
  rawClassification: string
}

/** Assistant error kinds the SDK reports (SDKAssistantMessageError), plus the synthetic throttle kinds. */
export type AssistantErrorKind =
  | 'authentication_failed'
  | 'oauth_org_not_allowed'
  | 'account_on_hold'
  | 'verification_required'
  | 'cloud_credential_error'
  | 'billing_error'
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'invalid_request'
  | 'model_not_found'
  | 'unknown'
  | 'max_output_tokens'

export type UsageSignalInput =
  | {
      kind: 'rate_limit'
      status: string
      /** Epoch seconds (the SDK) or milliseconds. */
      resetsAt: number | null
      limitType: string | null
      utilization?: number | null
      overageStatus?: string | null
      isUsingOverage?: boolean | null
      surpassedThreshold?: number | null
    }
  | { kind: 'assistant_error'; error: AssistantErrorKind }
  | { kind: 'turn_outcome'; outcome: TurnOutcome | 'crashed' }
  | { kind: 'usage_report'; report: RuntimeUsageReport }

const AUTH_KINDS: readonly string[] = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
]
const QUOTA_KINDS: readonly string[] = ['rate_limit', 'billing_error']
const THROTTLE_KINDS: readonly string[] = ['overloaded', 'server_error']

/** Window utilization at which a runtime percentage means "limited". */
export const REPORT_LIMITED_PERCENT = 100
/** Window utilization at which a runtime percentage means "approaching". */
export const APPROACHING_PERCENT = 90

const base = (over: Partial<UsageSignal> & Pick<UsageSignal, 'availability' | 'eventType' | 'rawClassification'>): UsageSignal => ({
  limitType: null,
  utilization: null,
  utilizationUnit: null,
  resetAt: null,
  retryAfterMs: null,
  source: 'UNKNOWN',
  confidence: 'UNKNOWN',
  ...over,
})

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

/** The window of a report that limits the account: the highest utilization, ties by latest reset. */
export function limitingWindow(report: RuntimeUsageReport): RuntimeUsageReport['windows'][number] | null {
  let best: RuntimeUsageReport['windows'][number] | null = null
  for (const w of report.windows) {
    if (w.utilizationPercent === null) continue
    if (!best || (best.utilizationPercent ?? 0) < w.utilizationPercent) best = w
  }
  return best
}

/**
 * Null means the input carries no usage meaning (a successful or ordinary-failed turn, an invalid
 * request, ...). Successful sessions are recorded as `session` rows by the service, not as signals.
 */
export function classifyUsageSignal(input: UsageSignalInput, now: number): UsageSignal | null {
  switch (input.kind) {
    case 'rate_limit': {
      const resetMs = normalizeEpochMs(input.resetsAt)
      const common = {
        limitType: input.limitType,
        utilization: input.utilization ?? null,
        utilizationUnit: input.utilization === null || input.utilization === undefined ? null : ('raw' as const),
        resetAt: isoOrNull(resetMs),
        retryAfterMs: resetMs !== null && resetMs > now ? resetMs - now : null,
        source: 'SDK_EVENT' as const,
        confidence: 'EXACT' as const,
        rawClassification: `rate_limit:${input.status}${input.isUsingOverage ? ':overage' : ''}`,
      }
      if (input.status === 'rejected') return base({ ...common, availability: 'QUOTA_EXHAUSTED', eventType: 'limit_rejected' })
      if (input.status === 'allowed_warning') return base({ ...common, availability: 'AVAILABLE', eventType: 'limit_warning' })
      if (input.status === 'allowed') return base({ ...common, availability: 'AVAILABLE', eventType: 'limit_allowed' })
      return null
    }
    case 'assistant_error': {
      const raw = `assistant_error:${input.error}`
      if (QUOTA_KINDS.includes(input.error)) {
        return base({ availability: 'QUOTA_EXHAUSTED', eventType: 'limit_rejected', source: 'ERROR_METADATA', confidence: 'EXACT', rawClassification: raw })
      }
      // Overload and server errors are transient and never a quota condition.
      if (THROTTLE_KINDS.includes(input.error)) {
        return base({ availability: 'THROTTLED', eventType: 'throttle', source: 'ERROR_METADATA', confidence: 'EXACT', rawClassification: raw })
      }
      if (AUTH_KINDS.includes(input.error)) {
        return base({ availability: 'AUTH_REQUIRED', eventType: 'auth', source: 'ERROR_METADATA', confidence: 'EXACT', rawClassification: raw })
      }
      return null
    }
    case 'turn_outcome': {
      const raw = `turn_outcome:${input.outcome}`
      if (input.outcome === 'quota') {
        return base({ availability: 'QUOTA_EXHAUSTED', eventType: 'limit_rejected', source: 'ERROR_METADATA', confidence: 'EXACT', rawClassification: raw })
      }
      if (input.outcome === 'auth') {
        return base({ availability: 'AUTH_REQUIRED', eventType: 'auth', source: 'ERROR_METADATA', confidence: 'EXACT', rawClassification: raw })
      }
      if (input.outcome === 'crashed') {
        // A crash says the process died, not why; NEXUS observed it, the runtime did not state it.
        return base({ availability: 'RUNTIME_UNAVAILABLE', eventType: 'runtime_error', source: 'LOCAL_AGGREGATION', confidence: 'OBSERVED', rawClassification: raw })
      }
      return null
    }
    case 'usage_report': {
      const w = limitingWindow(input.report)
      if (!w) return base({ availability: 'UNKNOWN', eventType: 'usage_report', source: 'RUNTIME', confidence: 'UNKNOWN', rawClassification: 'usage_report:no_percentage' })
      const percent = w.utilizationPercent as number
      const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN
      const limited = percent >= REPORT_LIMITED_PERCENT
      return base({
        availability: limited ? 'QUOTA_EXHAUSTED' : 'AVAILABLE',
        eventType: 'usage_report',
        limitType: w.limitType,
        utilization: percent,
        utilizationUnit: 'percent',
        resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
        retryAfterMs: limited && Number.isFinite(resetMs) && resetMs > now ? resetMs - now : null,
        source: 'RUNTIME',
        confidence: 'EXACT',
        rawClassification: `usage_report:${w.limitType}`,
      })
    }
  }
}
