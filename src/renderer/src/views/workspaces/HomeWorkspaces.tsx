import { useWorkspaces } from '../../lib/queries-v5'
import { useUiStore } from '../../store/ui'
import { ArrowRightIcon, Button, Card } from '../../components/ui'
import { plural, workspacesWithActiveMissions } from './workspacesModel'

/** Home section: workspaces with missions in flight. Renders nothing without any (or without the service). */
export function HomeWorkspaces() {
  const q = useWorkspaces()
  const openWorkspace = useUiStore((s) => s.openWorkspace)
  const setView = useUiStore((s) => s.setView)
  const rows = workspacesWithActiveMissions(q.data ?? [])
  if (rows.length === 0) return null
  return (
    <Card
      title="Workspaces"
      data-testid="home-workspaces"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setView('workspaces')}>
          All workspaces
        </Button>
      }
    >
      <ul className="m-0 -mx-2 flex list-none flex-col gap-1 p-0">
        {rows.map((r) => (
          <li key={r.workspace.id}>
            <button
              type="button"
              onClick={() => openWorkspace(r.workspace.id)}
              aria-label={`Open workspace ${r.workspace.name}`}
              data-testid={`home-workspace-${r.workspace.id}`}
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-muted"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.workspace.name}</div>
                <div className="truncate text-small text-text-muted">
                  {plural(r.activeMissions, 'active mission')} across {plural(r.repositories, 'repository', 'repositories')}
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
