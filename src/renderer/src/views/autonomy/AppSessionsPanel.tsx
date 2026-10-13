import { useState } from 'react'
import type { AppSessionView } from '@shared/isolation'
import { useAppScreenshot, useAppSessions } from '../../lib/queries-autonomy'
import { formatDateTime } from '../../lib/format'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  KeyValue,
  Loading,
  RefreshIcon,
  type KeyValueRow,
} from '../../components/ui'
import {
  APPS_EMPTY,
  APP_STATE_LABEL,
  APP_TYPE_LABEL,
  EFFECTIVE_LABEL,
  EFFECTIVE_SENTENCE,
  appStateTone,
  exitCodeWords,
  screenshotAlt,
} from './isolationModel'

function Session({ session }: { session: AppSessionView }) {
  const shot = useAppScreenshot()
  const [image, setImage] = useState<{ dataUrl: string; takenAt: string } | null | undefined>(
    undefined,
  )
  const exit = exitCodeWords(session.exitCode)
  const rows: KeyValueRow[] = [
    { label: 'Execution profile', value: EFFECTIVE_LABEL[session.profile] },
    { label: 'Endpoint', value: session.endpoint ?? 'None', mono: session.endpoint !== null },
    { label: 'Started', value: formatDateTime(session.startedAt), mono: true },
    ...(exit ? [{ label: 'Exit', value: exit, mono: true } satisfies KeyValueRow] : []),
  ]
  const title = `${APP_TYPE_LABEL[session.type]} ${session.id}`

  return (
    <li
      className="flex flex-col gap-2 border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
      data-testid={`app-session-${session.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-body font-semibold">{title}</h3>
        <Badge tone={appStateTone(session.state)}>{APP_STATE_LABEL[session.state]}</Badge>
      </div>
      <KeyValue rows={rows} />
      <p className="m-0 text-small text-text-secondary" data-testid={`app-session-profile-${session.id}`}>
        {EFFECTIVE_SENTENCE[session.profile]}
      </p>
      {session.note ? <p className="m-0 text-text-secondary">{session.note}</p> : null}
      {session.output.length > 0 ? (
        // A scrolling region must be reachable by keyboard.
        <pre
          tabIndex={0}
          aria-label={`Last output of ${title}`}
          className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-surface-hover p-2 font-mono text-code"
        >
          {session.output.join('\n')}
        </pre>
      ) : (
        <p className="m-0 text-small text-text-muted">The application has printed nothing.</p>
      )}
      {session.screenshots > 0 ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              size="sm"
              loading={shot.isPending}
              onClick={() =>
                shot.mutate({ appId: session.id, index: 0 }, { onSuccess: (r) => setImage(r) })
              }
              data-testid={`app-screenshot-${session.id}`}
            >
              Show latest screenshot
            </Button>
          </div>
          <div
            role="status"
            className={
              image === null || shot.isError ? 'text-small text-text-secondary' : 'sr-only'
            }
          >
            {shot.isError
              ? `The screenshot could not be read. ${shot.error.message}`
              : image === null
                ? 'This screenshot is no longer kept.'
                : ''}
          </div>
          {image ? (
            <img
              src={image.dataUrl}
              alt={screenshotAlt(formatDateTime(image.takenAt))}
              className="max-h-96 max-w-full self-start rounded-md border"
            />
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** Project page: the applications NEXUS started to test this project's work, newest first. Read-only. */
export function AppSessionsPanel({ projectId }: { projectId: string }) {
  const sessions = useAppSessions(projectId)
  return (
    <Card
      title="Applications under test"
      description="Started by NEXUS to test this project, with a browser of its own."
      actions={
        <Button
          size="sm"
          icon={<RefreshIcon size={12} />}
          loading={sessions.isFetching}
          onClick={() => void sessions.refetch()}
          data-testid="app-sessions-refresh"
        >
          Refresh
        </Button>
      }
      data-testid="app-sessions-panel"
    >
      {sessions.isPending ? (
        <Loading label="Loading applications under test" />
      ) : sessions.isError ? (
        <ErrorNote error={sessions.error} />
      ) : sessions.data.length === 0 ? (
        <EmptyState title="No application launched" className="py-6">
          {APPS_EMPTY}
        </EmptyState>
      ) : (
        <ul className="m-0 list-none p-0" aria-label="Applications under test">
          {sessions.data.map((s) => (
            <Session key={s.id} session={s} />
          ))}
        </ul>
      )}
    </Card>
  )
}
