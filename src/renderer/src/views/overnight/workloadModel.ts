import type { OvernightStatus } from '@shared/overnight'
import {
  CONDITION_KEYS,
  CONDITION_LABEL,
  END_ACTION_LABEL,
  formatWallClock,
} from '../projects/overnight'

/**
 * Overnight records supervise either a mission (runId is a run id) or an Arena campaign (runId is the campaign
 * id, projectId is 'arena'). Everything that words or routes an overnight record goes through here so a
 * campaign id is never treated as a run id.
 */
type Workload = Pick<OvernightStatus, 'workloadType'>

export type WorkloadNoun = 'mission' | 'campaign'

export const isArenaWorkload = (s: Workload): boolean => s.workloadType === 'arena_campaign'

export const workloadNoun = (s: Workload): WorkloadNoun =>
  isArenaWorkload(s) ? 'campaign' : 'mission'

/** "Arena campaign" or "Mission": the label in front of the workload name. */
export const workloadKind = (s: Workload): string =>
  isArenaWorkload(s) ? 'Arena campaign' : 'Mission'

export const QUOTA_NO_RESET_TEXT = 'Waiting for the usage limit; reset time not reported'

/** True when the record carries a reset or resume time to show. Nothing is inferred when it does not. */
export function hasQuotaTime(status: Pick<OvernightStatus, 'quota'>): boolean {
  return !!(status.quota?.resumeAt ?? status.quota?.resetsAt)
}

/** The sentence next to a QUOTA_PAUSED state, or null for other states. */
export function quotaDetail(status: OvernightStatus, now: number): string | null {
  if (status.state !== 'QUOTA_PAUSED') return null
  const resume = status.quota?.resumeAt ?? status.quota?.resetsAt ?? null
  if (resume) return `waiting for the usage limit, resumes ${formatWallClock(resume, now)}`
  return isArenaWorkload(status) ? QUOTA_NO_RESET_TEXT : 'waiting for the usage limit'
}

export interface CancelCopy {
  title: string
  confirmLabel: string
  body: string
}

export function cancelCopy(noun: WorkloadNoun): CancelCopy {
  return noun === 'campaign'
    ? {
        title: 'Cancel this campaign?',
        confirmLabel: 'Cancel campaign',
        body: 'Running trials stop and queued trials do not run. Finished trials are kept. The end action runs only if cancellation is one of the conditions you selected.',
      }
    : {
        title: 'Cancel this mission?',
        confirmLabel: 'Cancel mission',
        body: 'Agents are stopped and the run ends. The end action runs only if cancellation is one of the conditions you selected.',
      }
}

export const deadlineLabel = (noun: WorkloadNoun): string =>
  noun === 'campaign' ? 'Campaign deadline' : 'Mission deadline'

/** The unattended-mode sentence under the state badge. */
export const runningSummary = (noun: WorkloadNoun): string =>
  `The ${noun} is running unattended. Tool approvals are denied while nobody is there.`

/** The configured end action and the conditions it applies to, e.g. "Shut down PC on success, failure". */
export function endActionSummary(policy: OvernightStatus['policy']): string {
  if (policy.endAction === 'NONE') return 'None: no power action is taken'
  const on = CONDITION_KEYS.filter((k) => policy.shutdownOn[k]).map((k) =>
    CONDITION_LABEL[k].toLowerCase(),
  )
  return on.length === 0
    ? `${END_ACTION_LABEL[policy.endAction]}, but no condition applies`
    : `${END_ACTION_LABEL[policy.endAction]} on ${on.join(', ')}`
}

/** A finished record: nothing left to cancel or extend. */
export const overnightFinished = (state: OvernightStatus['state']): boolean =>
  state === 'DONE' || state === 'FINALIZATION_FAILED' || state === 'POWER_ACTION_FAILED'
