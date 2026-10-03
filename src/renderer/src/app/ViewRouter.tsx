import { assertNever } from '@shared/result'
import { useUiStore, type View } from '../store/ui'
import { ProjectsView } from '../views/projects/ProjectsView'
import { RunView } from '../views/run/RunView'
import { AgentsView } from '../views/agents/AgentsView'
import { MemoryView } from '../views/memory/MemoryView'
import { SettingsView } from '../views/settings/SettingsView'
import { AuthView } from '../views/auth/AuthView'
import { PerformanceView } from '../views/performance/PerformanceView'
import { IntelligenceView } from '../views/intelligence/IntelligenceView'
import { ErrorBoundary } from './ErrorBoundary'

function renderView(view: View) {
  switch (view) {
    case 'projects':
      return <ProjectsView />
    case 'run':
      return <RunView />
    case 'agents':
      return <AgentsView />
    case 'memory':
      return <MemoryView />
    case 'settings':
      return <SettingsView />
    case 'performance':
      return <PerformanceView />
    case 'intelligence':
      return <IntelligenceView />
    case 'auth':
      return <AuthView />
    default:
      return assertNever(view, 'view')
  }
}

/** View-state router: no URL, one active view at a time. */
export function ViewRouter() {
  const view = useUiStore((s) => s.view)
  return (
    <ErrorBoundary resetKey={view}>
      <div className="h-full min-h-0" data-testid={`view-${view}`}>
        {renderView(view)}
      </div>
    </ErrorBoundary>
  )
}
