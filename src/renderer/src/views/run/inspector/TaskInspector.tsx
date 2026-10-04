import { useMemo, type ReactNode } from 'react'
import type { Task } from '@shared/domain'
import { Badge, EmptyState, ErrorNote, Loading, Tabs, type TabItem } from '../../../components/ui'
import { formatDateTime, formatDuration } from '../../../lib/format'
import { useContextPacks, useMessages, useTaskDiff, useTaskReviews, useTaskVerifications } from '../../../lib/queries'
import { groupPackSections } from '../../../lib/v2logic'
import { useUiStore } from '../../../store/ui'
import { CommandBlock, MessageRow, ReviewCard, VerificationCard } from '../blocks'
import { DiffView } from '../DiffView'
import { describeEvent, eventTone } from '../eventText'
import { clockTimeSeconds, useRunCtx } from '../runContext'
import { StatusDot } from '../../../components/ui'
import { OverviewTab } from './OverviewTab'

export const INSPECTOR_TABS = ['overview', 'context', 'diff', 'messages', 'review', 'verification', 'history'] as const
export type InspectorTab = (typeof INSPECTOR_TABS)[number]

const LABELS: Record<InspectorTab, string> = {
  overview: 'Overview',
  context: 'Context',
  diff: 'Files',
  messages: 'Messages',
  review: 'Review',
  verification: 'Verification',
  history: 'History',
}

const TAB_ITEMS: readonly TabItem<InspectorTab>[] = INSPECTOR_TABS.map((id) => ({
  id,
  label: LABELS[id],
  // The Files tab keeps the id of the old Diff tab.
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
  if (message) return <div className="p-3 text-text-secondary">{message}</div>
  return <>{children(query.data)}</>
}

/** Files: the task's changed files and diff viewer (keeps the old Diff tab content). */
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
      <QueryBody query={diff}>{(d) => <DiffView diff={d} findings={findings} ownerOf={() => [task.key]} testId="task-diff" />}</QueryBody>
    </div>
  )
}

function ReviewTab({ task }: { task: Task }) {
  const query = useTaskReviews(task.id)
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="inspector-review">
      <QueryBody query={query} empty={(r) => (r.length === 0 ? 'No review has been recorded for this task yet.' : null)}>
        {(reviews) => [...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => <ReviewCard key={r.id} review={r} />)}
      </QueryBody>
    </div>
  )
}

