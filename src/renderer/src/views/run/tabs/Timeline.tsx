import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Loading, StatusDot } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { TONE_CLASSES } from '../../../lib/status'
import { EVENT_CATEGORIES, describeEvent, eventCategory, eventTone, type EventCategory } from '../eventText'
import { clockTimeSeconds, useRunCtx } from '../runContext'
import { useStickyScroll } from '../useStickyScroll'

const ROW_HEIGHT = 22
const OVERSCAN = 12

/** Persistent chronological event view. Fixed-height rows are windowed, so thousands of events stay cheap. */
export function Timeline({ loading, error }: { loading: boolean; error: unknown }) {
  const { events, tasksById, agentsById } = useRunCtx()
  const [active, setActive] = useState<ReadonlySet<EventCategory>>(() => new Set(EVENT_CATEGORIES))

  const filtered = useMemo(() => events.filter((e) => active.has(eventCategory(e.type))), [events, active])
  const { ref, pinned, onScroll, jumpToLatest } = useStickyScroll<HTMLDivElement>(filtered.length)

  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(240)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [ref])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  const handleScroll = () => {
    onScroll()
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (ref.current) setScrollTop(ref.current.scrollTop)
    })
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(filtered.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const visible = filtered.slice(first, last)

  const toggle = (c: EventCategory) =>
    setActive((prev) => {
      const next = new Set(prev)
      if (!next.delete(c)) next.add(c)
      return next
    })

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="timeline">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
        {EVENT_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={active.has(c)}
            data-testid={`timeline-filter-${c}`}
            onClick={() => toggle(c)}
            className={cn(
              'rounded-[3px] border px-1.5 text-[0.82rem] leading-5',
              active.has(c) ? 'border-border-strong bg-surface-hover text-text-primary' : 'border-transparent text-text-muted hover:text-text-secondary',
            )}
          >
            {c}
          </button>
        ))}
        <span className="ml-auto font-mono text-small text-text-muted" data-testid="timeline-count">
          {filtered.length === events.length ? `${events.length} events` : `${filtered.length} of ${events.length} events`}
        </span>
        {!pinned ? (
          <Button size="sm" onClick={jumpToLatest} data-testid="timeline-latest">
            Jump to latest
          </Button>
        ) : null}
      </div>
      <div ref={ref} onScroll={handleScroll} className="relative min-h-0 flex-1 overflow-auto" data-testid="timeline-scroll">
        {loading ? (
          <Loading label="Loading events" />
        ) : error ? (
          <div className="p-3 text-tone-danger">{error instanceof Error ? error.message : String(error)}</div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-text-secondary">{events.length === 0 ? 'No events recorded yet.' : 'No events match the selected categories.'}</div>
        ) : (
          <div style={{ height: filtered.length * ROW_HEIGHT, position: 'relative' }}>
            {visible.map((e, i) => {
              const tone = eventTone(e)
              const task = e.taskId ? tasksById.get(e.taskId) : undefined
              const agent = e.agentId ? agentsById.get(e.agentId) : undefined
              return (
                <div
                  key={e.seq}
                  data-testid="timeline-row"
                  data-type={e.type}
                  style={{ position: 'absolute', top: (first + i) * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}
                  className="flex items-center gap-2 whitespace-nowrap px-2 font-mono text-small hover:bg-surface-muted"
                >
                  <span className="w-[4.5rem] shrink-0 text-text-muted">{clockTimeSeconds(e.createdAt)}</span>
                  <StatusDot tone={tone} />
                  <span className="w-[5.5rem] shrink-0 truncate text-text-muted">{eventCategory(e.type)}</span>
                  {task ? <span className="max-w-[10rem] shrink-0 truncate text-text-secondary">{task.key}</span> : null}
                  {agent ? <span className="max-w-[9rem] shrink-0 truncate text-text-muted">{agent.label}</span> : null}
                  <span className={cn('min-w-0 flex-1 truncate font-sans text-[1.04em]', tone === 'danger' && TONE_CLASSES.danger.text)} title={describeEvent(e)}>
                    {describeEvent(e)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
