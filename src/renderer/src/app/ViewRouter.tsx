import { useEffect, useRef } from 'react'
import { assertNever } from '@shared/result'
import { useUiStore, type View } from '../store/ui'
import { isDialogOpen, shouldFocusMainOnNavigation } from './navFocus'
import { PageHeader } from '../components/ui'
import { HomeView } from '../views/home/HomeView'
import { ProjectsView } from '../views/projects/ProjectsView'
import { RunView } from '../views/run/RunView'
import { AgentsView } from '../views/agents/AgentsView'
import { ProgramsView } from '../views/programs/ProgramsView'
import { WorkspacesView } from '../views/workspaces/WorkspacesView'
import { ArenaView } from '../views/arena/ArenaView'
import { PolicyView } from '../views/policy/PolicyView'
import { ProvidersView } from '../views/providers/ProvidersView'
import { ControlView } from '../views/control/ControlView'
import { UsageView } from '../views/usage/UsageView'
import { OvernightView } from '../views/overnight/OvernightView'
import { ActivityView } from '../views/activity/ActivityView'
import { MemoryView } from '../views/memory/MemoryView'
import { SettingsView } from '../views/settings/SettingsView'
import { AuthView } from '../views/auth/AuthView'
import { PerformanceView } from '../views/performance/PerformanceView'
import { IntelligenceView } from '../views/intelligence/IntelligenceView'
import { KnowledgeView } from '../views/knowledge/KnowledgeView'
import { DirectorView } from '../views/intelligence/DirectorView'
import { ErrorBoundary } from './ErrorBoundary'
import { VIEW_META, VIEWS_WITH_OWN_HEADER } from './nav'

function renderView(view: View) {
  switch (view) {
    case 'home':
      return <HomeView />
    case 'projects':
      return <ProjectsView />
    case 'run':
      return <RunView />
    case 'programs':
      return <ProgramsView />
    case 'workspaces':
      return <WorkspacesView />
    case 'agents':
      return <AgentsView />
    case 'arena':
      return <ArenaView />
    case 'policy':
      return <PolicyView />
    case 'providers':
      return <ProvidersView />
    case 'director':
      return <DirectorView />
    case 'control':
      return <ControlView />
    case 'usage':
      return <UsageView />
    case 'overnight':
      return <OvernightView />
    case 'activity':
      return <ActivityView />
    case 'memory':
      return <MemoryView />
    case 'settings':
      return <SettingsView />
    case 'performance':
      return <PerformanceView />
    case 'intelligence':
      return <IntelligenceView />
    case 'knowledge':
      return <KnowledgeView />
    case 'auth':
      return <AuthView />
    default:
      return assertNever(view, 'view')
  }
}

/**
 * View-state router: no URL, one active view at a time. Views that do not render their own PageHeader
 * (Mission Control, Agents and the other pre-0.3 views) get a default one here, with run controls in Missions.
 */
export function ViewRouter() {
  const view = useUiStore((s) => s.view)
  const meta = VIEW_META[view]
  const own = VIEWS_WITH_OWN_HEADER.includes(view)
  useEffect(() => {
    document.title = `${meta.title} · NEXUS`
  }, [meta.title])
  // After a navigation the focus moves to the main region, so a keyboard or screen-reader user starts at the new
  // view and not on a control of the old one. Not on the first render and not while a dialog is open.
  const previousView = useRef<View | null>(null)
  useEffect(() => {
    if (shouldFocusMainOnNavigation(previousView.current, view, isDialogOpen())) {
      document.getElementById('main-content')?.focus({ preventScroll: true })
    }
    previousView.current = view
  }, [view])
  return (
    <ErrorBoundary resetKey={view}>
      <div className="flex h-full min-h-0 flex-col" data-testid={`view-${view}`}>
        {own ? null : (
          <PageHeader
            title={meta.title}
            {...(meta.context ? { context: meta.context } : {})}
          />
        )}
        <div className="min-h-0 flex-1">{renderView(view)}</div>
      </div>
    </ErrorBoundary>
  )
}
