import type { ReactNode } from 'react'
import { useUiStore } from '../../store/ui'
import { Button, EmptyState, ErrorNote, Loading, PageHeader } from '../../components/ui'
import { useRunDetail } from '../../lib/queries'
import { AgentDetail } from './AgentDetail'
import { AgentsPanel } from './AgentsPanel'
import { groupAgentsByState } from './agentLogic'

function Page({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agents-page">
      <PageHeader
        title="Agents"
        context="Workspace"
        {...(count !== undefined ? { actions: <span className="text-small text-text-muted">{count} in this mission</span> } : {})}
      />
      <div className="@container min-h-0 flex-1">{children}</div>
    </div>
  )
}

export function AgentsView() {
  const runId = useUiStore((s) => s.runId)
  const agentId = useUiStore((s) => s.agentId)
  const selectAgent = useUiStore((s) => s.selectAgent)
  const setView = useUiStore((s) => s.setView)
  const query = useRunDetail(runId)

  if (!runId)
    return (
      <Page>
        <EmptyState
          title="No mission selected"
          className="h-full"
          action={
            <Button size="sm" onClick={() => setView('run')}>
              Open missions
            </Button>
          }
        >
          Agents belong to a mission. Select one to see who is working on it.
        </EmptyState>
      </Page>
    )
  if (query.isPending)
    return (
      <Page>
        <Loading label="Loading agents" />
      </Page>
    )
  if (query.isError)
    return (
      <Page>
        <ErrorNote error={query.error} className="m-4" />
      </Page>
    )

  const { agents } = query.data
  if (agents.length === 0) {
    return (
      <Page count={0}>
        <EmptyState title="No agents yet" className="h-full">
          Agents appear here once the mission starts executing tasks.
        </EmptyState>
      </Page>
    )
  }
  // A stale selection (from another run) falls back to the first working agent, else the first listed one.
  const groups = groupAgentsByState(agents)
  const selected = agents.find((a) => a.id === agentId) ?? groups[0]?.agents[0] ?? null

  return (
    <Page count={agents.length}>
      <div className="flex h-full min-h-0 flex-col @3xl:flex-row" data-testid="agents-view">
        <div className="h-[38%] min-h-32 shrink-0 border-b bg-surface @3xl:h-auto @3xl:min-h-0 @3xl:w-[340px] @3xl:border-b-0 @3xl:border-r">
          <AgentsPanel agents={agents} selectedId={selected?.id ?? null} onSelect={selectAgent} />
        </div>
        <div className="min-h-0 min-w-0 flex-1 bg-surface">{selected ? <AgentDetail key={selected.id} agent={selected} /> : null}</div>
      </div>
    </Page>
  )
}
