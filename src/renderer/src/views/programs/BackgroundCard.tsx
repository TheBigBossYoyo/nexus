import { BACKGROUND_JOB_KINDS, type BackgroundJobKind } from '@shared/program'
import {
  useBackgroundJobs,
  useBackgroundSettings,
  useCancelBackgroundJob,
  useSetBackgroundSettings,
  useStartBackgroundJob,
} from '../../lib/queries-v4'
import { useCurrentProject } from '../../app/useCurrent'
import { Button, Card, ErrorNote, StatusBadge, TimeAgo, Toggle } from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import { Check } from '../projects/OvernightPanel'
import { backgroundJobInfo, backgroundKindLabel } from './programsModel'

/** Background engineering: off by default, read-only analysis jobs whose only output is backlog proposals. */
export function BackgroundCard() {
  const settings = useBackgroundSettings()
  const setSettings = useSetBackgroundSettings()
  const project = useCurrentProject()
  const jobs = useBackgroundJobs(project?.id ?? null)
  const start = useStartBackgroundJob()
  const cancel = useCancelBackgroundJob()
  const s = settings.data

  const toggleKind = (kind: BackgroundJobKind, on: boolean) => {
    if (!s) return
    const kinds = on ? [...s.kinds, kind] : s.kinds.filter((k) => k !== kind)
    setSettings.mutate({ settings: { enabled: s.enabled, kinds: BACKGROUND_JOB_KINDS.filter((k) => kinds.includes(k)) } })
  }
  const running = (kind: BackgroundJobKind) => (jobs.data ?? []).some((j) => j.kind === kind && (j.state === 'queued' || j.state === 'running'))

  return (
    <Card
      title="Background engineering"
      description="Optional analysis of the current project, started by you."
      data-testid="background-card"
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-text-secondary" data-testid="background-note">
          Off by default. A background job only reads the project and never changes a file. Its only output is proposals in the backlog, which you can accept or reject. It uses your Claude usage like any session, and
          nothing runs on a schedule.
        </p>
        {settings.isPending ? (
          <BlockSkeleton rows={2} testId="background-loading" />
        ) : settings.isError || !s ? (
          <ReadError error={settings.error} calm="Background engineering is not available in this build yet." onRetry={() => void settings.refetch()} />
        ) : (
          <>
            <Toggle
              checked={s.enabled}
              disabled={setSettings.isPending}
              onChange={(enabled) => setSettings.mutate({ settings: { enabled, kinds: s.kinds } })}
              label={<span className="font-medium">{s.enabled ? 'Background engineering is on' : 'Background engineering is off'}</span>}
              data-testid="background-enabled"
              aria-label="Enable background engineering"
            />
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" disabled={!s.enabled}>
              <legend className="mb-1 p-0 text-small font-medium text-text-secondary">Analyses you allow{s.enabled ? '' : ' (turn background engineering on first)'}</legend>
              <ul className="m-0 grid list-none grid-cols-1 gap-x-4 gap-y-1.5 p-0 md:grid-cols-2">
                {BACKGROUND_JOB_KINDS.map((kind) => {
                  const on = s.kinds.includes(kind)
                  return (
                    <li key={kind} className="flex items-center justify-between gap-2">
                      <Check
                        checked={on}
                        disabled={!s.enabled || setSettings.isPending}
                        onChange={(v) => toggleKind(kind, v)}
                        label={backgroundKindLabel(kind)}
                        testId={`background-kind-${kind}`}
                      />
                      {s.enabled && on ? (
                        <Button
                          size="sm"
                          disabled={!project || running(kind)}
                          loading={start.isPending && start.variables?.kind === kind}
                          onClick={() => project && start.mutate({ projectId: project.id, kind })}
                          data-testid={`background-run-${kind}`}
                          aria-label={`Run ${backgroundKindLabel(kind)} on ${project?.name ?? 'the current project'}`}
                        >
                          {running(kind) ? 'Running' : 'Run'}
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </fieldset>
            {setSettings.isError ? <ErrorNote error={setSettings.error} /> : null}
            {start.isError ? <ErrorNote error={start.error} /> : null}
            {s.enabled && !project ? <p className="m-0 text-small text-text-muted">Open a project to run an analysis.</p> : null}

            <div data-testid="background-jobs" className="flex flex-col gap-1.5">
              <h3 className="m-0 text-caption font-medium text-text-muted">Jobs{project ? ` on ${project.name}` : ''}</h3>
              {!project ? null : jobs.isPending ? (
                <BlockSkeleton rows={2} />
              ) : jobs.isError ? (
                <ReadError error={jobs.error} calm="Jobs are not available in this build yet." onRetry={() => void jobs.refetch()} />
              ) : jobs.data.length === 0 ? (
                <p className="m-0 text-text-muted" data-testid="background-jobs-empty">
                  No job has run for this project.
                </p>
              ) : (
                <ul className="m-0 list-none divide-y rounded-md border p-0">
                  {[...jobs.data]
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .slice(0, 8)
                    .map((j) => (
                      <li key={j.id} className="flex flex-col gap-0.5 px-3 py-2" data-testid={`background-job-${j.id}`} data-state={j.state}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium">{backgroundKindLabel(j.kind)}</span>
                          <StatusBadge status={backgroundJobInfo(j.state)} pulse={j.state === 'running'} />
                          <span className="tnum text-small text-text-secondary">
                            {j.proposals} proposal{j.proposals === 1 ? '' : 's'}
                          </span>
                          <TimeAgo iso={j.createdAt} className="ml-auto text-small text-text-muted" />
                          {j.state === 'queued' || j.state === 'running' ? (
                            <Button size="sm" variant="ghost" loading={cancel.isPending && cancel.variables?.jobId === j.id} onClick={() => cancel.mutate({ jobId: j.id })} data-testid={`background-cancel-${j.id}`}>
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                        {j.summary ? <p className="m-0 text-small text-text-secondary">{j.summary}</p> : null}
                        {j.error ? <p className="m-0 text-small text-danger">{j.error}</p> : null}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
