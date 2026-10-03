import type { Agent } from '@shared/domain'
import { agentStatus, TONE_CLASSES } from '../../lib/status'
import { cn } from '../../lib/cn'
import { formatCount } from '../../lib/format'
import { StatusDot } from '../../components/ui'
import { agentElapsed, groupAgents, isActiveAgent } from './agentLogic'
import { useNow } from './useNow'

function AgentRow({ agent, selected, now, onSelect }: { agent: Agent; selected: boolean; now: number; onSelect: () => void }) {
  const status = agentStatus(agent.state)
  const active = isActiveAgent(agent)
  return (
    <li>
      <button
        type="button"
        data-testid={`agent-row-${agent.id}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left hover:bg-surface-2',
          selected ? 'border-accent bg-surface-3' : 'border-transparent',
        )}
      >
        <span className="flex items-center gap-1.5">
          <StatusDot tone={status.tone} pulse={agent.state === 'working'} />
          <span className="truncate font-medium">{agent.label}</span>
          {agent.model ? <span className="shrink-0 font-mono text-[0.8rem] text-fg-faint">{agent.model}</span> : null}
          <span className={cn('ml-auto shrink-0 text-[0.85rem]', TONE_CLASSES[status.tone].text)}>{status.label}</span>
        </span>
        <span className="flex items-center gap-2 text-[0.85rem] text-fg-muted">
          <span className="min-w-0 flex-1 truncate">{agent.activity ?? (active ? '—' : (agent.error ?? ''))}</span>
          <span className="shrink-0 font-mono text-fg-faint">
            {agentElapsed(agent, now)} · {formatCount(agent.metrics.toolCalls)} tool calls
          </span>
        </span>
      </button>
    </li>
  )
}

/** Left panel: the run's agents, active ones first. */
export function AgentsPanel({
  agents,
  selectedId,
  onSelect,
}: {
  agents: readonly Agent[]
  selectedId: string | null
  onSelect: (agentId: string) => void
}) {
  const { active, inactive } = groupAgents(agents)
  const now = useNow(active.length > 0)
  const section = (title: string, list: Agent[]) =>
    list.length === 0 ? null : (
      <section>
        <h3 className="m-0 px-3 py-1 text-[0.75rem] font-semibold uppercase tracking-wider text-fg-faint">
          {title} · {list.length}
        </h3>
        <ul className="m-0 list-none p-0">
          {list.map((a) => (
            <AgentRow key={a.id} agent={a} selected={a.id === selectedId} now={now} onSelect={() => onSelect(a.id)} />
          ))}
        </ul>
      </section>
    )
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1" data-testid="agents-panel">
      <div className="flex h-[var(--row-h)] shrink-0 items-center border-b px-3 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">
        Agents
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {section('Active', active)}
        {section('Finished / idle', inactive)}
      </div>
    </div>
  )
}
