import { TERMINAL_RUN_STATES, type Task } from '@shared/domain'
import { Badge, Button, CodeBlock, ErrorNote, Loading, Notice, PlayIcon, Stat } from '../../components/ui'
import { DASH, formatCost, formatDuration } from '../../lib/format'
import { useResumeRun, useRetryTask, useRunSummary, useUsageOverview } from '../../lib/queries'
import { useUiStore } from '../../store/ui'
import { CandidatesSection } from './CandidatesSection'
import { pauseDetailFromEvents } from './eventText'
import { quotaState } from './missionModel'
import { useNow, useRunCtx } from './runContext'

const PAUSE_LABEL = {
  user: 'Paused by you',
  quota: 'Paused: Claude usage limit reached',
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
        <span className="ml-2 font-mono text-code text-text-muted">{task.key}</span>
        {task.error ? (
          <div className="text-text-secondary">
            <div className="whitespace-pre-wrap break-words">{task.error.what}</div>
            {task.error.where ? <div className="font-mono text-code">at {task.error.where}</div> : null}
            <div>{task.error.why ? `Why: ${task.error.why}` : 'Cause not known.'}</div>
          </div>
        ) : task.blockedReason ? (
          <div className="whitespace-pre-wrap break-words text-text-secondary">{task.blockedReason}</div>
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

/** A quota pause is an expected wait, not an error: calm text, no red, no retry button. */
function QuotaPaused() {
  const { detail } = useRunCtx()
  const { run } = detail
  const overview = useUsageOverview()
  const resume = useResumeRun()
  const now = useNow(true, 30_000)
  const state = quotaState(run, overview.data, now)
  if (!state) return null
  return (
    <div className="shrink-0 border-b bg-surface-muted px-5 py-3" data-testid="run-state-panel" data-kind="quota">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-text-primary" data-testid="quota-paused-title">
            {state.title}
          </div>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-text-secondary" data-testid="quota-paused-lines">
            {state.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
        <Button size="sm" icon={<PlayIcon size={12} />} loading={resume.isPending} onClick={() => resume.mutate({ runId: run.id })}>
          Resume now
        </Button>
      </div>
    </div>
  )
}

/** Explains a paused, failed or cancelled run: what happened, where, why if known, and what can be retried. */
export function RunStatePanel() {
  const { detail, events } = useRunCtx()
  const { run, tasks } = detail
  const resume = useResumeRun()
  const finished = TERMINAL_RUN_STATES.includes(run.state)
  const problems = tasks.filter((t) => t.state === 'failed' || t.state === 'blocked')

  if (run.state === 'paused' && run.pauseReason === 'quota') return <QuotaPaused />

  if (run.state === 'paused') {
    const reason = run.pauseReason ? PAUSE_LABEL[run.pauseReason] : 'Paused'
    const detailText = pauseDetailFromEvents(events)
    return (
      <Notice tone="warning" title={reason} className="m-3 shrink-0" data-testid="run-state-panel">
        {detailText ? (
          <div className="whitespace-pre-wrap break-words" data-testid="pause-detail">
            {detailText}
          </div>
        ) : null}
        <div className="mt-1.5 flex items-center gap-2">
          <Button size="sm" variant="primary" icon={<PlayIcon size={12} />} loading={resume.isPending} onClick={() => resume.mutate({ runId: run.id })}>
            Resume
          </Button>
          {run.resumeState ? <span className="text-text-muted">Resumes into {run.resumeState}.</span> : null}
        </div>
      </Notice>
    )
  }

  if (run.state === 'failed' || run.state === 'cancelled') {
    return (
      <Notice
        tone={run.state === 'failed' ? 'danger' : 'neutral'}
        title={run.state === 'failed' ? 'Mission failed' : 'Mission cancelled'}
        className="m-3 shrink-0"
        data-testid="run-state-panel"
      >
        {run.error ? (
          <div className="whitespace-pre-wrap break-words" data-testid="run-error">
            {run.error}
          </div>
        ) : run.state === 'failed' ? (
          <div>No error message was recorded for the run itself.</div>
        ) : (
          <div>The mission was cancelled before it completed. Work already committed on the integration branch is kept.</div>
        )}
        {problems.length > 0 ? (
          <>
            <div className="mt-1.5 font-medium text-text-primary">Tasks that need attention</div>
            <ul className="m-0 list-none p-0">
              {problems.map((t) => (
                <TaskProblem key={t.id} task={t} canRetry={!finished} />
              ))}
            </ul>
          </>
        ) : null}
        {finished && problems.some((t) => t.error?.retryable) ? (
          <div className="mt-1 text-small">The mission is finished; start a new mission to retry this work.</div>
        ) : null}
      </Notice>
    )
  }
  return null
}

function Block({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h3 className="m-0 text-heading font-semibold">{title}</h3>
      {children}
    </section>
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
    <div className="h-full overflow-auto" data-testid="mission-complete">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-5">
        <div className="flex items-baseline gap-3">
          <h2 className="m-0 text-title font-semibold text-success">Mission complete</h2>
          <span className="text-small text-text-muted">{formatDuration(s.durationMs)} in total</span>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border bg-surface p-4 md:grid-cols-4">
          <Stat label="Tasks" value={`${s.tasksCompleted}/${s.tasksTotal}`} data-testid="stat-tasks" />
          <Stat label="Reviews approved" value={`${s.reviewsApproved}/${s.reviewsTotal}`} data-testid="stat-reviews" />
          <Stat label="Verification" value={`${s.verificationsPassed} passed`} hint={`${s.verificationsFailed} failed`} data-testid="stat-verification" />
          <Stat label="Files changed" value={String(s.filesChanged)} hint={`${s.commits} commits`} />
          <Stat label="Agent sessions" value={String(s.agentSessions)} source={{ confidence: 'OBSERVED', source: 'LOCAL_AGGREGATION' }} />
          <Stat
            label="List-price estimate"
            value={s.costUsd === null ? DASH : formatCost(s.costUsd)}
            source={{ confidence: 'ESTIMATED', source: 'RUNTIME' }}
            hint="Not a bill"
          />
        </div>
        {s.tasksFailed > 0 || s.tasksCancelled > 0 ? (
          <div className="text-text-secondary">
            {s.tasksFailed} task(s) failed and {s.tasksCancelled} cancelled.
          </div>
        ) : null}

        <CandidatesSection />

        <Block title={`Final checks${s.lastChecks.length > 0 ? ` (${checksPassed}/${s.lastChecks.length} passed)` : ''}`} testId="final-checks">
          {s.lastChecks.length === 0 ? (
            <div className="text-text-secondary">No check commands were recorded.</div>
          ) : (
            <ul className="m-0 list-none rounded-lg border bg-surface p-0">
              {s.lastChecks.map((c, i) => {
                const ok = c.exitCode === 0 && !c.timedOut
                return (
                  <li key={`${c.name}-${i}`} className="flex items-center gap-3 border-b px-3 py-1.5 last:border-b-0" data-ok={ok ? 'true' : 'false'}>
                    <Badge tone={ok ? 'success' : 'danger'}>{ok ? 'Passed' : c.timedOut ? 'Timed out' : 'Failed'}</Badge>
                    <span className="text-text-muted">{c.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-code">{c.command}</span>
                    <span className="tnum text-text-muted">{formatDuration(c.durationMs)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Block>

        <Block title="Bring the result into your branch" testId="merge-instructions">
          {run.integrationBranch ? (
            <>
              <CodeBlock>{`git merge ${run.integrationBranch}`}</CodeBlock>
              <div className="text-small text-text-secondary">
                This is a manual step: NEXUS does not merge into your branch. From a clean checkout of{' '}
                <span className="font-mono">{run.baseBranch ?? 'your target branch'}</span>, run the command above when you are ready.
              </div>
            </>
          ) : (
            <div className="text-text-secondary">This run has no integration branch to merge.</div>
          )}
        </Block>

        <div className="flex flex-wrap items-center gap-2">
          {links.map((l) => (
            <Button key={l.testId} size="sm" onClick={l.onClick} data-testid={l.testId}>
              {l.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
