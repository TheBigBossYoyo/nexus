import { useMemo } from 'react'
import type { Run } from '@shared/domain'
import { DataTable, EmptyState, ErrorNote, Loading, StatusBadge, TimeAgo, type Column } from '../../components/ui'
import { formatSpan } from '../../lib/format'
import { useRuns } from '../../lib/queries'
import { runStatus } from '../../lib/status'
import { useCurrentProject } from '../../app/useCurrent'
import { useUiStore } from '../../store/ui'

const COLUMNS: readonly Column<Run>[] = [
  { key: 'state', header: 'State', width: '9.5rem', render: (r) => <StatusBadge status={runStatus(r.state)} /> },
  { key: 'mode', header: 'Mode', width: '5.5rem', mono: true, render: (r) => r.mode },
  {
    key: 'prompt',
    header: 'Prompt',
    render: (r) => (
      <span className="block max-w-[60ch] truncate" title={r.prompt}>
        {r.prompt}
      </span>
    ),
  },
  { key: 'created', header: 'Created', width: '7rem', render: (r) => <TimeAgo iso={r.createdAt} /> },
  { key: 'duration', header: 'Duration', width: '6.5rem', align: 'right', mono: true, render: (r) => formatSpan(r.startedAt, r.finishedAt) },
]

/** Shown when no run is selected: the current project's runs, newest first. */
export function RunsList() {
  const project = useCurrentProject()
  const query = useRuns(project?.id ?? null)
  const openRun = useUiStore((s) => s.openRun)
  const setView = useUiStore((s) => s.setView)
  const rows = useMemo(() => [...(query.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [query.data])

  if (query.isPending) return <Loading label="Loading runs" />
  if (query.isError) return <ErrorNote error={query.error} className="m-4" />
  return (
    <div className="flex h-full flex-col" data-testid="runs-list">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-surface-1 px-3">
        <h1 className="m-0 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">Runs</h1>
        {project ? <span className="text-fg-faint">{project.name}</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="runs-table">
        {rows.length === 0 ? (
          <EmptyState title="No runs yet">
            Runs appear here once a mission is started.{' '}
            <button type="button" className="text-accent hover:underline" onClick={() => setView('projects')}>
              Start a mission
            </button>
            .
          </EmptyState>
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.id}
            rowTestId={(r) => `run-row-${r.id}`}
            onRowClick={(r) => openRun(r.id, r.projectId)}
          />
        )}
      </div>
    </div>
  )
}
