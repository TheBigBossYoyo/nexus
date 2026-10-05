import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { TONE_CLASSES, type StatusInfo, type Tone } from '../../lib/status'

export function StatusDot({ tone, className, pulse = false }: { tone: Tone; className?: string; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE_CLASSES[tone].dot, pulse && 'motion-safe:animate-pulse', className)}
    />
  )
}

/** Restrained label: quiet tinted background, readable text. Always carries text; colour is never the only signal. */
export function Badge({
  tone = 'neutral',
  children,
  className,
  mono = false,
  ...rest
}: {
  tone?: Tone
  children: ReactNode
  className?: string
  mono?: boolean
  'data-testid'?: string
  title?: string
}) {
  const t = TONE_CLASSES[tone]
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 text-caption font-medium',
        t.soft,
        t.text,
        mono && 'font-mono',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

/** Dot + label for a state, e.g. <StatusBadge status={runStatus(run.state)} />. */
export function StatusBadge({
  status,
  className,
  pulse = false,
  ...rest
}: {
  status: StatusInfo
  className?: string
  pulse?: boolean
  'data-testid'?: string
  title?: string
}) {
  return (
    <Badge tone={status.tone} className={className} {...rest}>
      <StatusDot tone={status.tone} pulse={pulse} />
      {status.label}
    </Badge>
  )
}

/** Plain dot + text, for dense lists. */
export function StatusText({ status, className }: { status: StatusInfo; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <StatusDot tone={status.tone} />
      <span className="text-text-primary">{status.label}</span>
    </span>
  )
}
