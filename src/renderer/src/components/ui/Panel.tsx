import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** Titled, dense container. The header carries optional actions on the right. */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
  ...rest
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  padded?: boolean
  'data-testid'?: string
}) {
  return (
    <section className={cn('flex min-h-0 flex-col border bg-surface-1', className)} {...rest}>
      {title || actions ? (
        <header className="flex h-[var(--row-h)] shrink-0 items-center justify-between gap-2 border-b bg-surface-2/60 px-2.5">
          <h2 className="truncate text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">{title}</h2>
          {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('min-h-0 flex-1 overflow-auto', padded && 'p-3', bodyClassName)}>{children}</div>
    </section>
  )
}
