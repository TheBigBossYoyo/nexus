import type { OvernightState, OvernightStatus } from '@shared/overnight'
import type { Tone } from '../../lib/status'
import { END_ACTION_BANNER, formatWallClock } from '../projects/overnight'
import { endedText, failsafeRowValue, quotaDetail } from '../overnight/workloadModel'

/** Mirrors the failsafe check in the supervisor: a timer that is actually armed in Windows. */
export function failsafeArmed(status: Pick<OvernightStatus, 'failsafe'>): boolean {
  const f = status.failsafe
  return f !== null && f.result.ok && f.cancelledAt === null && f.lostAt === null
}

export function failsafeText(
  status: Pick<OvernightStatus, 'failsafe' | 'policy'>,
  now: number = Date.now(),
): string {
  const f = status.failsafe
  if (!f) return status.policy.failsafeEnabled ? 'not armed' : 'off'
  if (f.cancelledAt !== null) return 'cancelled'
  if (f.lostAt !== null) return 'lost (Windows restarted)'
  if (!f.result.ok) return 'not armed'
  return formatWallClock(f.deadline, now)
}

/** m:ss, or h:mm:ss from an hour up. Never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const ACTION_VERB = {
  SHUTDOWN: 'Shutting down',
  SLEEP: 'Sleeping',
  HIBERNATE: 'Hibernating',
} as const

/** Seconds-precision countdown label for a pending final power action, or null. */
export function powerCountdown(
  status: Pick<OvernightStatus, 'state' | 'powerAction'>,
  now: number,
): string | null {
  const p = status.powerAction
  if (
    status.state !== 'POWER_ACTION_SCHEDULED' ||
    !p ||
    p.executedAt !== null ||
    p.cancelledAt !== null
  )
    return null
  return `${ACTION_VERB[p.action]} in ${formatCountdown(Date.parse(p.executeAt) - now)}`
}

const STATE_TONE: Record<OvernightState, Tone> = {
  IDLE: 'neutral',
  ARMING: 'active',
  RUNNING: 'active',
  QUOTA_PAUSED: 'waiting',
  FINALIZING: 'active',
  POWER_ACTION_SCHEDULED: 'warning',
  DONE: 'success',
  CANCELLING: 'warning',
  FINALIZATION_FAILED: 'danger',
  POWER_ACTION_FAILED: 'danger',
}

export interface BannerModel {
  state: OvernightState
  tone: Tone
  /** Sentence next to the state name (quota wait, error, ...), or null. */
  detail: string | null
  failsafe: string
  deadline: string
  endAction: string
  countdown: string | null
  canCancelPower: boolean
  canChangeEndAction: boolean
  canExtend: boolean
  canCancelMission: boolean
  hasReport: boolean
  /** The run itself can be paused or resumed with the normal run controls. */
  live: boolean
}

export interface BannerEnablement {
  canCancelPower: boolean
  canChangeEndAction: boolean
  canExtend: boolean
  canCancelMission: boolean
}

/** Which actions the supervisor accepts in which state. */
export function bannerEnablement(
  status: Pick<OvernightStatus, 'state' | 'powerAction' | 'failsafe' | 'policy'>,
): BannerEnablement {
  const working = status.state === 'RUNNING' || status.state === 'QUOTA_PAUSED'
  const pending =
    status.state === 'POWER_ACTION_SCHEDULED' &&
    status.powerAction !== null &&
    status.powerAction.executedAt === null &&
    status.powerAction.cancelledAt === null
  const failed = status.state === 'FINALIZATION_FAILED' || status.state === 'POWER_ACTION_FAILED'
  return {
    canCancelPower:
      (working && (status.policy.endAction !== 'NONE' || failsafeArmed(status))) ||
      pending ||
      (failed && failsafeArmed(status)),
    canChangeEndAction: working,
    canExtend: working,
    canCancelMission: working,
  }
}

export function bannerModel(status: OvernightStatus, now: number = Date.now()): BannerModel {
  let detail: string | null = null
  switch (status.state) {
    case 'QUOTA_PAUSED': {
      detail = quotaDetail(status, now)
      break
    }
    case 'FINALIZING':
      detail = 'writing the final report and checkpoint'
      break
    case 'POWER_ACTION_SCHEDULED':
      detail = endedText(status)
      break
    case 'DONE':
      detail = endedText(status)
      break
    case 'FINALIZATION_FAILED':
    case 'POWER_ACTION_FAILED':
      detail = status.error ?? 'failed'
      break
    default:
      break
  }
  const enable = bannerEnablement(status)
  return {
    state: status.state,
    tone: STATE_TONE[status.state],
    detail,
    failsafe: failsafeRowValue(status, now),
    deadline: formatWallClock(status.deadlineAt, now),
    endAction: END_ACTION_BANNER[status.policy.endAction],
    countdown: powerCountdown(status, now),
    ...enable,
    hasReport: status.hasReport,
    live: status.state === 'RUNNING' || status.state === 'QUOTA_PAUSED',
  }
}

/** Overnight runs that still own the PC's power state, for the global indicator. */
export function activeIndicatorText(active: readonly OvernightStatus[]): string | null {
  if (active.length === 0) return null
  const first = active[0] as OvernightStatus
  return `OVERNIGHT ${first.state.replace(/_/g, ' ')}`
}
