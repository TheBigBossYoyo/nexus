import {
  LIVE_QUOTA_PAUSE_STATES,
  usageStatusLabel,
  type UsageOverview,
  type UsageStatus,
} from '@shared/v3'
import type { Tone } from './status'

/**
 * Pure text models for the Claude usage surfaces (header indicator, popover, quota banner).
 * Every sentence is derived from timestamps and the status the service reported; nothing is guessed.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM in local time, with a day hint when the moment is not today. '—' for anything unparsable. */
export function clockText(iso: string | null | undefined, now: number): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const t = new Date(now)
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) /
      86_400_000,
  )
  if (dayDiff === 0) return clock
  if (dayDiff === 1) return `${clock} tomorrow`
  if (dayDiff === -1) return `${clock} yesterday`
  return `${clock} (${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())})`
}

/** "42m", "1h 05m", "<1m". Null when the moment is unknown or not in the future. */
export function untilText(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t) || t <= now) return null
  const minutes = Math.ceil((t - now) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return m === 0 ? `${h}h` : `${h}h ${pad(m)}m`
}

const BLOCKED: readonly UsageStatus[] = ['QUOTA_PAUSED', 'WAITING_FOR_RESET', 'PROBING']

/** The reset time, only when the runtime reported it (EXACT). */
export function exactResetAt(o: UsageOverview): string | null {
  const m = o.nextResetAt
  if (m.confidence === 'EXACT' && m.value) return m.value
  const p = o.autoResume.pause
  if (p && p.resetConfidence === 'EXACT' && p.resetAt) return p.resetAt
  return null
}

export type IndicatorIcon = 'dot' | 'clock' | 'pause' | 'alert' | 'key' | 'unknown'

export interface UsageIndicatorModel {
  /** Text after "Claude", e.g. "Available" or "Resets 42m". */
  label: string
  /** A second, smaller phrase for tooltips, e.g. "Paused · Usage limit". */
  detail: string | null
  tone: Tone
  icon: IndicatorIcon
  status: UsageStatus | 'LOADING' | 'UNKNOWN'
}

/** State of the header and sidebar indicator. `failed` is a rejected usage.overview call (service not wired, bridge error). */
export function usageIndicator(
  overview: UsageOverview | null | undefined,
  now: number,
  failed = false,
): UsageIndicatorModel {
  if (!overview) {
    return failed
      ? {
          label: 'Status unknown',
          detail: 'Usage status is not available yet.',
          tone: 'neutral',
          icon: 'unknown',
          status: 'UNKNOWN',
        }
      : {
          label: 'Checking availability',
          detail: null,
          tone: 'neutral',
          icon: 'dot',
          status: 'LOADING',
        }
  }
  const status = overview.status
  const label = usageStatusLabel(status)
  switch (status) {
    case 'AVAILABLE':
      return { label, detail: null, tone: 'success', icon: 'dot', status }
    case 'LIMIT_APPROACHING':
      return {
        label,
        detail: 'The runtime reports the limit is close.',
        tone: 'warning',
        icon: 'alert',
        status,
      }
    case 'THROTTLED':
      return {
        label,
        detail: 'The runtime is slowing requests down.',
        tone: 'warning',
        icon: 'alert',
        status,
      }
    case 'PROBING':
      return {
        label,
        detail: 'NEXUS is checking whether Claude is available again.',
        tone: 'waiting',
        icon: 'clock',
        status,
      }
    case 'QUOTA_PAUSED':
    case 'WAITING_FOR_RESET': {
      // A countdown is shown only for a reset time the runtime reported.
      const until = untilText(exactResetAt(overview), now)
      return until
        ? { label: `Resets ${until}`, detail: label, tone: 'waiting', icon: 'clock', status }
        : { label, detail: null, tone: 'waiting', icon: 'pause', status }
    }
    case 'AUTH_REQUIRED':
      return {
        label,
        detail: 'Sign in to Claude to continue.',
        tone: 'danger',
        icon: 'key',
        status,
      }
    case 'RUNTIME_UNAVAILABLE':
      return {
        label,
        detail: 'The Claude runtime did not respond.',
        tone: 'danger',
        icon: 'alert',
        status,
      }
  }
}

export interface QuotaSegment {
  text: string
  /** Marks the time inside the sentence so the UI (and tests) can find it. */
  mark?: 'resume-at' | 'reset'
}

export interface QuotaBannerModel {
  headline: string
  /** "Automatic resume: 03:43 (reset 03:42)" and its variants. */
  resumeLine: string
  /** The same sentence in pieces; the times carry a `mark`. */
  resumeSegments: QuotaSegment[]
  /** Live countdown to the next check or resume, derived from the timestamp. */
  countdown: string | null
  checking: boolean
  resumeAtText: string | null
  resetText: string | null
  pausedRuns: number
}

