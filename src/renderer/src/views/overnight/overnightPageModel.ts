import type { OvernightStatus } from '@shared/overnight'
import { bannerModel, failsafeArmed, type BannerModel } from '../run/overnightModel'
import { formatWallClock } from '../projects/overnight'

export interface QuotaLine {
  key: 'paused' | 'reset' | 'resume' | 'deadline' | 'failsafe'
  text: string
}

/** The quota-wait explanation. Only values that exist are listed; nothing is inferred. */
export function quotaLines(status: OvernightStatus, now: number): QuotaLine[] {
  if (status.state !== 'QUOTA_PAUSED') return []
  const lines: QuotaLine[] = [{ key: 'paused', text: 'Mission paused for Claude usage limit' }]
  const q = status.quota
  if (q?.resetsAt)
    lines.push({ key: 'reset', text: `Expected reset ${formatWallClock(q.resetsAt, now)}` })
  if (q?.resumeAt)
    lines.push({
      key: 'resume',
      text: `Expected automatic resume ${formatWallClock(q.resumeAt, now)}`,
    })
  lines.push({
    key: 'deadline',
    text: `Overnight hard deadline ${formatWallClock(status.deadlineAt, now)}`,
  })
  const f = status.failsafe
  if (f && failsafeArmed(status))
    lines.push({
      key: 'failsafe',
      text: `PC failsafe shutdown ${formatWallClock(f.deadline, now)}`,
    })
  return lines
}

export interface OvernightPageModel {
  banner: BannerModel
  quota: QuotaLine[]
  /** The unattended mission is still working or waiting (the run itself is not finished). */
  working: boolean
  /** Short sentence under the state. */
  summary: string
}

export function overnightPageModel(status: OvernightStatus, now: number): OvernightPageModel {
  const banner = bannerModel(status, now)
  const working =
    status.state === 'RUNNING' || status.state === 'QUOTA_PAUSED' || status.state === 'ARMING'
  const summary =
    status.state === 'QUOTA_PAUSED'
      ? 'Waiting for Claude to be available again. No work has been lost.'
      : status.state === 'RUNNING'
        ? 'The mission is running unattended. Tool approvals are denied while nobody is there.'
        : (banner.detail ?? 'See the state below.')
  return { banner, quota: quotaLines(status, now), working, summary }
}
