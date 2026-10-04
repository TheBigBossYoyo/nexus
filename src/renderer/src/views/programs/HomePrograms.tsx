import { useProgramList } from '../../lib/queries-v4'
import { useUiStore } from '../../store/ui'
import { ArrowRightIcon, Button, Card, ProgressBar } from '../../components/ui'
import { activePrograms, progressText } from './programsModel'
import { ProgramStateBadge } from './programsUi'

/** Home section: programs that are doing or about to do work. Renders nothing without any (or without the service). */
export function HomePrograms() {
  const q = useProgramList(null)
  const openProgram = useUiStore((s) => s.openProgram)
  const setView = useUiStore((s) => s.setView)
  const rows = activePrograms(q.data?.programs ?? [])
  if (rows.length === 0) return null
  return (
    <Card
      title="Active programs"
      data-testid="home-programs"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setView('programs')}>
          All programs
        </Button>
      }
    >
      <ul className="m-0 -mx-2 flex list-none flex-col gap-1 p-0">
        {rows.map((r) => (
          <li key={r.program.id}>
            <button
              type="button"
              onClick={() => openProgram(r.program.id)}
              aria-label={`Open program ${r.program.name}`}
              data-testid={`home-program-${r.program.id}`}
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-muted"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{r.program.name}</span>
                  <ProgramStateBadge program={r.program} />
                </div>
                <div className="mt-0.5 truncate text-small text-text-muted">{r.milestones.active ?? 'No current milestone'}</div>
                <div className="mt-1 flex items-center gap-3">
                  <ProgressBar value={r.milestones.completed} max={Math.max(1, r.milestones.total)} label="Milestones completed" className="max-w-64" />
                  <span className="tnum shrink-0 text-small text-text-secondary">{progressText(r.milestones)}</span>
                </div>
              </div>
              <ArrowRightIcon size={14} className="shrink-0 text-text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
