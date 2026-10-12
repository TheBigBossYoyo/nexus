import { Fragment, useId } from 'react'
import type { BoundaryDecision, BoundaryRequestView } from '@shared/autonomy'
import { useUiStore } from '../../store/ui'
import {
  usePendingBoundaryRequests,
  useRecentBoundaryRequests,
  useResolveBoundaryRequest,
} from '../../lib/queries-autonomy'
import { cn } from '../../lib/cn'
import { shortId } from '../../lib/format'
import { Badge, Button, Drawer, EmptyState, ErrorNote, Loading, TimeAgo } from '../../components/ui'
import {
  INBOX_HEADER_LINE,
  REQUEST_STATE_TONE,
  actionShown,
  answerCoverage,
  decidedWords,
  decisionButtons,
  groupRequests,
  occurrencesLabel,
  recentCommand,
  recentNotes,
  resolveErrorText,
  sortRecent,
} from './autonomyModel'

/**
 * One pending boundary request. `action` comes from a tool call: it is shown as text in a code style and never
 * interpreted. The answer's error stays next to the request, in a status region that is always mounted.
 */
function RequestCard({ request }: { request: BoundaryRequestView }) {
  const resolve = useResolveBoundaryRequest()
  const errorId = useId()
  const coverId = useId()
  const commandId = useId()
  const buttons = decisionButtons(request.scopes)
  const times = occurrencesLabel(request.occurrences)
  const shown = actionShown(request)
  const answer = (decision: BoundaryDecision['decision']) => {
    if (resolve.isPending) return
    resolve.mutate({ requestId: request.id, decision })
  }
  return (
    <li
      data-testid="boundary-request"
      data-request-id={request.id}
      className="flex flex-col gap-2 border-b border-l-2 border-l-tone-waiting p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{request.capabilityLabel}</span>
        <Badge tone={REQUEST_STATE_TONE[request.state]}>{decidedWords(request)}</Badge>
        {times ? <Badge>{times}</Badge> : null}
        <TimeAgo iso={request.createdAt} className="ml-auto text-small text-text-muted" />
      </div>
      <div className="min-w-0 break-words text-text-secondary">
        <span className="text-text-muted">Resource: </span>
        {request.resourceLabel}
      </div>
      <div id={commandId} className="text-small text-text-muted">Command the agent tried</div>
      {/* A long command scrolls inside its box so that the answers stay in view; the box is reachable by keyboard. */}
      <pre
        tabIndex={0}
        aria-labelledby={commandId}
        className="m-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-surface-muted px-2.5 py-1.5 font-mono text-code"
        data-testid="boundary-action"
      >
        <code className="[unicode-bidi:isolate]">{shown.text}</code>
      </pre>
      {shown.note ? <div className="text-small text-text-muted" data-testid="boundary-action-note">{shown.note}</div> : null}
      <div className="text-text-secondary">{request.reason}</div>
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={`Answer: ${request.capabilityLabel}`}
        aria-describedby={`${coverId} ${errorId}`}
      >
        {buttons.map((b) => (
          <Fragment key={b.decision}>
            {b.decision === 'ALLOW_PROJECT' ? <span className="ml-2 text-small font-medium text-warning">Lasting:</span> : null}
          <Button
            size="sm"
            variant={b.variant}
            className={b.decision === 'ALLOW_PROJECT' ? 'border-warning' : undefined}
            busy={resolve.isPending}
            loading={resolve.isPending && resolve.variables?.decision === b.decision}
            onClick={() => answer(b.decision)}
            data-testid={`boundary-${b.decision.toLowerCase().replace('_', '-')}`}
          >
            {b.label}
          </Button>
          </Fragment>
        ))}
      </div>
      <ul id={coverId} className="m-0 flex list-none flex-col gap-0.5 p-0 text-small text-text-muted" data-testid="boundary-coverage">
        {answerCoverage(request).map((c) => (
          <li key={c.decision}>{c.text}</li>
        ))}
      </ul>
      <div
        id={errorId}
        role="status"
        data-testid="boundary-error"
        className={cn('text-small', resolve.error ? 'text-danger' : 'sr-only')}
      >
        {resolve.error ? resolveErrorText(resolve.error) : ''}
      </div>
      <div className="font-mono text-caption text-text-muted">{shortId(request.id)}</div>
    </li>
  )
}

