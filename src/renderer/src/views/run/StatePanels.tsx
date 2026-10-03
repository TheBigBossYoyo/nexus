import { TERMINAL_RUN_STATES, type Task } from '@shared/domain'
import { Badge, Button, CodeBlock, ErrorNote, Loading, Notice, Panel, PlayIcon } from '../../components/ui'
import { DASH, formatCost, formatDuration } from '../../lib/format'
import { useResumeRun, useRetryTask, useRunSummary } from '../../lib/queries'
import { useUiStore } from '../../store/ui'
import { pauseDetailFromEvents } from './eventText'
import { useRunCtx } from './runContext'

const PAUSE_LABEL = {
  user: 'Paused by the user',
  quota: 'Paused: usage quota or rate limit reached',
  recovery: 'Paused after an app restart (recovery)',
} as const

function TaskProblem({ task, canRetry }: { task: Task; canRetry: boolean }) {
  const retry = useRetryTask()
  const selectTask = useUiStore((s) => s.selectTask)
  return (
    <li className="flex items-start gap-2 border-b py-1.5 last:border-b-0" data-testid={`problem-${task.key}`}>
      <div className="min-w-0 flex-1">
        <button type="button" className="font-medium text-accent hover:underline" onClick={() => selectTask(task.id)}>
          {task.title}
        </button>
        <span className="ml-2 font-mono text-[0.85em] text-fg-faint">{task.key}</span>
        {task.error ? (
          <div className="text-fg-muted">
            <div className="whitespace-pre-wrap break-words">{task.error.what}</div>
            {task.error.where ? <div className="font-mono text-[0.88em]">at {task.error.where}</div> : null}
            <div>{task.error.why ? `Why: ${task.error.why}` : 'Cause not known.'}</div>
          </div>
        ) : task.blockedReason ? (
          <div className="whitespace-pre-wrap break-words text-fg-muted">{task.blockedReason}</div>
        ) : null}
      </div>
      {task.error?.retryable ? <Badge tone="active">retryable</Badge> : null}
      {canRetry ? (
        <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate({ taskId: task.id })}>
          Retry
        </Button>
      ) : null}
    </li>
  )
}

/** Explains a paused, failed or cancelled run: what happened, where, why if known, and what can be retried. */
export function RunStatePanel() {
  const { detail, events } = useRunCtx()
  const { run, tasks } = detail
  const resume = useResumeRun()
  const finished = TERMINAL_RUN_STATES.includes(run.state)
  const problems = tasks.filter((t) => t.state === 'failed' || t.state === 'blocked')

  if (run.state === 'paused') {
    const reason = run.pauseReason ? PAUSE_LABEL[run.pauseReason] : 'Paused'
    const detailText = pauseDetailFromEvents(events)
    return (
      <Notice tone="warning" title={reason} className="shrink-0" data-testid="run-state-panel">
        {detailText ? <div className="whitespace-pre-wrap break-words" data-testid="pause-detail">{detailText}</div> : null}
        <div className="mt-1.5 flex items-center gap-2">
          <Button size="sm" variant="primary" icon={<PlayIcon size={12} />} loading={resume.isPending} onClick={() => resume.mutate({ runId: run.id })}>
            Resume
          </Button>
          {run.resumeState ? <span className="text-fg-faint">Resumes into {run.resumeState}.</span> : null}
        </div>
      </Notice>
    )
  }

  if (run.state === 'failed' || run.state === 'cancelled') {
    return (
      <Notice
        tone={run.state === 'failed' ? 'danger' : 'neutral'}
        title={run.state === 'failed' ? 'Run failed' : 'Run cancelled'}
        className="shrink-0"
        data-testid="run-state-panel"
      >
        {run.error ? (
          <div className="whitespace-pre-wrap break-words" data-testid="run-error">
            {run.error}
          </div>
        ) : run.state === 'failed' ? (
          <div>No error message was recorded for the run itself.</div>
        ) : (
          <div>The run was cancelled before it completed. Work already committed on the integration branch is kept.</div>
        )}
        {problems.length > 0 ? (
          <>
            <div className="mt-1.5 font-medium text-fg">Tasks that need attention</div>
            <ul className="m-0 list-none p-0">
              {problems.map((t) => (
                <TaskProblem key={t.id} task={t} canRetry={!finished} />
              ))}
            </ul>
          </>
        ) : null}
        {finished && problems.some((t) => t.error?.retryable) ? (
          <div className="mt-1 text-[0.9em]">The run is finished; start a new mission to retry this work.</div>
        ) : null}
      </Notice>
    )
  }
  return null
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border bg-surface-1 px-3 py-2" data-testid={testId}>
      <span className="text-[0.78rem] uppercase tracking-wider text-fg-muted">{label}</span>
      <span className="font-mono text-[1.15rem]">{value}</span>
    </div>
  )
}

