import { useMemo } from 'react'
import { EmptyState, StatusText } from '../../../components/ui'
import { formatSpan } from '../../../lib/format'
import { taskStatus } from '../../../lib/status'
import { latestAgentOf, useNow, useRunCtx } from '../runContext'

/** Dense table alternative to the graph. Better than a canvas for large runs; same selection model. */
export function TaskList({ selectedTaskId, onSelect }: { selectedTaskId: string | null; onSelect: (taskId: string) => void }) {
  const { detail, tasksById } = useRunCtx()
  const { tasks, dependencies, agents } = detail
  const live = tasks.some((t) => t.startedAt !== null && t.finishedAt === null)
  const now = useNow(live)
  const depsOf = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const d of dependencies) {
      const key = tasksById.get(d.dependsOnTaskId)?.key
      if (!key) continue
      m.set(d.taskId, [...(m.get(d.taskId) ?? []), key])
    }
    return m
  }, [dependencies, tasksById])
  const rows = useMemo(() => [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key)), [tasks])

  if (rows.length === 0) return <EmptyState title="No tasks yet" className="h-full" />
  return (
    <div className="h-full overflow-auto" data-testid="task-list">
      <table className="w-full border-collapse text-left text-body">
        <thead>
          <tr className="text-caption text-text-muted">
            {['Task', 'State', 'Role · model', 'After', 'Elapsed'].map((h) => (
              <th key={h} scope="col" className="sticky top-0 z-[1] h-7 border-b bg-surface px-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const selected = t.id === selectedTaskId
            const agent = latestAgentOf(agents, t.id)
            return (
              <tr
                key={t.id}
                tabIndex={0}
                aria-selected={selected}
                data-testid={`task-row-${t.key}`}
                data-state={t.state}
                onClick={() => onSelect(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(t.id)
                  }
                }}
                className={`cursor-pointer border-b hover:bg-surface-muted ${selected ? 'bg-accent-subtle hover:bg-accent-subtle' : ''}`}
              >
                <td className="px-3 py-1.5">
                  <div className="font-medium">{t.title}</div>
                  <div className="font-mono text-code text-text-muted">{t.key}</div>
                </td>
                <td className="px-3 py-1.5">
                  <StatusText status={taskStatus(t.state)} />
                </td>
                <td className="px-3 py-1.5 text-text-secondary">
                  {t.role} · <span className="font-mono text-code">{agent?.model ?? 'no agent yet'}</span>
                </td>
                <td className="px-3 py-1.5 font-mono text-code text-text-muted">{(depsOf.get(t.id) ?? []).join(', ') || '—'}</td>
                <td className="tnum px-3 py-1.5">{formatSpan(t.startedAt, t.finishedAt, now)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
