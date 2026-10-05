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
    <dl className={cn('m-0 grid gap-x-4 gap-y-1.5', className)} style={{ gridTemplateColumns: `${labelWidth} minmax(0,1fr)` }}>
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-text-muted">{r.label}</dt>
          <dd className={cn('m-0 min-w-0 break-words', r.mono && 'font-mono text-code tnum')}>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}
