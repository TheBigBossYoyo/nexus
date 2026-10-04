import type { UsageOverview } from '@shared/v3'
import { DASH, formatDateTime } from '../../lib/format'
import { clockText, exactResetAt, untilText } from '../../lib/usageModel'
import {
  Badge,
  Card,
  DataTable,
  KeyValue,
  Notice,
  ProgressBar,
  SourceLabel,
  StatusDot,
  type Column,
} from '../../components/ui'
import {
  NOT_EXPOSED,
  SUBSCRIPTION_NOTE,
  accountModeText,
  isWaitingStatus,
  subscriptionRemaining,
  subscriptionTypeText,
  usageHeader,
  windowRows,
  type WindowRow,
} from './usageViewModel'
import { BlockSkeleton, Caption, ReadError } from './shared'

function ResetValue({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="text-text-secondary">Not reported</span>
  const until = untilText(iso, now)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="tnum" title={formatDateTime(iso)}>
        {clockText(iso, now)}
      </span>
      {until ? <span className="tnum text-text-muted">in {until}</span> : null}
      <SourceLabel confidence="EXACT" source="RUNTIME" />
    </span>
  )
}

const WINDOW_COLUMNS = (now: number): Column<WindowRow>[] => [
  { key: 'name', header: 'Window', render: (w) => <span className="font-medium">{w.name}</span> },
  {
    key: 'status',
    header: 'Runtime status',
    render: (w) => (
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone={w.tone} />
        {w.statusLabel}
      </span>
    ),
  },
  {
    key: 'util',
    header: 'Utilization',
    width: '30%',
    render: (w) =>
      // A bar exists only when the runtime sent a percentage for this window.
      w.percent !== null ? (
        <span className="flex items-center gap-2">
          <ProgressBar
            value={w.percent}
            max={100}
            label={`${w.name} utilization reported by the runtime`}
            className="max-w-40"
            tone={w.percent >= 90 ? 'warning' : 'accent'}
          />
          <span className="tnum w-9 text-right">{Math.round(w.percent)}%</span>
        </span>
      ) : (
        <span className="text-text-muted">{DASH} Not reported</span>
      ),
  },
  {
    key: 'reset',
    header: 'Resets',
    render: (w) =>
      w.resetAt ? (
        <ResetValue iso={w.resetAt} now={now} />
      ) : (
        <span className="text-text-muted">Not reported</span>
      ),
  },
  {
    key: 'src',
    header: 'Source',
    render: (w) => <SourceLabel confidence={w.confidence} source={w.source} />,
  },
]

function SubscriptionBlock({ overview }: { overview: UsageOverview | null }) {
  const sub = subscriptionRemaining(overview)
  return (
    <div className="flex flex-col gap-1.5" data-testid="usage-subscription">
      <div className="flex items-center gap-1.5 text-small text-text-muted">
        <span>Subscription remaining</span>
        <SourceLabel
          confidence={sub.kind === 'percent' ? 'EXACT' : 'UNKNOWN'}
          source={sub.kind === 'percent' ? 'RUNTIME' : 'UNKNOWN'}
        />
      </div>
      {sub.kind === 'percent' ? (
        <>
          <div className="tnum text-[1.54rem] font-semibold leading-7">
            {Math.round(sub.percent)}% used
          </div>
          <ProgressBar
            value={sub.percent}
            max={100}
            label="Subscription used, reported by the runtime"
            className="max-w-56"
            tone={sub.percent >= 90 ? 'warning' : 'accent'}
          />
          <div className="tnum text-small text-text-muted">
            {Math.round(100 - sub.percent)}% remaining, as reported by the Claude runtime.
          </div>
        </>
      ) : (
        <div className="flex items-baseline gap-2">
          <span
            className="text-[1.54rem] font-semibold leading-7 text-text-muted"
            aria-label="No value"
          >
            {DASH}
          </span>
          <span className="text-text-secondary">{NOT_EXPOSED}</span>
        </div>
      )}
      <p className="m-0 max-w-md text-small text-text-muted">{SUBSCRIPTION_NOTE}</p>
    </div>
  )
}

