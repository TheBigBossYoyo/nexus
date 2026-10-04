import type { ReactNode } from 'react'
import type { UsageOverview } from '@shared/v3'
import { useUiStore } from '../store/ui'
import { useUsageOverview, useUsageRefresh } from '../lib/queries'
import { useNow } from '../lib/useNow'
import { formatCount, formatTokens } from '../lib/format'
import {
  popoverRows,
  usageIndicator,
  type PopoverRow,
  type UsageIndicatorModel,
} from '../lib/usageModel'
import { TONE_CLASSES } from '../lib/status'
import { cn } from '../lib/cn'
import {
  AlertIcon,
  Button,
  ClockIcon,
  KeyIcon,
  MeasuredValue,
  PauseIcon,
  Popover,
  SourceLabel,
  StatusDot,
  type PopoverTriggerProps,
} from '../components/ui'

export function IndicatorGlyph({ model }: { model: UsageIndicatorModel }) {
  switch (model.icon) {
    case 'clock':
      return <ClockIcon size={12} className={TONE_CLASSES[model.tone].text} />
    case 'pause':
      return <PauseIcon size={12} className={TONE_CLASSES[model.tone].text} />
    case 'key':
      return <KeyIcon size={12} className={TONE_CLASSES[model.tone].text} />
    case 'alert':
      return <AlertIcon size={12} className={TONE_CLASSES[model.tone].text} />
    case 'unknown':
      return <StatusDot tone="neutral" className="opacity-60" />
    default:
      return <StatusDot tone={model.tone} />
  }
}

/** Hook shared by the header indicator and the sidebar row. Re-renders each 30 s while a countdown matters. */
export function useUsageIndicator() {
  const query = useUsageOverview()
  const overview = query.data ?? null
  const now = useNow(!!overview && overview.status !== 'AVAILABLE', 30_000)
  return {
    overview,
    model: usageIndicator(overview, now, query.isError),
    now,
    failed: query.isError,
  }
}

function Row({ row }: { row: PopoverRow }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-text-muted">{row.label}</span>
      <span className="flex items-center gap-1.5">
        <span className={cn('tnum', row.muted && 'text-text-muted')}>{row.value}</span>
        {row.confidence ? <SourceLabel confidence={row.confidence} /> : null}
      </span>
    </div>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t px-4 py-3 first:border-t-0">
      <h3 className="m-0 mb-1.5 text-small font-semibold text-text-primary">{title}</h3>
      {children}
    </section>
  )
}

function UsagePanelBody({
  overview,
  model,
  now,
}: {
  overview: UsageOverview | null
  model: UsageIndicatorModel
  now: number
}) {
  const setView = useUiStore((s) => s.setView)
  const refresh = useUsageRefresh()
  const rows = overview ? popoverRows(overview, now) : null
  const session = overview?.session
  return (
    <div>
      <section className="px-4 py-3">
        <div className="flex items-center gap-2" role="status">
          <IndicatorGlyph model={model} />
          <span className="font-semibold">{model.label}</span>
        </div>
        <p className="m-0 mt-0.5 text-small text-text-muted">
          {model.detail ??
            (overview
              ? 'Status as last reported by the Claude runtime.'
              : model.status === 'UNKNOWN'
                ? 'NEXUS could not read the usage status. Nothing is wrong with your missions; this will fill in when the runtime reports.'
                : 'Waiting for the first status report.')}
        </p>
      </section>

      {rows ? (
        <Block title="Authentication">
          {rows.auth.map((r) => (
            <Row key={r.label} row={r} />
          ))}
        </Block>
      ) : null}

      <Block title="Observed this NEXUS session">
        {session ? (
          <>
            <Row
              row={{
                label: 'Input tokens',
                value: formatTokens(session.inputTokens),
                confidence: 'OBSERVED',
              }}
            />
            <Row
              row={{
                label: 'Output tokens',
                value: formatTokens(session.outputTokens),
                confidence: 'OBSERVED',
              }}
            />
            <Row
              row={{
                label: 'Sessions',
                value: formatCount(session.sessions),
                confidence: 'OBSERVED',
              }}
            />
          </>
        ) : (
          <p className="m-0 text-text-muted">Nothing observed yet.</p>
        )}
      </Block>

      <Block title="Current subscription remaining">
        {overview && overview.subscriptionUtilizationPercent.confidence === 'EXACT' ? (
          <MeasuredValue measured={overview.subscriptionUtilizationPercent} percent progress />
        ) : (
          <div>
            <div className="text-text-secondary">Not exposed by runtime</div>
            <p className="m-0 text-small text-text-muted">
              NEXUS never estimates a remaining quota, so no percentage is shown.
            </p>
          </div>
        )}
      </Block>

      {rows ? (
        <Block title="Limits and resume">
          {rows.limit.map((r) => (
            <Row key={r.label} row={r} />
          ))}
          {rows.resume.map((r) => (
            <Row key={r.label} row={r} />
          ))}
        </Block>
      ) : null}

      <footer className="flex items-center justify-between gap-2 border-t px-4 py-3">
        <Button
          size="sm"
          variant="primary"
          onClick={() => setView('usage')}
          data-testid="open-usage-dashboard"
        >
          Open Usage Dashboard
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={refresh.isPending}
          onClick={() => refresh.mutate({})}
          data-testid="usage-refresh"
        >
          Refresh
        </Button>
      </footer>
    </div>
  )
}

/** Wraps any trigger so that pressing it opens the usage popover (data-testid="usage-popover"). */
export function UsagePopover({
  children,
  align = 'end',
  side = 'bottom',
}: {
  children: (props: PopoverTriggerProps, state: ReturnType<typeof useUsageIndicator>) => ReactNode
  align?: 'start' | 'end'
  side?: 'top' | 'bottom'
}) {
  const state = useUsageIndicator()
  return (
    <Popover
      label="Claude usage"
      testId="usage-popover"
      align={align}
      side={side}
      width={340}
      content={<UsagePanelBody overview={state.overview} model={state.model} now={state.now} />}
    >
      {(p) => children(p, state)}
    </Popover>
  )
}
