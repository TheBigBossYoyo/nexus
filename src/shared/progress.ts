/**
 * 0.9: progress and time remaining of a long piece of work, from what the runtime knows: the task graph, what
 * has finished, how long such tasks took before, what is waiting and on what. No model is asked for a number.
 */

export const PROGRESS_CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'] as const
export type ProgressConfidence = (typeof PROGRESS_CONFIDENCE)[number]

/** What the work is doing about time: going on, or waiting on something outside it. */
export const PROGRESS_WAITS = ['ACTIVE', 'WAITING_FOR_NETWORK', 'WAITING_FOR_PROVIDER', 'WAITING_FOR_USER_BOUNDARY', 'WAITING_FOR_USER', 'WAITING_FOR_EXTERNAL_PROCESS', 'FINISHED'] as const
export type ProgressWait = (typeof PROGRESS_WAITS)[number]

export interface EtaEstimate {
  /** Seconds of active work that remain, low and high end. Null when nothing can be said. */
  lowSeconds: number | null
  highSeconds: number | null
  /** As a person reads it: "12–18 min", "1h20–2h". */
  text: string
  confidence: ProgressConfidence
  /** Why the range is as wide as it is, when that is worth saying. */
  uncertainty: string | null
}

export interface ProgressMilestone {
  at: string
  text: string
}

export interface ProgressSnapshot {
  subject: { kind: 'run' | 'program' | 'workspace'; id: string }
  at: string
  /** 0 to 100, by expected work and not by count of tasks. May go down when the known scope grows. */
  percent: number
  /** What is going on now, in a few words: "Implementing 2 of 5 tasks", "Verifying". */
  stage: string
  elapsedSeconds: number
  eta: EtaEstimate
  wait: ProgressWait
  /** One sentence that keeps active time apart from waiting: "24–35 min of active work remain. Waiting for the Internet; when it ends is not known." */
  summary: string
  tasks: { total: number; completed: number; running: number; waiting: number; failed: number; remaining: number }
  workers: { active: number; waiting: number }
  blocker: string | null
  /** Set when the known work grew since the last snapshot: "Scope expanded: 2 repairs were added." */
  scopeChange: string | null
  lastEvent: ProgressMilestone | null
  milestones: ProgressMilestone[]
  /** When the shown estimate is next refreshed if nothing happens before. */
  nextRefreshAt: string | null
}

/** How often a shown estimate is refreshed when nothing happens: five minutes unless set otherwise. */
export const DEFAULT_PROGRESS_REFRESH_SECONDS = 300
export const MIN_PROGRESS_REFRESH_SECONDS = 30
export const MAX_PROGRESS_REFRESH_SECONDS = 3600

/** A range of seconds as a person reads it. Ranges, never one number: the precision would be invented. */
export function formatEtaRange(lowSeconds: number, highSeconds: number): string {
  const low = Math.max(0, Math.min(lowSeconds, highSeconds))
  const high = Math.max(lowSeconds, highSeconds)
  if (high < 90) return 'under 2 min'
  const minutes = (seconds: number, up: boolean): number => {
    const m = seconds / 60
    // Rounded outwards to a step that fits the size: nobody is told "37–52 min" from evidence this coarse.
    const step = m < 20 ? 1 : m < 60 ? 5 : m < 180 ? 10 : 30
    return (up ? Math.ceil(m / step) : Math.floor(m / step)) * step
  }
  const one = (m: number): string => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`)
  const a = Math.max(1, minutes(low, false))
  const b = Math.max(a, minutes(high, true))
  if (a === b) return one(a)
  // "12–18 min", "35–55 min", "1h20–2h".
  return b < 60 ? `${a}–${b} min` : `${one(a).replace(' min', a < 60 ? ' min' : '')}–${one(b)}`
}

export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  if (m < 1) return 'under a minute'
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