export function StatusSection({
  overview,
  pending,
  error,
  now,
}: {
  overview: UsageOverview | null
  pending: boolean
  error: unknown
  now: number
}) {
  const h = usageHeader(overview)
  const body = (() => {
    if (pending) return <BlockSkeleton rows={4} testId="usage-status-loading" />
    if (!overview)
      return (
        <div className="flex flex-col gap-4">
          <ReadError
            error={error}
            calm="Claude status is not available yet. NEXUS shows it as soon as the usage service answers."
          />
          <SubscriptionBlock overview={null} />
        </div>
      )
    const o = overview
    const reset = exactResetAt(o)
    const nextCheck = o.autoResume.nextCheckAt
    const mode = accountModeText(o)
    const subType = subscriptionTypeText(o)
    const windows = windowRows(o.windows)
    return (
      <div className="flex flex-col gap-5">
        {isWaitingStatus(o.status) ? (
          <Notice
            tone="warning"
            title="Paused for Claude usage limit"
            data-testid="usage-paused-notice"
          >
            {o.autoResume.enabled
              ? 'Work that needs Claude is waiting. NEXUS resumes automatically when Claude is available again.'
              : 'Work that needs Claude is waiting. Automatic resume is disabled, so use Check now when you expect the limit to have reset.'}
            {o.autoResume.pausedRuns > 0
              ? ` ${o.autoResume.pausedRuns} mission${o.autoResume.pausedRuns === 1 ? ' is' : 's are'} paused.`
              : ''}
          </Notice>
        ) : null}
        <div className="grid gap-x-10 gap-y-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <KeyValue
            labelWidth="9.5rem"
            rows={[
              {
                label: 'Claude availability',
                value: (
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={h.tone} />
                    <span className="font-medium" role="status">
                      {h.statusLabel}
                    </span>
                  </span>
                ),
              },
              {
                label: 'Authentication',
                value: mode ? (
                  <span className="inline-flex items-center gap-1.5">
                    {mode}
                    <SourceLabel
                      confidence={o.accountMode.confidence}
                      source={o.accountMode.source}
                    />
                  </span>
                ) : (
                  <span className="text-text-muted">Not reported</span>
                ),
              },
              {
                label: 'Subscription type',
                value: subType ? (
                  <span className="inline-flex items-center gap-1.5">
                    {subType}
                    <SourceLabel
                      confidence={o.subscriptionType.confidence}
                      source={o.subscriptionType.source}
                    />
                  </span>
                ) : (
                  <span className="text-text-muted">Not reported</span>
                ),
              },
              { label: 'Known reset', value: <ResetValue iso={reset} now={now} /> },
              {
                label: 'Auto-resume',
                value: (
                  <Badge tone={o.autoResume.enabled ? 'success' : 'neutral'}>
                    {o.autoResume.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                ),
              },
              {
                label: 'Next check',
                value: nextCheck.value ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="tnum" title={formatDateTime(nextCheck.value)}>
                      {clockText(nextCheck.value, now)}
                    </span>
                    <SourceLabel confidence={nextCheck.confidence} source={nextCheck.source} />
                  </span>
                ) : (
                  <span className="text-text-muted">None planned</span>
                ),
              },
            ]}
          />
          <SubscriptionBlock overview={o} />
        </div>
        {windows.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Caption>Plan windows reported by the runtime</Caption>
            <div className="overflow-x-auto rounded-md border" data-testid="usage-windows">
              <DataTable
                columns={WINDOW_COLUMNS(now)}
                rows={windows}
                rowKey={(w) => w.id}
                caption="Plan windows"
              />
            </div>
          </div>
        ) : null}
      </div>
    )
  })()
  return (
    <Card title="Current status" data-testid="usage-status">
      {body}
    </Card>
  )
}
