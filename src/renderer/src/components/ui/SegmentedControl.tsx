import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  testId?: string
  disabled?: boolean
}

/** Compact radio-group switch for 2 to 5 mutually exclusive choices. Arrow keys move the selection. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-md border bg-surface-muted p-0.5',
        className,
      )}
      onKeyDown={(e) => {
        const enabled = options.filter((o) => !o.disabled)
        const idx = enabled.findIndex((o) => o.value === value)
        const step =
          e.key === 'ArrowRight' || e.key === 'ArrowDown'
            ? 1
            : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
              ? -1
              : 0
        if (step === 0) return
        e.preventDefault()
        const target = enabled[(idx + step + enabled.length) % enabled.length]
        if (!target) return
        onChange(target.value)
        const buttons = e.currentTarget.querySelectorAll<HTMLElement>(
          '[role="radio"]:not([disabled])',
        )
        buttons[enabled.indexOf(target)]?.focus()
      }}
    >
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            data-testid={o.testId}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-sm px-2.5 font-medium transition-colors disabled:opacity-50',
              size === 'sm' ? 'h-5 text-small' : 'h-6 text-body',
              selected
                ? 'bg-surface text-text-primary ring-1 ring-border-strong'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
