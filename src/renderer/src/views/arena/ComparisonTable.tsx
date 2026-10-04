import { useMemo } from 'react'
import type { StrategyComparisonRow } from '@shared/v3'
import { formatCount, formatDuration, formatTokens } from '../../lib/format'
import { Badge, DataTable, type Column } from '../../components/ui'
import { TableFrame } from '../usage/shared'
import {
  evidenceText,
  evidenceTone,
  intervalText,
  meanText,
  passText,
  sortComparison,
  strategyName,
} from './arenaModel'

const columns: Column<StrategyComparisonRow>[] = [
  {
    key: 's',
    header: 'Strategy',
    render: (r) => <span className="font-medium">{strategyName(r.strategy)}</span>,
  },
  {
    key: 'pass',
    header: 'Passed',
    numeric: true,
    render: (r) => passText(r.passed, r.n, r.passRate),
  },
  {
    key: 'int',
    header: '95% interval',
    numeric: true,
    render: (r) => intervalText(r.passInterval),
  },
  {
    key: 'time',
    header: 'Median time',
    numeric: true,
    render: (r) => formatDuration(r.medianWallClockMs),
  },
  { key: 'sess', header: 'Mean sessions', numeric: true, render: (r) => meanText(r.meanSessions) },
  {
    key: 'tok',
    header: 'Mean observed tokens',
    numeric: true,
    render: (r) => formatTokens(r.meanObservedTokens),
  },
  { key: 'rep', header: 'Mean repairs', numeric: true, render: (r) => meanText(r.meanRepairs) },
  {
    key: 'find',
    header: 'Critical / high findings',
    numeric: true,
    render: (r) =>
      r.criticalHighFindings > 0 ? (
        <span className="font-medium text-danger">{r.criticalHighFindings}</span>
      ) : (
        <span className="text-text-muted">0</span>
      ),
  },
  {
    key: 'quota',
    header: 'Quota pauses',
    numeric: true,
    render: (r) => formatCount(r.quotaPauses),
  },
  {
    key: 'label',
    header: 'Evidence',
    render: (r) => <Badge tone={evidenceTone(r.label)}>{evidenceText(r.label)}</Badge>,
  },
]

/** The strategy comparison. Raw pass counts and the interval come first; ordering follows correctness, never cost. */
export function ComparisonTable({
  rows,
  testId,
  caption = 'Strategy comparison',
}: {
  rows: readonly StrategyComparisonRow[]
  testId?: string
  caption?: string
}) {
  const sorted = useMemo(() => sortComparison(rows), [rows])
  return (
    <TableFrame testId={testId}>
      <DataTable
        columns={columns}
        rows={sorted}
        rowKey={(r) => r.strategy}
        caption={caption}
        empty="No finished trials yet"
      />
    </TableFrame>
  )
}
