import { useMemo, type ReactNode } from 'react'
import type { Task } from '@shared/domain'
import { Badge, EmptyState, ErrorNote, Loading, StatusBadge, Tabs, type TabItem } from '../../../components/ui'
import { formatDateTime, formatDuration } from '../../../lib/format'
import { agentStatus } from '../../../lib/status'
import { useMessages, useTaskDiff, useTaskReviews, useTaskVerifications } from '../../../lib/queries'
import { useUiStore } from '../../../store/ui'
import { CommandBlock, CriteriaList, MessageRow, ReviewCard, VerificationCard } from '../blocks'
import { DiffView } from '../DiffView'
import { useRunCtx } from '../runContext'
import { OverviewTab } from './OverviewTab'

export const INSPECTOR_TABS = ['overview', 'criteria', 'agents', 'diff', 'checks', 'review', 'verification', 'messages'] as const
export type InspectorTab = (typeof INSPECTOR_TABS)[number]

const LABELS: Record<InspectorTab, string> = {
  overview: 'Overview',
  criteria: 'Criteria',
  agents: 'Agents',
  diff: 'Diff',
  checks: 'Checks',
  review: 'Review',
  verification: 'Verification',
  messages: 'Messages',
}

const TAB_ITEMS: readonly TabItem<InspectorTab>[] = INSPECTOR_TABS.map((id) => ({
  id,
  label: LABELS[id],
  testId: `inspector-tab-${id}`,
}))

function isInspectorTab(v: string): v is InspectorTab {
  return (INSPECTOR_TABS as readonly string[]).includes(v)
}

function QueryBody<T>({
  query,
  children,
  empty,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined }
  children: (data: T) => ReactNode
  empty?: (data: T) => string | null
}) {
  if (query.isPending) return <Loading />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  if (query.data === undefined) return null
  const message = empty?.(query.data) ?? null
  if (message) return <div className="p-3 text-fg-muted">{message}</div>
  return <>{children(query.data)}</>
}

