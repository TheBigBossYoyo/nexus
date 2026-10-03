import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Agent, Task } from '@shared/domain'
import type { RunDetail } from '@shared/ipc'
import type { RunEvent } from '@shared/events'
import { useEvents } from '../../lib/queries'
import { mergeEvents } from './eventText'

export type StageView = 'overview' | 'graph' | 'plan'

export const BOTTOM_TABS = [
  'timeline',
  'communications',
  'tools',
  'diff',
  'reviews',
  'verification',
  'decisions',
  'criteria',
] as const
export type BottomTab = (typeof BOTTOM_TABS)[number]

export interface RunCtx {
  detail: RunDetail
  events: readonly RunEvent[]
  tasksById: ReadonlyMap<string, Task>
  agentsById: ReadonlyMap<string, Agent>
  /** Switch the central stage (overview panel or graph). */
  showStage: (view: StageView) => void
  /** Open one of the run-level tabs below the graph. */
  showBottom: (tab: BottomTab) => void
}

const Ctx = createContext<RunCtx | null>(null)

export function RunProvider({
  detail,
  events,
  showStage,
  showBottom,
  children,
}: {
  detail: RunDetail
  events: readonly RunEvent[]
  showStage: (view: StageView) => void
  showBottom: (tab: BottomTab) => void
  children: ReactNode
}) {
  const value = useMemo<RunCtx>(
    () => ({
      detail,
      events,
      tasksById: new Map(detail.tasks.map((t) => [t.id, t])),
      agentsById: new Map(detail.agents.map((a) => [a.id, a])),
      showStage,
      showBottom,
    }),
    [detail, events, showStage, showBottom],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRunCtx(): RunCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRunCtx outside RunProvider')
  return v
}

const PAGE = 1000

/**
 * The run's full durable event list, loaded incrementally with afterSeq. The cursor advances as pages arrive;
 * push invalidation refetches the tail query, so new events append without re-reading history.
 */
export function useEventStream(runId: string): { events: RunEvent[]; loading: boolean; error: unknown } {
  const [events, setEvents] = useState<RunEvent[]>([])
  const [cursor, setCursor] = useState(0)
  const query = useEvents(runId, { afterSeq: cursor, limit: PAGE })
  const page = query.data

  useEffect(() => {
    if (!page || page.length === 0) return
    setEvents((prev) => mergeEvents(prev, page))
    const max = page.reduce((m, e) => Math.max(m, e.seq), 0)
    setCursor((c) => Math.max(c, max))
  }, [page])

  return { events, loading: query.isPending && events.length === 0, error: query.error }
}

/** Ticks while `active`, so live durations stay current without refetching. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
  return now
}

/** The most recently created agent that worked on a task. */
export function latestAgentOf(agents: readonly Agent[], taskId: string): Agent | null {
  let best: Agent | null = null
  for (const a of agents) {
    if (a.taskId !== taskId) continue
    if (!best || a.createdAt >= best.createdAt) best = a
  }
  return best
}

export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function clockTimeSeconds(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return `${clockTime(iso)}:${String(d.getSeconds()).padStart(2, '0')}`
}
