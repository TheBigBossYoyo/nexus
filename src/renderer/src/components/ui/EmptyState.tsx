import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={cn('animate-spin text-fg-muted', className)}
      role="status"
      aria-label="Loading"
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function EmptyState({
  title,
  children,
  action,
  icon,
  className,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-4 py-10 text-center', className)}>
      {icon ? <div className="text-fg-faint">{icon}</div> : null}
      <div className="font-medium text-fg">{title}</div>
      {children ? <div className="max-w-md text-fg-muted">{children}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-fg-muted">
      <Spinner />
      <span>{label}…</span>
    </div>
  )
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div
      role="alert"
      className={cn('border-l-2 border-tone-danger bg-tone-danger/10 px-3 py-2 text-tone-danger', className)}
    >
      {message}
    </div>
  )
}

/** Inline notice with a coloured left border. */
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
  const styles = {
    warning: 'border-tone-warning bg-tone-warning/10',
    danger: 'border-tone-danger bg-tone-danger/10',
    active: 'border-tone-active bg-tone-active/10',
    neutral: 'border-tone-neutral bg-surface-2',
    success: 'border-tone-success bg-tone-success/10',
  }[tone]
  return (
    <div className={cn('border-l-2 px-3 py-2', styles, className)} {...rest}>
      {title ? <div className="mb-0.5 font-medium">{title}</div> : null}
      <div className="text-fg-muted">{children}</div>
    </div>
  )
}
