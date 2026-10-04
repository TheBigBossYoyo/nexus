import { useMemo } from 'react'
import type { Review, Task } from '@shared/domain'
import { Badge, Button, ErrorNote, Loading } from '../../../components/ui'
import { formatDateTime } from '../../../lib/format'
import { useDecisions, useMessages, useReviews, useRunDiff, useTaskDiffs, useVerifications } from '../../../lib/queries'
import { CriteriaList, MessageRow, ReviewCard, VerificationCard } from '../blocks'
import { DiffView } from '../DiffView'
import { normalizePath, ownersByPath } from '../diffModel'
import { toolActivityFromEvents, type ToolActivityRow } from '../eventText'
import { clockTimeSeconds, useRunCtx } from '../runContext'
import { useStickyScroll } from '../useStickyScroll'

function Empty({ children }: { children: string }) {
  return <div className="p-3 text-text-secondary">{children}</div>
}

function taskKeyOf(tasksById: ReadonlyMap<string, Task>, taskId: string | null): string {
  return taskId ? (tasksById.get(taskId)?.key ?? 'task') : 'mission'
}

export function CommunicationsTab() {
  const { detail } = useRunCtx()
  const query = useMessages(detail.run.id)
  const messages = useMemo(() => [...(query.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [query.data])
  const { ref, pinned, onScroll, jumpToLatest } = useStickyScroll<HTMLDivElement>(messages.length)
  if (query.isPending) return <Loading />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  return (
    <div className="relative h-full" data-testid="communications">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-auto">
        {messages.length === 0 ? <Empty>No agent or user messages yet.</Empty> : messages.map((m) => <MessageRow key={m.id} message={m} />)}
      </div>
      {!pinned ? (
        <Button size="sm" className="absolute bottom-2 right-3" onClick={jumpToLatest}>
          Jump to latest
        </Button>
      ) : null}
    </div>
  )
}

const TOOL_RENDER_CAP = 500

const TOOL_STATUS: Record<ToolActivityRow['status'], { label: string; tone: 'active' | 'success' | 'danger' | 'warning' }> = {
  running: { label: 'running', tone: 'active' },
  ok: { label: 'ok', tone: 'success' },
  error: { label: 'error', tone: 'danger' },
  denied: { label: 'denied', tone: 'warning' },
}

/** Structured command log across all agents, built from the durable tool events of the run. */
export function ToolActivityTab() {
  const { events, agentsById } = useRunCtx()
  const rows = useMemo(() => toolActivityFromEvents(events), [events])
  const shown = rows.length > TOOL_RENDER_CAP ? rows.slice(-TOOL_RENDER_CAP) : rows
  const { ref, onScroll } = useStickyScroll<HTMLDivElement>(rows.length)
  return (
    <div ref={ref} onScroll={onScroll} className="h-full overflow-auto" data-testid="tool-activity">
      {rows.length === 0 ? (
        <Empty>No tool calls yet.</Empty>
      ) : (
        <>
          {rows.length > shown.length ? (
            <div className="px-3 py-1 text-text-muted">Showing the latest {shown.length} of {rows.length} tool calls.</div>
          ) : null}
          <ul className="m-0 list-none p-0 font-mono text-small">
            {shown.map((r) => {
              const s = TOOL_STATUS[r.status]
              const agent = r.agentId ? agentsById.get(r.agentId) : undefined
              return (
                <li key={r.key} className="flex items-baseline gap-2 border-b px-3 py-0.5" data-testid="tool-row" data-status={r.status}>
                  <span className="shrink-0 text-text-muted">[{clockTimeSeconds(r.at)}]</span>
                  <span className="shrink-0 text-text-secondary">{agent?.label ?? 'agent'}</span>
                  <span className="shrink-0 text-text-muted">&gt;</span>
                  <span className="shrink-0 text-accent">{r.toolName}</span>
                  <span className="min-w-0 flex-1 break-all">{r.summary}</span>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

function latestFindings(reviews: readonly Review[]) {
  const latest = new Map<string, Review>()
  for (const r of reviews) {
    const prev = latest.get(r.taskId)
    if (!prev || r.createdAt >= prev.createdAt) latest.set(r.taskId, r)
  }
  return [...latest.values()].flatMap((r) => r.findings)
}

/** Integration-branch diff, with the task(s) that changed each file derived from the per-task diffs. */
export function RunDiffTab() {
  const { detail, tasksById } = useRunCtx()
  const diff = useRunDiff(detail.run.id)
  const reviews = useReviews(detail.run.id)
  const withBranch = useMemo(() => detail.tasks.filter((t) => t.branch !== null), [detail.tasks])
  const taskDiffs = useTaskDiffs(withBranch.map((t) => t.id))
  const owners = useMemo(
    () =>
      ownersByPath(
        withBranch.flatMap((t, i) => {
          const d = taskDiffs[i]?.data
          return d ? [{ taskKey: tasksById.get(t.id)?.key ?? t.key, files: d.files }] : []
        }),
      ),
    [withBranch, taskDiffs, tasksById],
  )
  const findings = useMemo(() => latestFindings(reviews.data ?? []), [reviews.data])

  if (diff.isPending) return <Loading label="Loading diff" />
  if (diff.isError) return <ErrorNote error={diff.error} className="m-3" />
  return (
    <div className="h-full overflow-auto p-3" data-testid="run-diff">
      <DiffView diff={diff.data} findings={findings} ownerOf={(p) => owners.get(normalizePath(p)) ?? []} testId="run-diff-view" />
    </div>
  )
}

export function ReviewsTab() {
  const { detail, tasksById } = useRunCtx()
  const query = useReviews(detail.run.id)
  if (query.isPending) return <Loading />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  if (query.data.length === 0) return <Empty>No reviews yet.</Empty>
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3" data-testid="reviews-tab">
      {[...query.data]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => (
          <ReviewCard key={r.id} review={r} label={taskKeyOf(tasksById, r.taskId)} />
        ))}
    </div>
  )
}

export function VerificationsTab() {
  const { detail, tasksById } = useRunCtx()
  const query = useVerifications(detail.run.id)
  if (query.isPending) return <Loading />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  if (query.data.length === 0) return <Empty>No checks or verification results yet.</Empty>
  // Mission-level results first, then newest first.
  const sorted = [...query.data].sort(
    (a, b) => Number(a.taskId !== null) - Number(b.taskId !== null) || b.createdAt.localeCompare(a.createdAt),
  )
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3" data-testid="verifications-tab">
      {sorted.map((v) => (
        <VerificationCard key={v.id} verification={v} label={taskKeyOf(tasksById, v.taskId)} />
      ))}
    </div>
  )
}

export function DecisionsTab() {
  const { detail, tasksById } = useRunCtx()
  const query = useDecisions(detail.run.id)
  if (query.isPending) return <Loading />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  if (query.data.length === 0) return <Empty>No decisions recorded yet.</Empty>
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3" data-testid="decisions-tab">
      {[...query.data]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((d) => (
          <article key={d.id} className="flex flex-col gap-1 rounded-md border bg-surface p-2.5" data-testid="decision">
            <div className="flex items-center gap-2">
              <span className="font-medium">{d.title}</span>
              <span className="font-mono text-small text-text-secondary">{taskKeyOf(tasksById, d.taskId)}</span>
              <span className="ml-auto text-text-muted">{formatDateTime(d.createdAt)}</span>
            </div>
            <div className="whitespace-pre-wrap break-words">{d.decision}</div>
            <div className="whitespace-pre-wrap break-words text-text-secondary">
              <span className="text-text-muted">Rationale: </span>
              {d.rationale}
            </div>
          </article>
        ))}
    </div>
  )
}

export function MissionCriteriaTab() {
  const { detail } = useRunCtx()
  const criteria = detail.criteria.filter((c) => c.taskId === null)
  return (
    <div className="h-full overflow-auto p-3" data-testid="mission-criteria">
      <CriteriaList criteria={criteria} emptyText="This run has no mission-level acceptance criteria." />
    </div>
  )
}
