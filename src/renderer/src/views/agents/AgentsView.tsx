import { useUiStore } from '../../store/ui'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { useRunDetail } from '../../lib/queries'
import { AgentDetail } from './AgentDetail'
import { AgentsPanel } from './AgentsPanel'
import { groupAgents } from './agentLogic'

export function AgentsView() {
  const runId = useUiStore((s) => s.runId)
  const agentId = useUiStore((s) => s.agentId)
  const selectAgent = useUiStore((s) => s.selectAgent)
  const query = useRunDetail(runId)

  if (!runId) return <EmptyState title="No run selected">Agents belong to a run. Select a run first.</EmptyState>
  if (query.isPending) return <Loading label="Loading agents" />
  if (query.isError) return <ErrorNote error={query.error} className="m-4" />

  const { agents } = query.data
  if (agents.length === 0) {
    return (
      <EmptyState title="No agents yet" className="h-full">
        Agents appear here once the run starts executing tasks.
      </EmptyState>
    )
  }
  // A stale selection (from another run) falls back to the first active agent, else the first agent.
  const { active, inactive } = groupAgents(agents)
  const selected = agents.find((a) => a.id === agentId) ?? active[0] ?? inactive[0] ?? null

  return (
    <div className="flex h-full min-h-0" data-testid="agents-view">
      <div className="w-[320px] shrink-0 border-r">
        <AgentsPanel agents={agents} selectedId={selected?.id ?? null} onSelect={selectAgent} />
      </div>
      <div className="min-w-0 flex-1">{selected ? <AgentDetail key={selected.id} agent={selected} /> : null}</div>
    </div>
  )
}
