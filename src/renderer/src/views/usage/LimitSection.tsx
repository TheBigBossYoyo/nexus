import { useMemo } from 'react'
import { formatDateTime, formatDuration } from '../../lib/format'
import { useUsageLimitHistory } from '../../lib/queries-v3'
import { Card, DataTable, EmptyState, StatusDot, UsageIcon, type Column } from '../../components/ui'
import { clockText } from '../../lib/usageModel'
import { limitRows, type LimitRow } from './usageViewModel'
import { BlockSkeleton, LoadMore, ReadError, TableFrame } from './shared'

const columns = (now: number): Column<LimitRow>[] => [
  {
    key: 'at',
    header: 'When',
    render: (r) => (
      <time dateTime={r.at} title={formatDateTime(r.at)} className="tnum whitespace-nowrap">
        {clockText(r.at, now)}
      </time>
    ),
  },
  {
    key: 'run',
    header: 'Run',
    render: (r) => (
      <span className="block max-w-44 truncate" title={r.run}>
        {r.run}
      </span>
    ),
  },
  {
    key: 'state',
    header: 'State',
    render: (r) => (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <StatusDot tone={r.tone} />
        {r.state}
      </span>
    ),
  },
  {
    key: 'reset',
    header: 'Reset',
    render: (r) =>
      r.resetAt ? (
        <span className="tnum whitespace-nowrap" title={formatDateTime(r.resetAt)}>
          {clockText(r.resetAt, now)}
        </span>
      ) : (
        <span className="whitespace-nowrap text-text-muted">Not reported</span>
      ),
  },
  {
    key: 'paused',
    header: 'Paused for',
    numeric: true,
    render: (r) => (r.pausedMs === null ? '—' : formatDuration(r.pausedMs)),
  },
  {
    key: 'probes',
    header: 'Checks',
    render: (r) =>
      r.kind === 'signal' ? (
        <span className="text-text-muted">—</span>
      ) : r.probes === 0 ? (
        <span className="text-text-muted">None</span>
      ) : (
        <span>
          <span className="tnum">{r.probes}</span>
          {r.methods.length > 0 ? (
            <span className="text-text-muted"> · {r.methods.join(', ')}</span>
          ) : null}
        </span>
      ),
  },
  {
    key: 'result',
    header: 'Result',
    render: (r) => <span className="text-text-secondary">{r.result}</span>,
  },
]

export function LimitSection({ now }: { now: number }) {
  const q = useUsageLimitHistory()
  const rows = useMemo(() => limitRows(q.data?.pages ?? [], now), [q.data, now])

  let body
  if (q.isPending) body = <BlockSkeleton rows={3} testId="usage-limits-loading" />
  else if (q.isError)
    body = (
      <ReadError
        error={q.error}
        calm="Limit history is not available yet."
        onRetry={() => void q.refetch()}
      />
    )
  else if (rows.length === 0)
    body = (
      <EmptyState
        icon={<UsageIcon size={18} />}
        title="No limit events"
        className="py-8"
        data-testid="usage-limits-empty"
      >
        Claude has not reported a usage limit while NEXUS was watching.
      </EmptyState>
    )
  else
    body = (
      <>
        <TableFrame>
          <DataTable
            columns={columns(now)}
            rows={rows}
            rowKey={(r) => r.id}
            caption="Limit events"
            rowTestId={(r) => `usage-limit-${r.id}`}
          />
        </TableFrame>
        {q.hasNextPage ? (
          <LoadMore onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage} />
        ) : null}
      </>
    )

  return (
    <Card
      title="Limit events"
      description="Usage limits and the automatic recovery that followed."
      data-testid="usage-limits"
      padded
    >
      {body}
    </Card>
  )
}
