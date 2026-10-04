import { useMemo } from 'react'
import { EmptyState, StatusDot } from '../../../components/ui'
import { formatSpan, formatTokens } from '../../../lib/format'
import { agentStatus } from '../../../lib/status'
import { useUiStore } from '../../../store/ui'
import { useNow, useRunCtx } from '../runContext'

const rank = (s: string) => (s === 'working' || s === 'starting' ? 0 : s === 'waiting' || s === 'blocked' ? 1 : 2)

/** Live agent activity: one dense row per agent of this run. */
export function AgentActivityTab() {
  const { detail, tasksById } = useRunCtx()
  const selectAgent = useUiStore((s) => s.selectAgent)
  const selectTask = useUiStore((s) => s.selectTask)
  const setView = useUiStore((s) => s.setView)
  const live = detail.agents.some((a) => a.state === 'working' || a.state === 'starting')
  const now = useNow(live)
  const rows = useMemo(
    () => [...detail.agents].sort((a, b) => rank(a.state) - rank(b.state) || b.createdAt.localeCompare(a.createdAt)),
    [detail.agents],
  )
  if (rows.length === 0)
    return (
      <EmptyState title="No agents yet" className="py-6">
        Agents appear here as soon as the mission starts work.
      </EmptyState>
    )
  return (
    <ul className="@container m-0 h-full list-none overflow-y-auto overflow-x-hidden p-0" data-testid="agent-activity">
      {rows.map((a) => {
        const st = agentStatus(a.state)
        const task = a.taskId ? tasksById.get(a.taskId) : undefined
        return (
          <li key={a.id} className="flex items-center gap-3 border-b px-4 py-1.5 text-small" data-testid={`activity-agent-${a.id}`}>
            <span className="inline-flex w-20 shrink-0 items-center gap-1.5">
              <StatusDot tone={st.tone} />
              <span>{st.label}</span>
            </span>
            <span className="w-20 shrink-0 truncate font-medium">{a.role}</span>
            <span className="hidden w-28 shrink-0 truncate text-text-muted @[640px]:inline">{a.model ?? 'model unknown'}</span>
            {task ? (
              <button
                type="button"
                className="w-16 shrink-0 truncate text-left font-mono text-code text-accent hover:underline"
                onClick={() => selectTask(task.id)}
              >
                {task.key}
              </button>
            ) : (
              <span className="w-16 shrink-0 truncate text-text-muted">no task</span>
            )}
            <span className="min-w-0 flex-1 truncate text-text-secondary">{a.activity ?? a.purpose}</span>
            <span className="tnum hidden w-14 shrink-0 text-right @[440px]:inline">{formatSpan(a.startedAt, a.stoppedAt, now)}</span>
            <span className="tnum hidden w-24 shrink-0 text-right text-text-muted @[520px]:inline" title="Observed output tokens">
              {formatTokens(a.metrics.outputTokens)} out
            </span>
            <button
              type="button"
              className="shrink-0 rounded-sm px-1.5 text-accent hover:underline"
              onClick={() => {
                selectAgent(a.id)
                setView('agents')
              }}
            >
              Open
            </button>
          </li>
        )
      })}
    </ul>
  )
}
