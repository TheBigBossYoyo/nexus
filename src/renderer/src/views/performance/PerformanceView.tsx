import { useState } from 'react'
import type { PerformanceStat } from '@shared/v2'
import { useCurrentProject } from '../../app/useCurrent'
import { usePerformanceSummary } from '../../lib/queries'
import { DASH, formatDateTime, formatDuration } from '../../lib/format'
import { formatRate, insufficientLabel, performanceRowKey } from '../../lib/v2logic'
import { Badge, DataTable, EmptyState, ErrorNote, Loading, PerformanceIcon, Select, type Column } from '../../components/ui'

type Scope = 'project' | 'all'

function Recent({ stat }: { stat: PerformanceStat }) {
  if (stat.recent.length === 0) return <span className="text-fg-faint">{DASH}</span>
  return (
    <span className="inline-flex items-center gap-0.5" data-testid="performance-recent">
      {stat.recent.map((r) => {
        const tone = !r.completed ? 'bg-tone-danger' : r.firstPassVerified ? 'bg-tone-success' : 'bg-tone-waiting'
        const label = !r.completed ? 'not completed' : r.firstPassVerified ? 'completed, first pass' : 'completed after rework'
        return (
          <span
            key={`${r.taskId}:${r.createdAt}`}
            className={`inline-block size-2 rounded-[2px] ${tone}`}
            title={`${label}, ${formatDateTime(r.createdAt)}`}
          />
        )
      })}
    </span>
  )
}

function columns(minSamples: number): Column<PerformanceStat>[] {
  const rate =
    (pick: (s: PerformanceStat) => number): Column<PerformanceStat>['render'] =>
    (s) => <span className={s.sufficient ? '' : 'text-fg-muted'}>{formatRate(pick(s), s.samples)}</span>
  return [
    { key: 'role', header: 'Role', render: (s) => s.role },
    { key: 'model', header: 'Model', render: (s) => s.model, mono: true },
    { key: 'category', header: 'Category', render: (s) => s.category },
    {
      key: 'samples',
      header: 'Samples',
      align: 'right',
      mono: true,
      render: (s) => (
        <span className="inline-flex flex-col items-end gap-0.5">
          <span>{s.samples}</span>
          {s.sufficient ? null : (
            <Badge tone="waiting" data-testid="insufficient-badge">
              {insufficientLabel(s, minSamples)}
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'first', header: 'First pass', align: 'right', mono: true, render: rate((s) => s.firstPassRate) },
    { key: 'completion', header: 'Completed', align: 'right', mono: true, render: rate((s) => s.completionRate) },
    { key: 'rejection', header: 'Review rejected', align: 'right', mono: true, render: rate((s) => s.reviewRejectionRate) },
    { key: 'repairs', header: 'Avg repairs', align: 'right', mono: true, render: (s) => `${s.averageRepairs.toFixed(1)} (n=${s.samples})` },
    { key: 'checks', header: 'Check failures', align: 'right', mono: true, render: rate((s) => s.checkFailureRate) },
    { key: 'intervention', header: 'Intervention', align: 'right', mono: true, render: rate((s) => s.interventionRate) },
    { key: 'elapsed', header: 'Avg elapsed', align: 'right', mono: true, render: (s) => formatDuration(s.averageElapsedMs) },
    { key: 'recent', header: 'Recent', render: (s) => <Recent stat={s} /> },
  ]
}

/** Measured outcomes per role, model and task category. Rates always carry their sample count. */
export function PerformanceView() {
  const project = useCurrentProject()
  const [scope, setScope] = useState<Scope>('project')
  const query = usePerformanceSummary(scope === 'project' ? (project?.id ?? null) : null)

  const stats = [...(query.data?.stats ?? [])].sort(
    (a, b) =>
      Number(b.sufficient) - Number(a.sufficient) || b.samples - a.samples || performanceRowKey(a).localeCompare(performanceRowKey(b)),
  )
  const minSamples = query.data?.minSamples ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="performance-view">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-surface-1 px-3 py-2">
        <h1 className="m-0 mr-2 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">Performance</h1>
        <Select
          aria-label="Scope"
          className="w-52"
          value={scope}
          onChange={setScope}
          data-testid="performance-scope"
          options={[
            { value: 'project', label: project ? `Project: ${project.name}` : 'Current project', disabled: !project },
            { value: 'all', label: 'All projects' },
          ]}
        />
        {query.data ? (
          <span className="ml-auto font-mono text-[0.88em] text-fg-faint" data-testid="performance-total">
            {query.data.totalOutcomes} task outcomes · rows need at least {minSamples} samples to count as reliable
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {query.isPending ? (
          <Loading label="Loading performance" />
        ) : query.isError ? (
          <ErrorNote error={query.error} className="m-3" />
        ) : stats.length === 0 ? (
          <EmptyState title="No performance data yet" icon={<PerformanceIcon size={22} />} className="h-full">
            Statistics accumulate from completed tasks. Each finished implementation task records its role, the model that ran it,
            whether it passed review and verification the first time, repairs, failed checks and elapsed time.
          </EmptyState>
        ) : (
          <div data-testid="performance-table" className="min-w-[72rem]">
            <DataTable
              columns={columns(minSamples)}
              rows={stats}
              rowKey={performanceRowKey}
              rowTestId={(s) => `performance-row-${performanceRowKey(s)}`}
            />
            <p className="m-0 px-3 py-2 text-[0.85rem] text-fg-faint">
              Rates are fractions of the samples in that row, shown as whole percents with their sample count. Rows below {minSamples}{' '}
              samples are marked as insufficient. Recent outcomes: green passed first time, amber completed after rework, red not completed.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
