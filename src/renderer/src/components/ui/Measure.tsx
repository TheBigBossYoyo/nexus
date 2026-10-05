import type { ReactNode } from 'react'
import type { Confidence, Measured, UsageSource } from '@shared/v3'
import { cn } from '../../lib/cn'
import { CONFIDENCE_LABEL, describeMeasured, sourceExplanation } from '../../lib/measured'
import { Tooltip } from './Tooltip'

/** Tiny provenance label: Exact / Observed / Estimated / Unknown, with the explanation in a tooltip. */
export function SourceLabel({
  confidence,
  source = 'UNKNOWN',
  className,
}: {
  confidence: Confidence
  source?: UsageSource
  className?: string
}) {
  return (
    <Tooltip text={sourceExplanation(confidence, source)} side="top" align="start">
      <span
        tabIndex={0}
        data-confidence={confidence}
        className={cn(
          'inline-flex h-4 cursor-help items-center rounded-sm border px-1 text-caption font-medium leading-none text-text-muted',
          className,
        )}
      >
        {CONFIDENCE_LABEL[confidence]}
      </span>
    </Tooltip>
  )
}

/** Determinate progress. Use ONLY when the denominator is known (tasks done of total, an EXACT percentage). */
export function ProgressBar({
  value,
  max,
  label,
  className,
  tone = 'accent',
}: {
  value: number
  max: number
  label: string
  className?: string
  tone?: 'accent' | 'success' | 'warning'
}) {
  const safeMax = max > 0 ? max : 1
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100))
  const fill = { accent: 'bg-accent', success: 'bg-success', warning: 'bg-warning' }[tone]
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-hover', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-150', fill)}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/**
 * Renders a Measured<T>. A value shows with its SourceLabel. UNKNOWN shows an em dash and an explanatory line
 * that reads as intentional. A percentage or progress bar is drawn ONLY when confidence is EXACT and the
 * value is a finite number; otherwise the value is treated as unknown (see lib/measured.ts describeMeasured).
 */
export function MeasuredValue<T>({
  measured,
  format,
  percent = false,
  progress = false,
  unknownReason,
  showSource = true,
  inline = false,
  className,
  ...rest
}: {
  measured: Measured<T> | null | undefined
  format?: (value: T) => ReactNode
  /** Render the value as "NN%". Honoured only for EXACT numbers. */
  percent?: boolean
  /** Also draw a bar under the value. Honoured only for EXACT numbers (0 to 100). */
  progress?: boolean
  /** Explanation under the dash when the value is unknown. */
  unknownReason?: string
  showSource?: boolean
  /** Keep everything on one line (no explanatory line); the reason goes to a tooltip. */
  inline?: boolean
  className?: string
  'data-testid'?: string
}) {
  const view = describeMeasured(measured, {
    wantPercent: percent || progress,
    ...(unknownReason ? { reason: unknownReason } : {}),
  })
  if (view.state === 'unknown') {
    return (
      <span className={cn('inline-flex flex-col', className)} {...rest}>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-text-muted" aria-label="No value">
            —
          </span>
          {showSource ? <SourceLabel confidence="UNKNOWN" /> : null}
        </span>
        {inline ? null : <span className="text-small text-text-muted">{view.reason}</span>}
      </span>
    )
  }
  const text: ReactNode =
    view.percent !== null
      ? `${Math.round(view.percent)}%`
      : format
        ? format(view.value)
        : String(view.value)
  return (
    <span className={cn('inline-flex flex-col gap-1', className)} {...rest}>
      <span className="inline-flex items-center gap-1.5">
        <span className="tnum">{text}</span>
        {showSource ? <SourceLabel confidence={view.confidence} source={view.source} /> : null}
      </span>
      {progress && view.percent !== null ? (
        <ProgressBar value={view.percent} max={100} label="Reported percentage" />
      ) : null}
    </span>
  )
}

/** Label + value (+ optional provenance and hint). For summary rows, never for decoration. */
export function Stat({
  label,
  value,
  source,
  hint,
  className,
  ...rest
}: {
  label: ReactNode
  value: ReactNode
  /** Provenance of the value, shown as a SourceLabel next to the label. */
  source?: { confidence: Confidence; source?: UsageSource }
  hint?: ReactNode
  className?: string
  'data-testid'?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)} {...rest}>
      <div className="flex items-center gap-1.5 text-small text-text-muted">
        <span className="truncate">{label}</span>
        {source ? (
          <SourceLabel
            confidence={source.confidence}
            {...(source.source ? { source: source.source } : {})}
          />
        ) : null}
      </div>
      <div className="tnum text-[1.23rem] font-semibold leading-6 text-text-primary">{value}</div>
      {hint ? <div className="text-small text-text-muted">{hint}</div> : null}
    </div>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border bg-surface-muted px-1 font-mono text-caption leading-none text-text-secondary',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
