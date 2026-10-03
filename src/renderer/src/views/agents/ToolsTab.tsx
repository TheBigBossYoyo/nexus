import { useState } from 'react'
import type { Agent, ToolEvent, ToolEventStatus } from '@shared/domain'
import { assertNever } from '@shared/result'
import { useAgentTools } from '../../lib/queries'
import type { Tone } from '../../lib/status'
import { Badge, EmptyState, ErrorNote, Loading } from '../../components/ui'
import { clockTime, isShellTool, terminalLine, toolInputSummary } from './agentLogic'

function statusTone(status: ToolEventStatus): Tone {
  switch (status) {
    case 'started':
      return 'active'
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'denied':
      return 'warning'
    default:
      return assertNever(status, 'tool status')
  }
}

function ToolRow({ event }: { event: ToolEvent }) {
  const [open, setOpen] = useState(false)
  const shell = isShellTool(event.toolName)
  const preview = event.outputPreview
  return (
    <li data-testid="tool-event" className="border-b px-3 py-1.5">
      <div className="flex items-start gap-2">
        {shell ? (
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[0.92em]">{terminalLine(event)}</code>
        ) : (
          <span className="flex min-w-0 flex-1 gap-2">
            <span className="shrink-0 font-mono text-[0.92em] text-fg-faint">[{clockTime(event.startedAt)}]</span>
            <span className="shrink-0 font-medium">{event.toolName}</span>
            <span className="min-w-0 break-all font-mono text-[0.92em] text-fg-muted">{toolInputSummary(event)}</span>
          </span>
        )}
        <Badge tone={statusTone(event.status)}>{event.status}</Badge>
        {preview ? (
          <button type="button" className="text-[0.85rem] text-accent hover:underline" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide output' : 'Output'}
          </button>
        ) : null}
      </div>
      {open && preview ? (
        <pre className="m-0 mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[3px] border bg-surface-0 p-2 font-mono text-[0.88em] text-fg-muted">
          {preview}
        </pre>
      ) : null}
    </li>
  )
}

export function ToolsTab({ agent }: { agent: Agent }) {
  const query = useAgentTools(agent.id)
  if (query.isPending) return <Loading label="Loading tool calls" />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  if (query.data.length === 0) return <EmptyState title="No tool calls yet" />
  const events = [...query.data].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return (
    <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0" data-testid="agent-tools">
      {events.map((e) => (
        <ToolRow key={e.id} event={e} />
      ))}
    </ul>
  )
}
