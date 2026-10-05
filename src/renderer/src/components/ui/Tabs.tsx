import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  /** Small count/indicator after the label. */
  badge?: ReactNode
  testId?: string
}

/** Controlled underline tab strip; the caller renders the active panel. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
  label,
  bare = false,
}: {
  tabs: readonly TabItem<T>[]
  active: T
  onChange: (id: T) => void
  className?: string
  label?: string
  /** No bottom border, for tab strips that sit inside a bordered row. */
  bare?: boolean
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('flex shrink-0 items-end gap-1', !bare && 'border-b', className)}
      onKeyDown={(e) => {
        // Arrow keys / Home / End move between tabs.
        const idx = tabs.findIndex((t) => t.id === active)
        const next =
          e.key === 'ArrowRight' ? idx + 1 : e.key === 'ArrowLeft' ? idx - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
        const target = next === null ? undefined : tabs[(next + tabs.length) % tabs.length]
        if (!target) return
        e.preventDefault()
        onChange(target.id)
        const buttons = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
        buttons[tabs.indexOf(target)]?.focus()
      }}
    >
      {tabs.map((t) => {
        const selected = t.id === active
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-testid={t.testId}
            onClick={() => onChange(t.id)}
            className={cn(
              '-mb-px inline-flex h-[var(--row-h)] items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 font-medium transition-colors',
              selected ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
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
