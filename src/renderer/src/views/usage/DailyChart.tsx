import { useEffect, useRef, useState } from 'react'
import { formatCount, formatTokens } from '../../lib/format'
import { chartGeometry, type DayPoint } from './usageViewModel'

const H = 168
const PAD = { top: 10, right: 8, bottom: 22, left: 40 }

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(640)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(Math.max(240, Math.floor(el.getBoundingClientRect().width)))
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setW(Math.max(240, Math.floor(entry.contentRect.width)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDay = (day: string) => {
  const [, m, d] = day.split('-')
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`
}

/** Observed tokens per day as quiet bars. No capacity line, no percentage: the axis only scales the picture. */
export function DailyChart({ points }: { points: readonly DayPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)
  const plotW = width - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const g = chartGeometry(points, plotW, plotH)
  const total = points.reduce((n, p) => n + p.total, 0)
  const a = active === null ? null : points[active]
  const bar = active === null ? null : g.bars[active]
  const summary = `Observed Claude tokens per day for the last ${points.length} days, ${formatTokens(total)} in total.`

  return (
    <div ref={ref} className="relative" data-testid="usage-history-chart">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={summary}
        className="block overflow-visible"
        onMouseLeave={() => setActive(null)}
      >
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {g.ticks.map((t) => {
            const y = plotH - (t / g.max) * plotH
            return (
              <g key={t}>
                <line
                  x1={0}
                  x2={plotW}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeDasharray={t === 0 ? undefined : '2 3'}
                />
                <text
                  x={-8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-text-muted text-caption tnum"
                >
                  {formatTokens(t)}
                </text>
              </g>
            )
          })}
          {g.bars.map((b) => (
            <g key={b.day}>
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={2}
                className={active === b.index ? 'fill-accent' : 'fill-accent/70'}
              />
              {/* Wider invisible target: hover and keyboard focus show the tooltip. */}
              <rect
                x={b.x - (plotW / points.length - b.w) / 2}
                y={0}
                width={plotW / points.length}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${b.day}: ${formatCount(points[b.index]?.total ?? 0)} observed tokens`}
                onMouseEnter={() => setActive(b.index)}
                onFocus={() => setActive(b.index)}
                onBlur={() => setActive(null)}
                className="outline-none focus-visible:stroke-focus-ring"
                strokeWidth={2}
              />
            </g>
          ))}
          {g.labelIndices.map((i) => {
            const b = g.bars[i]
            if (!b) return null
            return (
              <text
                key={i}
                x={b.x + b.w / 2}
                y={plotH + 15}
                textAnchor="middle"
                className="fill-text-muted text-caption"
              >
                {shortDay(b.day)}
              </text>
            )
          })}
        </g>
      </svg>
      {a && bar ? (
        <div
          role="presentation"
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-border-strong bg-surface-elevated px-2.5 py-1.5 shadow-elevated"
          style={{
            left: Math.min(Math.max(PAD.left + bar.x + bar.w / 2, 80), width - 80),
            top: -4,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="mb-1 text-small font-medium text-text-primary">{a.day}</div>
          <table className="text-small">
            <tbody>
              <tr>
                <td className="pr-3 text-text-muted">Input</td>
                <td className="tnum text-right">{formatCount(a.inputTokens)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-text-muted">Output</td>
                <td className="tnum text-right">{formatCount(a.outputTokens)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-text-muted">Sessions</td>
                <td className="tnum text-right">{formatCount(a.sessions)}</td>
              </tr>
              {a.limitEvents > 0 ? (
                <tr>
                  <td className="pr-3 text-text-muted">Limit events</td>
                  <td className="tnum text-right">{a.limitEvents}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
      <table className="sr-only">
        <caption>Observed Claude tokens per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Input tokens</th>
            <th scope="col">Output tokens</th>
            <th scope="col">Sessions</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}>
              <th scope="row">{p.day}</th>
              <td>{p.inputTokens}</td>
              <td>{p.outputTokens}</td>
              <td>{p.sessions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
