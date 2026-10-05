import type { Agent, AgentSession, Handoff } from '@shared/domain'
import { useAgentDetail } from '../../lib/queries'
import { DASH, formatDateTime } from '../../lib/format'
import { taskStatus } from '../../lib/status'
import { useUiStore } from '../../store/ui'
import { Badge, Button, ErrorNote, KeyValue, Loading, StatusBadge } from '../../components/ui'
import { RoutingSection } from './RoutingSection'

const HANDOFF_SECTIONS: { key: keyof Handoff; label: string }[] = [
  { key: 'completedWork', label: 'Completed work' },
  { key: 'commits', label: 'Commits' },
  { key: 'filesChanged', label: 'Files changed' },
  { key: 'unresolvedIssues', label: 'Unresolved issues' },
  { key: 'importantFindings', label: 'Important findings' },
  { key: 'nextSteps', label: 'Next steps' },
]

function HandoffView({ handoff }: { handoff: Handoff }) {
  return (
    <div className="mt-1 flex flex-col gap-1.5 border-l-2 border-tone-review pl-3" data-testid="session-handoff">
      <div className="text-caption font-medium text-tone-review">Handoff</div>
      {HANDOFF_SECTIONS.map(({ key, label }) => {
        const items = handoff[key]
        if (items.length === 0) return null
        return (
          <div key={key}>
            <div className="text-small text-text-muted">{label}</div>
            <ul className="m-0 list-disc pl-5">
              {items.map((item, i) => (
                <li key={`${i}:${item}`} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function SessionRow({ session }: { session: AgentSession }) {
  return (
    <li className="flex flex-col gap-1 border-b py-2.5" data-testid="agent-session">
      <div className="flex items-center gap-2">
        <Badge tone={session.state === 'active' ? 'active' : session.state === 'failed' ? 'danger' : 'neutral'}>{session.state}</Badge>
        <span className="font-mono text-code">{session.model ?? DASH}</span>
        <span className="tnum ml-auto text-small text-text-muted">{formatDateTime(session.startedAt)}</span>
      </div>
      <KeyValue
        labelWidth="7rem"
        rows={[
          { label: 'Session id', value: session.sdkSessionId ?? DASH, mono: true },
          { label: 'Ended', value: formatDateTime(session.endedAt) },
          { label: 'End reason', value: session.endReason ?? DASH },
        ]}
      />
      {session.handoff ? <HandoffView handoff={session.handoff} /> : null}
    </li>
  )
}

const H = 'm-0 mb-1.5 text-heading font-semibold text-text-primary'

/** Task context, sessions with handoffs and model routing. */
export function SessionTab({ agent }: { agent: Agent }) {
  const query = useAgentDetail(agent.id)
  const openRun = useUiStore((s) => s.openRun)
  const selectTask = useUiStore((s) => s.selectTask)
  const task = query.data?.task ?? null
  const sessions = query.data?.sessions ?? []
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-5" data-testid="agent-session-tab">
      <section data-testid="agent-task">
        <h3 className={H}>Task</h3>
        {query.isPending ? <Loading label="Loading task" /> : null}
        {query.isError ? <ErrorNote error={query.error} /> : null}
        {query.isSuccess && !task ? (
          <div className="text-text-muted">This agent ({agent.purpose}) is not attached to a task.</div>
        ) : null}
        {task ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">{task.title}</span>
              <StatusBadge status={taskStatus(task.state)} />
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => {
                  openRun(task.runId)
                  selectTask(task.id)
                }}
                data-testid="agent-open-task"
              >
                Open task in mission
              </Button>
            </div>
            <KeyValue
              rows={[
                { label: 'Key', value: task.key, mono: true },
                { label: 'Role', value: task.role },
                { label: 'Attempt', value: String(task.attempt), mono: true },
                { label: 'Branch', value: task.branch ?? DASH, mono: true },
              ]}
            />
            {task.acceptanceCriteria.length > 0 ? (
              <ul className="m-0 list-disc pl-5 text-text-secondary">
                {task.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : null}
            {task.error ? <ErrorNote error={`${task.error.what}${task.error.why ? `: ${task.error.why}` : ''}`} /> : null}
          </div>
        ) : null}
      </section>
      <RoutingSection agent={agent} />
      <section>
        <h3 className={H}>Sessions · {sessions.length}</h3>
        {query.isSuccess && sessions.length === 0 ? <div className="text-text-muted">No sessions recorded.</div> : null}
        <ul className="m-0 list-none p-0">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </ul>
      </section>
    </div>
  )
}
