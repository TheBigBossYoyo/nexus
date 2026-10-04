import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** CSS-only tooltip (hover and keyboard focus, short delay). Not for essential information. */
export function Tooltip({
  text,
  children,
  side = 'bottom',
  align = 'center',
  className,
}: {
  text: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'right'
  align?: 'start' | 'center' | 'end'
  className?: string
}) {
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 hidden w-max max-w-64 rounded-md bg-text-primary px-2 py-1 text-left text-small font-normal text-background',
          'group-hover/tip:block group-focus-within/tip:block group-hover/tip:anim-fade group-focus-within/tip:anim-fade',
          side === 'right'
            ? 'left-full top-1/2 ml-2 -translate-y-1/2'
            : cn(
                align === 'center' && 'left-1/2 -translate-x-1/2',
                align === 'start' && 'left-0',
                align === 'end' && 'right-0',
                side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1',
              ),
        )}
      >
        {text}
      </span>
    </span>
  )
}