export function quotaWaitActive(o: UsageOverview | null | undefined): boolean {
  if (!o) return false
  const pause = o.autoResume.pause
  const live = !!pause && LIVE_QUOTA_PAUSE_STATES.includes(pause.state)
  return live || BLOCKED.includes(o.status)
}

/** Null when there is no quota wait to announce. */
export function quotaBanner(
  o: UsageOverview | null | undefined,
  now: number,
): QuotaBannerModel | null {
  if (!o || !quotaWaitActive(o)) return null
  const n = o.autoResume.pausedRuns
  const headline =
    n > 0
      ? `Claude usage limit reached — NEXUS has safely paused ${n} run${n === 1 ? '' : 's'}.`
      : 'Claude usage limit reached — NEXUS is holding new Claude work.'
  const reset = exactResetAt(o)
  const nextCheck = o.autoResume.nextCheckAt.value ?? o.autoResume.pause?.nextCheckAt ?? null
  const checking = o.status === 'PROBING' || o.autoResume.pause?.state === 'probing'
  const at = nextCheck ? clockText(nextCheck, now) : null
  const resetClock = reset ? clockText(reset, now) : null
  let resumeSegments: QuotaSegment[]
  if (checking) resumeSegments = [{ text: 'Checking availability…' }]
  else if (!o.autoResume.enabled)
    resumeSegments = [
      {
        text: 'Automatic resume is off. Resume the paused runs yourself when Claude is available.',
      },
    ]
  else if (resetClock && at)
    resumeSegments = [
      { text: 'Automatic resume: ' },
      { text: at, mark: 'resume-at' },
      { text: ' (reset ' },
      { text: resetClock, mark: 'reset' },
      { text: ')' },
    ]
  else if (resetClock)
    resumeSegments = [
      { text: 'Automatic resume after the reset at ' },
      { text: resetClock, mark: 'reset' },
    ]
  else if (at)
    resumeSegments = [
      { text: 'Reset time not reported by Claude; next availability check ' },
      { text: at, mark: 'resume-at' },
    ]
  else
    resumeSegments = [
      {
        text: 'Reset time not reported by Claude; the next availability check is not scheduled yet.',
      },
    ]
  const resumeLine = resumeSegments.map((x) => x.text).join('')
  return {
    headline,
    resumeLine,
    resumeSegments,
    countdown: checking || !o.autoResume.enabled ? null : untilText(nextCheck ?? reset, now),
    checking,
    resumeAtText: nextCheck ? clockText(nextCheck, now) : null,
    resetText: reset ? clockText(reset, now) : null,
    pausedRuns: n,
  }
}

export interface PopoverRow {
  label: string
  value: string
  /** Provenance label to show next to the value; absent when the value is plain text. */
  confidence?: 'EXACT' | 'OBSERVED' | 'ESTIMATED' | 'UNKNOWN'
  muted?: boolean
}

/** Rows of the usage popover that are plain text. Observed totals are formatted by the component. */
export function popoverRows(
  o: UsageOverview,
  now: number,
): { auth: PopoverRow[]; resume: PopoverRow[]; limit: PopoverRow[] } {
  const account = o.accountMode.value
  const sub = o.subscriptionType.value
  const reset = exactResetAt(o)
  const nextCheck = o.autoResume.nextCheckAt.value
  return {
    auth: [
      {
        label: 'Account',
        value: account ?? 'Not reported',
        ...(account ? { confidence: o.accountMode.confidence } : { muted: true }),
      },
      {
        label: 'Subscription',
        value: sub ?? 'Not reported',
        ...(sub ? { confidence: o.subscriptionType.confidence } : { muted: true }),
      },
    ],
    limit: [
      {
        label: 'Last limit',
        value: o.lastLimitAt ? clockText(o.lastLimitAt, now) : 'None this session',
        muted: !o.lastLimitAt,
      },
      {
        label: 'Next known reset',
        value: reset ? clockText(reset, now) : 'Unknown',
        ...(reset ? { confidence: 'EXACT' as const } : { muted: true }),
      },
    ],
    resume: [
      { label: 'Automatic resume', value: o.autoResume.enabled ? 'On' : 'Off' },
      {
        label: 'Next check',
        value: nextCheck ? clockText(nextCheck, now) : 'None planned',
        ...(nextCheck ? { confidence: o.autoResume.nextCheckAt.confidence } : { muted: true }),
      },
    ],
  }
}
