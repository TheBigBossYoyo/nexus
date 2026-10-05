import { useMemo } from 'react'
import { EmptyState, StatusDot } from '../../../components/ui'
import { formatSpan, formatTokens } from '../../../lib/format'
import { agentStatus } from '../../../lib/status'
import { useUiStore } from '../../../store/ui'
import { useNow, useRunCtx } from '../runContext'
import { useProviderSessions } from '../../../lib/queries-v6'
import { agentProvider } from '../../providers/providersModel'

const rank = (s: string) => (s === 'working' || s === 'starting' ? 0 : s === 'waiting' || s === 'blocked' ? 1 : 2)

/** Live agent activity: one dense row per agent of this run. */
export function AgentActivityTab() {
  const { detail, tasksById } = useRunCtx()
  const selectAgent = useUiStore((s) => s.selectAgent)
  const selectTask = useUiStore((s) => s.selectTask)
  const setView = useUiStore((s) => s.setView)
  const live = detail.agents.some((a) => a.state === 'working' || a.state === 'starting')
  const now = useNow(live)
  // v0.6: which provider ran each agent. Until a session is recorded the model name alone is shown.
  const providerSessions = useProviderSessions(detail.run.id).data ?? []
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
      <li aria-hidden="true" className="sticky top-0 z-[1] flex items-center gap-3 border-b bg-surface px-4 py-1 text-caption text-text-muted">
        <span className="w-20 shrink-0">State</span>
        <span className="w-20 shrink-0">Role</span>
        <span className="hidden w-28 shrink-0 @[640px]:inline">Provider · model</span>
        <span className="w-16 shrink-0">Task</span>
        <span className="min-w-0 flex-1">Activity</span>
        <span className="hidden w-14 shrink-0 text-right @[440px]:inline">Time</span>
        <span className="hidden w-24 shrink-0 text-right @[520px]:inline">Output</span>
        <span className="w-10 shrink-0" />
      </li>
      {rows.map((a) => {
        const st = agentStatus(a.state)
        const task = a.taskId ? tasksById.get(a.taskId) : undefined
        const provider = agentProvider(providerSessions, a.id)
        return (
          <li key={a.id} className="flex items-center gap-3 border-b px-4 py-1.5 text-small" data-testid={`activity-agent-${a.id}`}>
            <span className="inline-flex w-20 shrink-0 items-center gap-1.5">
              <StatusDot tone={st.tone} />
              <span>{st.label}</span>
            </span>
            <span className="w-20 shrink-0 truncate font-medium" title={a.role}>{a.role}</span>
            <span className="hidden w-28 shrink-0 truncate text-text-muted @[640px]:inline" title={provider ? `${provider.label}${provider.fallbackReason ? `. ${provider.fallbackReason}` : ''}` : undefined} data-testid={`activity-provider-${a.id}`} data-provider={provider?.label ?? ''}>
              {provider ? provider.label : (a.model ?? 'model unknown')}
            </span>
            {task ? (
              <button
                type="button"
                title={task.title}
                className="w-16 shrink-0 truncate text-left font-mono text-code text-accent hover:underline"
                onClick={() => selectTask(task.id)}
              >
                {task.key}
              </button>
            ) : (
              <span className="w-16 shrink-0 truncate text-text-muted">no task</span>
            )}
            <span className="min-w-0 flex-1 truncate text-text-secondary" title={a.activity ?? a.purpose}>{a.activity ?? a.purpose}</span>
            <span className="tnum hidden w-14 shrink-0 text-right @[440px]:inline">{formatSpan(a.startedAt, a.stoppedAt, now)}</span>
            <span className="tnum hidden w-24 shrink-0 text-right text-text-muted @[520px]:inline" title="Observed output tokens">
              {formatTokens(a.metrics.outputTokens)} out
            </span>
            <button
              type="button"
              className="w-10 shrink-0 rounded-sm text-right text-accent hover:underline"
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
