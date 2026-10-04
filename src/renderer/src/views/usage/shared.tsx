import type { ReactNode } from 'react'
import { Button, ErrorNote, Skeleton } from '../../components/ui'
import { isNotWired } from '../../lib/queries-v3'

/** Small building blocks shared by the three Intelligence pages. */

export function BlockSkeleton({ rows = 3, testId }: { rows?: number; testId?: string }) {
  return (
    <div
      className="flex flex-col gap-2 py-1"
      role="status"
      aria-label="Loading"
      data-testid={testId}
    >
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-5 ${['w-full', 'w-11/12', 'w-3/4'][i % 3]}`} />
      ))}
    </div>
  )
}

/** A failed read. When the service is not wired in this build the page stays calm: a quiet line, not an alert. */
export function ReadError({
  error,
  calm,
  onRetry,
}: {
  error: unknown
  calm: string
  onRetry?: () => void
}) {
  if (isNotWired(error)) return <p className="m-0 py-2 text-text-muted">{calm}</p>
  return (
    <div className="flex items-center gap-2">
      <ErrorNote error={error} className="min-w-0 flex-1" />
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

export function LoadMore({
  onClick,
  loading,
  children = 'Load older',
}: {
  onClick: () => void
  loading: boolean
  children?: ReactNode
}) {
  return (
    <div className="flex justify-center py-2">
      <Button size="sm" variant="ghost" onClick={onClick} loading={loading}>
        {children}
      </Button>
    </div>
  )
}

/** Quiet group label above a table or a list. */
export function Caption({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <h3
      className={`m-0 text-caption font-medium uppercase tracking-wide text-text-muted ${className}`}
    >
      {children}
    </h3>
  )
}

/** A table inside a flat bordered container. */
export function TableFrame({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-surface" data-testid={testId}>
      {children}
    </div>
  )
}
