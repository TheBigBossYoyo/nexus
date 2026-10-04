import { useMemo } from 'react'
import type { ArenaCampaignSummary } from '@shared/v3-read'
import { formatDuration, formatRelative } from '../../lib/format'
import { DataTable, StatusBadge, TimeAgo, type Column } from '../../components/ui'
import { TableFrame } from '../usage/shared'
import {
  campaignProgress,
  campaignStateInfo,
  strategyName,
  type CampaignProgress,
  type StrategyProgress,
} from './arenaModel'

/** Stacked bar of trial counts. The denominator is the known trial total, so a bar is honest here. */
export function ProgressStrip({ p, className = '' }: { p: CampaignProgress; className?: string }) {
  if (p.total === 0) return null
  const seg = (n: number, cls: string) =>
    n > 0 ? <span className={cls} style={{ width: `${(n / p.total) * 100}%` }} /> : null
  return (
    <span
      aria-hidden="true"
      className={`flex h-1.5 w-full overflow-hidden rounded-full bg-surface-hover ${className}`}
    >
      {seg(p.passed, 'bg-success')}
      {seg(p.failed, 'bg-danger')}
      {seg(p.other, 'bg-text-muted')}
      {seg(p.running, 'bg-info')}
    </span>
  )
}

/** Passed and finished trials for each strategy, next to the campaign strip. */
export function StrategyCounts({ rows }: { rows: readonly StrategyProgress[] }) {
  if (rows.length === 0) return null
  return (
    <ul
      className="tnum m-0 mt-0.5 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-small text-text-secondary"
      aria-label="Trials per strategy"
      data-testid="arena-strategy-counts"
    >
      {rows.map((r) => (
        <li key={r.strategy} title={`${r.passed} passed, ${r.finished} of ${r.total} finished`}>
          <span className="text-text-muted">{strategyName(r.strategy)}</span>{' '}
          <span className="font-medium text-text-primary">{r.passed}</span> passed ·{' '}
          <span className="font-medium text-text-primary">{r.finished}</span>/{r.total} finished
        </li>
      ))}
    </ul>
  )
}

export function ProgressCounts({ p }: { p: CampaignProgress }) {
  const bits: [number, string][] = [
    [p.passed, 'passed'],
    [p.failed, 'failed'],
    [p.running, 'running'],
    [p.queued, 'queued'],
    [p.other, 'blocked or cancelled'],
  ]
  return (
    <span className="tnum text-small text-text-secondary">
      {bits
        .filter(([n]) => n > 0)
        .map(([n, w], i) => (
          <span key={w}>
            {i > 0 ? <span className="text-text-muted"> · </span> : null}
            {n} {w}
          </span>
        ))}
      {p.total === 0 ? 'No trials' : null}
    </span>
  )
}

export function CampaignStateBadge({ c }: { c: ArenaCampaignSummary['campaign'] }) {
  const info = campaignStateInfo(c.state, c.pauseReason)
  return (
    <StatusBadge status={info} />
  )
}

export const campaignDuration = (c: ArenaCampaignSummary['campaign'], now: number): string => {
  if (!c.startedAt) return '—'
  const ms = (c.completedAt ? Date.parse(c.completedAt) : now) - Date.parse(c.startedAt)
  return ms < 1000 ? '—' : formatDuration(ms)
}

export function CampaignTable({
  rows,
  onOpen,
  now,
}: {
  rows: readonly ArenaCampaignSummary[]
  onOpen: (id: string) => void
  now: number
}) {
  const columns = useMemo<Column<ArenaCampaignSummary>[]>(
    () => [
      {
        key: 'name',
        header: 'Campaign',
        render: (r) => (
          <span className="block max-w-72 truncate font-medium">{r.campaign.name}</span>
        ),
      },
      { key: 'state', header: 'State', render: (r) => <CampaignStateBadge c={r.campaign} /> },
      {
        key: 'strat',
        header: 'Strategies',
        render: (r) => (
          <span className="text-text-secondary">
            {r.campaign.strategies.map(strategyName).join(', ')}
          </span>
        ),
      },
      {
        key: 'shape',
        header: 'Cases × reps',
        numeric: true,
        render: (r) => `${r.campaign.caseVersionIds.length} × ${r.campaign.repetitions}`,
      },
      {
        key: 'prog',
        header: 'Progress',
        width: '26%',
        render: (r) => {
          const p = campaignProgress(r.counts, r.total)
          return (
            <span className="flex flex-col gap-1">
              <ProgressStrip p={p} />
              <ProgressCounts p={p} />
            </span>
          )
        },
      },
      {
        key: 'started',
        header: 'Started',
        render: (r) =>
          r.campaign.startedAt ? (
            <TimeAgo iso={r.campaign.startedAt} />
          ) : (
            <span className="text-text-muted">{formatRelative(null)}</span>
          ),
      },
      {
        key: 'dur',
        header: 'Duration',
        numeric: true,
        render: (r) => campaignDuration(r.campaign, now),
      },
    ],
    [now],
  )
  return (
    <TableFrame testId="arena-campaigns">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.campaign.id}
        onRowClick={(r) => onOpen(r.campaign.id)}
        rowTestId={(r) => `arena-campaign-row-${r.campaign.id}`}
        caption="Arena campaigns"
      />
    </TableFrame>
  )
}
