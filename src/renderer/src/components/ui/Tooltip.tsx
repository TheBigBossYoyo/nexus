import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** CSS-only tooltip (hover and keyboard focus). Not for essential information. */
export function Tooltip({
  text,
  children,
  side = 'bottom',
  className,
}: {
  text: string
  children: ReactNode
  side?: 'top' | 'bottom'
  className?: string
}) {
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded-[3px] border border-border-strong bg-surface-3 px-1.5 py-0.5 text-[0.8rem] text-fg shadow',
          'group-hover/tip:block group-focus-within/tip:block',
          side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1',
        )}
      >
        {text}
      </span>
    </span>
  )
}
