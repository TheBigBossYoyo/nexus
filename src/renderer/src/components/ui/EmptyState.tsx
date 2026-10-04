import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={cn('motion-safe:animate-spin text-text-muted', className)}
      role="status"
      aria-label="Loading"
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** Placeholder block for content that is loading. Pulses only when the user allows motion. */
export function Skeleton({ className, ...rest }: { className?: string; 'data-testid'?: string }) {
  return <div aria-hidden="true" className={cn('rounded-md bg-surface-hover motion-safe:animate-pulse', className)} {...rest} />
}

/** An intentional, calm "nothing here" state: quiet icon, one line of title, one short explanation, one action. */
export function EmptyState({
  title,
  children,
  action,
  icon,
  className,
  ...rest
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
  icon?: ReactNode
  className?: string
  'data-testid'?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center', className)} {...rest}>
      {icon ? <div className="mb-1 text-text-muted">{icon}</div> : null}
      <div className="text-heading font-semibold text-text-primary">{title}</div>
      {children ? <div className="max-w-md text-text-secondary">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-text-secondary" role="status">
      <Spinner />
      <span>{label}…</span>
    </div>
  )
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div role="alert" className={cn('rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-danger', className)}>
      {message}
    </div>
  )
}

const NOTICE_STYLES = {
  warning: 'border-warning/30 bg-warning-subtle',
  danger: 'border-danger/30 bg-danger-subtle',
  active: 'border-info/30 bg-info-subtle',
  neutral: 'border-border bg-surface-muted',
  success: 'border-success/30 bg-success-subtle',
} as const

const NOTICE_ACCENT = {
  warning: 'bg-warning',
  danger: 'bg-danger',
  active: 'bg-info',
  neutral: 'bg-text-muted',
  success: 'bg-success',
} as const

/** Inline notice: quiet tinted surface, a thin accent bar, primary-coloured text so contrast never depends on the tint. */
export function Notice({
  tone = 'warning',
  title,
  children,
  className,
  ...rest
}: {
  tone?: 'warning' | 'danger' | 'active' | 'neutral' | 'success'
  title?: string
  children: ReactNode
  className?: string
  'data-testid'?: string
}) {
  return (
    <div className={cn('relative overflow-hidden rounded-md border py-2 pl-4 pr-3', NOTICE_STYLES[tone], className)} {...rest}>
      <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-1', NOTICE_ACCENT[tone])} />
      {title ? <div className="mb-0.5 font-semibold text-text-primary">{title}</div> : null}
      <div className="text-text-secondary">{children}</div>
    </div>
  )
}
