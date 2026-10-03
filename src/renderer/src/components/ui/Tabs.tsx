import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  /** Small count/indicator after the label. */
  badge?: ReactNode
  testId?: string
}

/** Controlled tab strip; the caller renders the active panel. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: readonly TabItem<T>[]
  active: T
  onChange: (id: T) => void
  className?: string
}) {
  return (
    <div role="tablist" className={cn('flex shrink-0 items-end gap-0.5 border-b', className)}>
      {tabs.map((t) => {
        const selected = t.id === active
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={selected}
            data-testid={t.testId}
            onClick={() => onChange(t.id)}
            className={cn(
              '-mb-px inline-flex h-[var(--row-h)] items-center gap-1.5 border-b-2 px-2.5 transition-colors',
              selected ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
            )}
          >
            {t.label}
            {t.badge}
          </button>
        )
      })}
    </div>
  )
}
