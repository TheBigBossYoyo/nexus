import { useEffect, useState } from 'react'
import { programHealth, type ProgramSummary } from '@shared/program'
import { useProjects } from '../../lib/queries'
import { useProgramList } from '../../lib/queries-v4'
import { useNow } from '../../lib/useNow'
import { useUiStore } from '../../store/ui'
import { ArrowRightIcon, Button, Card, EmptyState, PageHeader, PlusIcon, ProgramsIcon, ProgressBar, TimeAgo } from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import { BackgroundCard } from './BackgroundCard'
import { NewProgramDialog } from './NewProgramDialog'
import { ProgramPage } from './ProgramPage'
import { progressText, windowTextAt } from './programsModel'
import { HealthBadge, ProgramStateBadge } from './programsUi'

function ProgramRow({ row, projectName, now, onOpen }: { row: ProgramSummary; projectName: string | null; now: number; onOpen: (id: string) => void }) {
  const p = row.program
  const health = programHealth(p, row.window)
  const window = windowTextAt(p, now)
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(p.id)}
        aria-label={`Open program ${p.name}`}
        data-testid={`program-row-${p.id}`}
        data-state={p.state}
        className="flex w-full items-start gap-3 rounded-lg border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-muted"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-heading font-semibold">{p.name}</span>
            <ProgramStateBadge program={p} />
            <HealthBadge level={health.level} />
            {projectName ? <span className="text-small text-text-muted">{projectName}</span> : null}
          </div>
          <p className="m-0 mt-0.5 truncate text-text-secondary" title={p.goal.statement}>
            {p.goal.statement}
          </p>
          <p className="m-0 mt-0.5 text-small text-text-muted">{health.reason}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-small text-text-secondary">
            <span className="flex min-w-44 items-center gap-2">
              <ProgressBar value={row.milestones.completed} max={Math.max(1, row.milestones.total)} label="Milestones completed" className="w-24" tone={p.state === 'COMPLETED' ? 'success' : 'accent'} />
              <span className="tnum" data-testid={`program-progress-${p.id}`}>
                {progressText(row.milestones)}
              </span>
            </span>
            <span className="min-w-0 truncate">
              <span className="text-text-muted">Current milestone </span>
              {row.milestones.active ?? 'None'}
            </span>
            <span>
              <span className="text-text-muted">Work window </span>
              {window ?? 'None'}
            </span>
            <span className="tnum">
              <span className="text-text-muted">Open backlog </span>
              {row.backlogOpen}
            </span>
            <span className="text-text-muted">
              Updated <TimeAgo iso={p.updatedAt} />
            </span>
          </div>
        </div>
        <ArrowRightIcon size={14} className="mt-1.5 shrink-0 text-text-muted" />
      </button>
    </li>
  )
}

/** Programs: long-running engineering goals pursued milestone by milestone. A program opens in place of the list. */
export function ProgramsView() {
  const [programId, setProgramId] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)
  const programs = useProgramList(null)
  const projects = useProjects()
  const requested = useUiStore((s) => s.programId)
  const openProgram = useUiStore((s) => s.openProgram)
  const now = useNow(true, 30_000)
  // Home (and other pages) can ask for a program page; consume the request once.
  useEffect(() => {
    if (!requested) return
    setProgramId(requested)
    openProgram(null)
  }, [requested, openProgram])

  if (programId)
    return (
      <div className="h-full" data-testid="programs-view">
        <ProgramPage programId={programId} onBack={() => setProgramId(null)} />
      </div>
    )

  const rows = programs.data?.programs ?? []
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]))
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="programs-view">
      <PageHeader
        title="Programs"
        context="Workspace"
        actions={
          <Button size="sm" variant="primary" icon={<PlusIcon size={12} />} onClick={() => setDialog(true)} data-testid="programs-new">
            New program
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-5">
          {programs.isPending ? (
            <BlockSkeleton rows={4} testId="programs-loading" />
          ) : programs.isError ? (
            <div data-testid="programs-error">
              <ReadError error={programs.error} calm="Programs are not available in this build yet." onRetry={() => void programs.refetch()} />
            </div>
          ) : rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={<ProgramsIcon size={22} />}
                title="No programs yet"
                data-testid="programs-empty"
                action={
                  <Button variant="primary" icon={<PlusIcon size={12} />} onClick={() => setDialog(true)} data-testid="programs-empty-new">
                    New program
                  </Button>
                }
              >
                A program pursues one engineering goal across several milestones: NEXUS plans them, runs a mission for each, verifies the result and reassesses the plan as it goes. The work stays on a
                program branch until you merge it.
              </EmptyState>
            </Card>
          ) : (
            <section className="flex flex-col gap-2" aria-label="Programs">
              <div className="flex items-end justify-between">
                <h2 className="m-0 text-heading font-semibold">All programs</h2>
                <span className="tnum text-small text-text-muted">{programs.data?.total ?? rows.length} total</span>
              </div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="programs-list">
                {rows.map((r) => (
                  <ProgramRow key={r.program.id} row={r} projectName={names.get(r.program.projectId) ?? null} now={now} onOpen={setProgramId} />
                ))}
              </ul>
            </section>
          )}
          <BackgroundCard />
        </div>
      </div>
      <NewProgramDialog open={dialog} onClose={() => setDialog(false)} onCreated={setProgramId} />
    </div>
  )
}