function RecentRow({ request }: { request: BoundaryRequestView }) {
  return (
    <li className="flex flex-col gap-0.5 border-b px-4 py-2" data-testid="boundary-recent">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{request.capabilityLabel}</span>
        <Badge tone={REQUEST_STATE_TONE[request.state]}>{decidedWords(request)}</Badge>
        <TimeAgo
          iso={request.decidedAt ?? request.lastSeenAt}
          className="ml-auto text-small text-text-muted"
        />
      </div>
      <div className="text-small text-text-muted">
        {request.projectName}
        {request.missionTitle ? `, ${request.missionTitle}` : ''}
        {': '}
        {request.resourceLabel}
      </div>
      <code className="break-all font-mono text-code [unicode-bidi:isolate]" data-testid="boundary-recent-command">
        {recentCommand(request)}
      </code>
      {request.followUp ? (
        <div className="break-words text-small text-text-secondary" data-testid="boundary-follow-up">
          {request.followUp}
        </div>
      ) : null}
      {recentNotes(request).map((note) => (
        <div key={note} className="break-words text-small text-text-secondary" data-testid="boundary-recent-note">
          {note}
        </div>
      ))}
    </li>
  )
}

/** The inbox. It opens only when the user opens it from the status bar; nothing in the app opens it. */
export function BoundaryInbox() {
  const open = useUiStore((s) => s.drawer === 'boundary')
  const setDrawer = useUiStore((s) => s.setDrawer)
  const pending = usePendingBoundaryRequests(null)
  const recent = useRecentBoundaryRequests(null)
  const requests = pending.data ?? []
  const groups = groupRequests(requests)
  const decided = sortRecent((recent.data ?? []).filter((r) => r.state !== 'PENDING'))
  return (
    <Drawer
      open={open}
      onClose={() => setDrawer(null)}
      title={`Boundary requests (${requests.length})`}
      testId="boundary-drawer"
      width={560}
    >
      <p className="m-0 border-b px-4 py-2 text-small text-text-muted">
        {INBOX_HEADER_LINE}
      </p>
      {pending.isPending ? (
        <Loading label="Loading boundary requests" />
      ) : pending.isError ? (
        <ErrorNote error={pending.error} className="m-4" />
      ) : groups.length === 0 ? (
        <EmptyState title="No boundary request is waiting" data-testid="boundary-empty">
          Projects you have enrolled run inside their profile without asking. Something outside it
          appears here.
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section
            key={g.projectId}
            aria-labelledby={`boundary-project-${g.projectId}`}
            data-testid="boundary-project"
          >
            <h3
              id={`boundary-project-${g.projectId}`}
              className="m-0 border-b bg-surface-muted px-4 py-1.5 text-body font-semibold"
            >
              {g.projectName}
            </h3>
            {g.missions.map((m) => (
              <div key={m.key || 'none'}>
                <h4 className="m-0 border-b px-4 py-1 text-small font-medium text-text-secondary">
                  {m.missionTitle ??
                    (m.key ? `Mission ${shortId(m.key)}` : 'Not tied to a mission')}
                </h4>
                <ul className="m-0 list-none p-0">
                  {m.requests.map((r) => (
                    <RequestCard key={r.id} request={r} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}
      <section aria-labelledby="boundary-recent-title" className="mt-2">
        <h3
          id="boundary-recent-title"
          className="m-0 border-b bg-surface-muted px-4 py-1.5 text-body font-semibold"
        >
          Recently decided
        </h3>
        {decided.length === 0 ? (
          <p className="m-0 px-4 py-3 text-text-muted">
            {recent.isPending ? 'Loading…' : 'Nothing decided yet.'}
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {decided.map((r) => (
              <RecentRow key={r.id} request={r} />
            ))}
          </ul>
        )}
      </section>
    </Drawer>
  )
}
