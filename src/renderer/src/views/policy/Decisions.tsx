import { useMemo } from 'react'
import type { PolicyDecision } from '@shared/v3'
import { useUiStore } from '../../store/ui'
import { usePolicyDecisions } from '../../lib/queries-v3'
import { shortId } from '../../lib/format'
import { Badge, Card, DataTable, EmptyState, TimeAgo, type Column } from '../../components/ui'
import { BlockSkeleton, LoadMore, ReadError, TableFrame } from '../usage/shared'
import { strategyName } from '../arena/arenaModel'
import { LAYER_LABEL, formatContextKey } from './policyModel'

export function Decisions() {
  const q = usePolicyDecisions()
  const openRun = useUiStore((s) => s.openRun)
  const rows = useMemo(() => q.data?.pages.flat() ?? [], [q.data])
  const columns: Column<PolicyDecision>[] = [
    {
      key: 'at',
      header: 'When',
      render: (d) => <TimeAgo iso={d.createdAt} className="whitespace-nowrap" />,
    },
    {
      key: 'run',
      header: 'Mission',
      mono: true,
      render: (d) => (d.runId ? shortId(d.runId) : '—'),
    },
    {
      key: 'ctx',
      header: 'Context',
      render: (d) => <span className="whitespace-nowrap">{formatContextKey(d.contextKey)}</span>,
    },
    {
      key: 'strat',
      header: 'Strategy',
      render: (d) => <span className="font-medium">{strategyName(d.strategy)}</span>,
    },
    {
      key: 'layer',
      header: 'Decided by',
      render: (d) => (
        <Badge tone={d.layer === 'user' ? 'active' : 'neutral'}>{LAYER_LABEL[d.layer]}</Badge>
      ),
    },
    {
      key: 'exp',
      header: 'Exploration',
      render: (d) =>
        d.exploration ? (
          <Badge tone="waiting">Exploring</Badge>
        ) : (
          <span className="text-text-muted">No</span>
        ),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (d) => <span className="line-clamp-2 max-w-md text-text-secondary">{d.reason}</span>,
    },
  ]
  return (
    <Card
      title="Recent decisions"
      description="How the policy chose a strategy for recent missions. Select a row to open the mission."
      data-testid="policy-decisions"
    >
      {q.isPending ? (
        <BlockSkeleton rows={4} />
      ) : q.isError ? (
        <ReadError
          error={q.error}
          calm="Decisions are not available yet."
          onRetry={() => void q.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="No decisions yet" className="py-6">
          Each mission started with the Adaptive strategy records why a strategy was chosen.
        </EmptyState>
      ) : (
        <>
          <TableFrame>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(d) => d.id}
              onRowClick={(d) => d.runId && openRun(d.runId, d.projectId ?? undefined)}
              rowTestId={(d) => `policy-decision-${d.id}`}
              caption="Recent policy decisions"
            />
          </TableFrame>
          {q.hasNextPage ? (
            <LoadMore
              onClick={() => void q.fetchNextPage()}
              loading={q.isFetchingNextPage}
              children="Load older"
            />
          ) : null}
        </>
      )}
    </Card>
  )
}