/** Shown when the run is completed: results from runs.summary (only values present in the data) and next steps. */
export function MissionComplete() {
  const { detail, showStage, showBottom } = useRunCtx()
  const { run } = detail
  const query = useRunSummary(run.id)
  const setView = useUiStore((s) => s.setView)

  if (query.isPending) return <Loading label="Loading summary" />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  const s = query.data
  const checksPassed = s.lastChecks.filter((c) => c.exitCode === 0 && !c.timedOut).length

  const links: { label: string; onClick: () => void; testId: string }[] = [
    { label: 'Task graph', onClick: () => showStage('graph'), testId: 'link-graph' },
    { label: 'Diffs', onClick: () => showBottom('diff'), testId: 'link-diff' },
    { label: 'Test logs', onClick: () => showBottom('verification'), testId: 'link-tests' },
    { label: 'Reviews', onClick: () => showBottom('reviews'), testId: 'link-reviews' },
    { label: 'Decisions', onClick: () => showBottom('decisions'), testId: 'link-decisions' },
    { label: 'Agent transcripts', onClick: () => setView('agents'), testId: 'link-agents' },
  ]

  return (
    <Panel title="Mission result" className="h-full" data-testid="mission-complete">
      <div className="flex flex-col gap-4">
        <h2 className="m-0 text-[1.3rem] font-semibold tracking-wide text-tone-success">MISSION COMPLETE</h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Tasks" value={`${s.tasksCompleted}/${s.tasksTotal}`} testId="stat-tasks" />
          <Stat label="Reviews" value={`${s.reviewsApproved}/${s.reviewsTotal} approved`} testId="stat-reviews" />
          <Stat label="Verification" value={`${s.verificationsPassed} passed, ${s.verificationsFailed} failed`} testId="stat-verification" />
          <Stat label="Files changed" value={String(s.filesChanged)} />
          <Stat label="Commits" value={String(s.commits)} />
          <Stat label="Agents (sessions)" value={String(s.agentSessions)} />
          <Stat label="Duration" value={formatDuration(s.durationMs)} />
          <Stat label="Est. cost (runtime)" value={s.costUsd === null ? DASH : formatCost(s.costUsd)} />
        </div>
        {s.tasksFailed > 0 || s.tasksCancelled > 0 ? (
          <div className="text-fg-muted">
            {s.tasksFailed} task(s) failed and {s.tasksCancelled} cancelled.
          </div>
        ) : null}

        <section className="flex flex-col gap-1.5" data-testid="final-checks">
          <h3 className="m-0 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">
            Final checks{s.lastChecks.length > 0 ? ` (${checksPassed}/${s.lastChecks.length} commands passed)` : ''}
          </h3>
          {s.lastChecks.length === 0 ? (
            <div className="text-fg-muted">No check commands were recorded.</div>
          ) : (
            <ul className="m-0 list-none p-0">
              {s.lastChecks.map((c, i) => {
                const ok = c.exitCode === 0 && !c.timedOut
                return (
                  <li key={`${c.name}-${i}`} className="flex items-center gap-2 border-b py-1 font-mono text-[0.92em]" data-ok={ok ? 'true' : 'false'}>
                    <Badge tone={ok ? 'success' : 'danger'}>{ok ? 'PASS' : c.timedOut ? 'TIMEOUT' : 'FAIL'}</Badge>
                    <span className="text-fg-muted">{c.name}</span>
                    <span className="min-w-0 flex-1 truncate">{c.command}</span>
                    <span className="text-fg-faint">{formatDuration(c.durationMs)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-1.5" data-testid="merge-instructions">
          <h3 className="m-0 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">Bring the result into your branch</h3>
          {run.integrationBranch ? (
            <>
              <CodeBlock>{`git merge ${run.integrationBranch}`}</CodeBlock>
              <div className="text-fg-muted">
                This is a manual step: NEXUS does not merge into your branch. From a clean checkout of{' '}
                <span className="font-mono">{run.baseBranch ?? 'your target branch'}</span>, run the command above when you are ready.
              </div>
            </>
          ) : (
            <div className="text-fg-muted">This run has no integration branch to merge.</div>
          )}
        </section>

        <div className="flex flex-wrap gap-2">
          {links.map((l) => (
            <Button key={l.testId} size="sm" onClick={l.onClick} data-testid={l.testId}>
              {l.label}
            </Button>
          ))}
        </div>
      </div>
    </Panel>
  )
}