function CriteriaTab({ task }: { task: Task }) {
  const { detail } = useRunCtx()
  const criteria = detail.criteria.filter((c) => c.taskId === task.id)
  return (
    <div className="p-3" data-testid="inspector-criteria">
      {criteria.length === 0 && task.acceptanceCriteria.length > 0 ? (
        <ul className="m-0 list-disc pl-5">
          {task.acceptanceCriteria.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ) : (
        <CriteriaList criteria={criteria} emptyText="This task has no acceptance criteria." />
      )}
    </div>
  )
}

function AgentsTab({ task }: { task: Task }) {
  const { detail } = useRunCtx()
  const selectAgent = useUiStore((s) => s.selectAgent)
  const setView = useUiStore((s) => s.setView)
  const agents = detail.agents.filter((a) => a.taskId === task.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (agents.length === 0) return <div className="p-3 text-fg-muted">No agent has worked on this task yet.</div>
  return (
    <ul className="m-0 list-none p-0" data-testid="inspector-agents">
      {agents.map((a) => (
        <li key={a.id} className="border-b">
          <button
            type="button"
            className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface-2"
            data-testid={`task-agent-${a.id}`}
            onClick={() => {
              selectAgent(a.id)
              setView('agents')
            }}
          >
            <span className="flex items-center gap-2">
              <span className="font-medium">{a.label}</span>
              <Badge mono>{a.role}</Badge>
              <span className="text-fg-muted">{a.purpose}</span>
              <span className="ml-auto">
                <StatusBadge status={agentStatus(a.state)} />
              </span>
            </span>
            <span className="flex gap-3 font-mono text-[0.88em] text-fg-muted">
              <span>{a.model ?? 'model unknown'}</span>
              <span>turns {a.metrics.turns}</span>
              <span>tool calls {a.metrics.toolCalls}</span>
            </span>
            {a.error ? <span className="text-tone-danger">{a.error}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

function DiffTab({ task }: { task: Task }) {
  const diff = useTaskDiff(task.id)
  const reviews = useTaskReviews(task.id)
  const findings = useMemo(() => {
    const all = reviews.data ?? []
    const latest = all.reduce<(typeof all)[number] | null>((best, r) => (!best || r.createdAt >= best.createdAt ? r : best), null)
    return latest?.findings ?? []
  }, [reviews.data])
  return (
    <div className="p-3" data-testid="inspector-diff">
      <QueryBody query={diff}>
        {(d) => <DiffView diff={d} findings={findings} ownerOf={() => [task.key]} testId="task-diff" />}
      </QueryBody>
    </div>
  )
}

function ChecksTab({ task }: { task: Task }) {
  const query = useTaskVerifications(task.id)
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="inspector-checks">
      <QueryBody
        query={query}
        empty={(all) => (all.some((v) => v.kind === 'checks') ? null : 'No check commands have run for this task yet.')}
      >
        {(all) =>
          all
            .filter((v) => v.kind === 'checks')
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((v) => (
              <section key={v.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Badge tone={v.passed ? 'success' : 'danger'}>{v.passed ? 'Passed' : 'Failed'}</Badge>
                  <span className="text-fg-muted">attempt {v.attempt}</span>
                  <span className="text-fg-faint">{formatDateTime(v.createdAt)}</span>
                  <span className="text-fg-faint">
                    {formatDuration(v.commands.reduce((sum, c) => sum + c.durationMs, 0))} total
                  </span>
                </div>
                {v.commands.length === 0 ? <div className="text-fg-muted">{v.summary || 'No commands were configured.'}</div> : null}
                {v.commands.map((c, i) => (
                  <CommandBlock key={`${c.name}-${i}`} result={c} at={v.createdAt} />
                ))}
              </section>
            ))
        }
      </QueryBody>
    </div>
  )
}

function ReviewTab({ task }: { task: Task }) {
  const query = useTaskReviews(task.id)
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="inspector-review">
      <QueryBody query={query} empty={(r) => (r.length === 0 ? 'No review has been recorded for this task yet.' : null)}>
        {(reviews) =>
          [...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => <ReviewCard key={r.id} review={r} />)
        }
      </QueryBody>
    </div>
  )
}

function VerificationTab({ task }: { task: Task }) {
  const query = useTaskVerifications(task.id)
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="inspector-verification">
      <QueryBody
        query={query}
        empty={(all) => (all.some((v) => v.kind === 'verifier') ? null : 'No verifier result for this task yet.')}
      >
        {(all) =>
          all
            .filter((v) => v.kind === 'verifier')
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((v) => <VerificationCard key={v.id} verification={v} label={task.key} />)
        }
      </QueryBody>
    </div>
  )
}

function MessagesTab({ task }: { task: Task }) {
  const query = useMessages(task.runId, task.id)
  return (
    <div data-testid="inspector-messages">
      <QueryBody query={query} empty={(m) => (m.length === 0 ? 'No messages to or from this task.' : null)}>
        {(messages) => messages.map((m) => <MessageRow key={m.id} message={m} />)}
      </QueryBody>
    </div>
  )
}

export function TaskInspector({ task }: { task: Task | null }) {
  const stored = useUiStore((s) => s.inspectorTab)
  const setTab = useUiStore((s) => s.setInspectorTab)
  const tab: InspectorTab = isInspectorTab(stored) ? stored : 'overview'

  if (!task) {
    return (
      <div className="h-full bg-surface-1" data-testid="task-inspector">
        <EmptyState title="No task selected">Select a node in the graph to inspect its details, diff, checks and reviews.</EmptyState>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1" data-testid="task-inspector" data-task-id={task.id}>
      <Tabs tabs={TAB_ITEMS} active={tab} onChange={setTab} className="overflow-x-auto px-1" />
      <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
        {tab === 'overview' ? <OverviewTab task={task} /> : null}
        {tab === 'criteria' ? <CriteriaTab task={task} /> : null}
        {tab === 'agents' ? <AgentsTab task={task} /> : null}
        {tab === 'diff' ? <DiffTab task={task} /> : null}
        {tab === 'checks' ? <ChecksTab task={task} /> : null}
        {tab === 'review' ? <ReviewTab task={task} /> : null}
        {tab === 'verification' ? <VerificationTab task={task} /> : null}
        {tab === 'messages' ? <MessagesTab task={task} /> : null}
      </div>
    </div>
  )
}
