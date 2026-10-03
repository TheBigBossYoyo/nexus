import type { ReactNode } from 'react'
import { useOpenProject, useRuns } from '../lib/queries'
import { runStatus } from '../lib/status'
import { cn } from '../lib/cn'
import { useUiStore, type View } from '../store/ui'
import {
  AgentsIcon,
  Button,
  FolderIcon,
  MemoryIcon,
  PlusIcon,
  RunsIcon,
  SettingsIcon,
  StatusDot,
  TimeAgo,
} from '../components/ui'
import { useCurrentProject } from './useCurrent'

const NAV: { view: View; label: string; icon: ReactNode; shortcut: string }[] = [
  { view: 'projects', label: 'Projects', icon: <FolderIcon />, shortcut: '1' },
  { view: 'run', label: 'Runs', icon: <RunsIcon />, shortcut: '2' },
  { view: 'agents', label: 'Agents', icon: <AgentsIcon />, shortcut: '3' },
  { view: 'memory', label: 'Memory', icon: <MemoryIcon />, shortcut: '4' },
  { view: 'settings', label: 'Settings', icon: <SettingsIcon />, shortcut: '5' },
]

function RecentRuns() {
  const project = useCurrentProject()
  const runs = useRuns(project?.id ?? null)
  const selectedRunId = useUiStore((s) => s.runId)
  const view = useUiStore((s) => s.view)
  const openRun = useUiStore((s) => s.openRun)
  if (!project) return null
  const recent = [...(runs.data ?? [])]
    .filter((r) => r.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
  return (
    <div className="min-h-0 flex-1 overflow-auto border-t pt-2">
      <div className="px-3 pb-1 text-[0.75rem] font-semibold uppercase tracking-wider text-fg-faint">
        Runs · {project.name}
      </div>
      {recent.length === 0 ? (
        <div className="px-3 py-1 text-fg-faint">No runs yet</div>
      ) : (
        <ul className="m-0 list-none p-0">
          {recent.map((r) => {
            const st = runStatus(r.state)
            return (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid={`sidebar-run-${r.id}`}
                  onClick={() => openRun(r.id, r.projectId)}
                  title={r.prompt}
                  className={cn(
                    'flex w-full flex-col gap-0.5 border-l-2 px-3 py-1 text-left hover:bg-surface-2',
                    r.id === selectedRunId && view === 'run' ? 'border-accent bg-surface-2' : 'border-transparent',
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <StatusDot tone={st.tone} />
                    <span className="font-mono text-[0.8rem] uppercase text-fg-muted">{r.mode}</span>
                    <span className="text-[0.8rem] text-fg-faint">{st.label}</span>
                    <TimeAgo iso={r.createdAt} className="ml-auto text-[0.8rem] text-fg-faint" />
                  </span>
                  <span className="truncate">{r.prompt}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function Sidebar() {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const selectProject = useUiStore((s) => s.selectProject)
  const open = useOpenProject()

  const openProject = async () => {
    const project = await open.mutateAsync({})
    if (project) {
      selectProject(project.id)
      setView('projects')
    }
  }

  return (
    <nav className="flex h-full min-h-0 flex-col bg-surface-1" aria-label="Primary">
      <div className="p-2">
        <Button
          className="w-full"
          icon={<PlusIcon size={12} />}
          loading={open.isPending}
          onClick={() => void openProject().catch(() => undefined)}
          data-testid="sidebar-open-project"
        >
          New Project / Open
        </Button>
      </div>
      <ul className="m-0 list-none p-0 pb-2">
        {NAV.map((n) => (
          <li key={n.view}>
            <button
              type="button"
              data-testid={`nav-${n.view}`}
              aria-current={view === n.view ? 'page' : undefined}
              onClick={() => setView(n.view)}
              className={cn(
                'flex h-[var(--row-h)] w-full items-center gap-2 border-l-2 px-3 text-left',
                view === n.view ? 'border-accent bg-surface-3 text-fg' : 'border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {n.icon}
              <span className="flex-1">{n.label}</span>
              <span className="font-mono text-[0.75rem] text-fg-faint">Ctrl {n.shortcut}</span>
            </button>
          </li>
        ))}
      </ul>
      <RecentRuns />
    </nav>
  )
}
