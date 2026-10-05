import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** Titled, dense container with a hairline border. The header carries optional actions on the right. */
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
    <section className={cn('flex min-h-0 flex-col rounded-lg border bg-surface', className)} {...rest}>
      {title || actions ? (
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
          <h2 className="m-0 truncate text-heading font-semibold text-text-primary">{title}</h2>
          {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('min-h-0 flex-1 overflow-auto', padded && 'p-3', bodyClassName)}>{children}</div>
    </section>
  )
}

/** Flat card: hairline border, no shadow. Use for grouped content on the page background. */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
  as: Tag = 'section',
  ...rest
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  padded?: boolean
  as?: 'section' | 'div' | 'article'
  'data-testid'?: string
}) {
  return (
    <Tag className={cn('flex min-w-0 flex-col rounded-lg border bg-surface', className)} {...rest}>
      {title || actions ? (
        <header className="flex min-h-9 shrink-0 items-center justify-between gap-3 px-4 pt-3">
          <div className="min-w-0">
            {title ? <h2 className="m-0 truncate text-heading font-semibold text-text-primary">{title}</h2> : null}
            {description ? <p className="m-0 text-small text-text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('min-h-0 min-w-0 flex-1', padded && (title || actions ? 'px-4 pb-4 pt-2' : 'p-4'), bodyClassName)}>{children}</div>
    </Tag>
  )
}

/** Unframed titled block: a heading line with optional actions, then content. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  ...rest
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  'data-testid'?: string
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)} {...rest}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-heading font-semibold text-text-primary">{title}</h2>
          {description ? <p className="m-0 text-small text-text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}
