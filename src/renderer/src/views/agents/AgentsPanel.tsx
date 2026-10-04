import type { Agent } from '@shared/domain'
import { agentStatus } from '../../lib/status'
import { cn } from '../../lib/cn'
import { formatCount, formatTokens } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import { StatusBadge } from '../../components/ui'
import { agentActivityLine, agentElapsed, claudeModelLabel, groupAgentsByState, isActiveAgent, observedTokens } from './agentLogic'

function AgentRow({ agent, selected, now, onSelect }: { agent: Agent; selected: boolean; now: number; onSelect: () => void }) {
  const status = agentStatus(agent.state)
  const tokens = observedTokens(agent.metrics)
  return (
    <li>
      <button
        type="button"
        data-testid={`agent-row-${agent.id}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'group flex w-full flex-col gap-1 border-b px-4 py-2 text-left transition-colors hover:bg-surface-muted',
          selected && 'bg-accent-subtle hover:bg-accent-subtle',
        )}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{agent.label}</span>
          <StatusBadge status={status} className="shrink-0" />
        </span>
        <span className="truncate text-small text-text-secondary" title={agentActivityLine(agent)}>
          {agentActivityLine(agent)}
        </span>
        <span className="tnum flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-text-muted">
          <span>{claudeModelLabel(agent.model)}</span>
          <span>{agentElapsed(agent, now)}</span>
          <span>
            {formatCount(agent.metrics.turns)} {agent.metrics.turns === 1 ? 'turn' : 'turns'}
          </span>
          <span title="Observed input + output tokens">{formatTokens(tokens)} tokens</span>
          <span className="ml-auto text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">Open</span>
        </span>
      </button>
    </li>
  )
}

/** Left panel: the mission's agents grouped by what they are doing. */
export function AgentsPanel({
  agents,
  selectedId,
  onSelect,
}: {
  agents: readonly Agent[]
  selectedId: string | null
  onSelect: (agentId: string) => void
}) {
  const groups = groupAgentsByState(agents)
  const now = useNow(agents.some(isActiveAgent))
  return (
    <nav aria-label="Agents" className="flex h-full min-h-0 flex-col overflow-auto" data-testid="agents-panel">
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label}>
          <h3 className="sticky top-0 z-[1] m-0 border-b bg-surface-muted px-4 py-1.5 text-caption font-medium text-text-muted">
            {g.label} · {g.agents.length}
          </h3>
          <ul className="m-0 list-none p-0">
            {g.agents.map((a) => (
              <AgentRow key={a.id} agent={a} selected={a.id === selectedId} now={now} onSelect={() => onSelect(a.id)} />
            ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}
