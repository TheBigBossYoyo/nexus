import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunEvent } from '@shared/events'
import { api } from '../../lib/bridge'
import { useActivity, useRuns } from '../../lib/queries'
import { TONE_CLASSES } from '../../lib/status'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../store/ui'
import {
  Button,
  EmptyState,
  ErrorNote,
  PageHeader,
  Skeleton,
  StatusDot,
  ActivityIcon,
} from '../../components/ui'
import { describeEvent, eventTone } from '../run/eventText'
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABEL,
  activityCategory,
  activityTime,
  filterActivity,
  mergeFeed,
  olderCursor,
  type ActivityFilter,
} from './activityModel'

const ROW_HEIGHT = 30
const OVERSCAN = 10
const PAGE = 100

/** Cross-run event feed. The newest page stays live through push invalidation; older pages load on request. */
export function ActivityView() {
  const latest = useActivity({ limit: PAGE })
  const runs = useRuns(null)
  const openRun = useUiStore((s) => s.openRun)
  const [older, setOlder] = useState<RunEvent[]>([])
  const [exhausted, setExhausted] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<unknown>(null)
  const [filter, setFilter] = useState<ActivityFilter>('all')

  const all = useMemo(() => mergeFeed(latest.data ?? [], older), [latest.data, older])
  const events = useMemo(() => filterActivity(all, filter), [all, filter])
  const labels = useMemo(() => new Map((runs.data ?? []).map((r) => [r.id, r.prompt])), [runs.data])
  const projectOf = useMemo(
    () => new Map((runs.data ?? []).map((r) => [r.id, r.projectId])),
    [runs.data],
  )

  const loadOlder = async () => {
    const cursor = olderCursor(all)
    if (cursor === null) return
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await api.invoke('activity.recent', { limit: PAGE, beforeSeq: cursor })
      setOlder((prev) => mergeFeed(prev, page))
      if (page.length < PAGE) setExhausted(true)
    } catch (e) {
      setOlderError(e)
    } finally {
      setLoadingOlder(false)
    }
  }

  // Windowing: fixed-height rows keep thousands of events cheap.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(480)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [latest.isPending])
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(events.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const now = Date.now()

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="activity-view">
      <PageHeader title="Activity" context="System" />
      <div
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-surface px-5 py-2"
        role="group"
        aria-label="Filter by category"
      >
        {(['all', ...ACTIVITY_CATEGORIES] as const).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={filter === c}
            data-testid={`activity-filter-${c}`}
            onClick={() => setFilter(c)}
            className={cn(
              'h-6 rounded-md border px-2 text-small font-medium transition-colors',
              filter === c
                ? 'border-accent/40 bg-accent-subtle text-accent'
                : 'border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary',
            )}
          >
            {c === 'all' ? 'All' : ACTIVITY_CATEGORY_LABEL[c]}
          </button>
        ))}
        <span className="tnum ml-auto text-small text-text-muted" data-testid="activity-count">
          {events.length} event{events.length === 1 ? '' : 's'}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="@container min-h-0 flex-1 overflow-auto bg-surface"
        data-testid="activity-scroll"
      >
        {latest.isPending ? (
          <div className="flex flex-col gap-2 p-5" aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : latest.isError && all.length === 0 ? (
          <div className="p-5">
            <ErrorNote error={latest.error} />
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            icon={<ActivityIcon size={20} />}
            title={all.length === 0 ? 'No activity yet' : 'Nothing in this category'}
          >
            {all.length === 0
              ? 'Events from every mission appear here as they happen.'
              : 'Choose another category, or show all activity.'}
          </EmptyState>
        ) : (
          <>
            <div
              style={{ height: events.length * ROW_HEIGHT, position: 'relative' }}
              role="list"
              aria-label="Recent activity"
            >
              {events.slice(first, last).map((e, i) => {
                const tone = eventTone(e)
                const label = labels.get(e.runId)
                return (
                  <button
                    key={e.seq}
                    type="button"
                    role="listitem"
                    data-testid="activity-row"
                    data-type={e.type}
                    onClick={() => openRun(e.runId, projectOf.get(e.runId))}
                    title={describeEvent(e)}
                    style={{
                      position: 'absolute',
                      top: (first + i) * ROW_HEIGHT,
                      height: ROW_HEIGHT,
                      left: 0,
                      right: 0,
                    }}
                    className="flex items-center gap-3 whitespace-nowrap border-b border-transparent px-5 text-left transition-colors hover:bg-surface-muted"
                  >
                    <span className="tnum w-24 shrink-0 font-mono text-code text-text-muted">
                      {activityTime(e.createdAt, now)}
                    </span>
                    <StatusDot tone={tone} />
                    <span className="w-28 shrink-0 truncate text-small text-text-muted">
                      {ACTIVITY_CATEGORY_LABEL[activityCategory(e.type)]}
                    </span>
                    <span
                      className="hidden w-48 shrink-0 truncate text-small text-text-secondary @min-[900px]:inline"
                      title={label}
                    >
                      {label ?? 'Mission'}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        tone === 'danger' && TONE_CLASSES.danger.text,
                      )}
                    >
                      {describeEvent(e)}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="flex items-center justify-center gap-3 border-t py-3">
              {olderError ? (
                <span className="text-small text-danger">Could not load older events.</span>
              ) : null}
              {exhausted ? (
                <span className="text-small text-text-muted">
                  That is the beginning of the history.
                </span>
              ) : (
                <Button
                  size="sm"
                  loading={loadingOlder}
                  onClick={() => void loadOlder()}
                  data-testid="activity-load-older"
                >
                  Load older
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