function VerificationTab({ task }: { task: Task }) {
  const query = useTaskVerifications(task.id)
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="inspector-verification">
      <QueryBody query={query} empty={(all) => (all.length === 0 ? 'No checks or verifier result for this task yet.' : null)}>
        {(all) => {
          const checks = all.filter((v) => v.kind === 'checks').sort((x, y) => y.createdAt.localeCompare(x.createdAt))
          const verifiers = all.filter((v) => v.kind === 'verifier').sort((x, y) => y.createdAt.localeCompare(x.createdAt))
          return (
            <>
              <section className="flex flex-col gap-2" data-testid="inspector-checks">
                <h3 className="m-0 text-caption font-semibold uppercase tracking-wide text-text-muted">Check commands</h3>
                {checks.length === 0 ? <p className="m-0 text-small text-text-muted">No check commands have run for this task yet.</p> : null}
                {checks.map((v) => (
                  <div key={v.id} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <Badge tone={v.passed ? 'success' : 'danger'}>{v.passed ? 'Passed' : 'Failed'}</Badge>
                      <span className="text-text-secondary">attempt {v.attempt}</span>
                      <span className="text-text-muted">{formatDateTime(v.createdAt)}</span>
                      <span className="text-text-muted">{formatDuration(v.commands.reduce((sum, c) => sum + c.durationMs, 0))} total</span>
                    </div>
                    {v.commands.length === 0 ? <div className="text-text-secondary">{v.summary || 'No commands were configured.'}</div> : null}
                    {v.commands.map((c, i) => (
                      <CommandBlock key={`${c.name}-${i}`} result={c} at={v.createdAt} />
                    ))}
                  </div>
                ))}
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="m-0 text-caption font-semibold uppercase tracking-wide text-text-muted">Verifier evidence</h3>
                {verifiers.length === 0 ? <p className="m-0 text-small text-text-muted">No verifier result for this task yet.</p> : null}
                {verifiers.map((v) => (
                  <VerificationCard key={v.id} verification={v} label={task.key} />
                ))}
              </section>
            </>
          )
        }}
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

function ContextTab({ task }: { task: Task }) {
  const { agentsById } = useRunCtx()
  const query = useContextPacks({ taskId: task.id })
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="inspector-context">
      <QueryBody query={query} empty={(p) => (p.length === 0 ? 'No context was composed for this task yet. Packs are recorded when an agent session starts.' : null)}>
        {(packs) =>
          [...packs]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((pack) => {
              const agent = pack.agentId ? agentsById.get(pack.agentId) : undefined
              const sections = groupPackSections(pack)
              return (
                <article key={pack.id} className="flex flex-col gap-2 border bg-surface p-2" data-testid="context-pack">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge mono>{pack.purpose}</Badge>
                    <span className="font-medium">{agent?.label ?? (pack.agentId ? 'agent' : 'no agent')}</span>
                    <span className="font-mono text-[0.88em] text-text-secondary">{pack.totalChars.toLocaleString()} chars</span>
                    <span className="ml-auto text-text-muted">{formatDateTime(pack.createdAt)}</span>
                  </div>
                  {sections.length === 0 ? <div className="text-text-muted">The pack has no entries.</div> : null}
                  {sections.map((s) => (
                    <section key={s.section} className="flex flex-col gap-0.5" data-testid="context-section" data-section={s.section}>
                      <h4 className="m-0 text-caption font-semibold uppercase tracking-wide text-text-muted">
                        {s.section}
                        <span className="ml-1.5 font-mono font-normal normal-case tracking-normal text-text-muted">
                          {s.includedCount} included{s.excludedCount > 0 ? `, ${s.excludedCount} excluded` : ''}, {s.includedChars.toLocaleString()} chars
                        </span>
                      </h4>
                      <ul className="m-0 flex list-none flex-col p-0">
                        {s.entries.map((e) => (
                          <li
                            key={e.id}
                            className={`flex flex-col gap-0.5 border-b py-1 ${e.included ? '' : 'opacity-70'}`}
                            data-testid="context-entry"
                            data-included={e.included ? 'true' : 'false'}
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge tone={e.included ? 'success' : 'neutral'}>{e.included ? 'included' : 'excluded'}</Badge>
                              <span className="min-w-0 break-words font-medium">{e.title}</span>
                              <span className="font-mono text-[0.85em] text-text-muted">{e.sourceKind.replace(/_/g, ' ')}</span>
                              <span className="ml-auto font-mono text-[0.85em] text-text-muted">{e.chars.toLocaleString()} chars</span>
                            </div>
                            <div className="whitespace-pre-wrap break-words text-text-secondary">{e.reason}</div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </article>
              )
            })
        }
      </QueryBody>
    </div>
  )
}

function HistoryTab({ task }: { task: Task }) {
  const { events } = useRunCtx()
  const mine = useMemo(() => events.filter((e) => e.taskId === task.id), [events, task.id])
  if (mine.length === 0) return <div className="p-3 text-text-secondary" data-testid="inspector-history">No events recorded for this task yet.</div>
  return (
    <ol className="m-0 list-none p-0" data-testid="inspector-history">
      {mine.map((e) => (
        <li key={e.seq} className="flex items-baseline gap-2 border-b px-3 py-1" data-testid="history-row" data-type={e.type}>
          <span className="shrink-0 font-mono text-[0.88em] text-text-muted">{clockTimeSeconds(e.createdAt)}</span>
          <StatusDot tone={eventTone(e)} />
          <span className="min-w-0 flex-1 break-words">{describeEvent(e)}</span>
        </li>
      ))}
    </ol>
  )
}

export function TaskInspector({ task }: { task: Task | null }) {
  const stored = useUiStore((s) => s.inspectorTab)
  const setTab = useUiStore((s) => s.setInspectorTab)
  const tab: InspectorTab = isInspectorTab(stored) ? stored : 'overview'

  if (!task) {
    return (
      <div className="h-full bg-surface" data-testid="task-inspector">
        <EmptyState title="No task selected">Select a task in the graph or list to see its details, files, checks and reviews.</EmptyState>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-testid="task-inspector" data-task-id={task.id}>
      <Tabs tabs={TAB_ITEMS} active={tab} onChange={setTab} label="Task inspector" className="overflow-x-auto overflow-y-hidden px-2 [&::-webkit-scrollbar]:h-1" />
      <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
        {tab === 'overview' ? <OverviewTab task={task} /> : null}
        {tab === 'context' ? <ContextTab task={task} /> : null}
        {tab === 'diff' ? <DiffTab task={task} /> : null}
        {tab === 'messages' ? <MessagesTab task={task} /> : null}
        {tab === 'review' ? <ReviewTab task={task} /> : null}
        {tab === 'verification' ? <VerificationTab task={task} /> : null}
        {tab === 'history' ? <HistoryTab task={task} /> : null}
      </div>
    </div>
  )
}
