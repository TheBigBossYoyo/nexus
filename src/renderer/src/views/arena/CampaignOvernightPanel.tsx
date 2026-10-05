import type { TrialState } from '@shared/v3'
import { useUsageIndicator } from '../../app/UsagePopover'
import { useOvernight } from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import {
  Card,
  ErrorNote,
  KeyValue,
  MoonIcon,
  Notice,
  Skeleton,
  StatusBadge,
} from '../../components/ui'
import { OvernightActions } from '../overnight/OvernightActions'
import { overnightPageModel } from '../overnight/overnightPageModel'
import {
  deadlineRowLabel,
  endActionSummary,
  finalActionRow,
  overnightFinished,
} from '../overnight/workloadModel'
import { activeTrialCount, trialProgressText, usageResetText } from './arenaOvernight'
import type { CampaignProgress } from './arenaModel'

/**
 * The Overnight panel of a campaign page. Renders from `overnight.get` with the campaign id (kept fresh by
 * the `overnight` push), so it survives a restart. Nothing is shown for a campaign that never ran overnight.
 */
export function CampaignOvernightPanel({
  campaignId,
  progress,
  counts,
}: {
  campaignId: string
  progress: CampaignProgress
  counts: Partial<Record<TrialState, number>>
}) {
  const query = useOvernight(campaignId)
  const usage = useUsageIndicator()
  const status = query.data ?? null
  const live = status?.state === 'POWER_ACTION_SCHEDULED' || status?.state === 'QUOTA_PAUSED'
  const now = useNow(!!live, 1000)

  if (query.isPending)
    return (
      <Card title="Overnight" data-testid="arena-overnight-panel">
        <Skeleton className="h-16 w-full" />
        <span className="sr-only" role="status">
          Loading overnight status
        </span>
      </Card>
    )
  if (query.isError)
    return (
      <Card title="Overnight" data-testid="arena-overnight-panel">
        <ErrorNote error={query.error} />
      </Card>
    )
  if (!status) return null

  const m = overnightPageModel(status, now)
  const b = m.banner
  const finished = overnightFinished(status.state)
  const finalRow = finalActionRow(status, b.countdown)
  const reset = usageResetText(usage.overview, now)
  const quotaShown = m.quota.filter((l) => l.key !== 'deadline' && l.key !== 'failsafe')

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <MoonIcon size={14} className="text-text-muted" />
          Overnight
        </span>
      }
      actions={
        <span className="flex items-center gap-2">
          <span role="status">
            <StatusBadge
              status={{ tone: b.tone, label: b.state.replace(/_/g, ' ') }}
              pulse={m.working}
              data-testid="arena-overnight-state"
            />
          </span>
          {b.countdown ? (
            <span
              className="tnum font-medium text-warning"
              role="timer"
              data-testid="arena-overnight-countdown"
            >
              {b.countdown}
            </span>
          ) : null}
        </span>
      }
      data-testid="arena-overnight-panel"
    >
      <p className="m-0 text-text-secondary" data-testid="arena-overnight-summary">
        {m.summary}
      </p>

      {quotaShown.length > 0 ? (
        <div
          className="mt-3 rounded-md border bg-warning-subtle px-3 py-2"
          data-testid="arena-overnight-quota"
        >
          <ul className="m-0 list-none space-y-0.5 p-0">
            {quotaShown.map((l) => (
              <li
                key={l.key}
                className={l.key === 'paused' ? 'font-semibold' : 'text-text-secondary'}
              >
                {l.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status.state === 'FINALIZING' ? (
        <p className="m-0 mt-3 text-small text-text-muted">
          Writing the final report. The end action, if any, is scheduled afterwards.
        </p>
      ) : null}
      {finished && status.error ? (
        <Notice tone="danger" className="mt-3" data-testid="arena-overnight-error">
          {status.error}
        </Notice>
      ) : null}
      {status.state === 'DONE' && status.terminalReason ? (
        <p className="m-0 mt-3 text-small text-text-muted" data-testid="arena-overnight-outcome">
          Campaign ended: {status.terminalReason.replace(/_/g, ' ').toLowerCase()}
          {status.terminalDetail ? `. ${status.terminalDetail}` : ''}
        </p>
      ) : null}

      <div className="mt-4 border-t pt-3">
        <KeyValue
          labelWidth="10rem"
          rows={[
            {
              label: 'Progress',
              value: (
                <span className="tnum" data-testid="arena-overnight-progress">
                  {trialProgressText(progress.finished, progress.total)}
                </span>
              ),
            },
            {
              label: 'Active trials',
              value: <span className="tnum">{activeTrialCount(counts)}</span>,
            },
            {
              label: 'Claude usage',
              value: (
                <StatusBadge
                  status={{ tone: usage.model.tone, label: usage.model.label }}
                  title={usage.model.detail ?? undefined}
                />
              ),
            },
            ...(reset ? [{ label: 'Usage resets', value: reset, mono: true }] : []),
            { label: deadlineRowLabel(status), value: b.deadline, mono: true },
            ...(finalRow ? [{ label: finalRow.label, value: finalRow.value, mono: true }] : []),
            { label: 'Failsafe timer', value: b.failsafe, mono: true },
            { label: 'End action', value: endActionSummary(status.policy) },
          ]}
        />
      </div>

      <div className="mt-4">
        <OvernightActions status={status} prefix="arena-overnight" />
      </div>
    </Card>
  )
}
