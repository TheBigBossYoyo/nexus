import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  width?: string
  align?: 'left' | 'right'
  mono?: boolean
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  className,
  rowTestId,
}: {
  columns: readonly Column<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  selectedKey?: string | null
  empty?: ReactNode
  className?: string
  rowTestId?: (row: T) => string
}) {
  return (
    <table className={cn('w-full border-collapse text-left', className)}>
      <thead>
        <tr className="border-b bg-surface-2/60">
          {columns.map((c) => (
            <th
              key={c.key}
              style={{ width: c.width }}
              className={cn(
                'h-[var(--row-h)] px-2 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted',
                c.align === 'right' && 'text-right',
              )}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="px-2 py-6 text-center text-fg-muted">
              {empty ?? 'No rows'}
            </td>
          </tr>
        ) : (
          rows.map((row) => {
            const key = rowKey(row)
            return (
              <tr
                key={key}
                data-testid={rowTestId?.(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b last:border-b-0',
                  onRowClick && 'cursor-pointer hover:bg-surface-2',
                  selectedKey === key && 'bg-surface-3',
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'min-h-[var(--row-h)] px-2 py-[calc(var(--pad-y)/2)] align-middle',
                      c.align === 'right' && 'text-right',
                      c.mono && 'font-mono text-[0.92em]',
                    )}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            )
          })
        )}
      </tbody>
    </table>
  )
}
