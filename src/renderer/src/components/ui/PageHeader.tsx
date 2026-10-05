import { createContext, useContext, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface ShellSlots {
  /** Global status cluster (Claude, agents, run, overnight, git, approvals), right side of every header. */
  status: ReactNode
  /** Global banners (approvals, authentication, quota wait) rendered directly under every header. */
  banners: ReactNode
}

/** The shell provides these so every PageHeader can show them without importing app code. */
export const ShellSlotsContext = createContext<ShellSlots>({ status: null, banners: null })

/**
 * Slim contextual page header: breadcrumb or context, 18/600 title, page actions, and the global status
 * cluster on the right. One per page. Height follows the density tokens.
 */
export function PageHeader({
  title,
  context,
  actions,
  status,
  className,
  ...rest
}: {
  title: ReactNode
  /** Quiet text before the title, e.g. "Intelligence". Rendered as a breadcrumb. */
  context?: ReactNode
  /** Page actions, right-aligned before the status cluster. */
  actions?: ReactNode
  /** Overrides the global status cluster. Pass `null` to hide it. */
  status?: ReactNode
  className?: string
  'data-testid'?: string
}) {
  const slots = useContext(ShellSlotsContext)
  const right = status === undefined ? slots.status : status
  return (
    <div className="shrink-0">
      <header
        data-testid="top-bar"
        className={cn(
          '@container/header flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-b bg-surface px-5 py-1.5',
          className,
        )}
        {...rest}
      >
        <div className="flex min-w-48 flex-1 items-baseline gap-2">
          {context ? (
            <>
              <span className="shrink-0 text-body text-text-muted">{context}</span>
              <span aria-hidden="true" className="shrink-0 text-text-muted">
                /
              </span>
            </>
          ) : null}
          <h1
            className="m-0 min-w-0 truncate text-title font-semibold text-text-primary"
            title={typeof title === 'string' ? title : undefined}
          >
            {title}
          </h1>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        {right ? (
          <div
            className="flex shrink-0 items-center gap-1 border-l pl-4"
            role="group"
            aria-label="Status"
          >
            {right}
          </div>
        ) : null}
      </header>
      {slots.banners}
    </div>
  )
}
