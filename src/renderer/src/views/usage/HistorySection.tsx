import { useMemo, useState } from 'react'
import type { UsageBreakdownRow } from '@shared/v3'
import { formatCount, formatDuration, formatTokens } from '../../lib/format'
import { useUsageBreakdown } from '../../lib/queries-v3'
import {
  Card,
  DataTable,
  EmptyState,
  SegmentedControl,
  SourceLabel,
  Tabs,
  UsageIcon,
  type Column,
} from '../../components/ui'
import { DailyChart } from './DailyChart'
import {
  BREAKDOWN_TABS,
  HISTORY_RANGES,
  breakdownLabel,
  dailySeries,
  sortBreakdown,
  type BreakdownTab,
  type HistoryRange,
} from './usageViewModel'
import { BlockSkeleton, ReadError, TableFrame } from './shared'

function columns(by: BreakdownTab): Column<UsageBreakdownRow>[] {
  const first = { run: 'Mission', model: 'Model', strategy: 'Strategy', role: 'Role' }[by]
  return [
    {
      key: 'label',
      header: first,
      render: (r) => (
        <span className="block max-w-[28rem] truncate font-medium">{breakdownLabel(by, r)}</span>
      ),
    },
    { key: 'sessions', header: 'Sessions', numeric: true, render: (r) => formatCount(r.sessions) },
    { key: 'turns', header: 'Turns', numeric: true, render: (r) => formatCount(r.turns) },
    { key: 'in', header: 'Input', numeric: true, render: (r) => formatTokens(r.inputTokens) },
    { key: 'out', header: 'Output', numeric: true, render: (r) => formatTokens(r.outputTokens) },
    { key: 'dur', header: 'Duration', numeric: true, render: (r) => formatDuration(r.durationMs) },
    {
      key: 'lim',
      header: 'Limit events',
      numeric: true,
      render: (r) =>
        r.limitEvents > 0 ? r.limitEvents : <span className="text-text-muted">0</span>,
    },
  ]
}

function BreakdownTable({ by, days }: { by: BreakdownTab; days: number }) {
  const q = useUsageBreakdown(by, days)
  const rows = useMemo(() => sortBreakdown(q.data ?? []), [q.data])
  if (q.isPending) return <BlockSkeleton rows={3} />
  if (q.isError)
    return (
      <ReadError
        error={q.error}
        calm="Usage breakdowns are not available yet."
        onRetry={() => void q.refetch()}
      />
    )
  return (
    <TableFrame testId={`usage-breakdown-${by}`}>
      <DataTable
        columns={columns(by)}
        rows={rows}
        rowKey={(r) => r.key}
        caption={`Observed usage ${BREAKDOWN_TABS.find((t) => t.id === by)?.label.toLowerCase()}`}
        empty="No usage observed in this period"
      />
    </TableFrame>
  )
}

export function HistorySection({ today }: { today: Date }) {
  const [days, setDays] = useState<HistoryRange>(30)
  const [tab, setTab] = useState<BreakdownTab>('run')
  const daily = useUsageBreakdown('day', days)
  const points = useMemo(
    () => dailySeries(daily.data ?? [], days, today),
    [daily.data, days, today],
  )
  const any = points.some((p) => p.total > 0 || p.sessions > 0)

  return (
    <Card
      title="History"
      description="Tokens NEXUS observed in its own Claude sessions. This is not account-wide usage."
      data-testid="usage-history"
      actions={
        <div className="flex items-center gap-2">
          <SourceLabel confidence="OBSERVED" source="LOCAL_AGGREGATION" />
          <SegmentedControl
            label="History range"
            size="sm"
            value={String(days) as `${HistoryRange}`}
            onChange={(v) => setDays(Number(v) as HistoryRange)}
            options={HISTORY_RANGES.map((d) => ({
              value: String(d) as `${HistoryRange}`,
              label: `${d} days`,
              testId: `usage-range-${d}`,
            }))}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {daily.isPending ? (
          <BlockSkeleton rows={4} testId="usage-history-loading" />
        ) : daily.isError ? (
          <ReadError
            error={daily.error}
            calm="Usage history is not available yet."
            onRetry={() => void daily.refetch()}
          />
        ) : !any ? (
          <EmptyState
            icon={<UsageIcon size={18} />}
            title="No usage observed yet"
            className="py-8"
            data-testid="usage-history-empty"
          >
            Token counts appear here after NEXUS runs its first Claude session.
          </EmptyState>
        ) : (
          <DailyChart points={points} />
        )}
        {any || daily.isError ? (
          <div className="flex flex-col gap-2">
            <Tabs
              label="Usage breakdown"
              active={tab}
              onChange={setTab}
              tabs={BREAKDOWN_TABS.map((t) => ({
                id: t.id,
                label: t.label,
                testId: `usage-tab-${t.id}`,
              }))}
            />
            <BreakdownTable by={tab} days={days} />
          </div>
        ) : null}
      </div>
    </Card>
  )
}
