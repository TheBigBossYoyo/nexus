import { useMemo } from 'react'
import type { SecurityDecisionRecord } from '@shared/security'
import { useSecurityDecisions } from '../../lib/queries-security'
import { shortId } from '../../lib/format'
import { Badge, Card, DataTable, EmptyState, TimeAgo, type Column } from '../../components/ui'
import { BlockSkeleton, LoadMore, ReadError, TableFrame } from '../usage/shared'
import { DECISION_LABEL, DECISION_TONE, PROVENANCE_LABEL, TRUST_LABEL } from './securityModel'

/**
 * "Why was this blocked?": the newest security decisions, optionally for one mission. Refusals, approval
 * requests and logged allowances only; a plain allow of a read-only command is not recorded.
 */
export function SecurityDecisions({ runId = null }: { runId?: string | null }) {
  const q = useSecurityDecisions(runId)
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.decisions) ?? [], [q.data])
  const columns: Column<SecurityDecisionRecord>[] = [
    { key: 'at', header: 'When', render: (d) => <TimeAgo iso={d.timestamp} className="whitespace-nowrap" /> },
    { key: 'decision', header: 'Decision', render: (d) => <Badge tone={DECISION_TONE[d.decision]}>{DECISION_LABEL[d.decision]}</Badge> },
    { key: 'action', header: 'Action', mono: true, render: (d) => <span className="line-clamp-2 max-w-sm break-all">{d.action}</span> },
    { key: 'class', header: 'Classification', render: (d) => <span className="whitespace-nowrap">{TRUST_LABEL[d.classification]}</span> },
    { key: 'prov', header: 'Provenance', render: (d) => <span className="whitespace-nowrap text-text-secondary">{PROVENANCE_LABEL[d.provenance]}</span> },
    { key: 'reason', header: 'Reason', render: (d) => <span className="line-clamp-3 max-w-md text-text-secondary">{d.reason}</span> },
    { key: 'run', header: 'Mission', mono: true, render: (d) => (d.runId ? shortId(d.runId) : '-') },
  ]
  return (
    <Card
      title="Why was this blocked?"
      description="Commands and scripts NEXUS refused, asked about or let through with a log entry. NEXUS inspects them before they run; this is not a sandbox."
      data-testid="security-decisions"
    >
      {q.isPending ? (
        <BlockSkeleton rows={4} />
      ) : q.isError ? (
        <ReadError error={q.error} calm="The security log is not available yet." onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing recorded" className="py-6">
          No command or script has been refused, held for approval or logged yet.
        </EmptyState>
      ) : (
        <>
          <TableFrame>
            <DataTable columns={columns} rows={rows} rowKey={(d) => d.id} rowTestId={(d) => `security-decision-${d.id}`} caption="Recent security decisions" />
          </TableFrame>
          {q.hasNextPage ? <LoadMore onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>Load older</LoadMore> : null}
        </>
      )}
    </Card>
  )
}
