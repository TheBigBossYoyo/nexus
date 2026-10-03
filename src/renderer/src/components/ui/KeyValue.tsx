import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface KeyValueRow {
  label: string
  value: ReactNode
  mono?: boolean
}

/** Dense two-column definition list. Missing values should be passed as '—', never omitted silently. */
export function KeyValue({
  rows,
  className,
  labelWidth = '8.5rem',
}: {
  rows: readonly KeyValueRow[]
  className?: string
  labelWidth?: string
}) {
  return (
    <dl className={cn('grid gap-x-3 gap-y-1', className)} style={{ gridTemplateColumns: `${labelWidth} minmax(0,1fr)` }}>
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-fg-muted">{r.label}</dt>
          <dd className={cn('m-0 min-w-0 break-words', r.mono && 'font-mono text-[0.92em]')}>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}
