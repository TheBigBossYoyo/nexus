import type { Confidence, Measured, UsageSource } from '@shared/v3'

/** Pure presentation rules for provenance. Shared by SourceLabel, MeasuredValue and the unit tests. */

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  EXACT: 'Exact',
  OBSERVED: 'Observed',
  ESTIMATED: 'Estimated',
  UNKNOWN: 'Unknown',
}

const SOURCE_TEXT: Record<UsageSource, string> = {
  RUNTIME: 'reported by the Claude runtime',
  SDK_EVENT: 'reported by a Claude SDK event',
  ERROR_METADATA: 'read from a Claude error response',
  LOCAL_AGGREGATION: 'counted by NEXUS from its own sessions',
  UNKNOWN: 'not reported',
}

/** One-sentence explanation for the tooltip of a SourceLabel. */
export function sourceExplanation(confidence: Confidence, source: UsageSource = 'UNKNOWN'): string {
  switch (confidence) {
    case 'EXACT':
      return `Exact: ${SOURCE_TEXT[source]}. NEXUS did not calculate or guess this value.`
    case 'OBSERVED':
      return `Observed: ${SOURCE_TEXT[source]}. It covers only what NEXUS itself saw, not the whole account.`
    case 'ESTIMATED':
      return 'Estimated: derived by NEXUS from other values. Treat it as approximate.'
    case 'UNKNOWN':
      return 'Unknown: the Claude runtime did not report this, so NEXUS does not show a value.'
  }
}

/** A percentage or progress bar may be rendered only for an EXACT, non-null value. */
export function canShowPercent(m: Measured<unknown> | null | undefined): boolean {
  return !!m && m.confidence === 'EXACT' && typeof m.value === 'number' && Number.isFinite(m.value)
}

export type MeasuredView<T> =
  | {
      state: 'value'
      value: T
      confidence: Confidence
      source: UsageSource
      percent: number | null
    }
  | { state: 'unknown'; reason: string }

const DEFAULT_REASON = 'Not reported by Claude'

/** Resolves a Measured to what may be displayed. `wantPercent` is honoured only when canShowPercent allows it. */
export function describeMeasured<T>(
  m: Measured<T> | null | undefined,
  opts: { wantPercent?: boolean; reason?: string } = {},
): MeasuredView<T> {
  if (!m || m.value === null || m.value === undefined || m.confidence === 'UNKNOWN') {
    return { state: 'unknown', reason: opts.reason ?? DEFAULT_REASON }
  }
  const percent = opts.wantPercent && canShowPercent(m) ? (m.value as unknown as number) : null
  if (opts.wantPercent && percent === null) {
    // A percentage was asked for but the value is not EXACT: it is shown as unknown, never as a number.
    return { state: 'unknown', reason: opts.reason ?? DEFAULT_REASON }
  }
  return { state: 'value', value: m.value, confidence: m.confidence, source: m.source, percent }
}
