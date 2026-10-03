import type { Agent } from '@shared/domain'
import { useAgentDetail } from '../../lib/queries'
import { taskStatus } from '../../lib/status'
import { useUiStore } from '../../store/ui'
import { Button, EmptyState, ErrorNote, KeyValue, Loading, StatusBadge } from '../../components/ui'

export function TaskTab({ agent }: { agent: Agent }) {
  const query = useAgentDetail(agent.id)
  const openRun = useUiStore((s) => s.openRun)
  const selectTask = useUiStore((s) => s.selectTask)
  if (query.isPending) return <Loading label="Loading task" />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  const task = query.data.task
  if (!task) return <EmptyState title="No task">This agent ({agent.purpose}) is not attached to a task.</EmptyState>
  const open = () => {
    openRun(task.runId)
    selectTask(task.id)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3" data-testid="agent-task">
      <div className="flex items-center gap-2">
        <span className="font-medium">{task.title}</span>
        <StatusBadge status={taskStatus(task.state)} />
        <Button size="sm" className="ml-auto" onClick={open} data-testid="agent-open-task">
          Open task in run view
        </Button>
      </div>
      <KeyValue
        rows={[
          { label: 'Key', value: task.key, mono: true },
          { label: 'Role', value: task.role },
          { label: 'Attempt', value: String(task.attempt), mono: true },
          { label: 'Branch', value: task.branch ?? '—', mono: true },
          { label: 'Blocked reason', value: task.blockedReason ?? '—' },
        ]}
      />
      <pre className="m-0 whitespace-pre-wrap break-words font-sans">{task.description}</pre>
      {task.acceptanceCriteria.length > 0 ? (
        <div>
          <div className="mb-1 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">Acceptance criteria</div>
          <ul className="m-0 list-disc pl-5">
            {task.acceptanceCriteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {task.resultSummary ? (
        <div>
          <div className="mb-1 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">Result</div>
          <pre className="m-0 whitespace-pre-wrap break-words font-sans">{task.resultSummary}</pre>
        </div>
      ) : null}
      {task.error ? <ErrorNote error={`${task.error.what}${task.error.why ? `: ${task.error.why}` : ''}`} /> : null}
    </div>
  )
}
