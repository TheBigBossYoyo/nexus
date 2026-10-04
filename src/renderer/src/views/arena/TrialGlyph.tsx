import { cn } from '../../lib/cn'
import { TONE_CLASSES } from '../../lib/status'
import { trialStateInfo, type TrialGlyph as Glyph } from './arenaModel'
import type { TrialState } from '@shared/v3'

/** Shape plus colour: every state has its own silhouette, so colour is never the only signal. */
export function GlyphIcon({
  glyph,
  size = 13,
  className,
}: {
  glyph: Glyph
  size?: number
  className?: string
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    'aria-hidden': true,
    className,
  } as const
  switch (glyph) {
    case 'pass':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M5.2 8.2l2 2 3.6-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'fail':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" strokeLinecap="round" />
        </svg>
      )
    case 'running':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'queued':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" strokeDasharray="2.2 2.2" />
        </svg>
      )
    case 'blocked':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M5 8h6" strokeLinecap="round" />
        </svg>
      )
    case 'cancelled':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M4.2 11.8l7.6-7.6" strokeLinecap="round" />
        </svg>
      )
  }
}

const BLOCK_WORDS = {
  infrastructure: 'Blocked by the harness, not counted',
  run: 'Run needed intervention',
  timeout: 'Timed out',
} as const

/** Icon plus word for a trial state. */
export function TrialStateText({
  state,
  detail = false,
  blockKind = null,
  className,
}: {
  state: TrialState
  detail?: boolean
  blockKind?: 'infrastructure' | 'run' | 'timeout' | null
  className?: string
}) {
  const info = trialStateInfo(state)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        TONE_CLASSES[info.tone].text,
        className,
      )}
    >
      <GlyphIcon glyph={info.glyph} />
      <span>{detail && state === 'blocked' && blockKind ? BLOCK_WORDS[blockKind] : detail ? DETAIL[state] : info.label}</span>
    </span>
  )
}

const DETAIL: Record<TrialState, string> = {
  queued: 'Queued',
  provisioning: 'Preparing',
  running: 'Running',
  evaluating: 'Evaluating',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
}
