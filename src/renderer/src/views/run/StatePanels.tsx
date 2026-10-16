import { useState } from 'react'
import { TERMINAL_RUN_STATES, type Task } from '@shared/domain'
import { Badge, Button, CodeBlock, ErrorNote, Loading, Markdown, Notice, PlayIcon } from '../../components/ui'
import { DASH, formatCost, formatDuration } from '../../lib/format'
import { useResumeRun, useRetryTask, useRunSummary } from '../../lib/queries'
import { useUiStore } from '../../store/ui'
import { CandidatesSection } from './CandidatesSection'
import { capacityWaitLines, pauseCauseFromEvents, pauseDetailFromEvents } from './eventText'
import { reportOf } from './reportModel'
import { useRunCtx } from './runContext'

const PAUSE_LABEL = {
  user: 'Paused by you',
  quota: 'Paused: Claude usage limit reached',
  recovery: 'Paused after an app restart (recovery)',
  capacity: 'Waiting for a provider: nothing failed, and NEXUS resumes this mission by itself',
  network: 'Waiting for the network: nothing failed, and NEXUS resumes this mission by itself when the provider can be reached',
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

/** A quota pause is an expected wait: one calm line. Timing and actions live in the quota banner. */
function QuotaPaused() {
  return (
    <div role="status" className="shrink-0 border-b bg-surface-muted px-5 py-2 text-small text-text-secondary" data-testid="run-state-panel" data-kind="quota">
      <span className="font-medium text-text-primary" data-testid="quota-paused-title">
        Waiting for the Claude usage limit.
      </span>{' '}
      <span data-testid="quota-paused-lines">Finished tasks are kept; unfinished work resumes from its last checkpoint when Claude is available again.</span>
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
    const reason = pauseCauseFromEvents(events) === 'intervention' ? 'Needs your attention' : run.pauseReason ? PAUSE_LABEL[run.pauseReason] : 'Paused'
    const waitingOn = run.pauseReason === 'capacity' ? capacityWaitLines(events) : []
    // A capacity wait says what it waits on in words; the raw routing reasons stay in the event log.
    const detailText = waitingOn.length > 0 ? null : pauseDetailFromEvents(events)
    return (
      <Notice live tone="warning" title={reason} className="m-3 shrink-0" data-testid="run-state-panel">
        {waitingOn.length > 0 ? (
          <ul className="list-disc pl-4" data-testid="capacity-wait-detail">
            {waitingOn.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {detailText ? (
          <div className="whitespace-pre-wrap break-words" data-testid="pause-detail">
            {detailText}
          </div>
        ) : null}
        <div className="mt-1.5 flex items-center gap-2">
          <Button size="sm" variant="primary" icon={<PlayIcon size={12} />} loading={resume.isPending} onClick={() => resume.mutate({ runId: run.id })}>
            {run.pauseReason === 'capacity' ? 'Try now' : 'Resume'}
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
  const selectTask = useUiStore((s) => s.selectTask)
  const readOnly = run.mode === 'audit' || run.mode === 'ask'
  const report = readOnly ? reportOf(detail.tasks) : null

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

  const fact = (label: string, value: string, testId?: string, hint?: string) => (
    <div className="flex items-baseline gap-1.5" data-testid={testId}>
      <dt className="text-text-muted">{label}</dt>
      <dd className="tnum m-0 font-medium text-text-primary">
        {value}
        {hint ? <span className="ml-1 font-normal text-text-muted">{hint}</span> : null}
      </dd>
    </div>
  )

  return (
    <div className="h-full overflow-auto" data-testid="mission-complete">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-5">
        <dl className="m-0 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-body">
          {fact('Tasks', `${s.tasksCompleted}/${s.tasksTotal}`, 'stat-tasks')}
          {readOnly ? null : fact('Reviews approved', `${s.reviewsApproved}/${s.reviewsTotal}`, 'stat-reviews')}
          {readOnly ? null : fact('Verification', `${s.verificationsPassed} passed`, 'stat-verification', `${s.verificationsFailed} failed`)}
          {readOnly ? null : fact('Files changed', String(s.filesChanged), undefined, `${s.commits} commits`)}
          {fact('Duration', formatDuration(s.durationMs))}
          {fact('Agent sessions', String(s.agentSessions), undefined, 'observed')}
          {fact('List-price estimate', s.costUsd === null ? DASH : formatCost(s.costUsd), undefined, 'estimated, not a bill')}
        </dl>
        {s.tasksFailed > 0 || s.tasksCancelled > 0 ? (
          <div className="text-text-secondary">
            {s.tasksFailed} task(s) failed and {s.tasksCancelled} cancelled.
          </div>
        ) : null}

        {report ? (
          <section className="flex flex-col gap-2 rounded-lg border bg-surface p-4" data-testid="mission-report">
            <div className="flex items-center gap-2">
              <h3 className="m-0 min-w-0 flex-1 text-heading font-semibold">Report</h3>
              <CopyButton text={report.task.resultSummary ?? ''} testId="copy-report" />
            </div>
            <div className="text-small text-text-muted">{report.task.title}</div>
            <Markdown>{report.task.resultSummary ?? ''}</Markdown>
            {report.others.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-small" data-testid="mission-report-parts">
                <span className="text-text-muted">The reports it was made from:</span>
                {report.others.map((t) => (
                  <Button key={t.id} size="sm" onClick={() => selectTask(t.id)}>
                    {t.title}
                  </Button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {readOnly ? null : (
        <section className="flex flex-col gap-2 rounded-lg border bg-surface p-4" data-testid="merge-instructions">
          <h3 className="m-0 text-heading font-semibold">Bring the result into your branch</h3>
          {run.integrationBranch ? (
            <>
              <div className="flex items-stretch gap-2">
                <div className="min-w-0 flex-1">
                  <CodeBlock>{`git merge ${run.integrationBranch}`}</CodeBlock>
                </div>
                <CopyButton text={`git merge ${run.integrationBranch}`} />
              </div>
              <div className="text-small text-text-secondary">
                This is a manual step: NEXUS does not merge into your branch. From a clean checkout of{' '}
                <span className="font-mono">{run.baseBranch ?? 'your target branch'}</span>, run the command above when you are ready.
              </div>
            </>
          ) : (
            <div className="text-text-secondary">This run has no integration branch to merge.</div>
          )}
        </section>
        )}

        <CandidatesSection />

        {readOnly && s.lastChecks.length === 0 ? null : (
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
                    <span className="min-w-0 flex-1 truncate font-mono text-code" title={c.command}>
                      {c.command}
                    </span>
                    <span className="tnum text-text-muted">{formatDuration(c.durationMs)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Block>
        )}

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

function CopyButton({ text, testId = 'copy-merge' }: { text: string; testId?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }}
      data-testid={testId}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}
