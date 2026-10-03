import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { TONE_CLASSES, type StatusInfo, type Tone } from '../../lib/status'

export function StatusDot({ tone, className, pulse = false }: { tone: Tone; className?: string; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE_CLASSES[tone].dot, pulse && 'animate-pulse', className)}
    />
  )
}

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
}) {
  const t = TONE_CLASSES[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-[3px] px-1.5 text-[0.8rem] leading-[1.35rem]',
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
export function StatusBadge({ status, className }: { status: StatusInfo; className?: string }) {
  return (
    <Badge tone={status.tone} className={className}>
      <StatusDot tone={status.tone} />
      {status.label}
    </Badge>
  )
}

/** Plain dot + text, for dense lists. */
export function StatusText({ status }: { status: StatusInfo }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot tone={status.tone} />
      <span className={TONE_CLASSES[status.tone].text}>{status.label}</span>
    </span>
  )
}
