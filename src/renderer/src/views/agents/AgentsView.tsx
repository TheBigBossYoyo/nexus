// PLACEHOLDER: the agent list, live output and tool timeline are mounted here by the next engineer, who
// replaces this file. Only the run header and the empty/loading states are real.
import { useUiStore } from '../../store/ui'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { useRunDetail } from '../../lib/queries'
import { RunHeader } from '../run/RunHeader'

export function AgentsView() {
  const runId = useUiStore((s) => s.runId)
  const query = useRunDetail(runId)

  if (!runId) return <EmptyState title="No run selected">Agents belong to a run. Select a run first.</EmptyState>
  if (query.isPending) return <Loading label="Loading agents" />
  if (query.isError) return <ErrorNote error={query.error} className="m-4" />
  return (
    <div className="flex h-full flex-col" data-testid="agents-view">
      <RunHeader detail={query.data} />
      <div className="p-4 text-fg-muted" data-testid="agents-view-placeholder">
        Agent panels are being mounted.
      </div>
    </div>
  )
}
