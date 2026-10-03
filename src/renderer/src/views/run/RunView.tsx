// PLACEHOLDER: the run workspace panels (task graph, inspector, diff, reviews, events) are mounted here by
// the next engineer, who replaces this file. Only the header and the empty/loading states are real.
import { useUiStore } from '../../store/ui'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { useRunDetail } from '../../lib/queries'
import { RunHeader } from './RunHeader'

export function RunView() {
  const runId = useUiStore((s) => s.runId)
  const setView = useUiStore((s) => s.setView)
  const query = useRunDetail(runId)

  if (!runId) {
    return (
      <EmptyState title="No run selected">
        Pick a run from the sidebar, or{' '}
        <button type="button" className="text-accent hover:underline" onClick={() => setView('projects')}>
          start a mission
        </button>
        .
      </EmptyState>
    )
  }
  if (query.isPending) return <Loading label="Loading run" />
  if (query.isError) return <ErrorNote error={query.error} className="m-4" />
  return (
    <div className="flex h-full flex-col" data-testid="run-view">
      <RunHeader detail={query.data} />
      <div className="p-4 text-fg-muted" data-testid="run-view-placeholder">
        Run panels are being mounted.
      </div>
    </div>
  )
}
