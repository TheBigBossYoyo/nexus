import { useMemo } from 'react'
import type { Run } from '@shared/domain'
import {
  Button,
  DataTable,
  EmptyState,
  ErrorNote,
  PageHeader,
  PlusIcon,
  ProgressBar,
  Skeleton,
  StatusBadge,
  TimeAgo,
  type Column,
} from '../../components/ui'
import { formatSpan } from '../../lib/format'
import { useHomeSummary, useRuns } from '../../lib/queries'
import { runStatus } from '../../lib/status'
import { useCurrentProject } from '../../app/useCurrent'
import { useUiStore } from '../../store/ui'
import { missionTitle } from './missionModel'

interface Row {
  run: Run
  strategy: string | null
  done: number | null
  total: number | null
}

const COLUMNS: readonly Column<Row>[] = [
  { key: 'state', header: 'State', width: '8.5rem', render: (r) => <StatusBadge status={runStatus(r.run.state)} /> },
  {
    key: 'mission',
    header: 'Mission',
    render: (r) => (
      <span className="block min-w-24 max-w-[30ch] truncate font-medium xl:max-w-[64ch]" title={r.run.prompt}>
        {missionTitle(r.run.prompt)}
      </span>
    ),
  },
  { key: 'mode', header: 'Mode', width: '4.5rem', render: (r) => <span className="text-text-secondary">{r.run.mode}</span> },
  {
    key: 'strategy',
    header: 'Strategy',
    width: '6.5rem',
    render: (r) => (r.strategy ? <span className="font-mono text-code">{r.strategy}</span> : <span className="text-text-muted">—</span>),
  },
  {
    key: 'progress',
    header: 'Progress',
    width: '8rem',
    render: (r) =>
      r.total === null || r.done === null ? (
        <span className="text-text-muted">—</span>
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className="tnum w-10 text-small">
            {r.done}/{r.total}
          </span>
          <ProgressBar value={r.done} max={Math.max(1, r.total)} label="Tasks completed" className="w-14" tone={r.run.state === 'completed' ? 'success' : 'accent'} />
        </span>
      ),
  },
  { key: 'created', header: 'Started', width: '5.5rem', render: (r) => <TimeAgo iso={r.run.createdAt} /> },
  { key: 'duration', header: 'Elapsed', width: '5rem', numeric: true, render: (r) => formatSpan(r.run.startedAt, r.run.finishedAt) },
]

/** Shown when no mission is selected: the current project's missions, newest first. */
export function RunsList() {
  const project = useCurrentProject()
  const query = useRuns(project?.id ?? null)
  const summary = useHomeSummary()
  const openRun = useUiStore((s) => s.openRun)
  const setView = useUiStore((s) => s.setView)

  const rows = useMemo<Row[]>(() => {
    // Progress and resolved strategy come from home.summary when it answers; otherwise they stay empty.
    const extra = new Map<string, { strategy: string | null; done: number; total: number }>()
    const s = summary.data
    for (const h of [...(s?.activeRuns ?? []), ...(s?.recentRuns ?? [])]) {
      extra.set(h.run.id, { strategy: h.strategy, done: h.tasksCompleted, total: h.tasksTotal })
    }
    return [...(query.data ?? [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => {
        const e = extra.get(run.id)
        return { run, strategy: e?.strategy ?? null, done: e?.done ?? null, total: e?.total ?? null }
      })
  }, [query.data, summary.data])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="runs-list">
      <PageHeader
        context="Workspace"
        title="Missions"
        actions={
          <Button size="sm" variant="primary" icon={<PlusIcon size={12} />} onClick={() => setView('projects')}>
            New mission
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {query.isPending ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading missions">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : query.isError ? (
          <ErrorNote error={query.error} />
        ) : rows.length === 0 ? (
          <EmptyState title="No mission selected" data-testid="runs-empty">
            {project ? `No missions in ${project.name} yet. ` : 'Open a project, then start a mission. '}
            <button type="button" className="text-accent hover:underline" onClick={() => setView('projects')}>
              Start a mission
            </button>
            .
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-surface" data-testid="runs-table">
            <p className="m-0 border-b px-3 py-2 text-small text-text-muted">
              No mission selected. Pick one to open Mission Control{project ? ` for ${project.name}` : ''}.
            </p>
            <DataTable
              caption="Missions"
              columns={COLUMNS}
              rows={rows}
              rowKey={(r) => r.run.id}
              rowTestId={(r) => `run-row-${r.run.id}`}
              onRowClick={(r) => openRun(r.run.id, r.run.projectId)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
