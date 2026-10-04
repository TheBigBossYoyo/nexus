import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  width?: string
  align?: 'left' | 'right'
  mono?: boolean
  /** Right-aligned, tabular figures. */
  numeric?: boolean
}

/** Dense, zebra-free table with a sticky header (sticks inside the nearest scrolling ancestor). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  className,
  rowTestId,
  caption,
}: {
  columns: readonly Column<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  selectedKey?: string | null
  empty?: ReactNode
  className?: string
  rowTestId?: (row: T) => string
  /** Accessible name of the table. */
  caption?: string
}) {
  return (
    <table className={cn('w-full border-collapse text-left text-body', className)} aria-label={caption}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              style={{ width: c.width }}
              className={cn(
                'sticky top-0 z-[1] h-[var(--row-h)] whitespace-nowrap border-b bg-surface px-3 text-caption font-medium text-text-muted',
                (c.align === 'right' || c.numeric) && 'text-right',
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
            <td colSpan={columns.length} className="px-3 py-8 text-center text-text-muted">
              {empty ?? 'No rows'}
            </td>
          </tr>
        ) : (
          rows.map((row) => {
            const key = rowKey(row)
            const selected = selectedKey === key
            return (
              <tr
                key={key}
                data-testid={rowTestId?.(row)}
                aria-selected={onRowClick ? selected : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onRowClick(row)
                        }
                      }
                    : undefined
                }
                className={cn(
                  'border-b transition-colors last:border-b-0',
                  onRowClick && 'cursor-pointer hover:bg-surface-muted',
                  selected && 'bg-accent-subtle hover:bg-accent-subtle',
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'min-h-[var(--row-h)] px-3 py-[calc(var(--pad-y)/2+1px)] align-middle',
                      (c.align === 'right' || c.numeric) && 'text-right',
                      c.numeric && 'tnum',
                      c.mono && 'font-mono text-code tnum',
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
