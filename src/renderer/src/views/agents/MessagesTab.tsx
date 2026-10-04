import type { Agent } from '@shared/domain'
import { useMessages } from '../../lib/queries'
import { severityStatus } from '../../lib/status'
import { Badge, EmptyState, ErrorNote, Loading, TimeAgo } from '../../components/ui'
import { messageDirection } from './agentLogic'

export function MessagesTab({ agent }: { agent: Agent }) {
  const query = useMessages(agent.taskId ? agent.runId : null, agent.taskId ?? undefined)
  if (!agent.taskId) return <EmptyState title="No task">This agent has no task, so there are no task messages.</EmptyState>
  if (query.isPending) return <Loading label="Loading messages" />
  if (query.isError) return <ErrorNote error={query.error} className="m-4" />
  if (query.data.length === 0) return <EmptyState title="No messages for this task" />
  return (
    <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0" data-testid="agent-messages">
      {query.data.map((m) => {
        const dir = messageDirection(m, agent)
        return (
          <li key={m.id} className="flex flex-col gap-1 border-b px-5 py-2.5">
            <div className="flex items-center gap-2">
              <Badge tone={dir === 'sent' ? 'active' : 'neutral'}>{dir}</Badge>
              <Badge mono>{m.type}</Badge>
              {m.severity ? <Badge tone={severityStatus(m.severity).tone}>{m.severity}</Badge> : null}
              <span className="text-text-secondary">
                {m.fromLabel} → {m.toLabel}
              </span>
              <TimeAgo iso={m.createdAt} className="ml-auto text-text-muted" />
            </div>
            <div className="font-medium">{m.subject}</div>
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-text-secondary">{m.body}</pre>
          </li>
        )
      })}
    </ul>
  )
}
