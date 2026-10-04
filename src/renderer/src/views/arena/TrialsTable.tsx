import { useMemo, useState } from 'react'
import type { ArenaTrialRow } from '@shared/v3-read'
import { TRIAL_PAGE, useArenaTrials } from '../../lib/queries-v3'
import { formatDuration, formatTokens } from '../../lib/format'
import { Button, DataTable, type Column } from '../../components/ui'
import { BlockSkeleton, ReadError, TableFrame } from '../usage/shared'
import { TrialStateText } from './TrialGlyph'
import { strategyName } from './arenaModel'

/** Paged trial list. Score is a secondary, muted column after the raw hidden-evaluation result. */
export function TrialsTable({
  campaignId,
  caseNames,
  onOpen,
  selected,
}: {
  campaignId: string
  caseNames: ReadonlyMap<string, string>
  onOpen: (trialId: string) => void
  selected: string | null
}) {
  const [page, setPage] = useState(0)
  const q = useArenaTrials(campaignId, page)
  const columns = useMemo<Column<ArenaTrialRow>[]>(
    () => [
      { key: 'ord', header: '#', numeric: true, width: '3rem', render: (r) => r.trial.ordinal + 1 },
      {
        key: 'case',
        header: 'Case',
        render: (r) => (
          <span className="block max-w-64 truncate font-medium">
            {caseNames.get(r.trial.caseId) ?? r.trial.caseId}
          </span>
        ),
      },
      { key: 'strat', header: 'Strategy', render: (r) => strategyName(r.trial.strategy) },
      { key: 'rep', header: 'Rep', numeric: true, render: (r) => r.trial.repetition },
      {
        key: 'state',
        header: 'State',
        render: (r) => <TrialStateText state={r.trial.state} detail />,
      },
      {
        key: 'hidden',
        header: 'Hidden evaluation',
        render: (r) =>
          r.hiddenPassed === null ? (
            <span className="text-text-muted">Not run</span>
          ) : (
            <span className={r.hiddenPassed ? 'text-success' : 'font-medium text-danger'}>
              {r.hiddenPassed ? 'Passed' : 'Failed'}
            </span>
          ),
      },
      {
        key: 'sess',
        header: 'Sessions',
        numeric: true,
        render: (r) => (r.metrics ? r.metrics.sessions : '—'),
      },
      {
        key: 'tok',
        header: 'Observed tokens',
        numeric: true,
        render: (r) =>
          r.metrics
            ? formatTokens((r.metrics.inputTokens ?? 0) + (r.metrics.outputTokens ?? 0))
            : '—',
      },
      {
        key: 'dur',
        header: 'Time',
        numeric: true,
        render: (r) =>
          formatDuration(
            r.metrics?.wallClockMs ??
              (r.trial.startedAt && r.trial.finishedAt
                ? Date.parse(r.trial.finishedAt) - Date.parse(r.trial.startedAt)
                : null),
          ),
      },
      {
        key: 'score',
        header: 'Score',
        numeric: true,
        render: (r) => (
          <span className="text-text-muted">{r.score === null ? '—' : Math.round(r.score)}</span>
        ),
      },
    ],
    [caseNames],
  )
  if (q.isPending) return <BlockSkeleton rows={5} />
  if (q.isError)
    return (
      <ReadError
        error={q.error}
        calm="Trials are not available yet."
        onRetry={() => void q.refetch()}
      />
    )
  const { trials, total } = q.data
  const pages = Math.max(1, Math.ceil(total / TRIAL_PAGE))
  return (
    <div className="flex flex-col gap-2" data-testid="arena-trials">
      <TableFrame>
        <DataTable
          columns={columns}
          rows={trials}
          rowKey={(r) => r.trial.id}
          onRowClick={(r) => onOpen(r.trial.id)}
          selectedKey={selected}
          rowTestId={(r) => `arena-trial-row-${r.trial.id}`}
          caption="Arena trials"
          empty="No trials"
        />
      </TableFrame>
      {pages > 1 ? (
        <div className="flex items-center justify-between text-small text-text-muted">
          <span className="tnum">
            {page * TRIAL_PAGE + 1}–{Math.min(total, (page + 1) * TRIAL_PAGE)} of {total}
          </span>
          <span className="flex gap-1">
            <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  )
}
