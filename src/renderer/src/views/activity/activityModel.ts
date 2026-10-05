import type { EventType, RunEvent } from '@shared/events'

/** Pure model of the cross-run Activity feed. */

export const ACTIVITY_CATEGORIES = [
  'missions',
  'tasks',
  'agents',
  'git',
  'quality',
  'approvals',
  'overnight',
  'usage',
  'strategy',
] as const
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]

export const ACTIVITY_CATEGORY_LABEL: Record<ActivityCategory, string> = {
  missions: 'Missions',
  tasks: 'Tasks',
  agents: 'Agents',
  git: 'Git',
  quality: 'Reviews and checks',
  approvals: 'Approvals',
  overnight: 'Overnight',
  usage: 'Usage',
  strategy: 'Strategy',
}

export function activityCategory(type: EventType): ActivityCategory {
  const family = type.split('.')[0]
  switch (family) {
    case 'task':
      return 'tasks'
    case 'agent':
    case 'message':
      return 'agents'
    case 'git':
      return 'git'
    case 'review':
    case 'verification':
    case 'checks':
      return 'quality'
    case 'approval':
      return 'approvals'
    case 'overnight':
    case 'checkpoint':
      return 'overnight'
    case 'usage':
      return 'usage'
    case 'strategy':
    case 'policy':
    case 'speculative':
    case 'outcome':
    case 'routing':
      return 'strategy'
    default:
      return 'missions'
  }
}

export type ActivityFilter = 'all' | ActivityCategory

export function filterActivity(events: readonly RunEvent[], filter: ActivityFilter): RunEvent[] {
  return filter === 'all' ? [...events] : events.filter((e) => activityCategory(e.type) === filter)
}

/** Newest first, no duplicate seq. Pages (live first page and older pages) merge in any order. */
export function mergeFeed(...pages: readonly (readonly RunEvent[])[]): RunEvent[] {
  const bySeq = new Map<number, RunEvent>()
  for (const page of pages) for (const e of page) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq)
}

/** `beforeSeq` for the next older page: the smallest seq seen. Null when nothing was loaded. */
export function olderCursor(events: readonly RunEvent[]): number | null {
  if (events.length === 0) return null
  return events.reduce((min, e) => Math.min(min, e.seq), Number.MAX_SAFE_INTEGER)
}

/** "14:03:22", with the date in front when it is not today. */
export function activityTime(iso: string, now: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const t = new Date(now)
  const same =
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  return same ? clock : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${clock}`
}
