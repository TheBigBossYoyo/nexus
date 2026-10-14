import { useState } from 'react'
import { TERMINAL_RUN_STATES } from '@shared/domain'
import {
  BranchIcon,
  Button,
  ChevronDownIcon,
  ConfirmDialog,
  InfoIcon,
  PageHeader,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Popover,
  ProgressBar,
  StatusBadge,
  StatusDot,
  StopIcon,
  Textarea,
  ErrorNote,
  TrashIcon,
} from '../../components/ui'
import { formatSpan } from '../../lib/format'
import { useCleanupRun, useGraphRevisions, useReplan } from '../../lib/queries'
import { useRunPolicy } from '../../lib/queries-run'
import { deriveHealth, planVersion } from '../../lib/v2logic'
import { runStatus } from '../../lib/status'
import { useUiStore } from '../../store/ui'
import { useRunControls } from '../../app/useRunControls'
import { AddTaskDialog } from './AddTaskDialog'
import { MissionAdmissionInspector } from '../projects/CompiledTaskInspector'
import { CompilationPreview } from '../projects/CompilationPreview'
import { defaultIntentMetadata, type CompilationMode, type CompiledTaskSpec } from '@shared/intelligence'
import { missionTitle, policyView, strategyChip, type PolicyView } from './missionModel'
import { pauseCauseFromEvents, pauseDetailFromEvents, pauseLabel } from './eventText'
import { useNow, useRunCtx } from './runContext'

function WhyStrategyBody({ view }: { view: PolicyView }) {
  return (
    <div className="flex max-h-[70vh] flex-col gap-3 overflow-auto p-3" data-testid="strategy-why">
      <p className="m-0 font-medium text-text-primary">{view.headline}</p>
      {view.kind === 'decision' ? (
        <>
          <dl className="m-0 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
            <dt className="text-text-muted">Layer</dt>
            <dd className="m-0">
              {view.layer}
              {view.exploration ? ' (exploration)' : ''}
              {view.layerNote ? <span className="block text-text-muted">{view.layerNote}</span> : null}
            </dd>
            <dt className="text-text-muted">Reason</dt>
            <dd className="m-0 break-words" data-testid="strategy-why-reason">
              {view.reason}
            </dd>
            {view.profile ? (
              <>
                <dt className="text-text-muted">Task profile</dt>
                <dd className="m-0">{view.profile}</dd>
              </>
            ) : null}
            <dt className="text-text-muted">Policy</dt>
            <dd className="m-0">{view.version}</dd>
          </dl>
          <div>
            <div className="mb-1 text-caption font-medium text-text-muted">Evidence by strategy</div>
            {view.evidence.length === 0 ? (
              <p className="m-0 text-small text-text-muted">No stored evidence for this kind of task.</p>
            ) : (
              <table className="w-full border-collapse text-small" data-testid="strategy-evidence">
                <thead>
                  <tr className="text-left text-caption text-text-muted">
                    <th className="py-1 pr-2 font-medium">Strategy</th>
                    <th className="py-1 pr-2 font-medium">Arena</th>
                    <th className="py-1 pr-2 font-medium">Missions</th>
                    <th className="py-1 font-medium">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {view.evidence.map((r) => (
                    <tr key={r.strategy} className="border-t">
                      <td className="py-1 pr-2 font-mono text-code">
                        {r.strategy}
                        {r.chosen ? <span className="ml-1 font-sans text-caption text-accent">chosen</span> : null}
                      </td>
                      <td className="tnum py-1 pr-2">{r.arena}</td>
                      <td className="tnum py-1 pr-2">{r.missions}</td>
                      <td className="py-1">{r.suppressed ? `${r.label} (not used)` : r.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="m-0 mt-1 text-caption text-text-muted">
              Arena trials and real missions are counted separately. Real missions are observations, not controlled experiments.
            </p>
          </div>
          {view.resourceNotes.length > 0 ? (
            <ul className="m-0 list-disc pl-4 text-small text-text-secondary">
              {view.resourceNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function StrategyChip() {
  const { detail } = useRunCtx()
  const policy = useRunPolicy(detail.run.id)
  const info = policy.data
  const chip = strategyChip(info?.strategy)
  const view = policyView(info)
  const failed = policy.isError
  return (
    <Popover
      label="Why this strategy"
      testId="strategy-popover"
      width={460}
      content={
        policy.isPending ? (
          <div className="p-3 text-small text-text-muted">Loading…</div>
        ) : failed ? (
          <div className="p-3 text-small text-text-muted">
            Strategy details are not available right now. The mission itself is not affected.
          </div>
        ) : (
          <WhyStrategyBody view={view} />
        )
      }
    >
      {(p) => (
        <button
          type="button"
          {...p}
          data-testid="strategy-chip"
          className="inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-small text-text-secondary hover:bg-surface-muted hover:text-text-primary"
        >
          <span className="text-text-muted">Strategy</span>
          <span className="font-mono text-code text-text-primary" data-testid="run-strategy">
            {chip.label ?? 'Not recorded'}
          </span>
          {chip.hint ? <span className="text-text-muted">({chip.hint})</span> : null}
          <InfoIcon size={12} className="text-text-muted" />
          <span className="sr-only">Why this strategy?</span>
        </button>
      )}
    </Popover>
  )
}

function DetailsPopover({ version }: { version: number }) {
  const { detail } = useRunCtx()
  const { run, tasks, agents, pendingApprovals } = detail
  const health = deriveHealth(run, tasks, pendingApprovals)
  const activeAgents = agents.filter((a) => a.state === 'starting' || a.state === 'working').length
  const row = (label: string, value: React.ReactNode, testId?: string) => (
    <div className="contents">
      <dt className="text-text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
  return (
    <Popover
      label="Mission details"
      align="end"
      width={400}
      testId="run-details"
      content={
        <dl className="m-0 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 p-3 text-small" data-testid="run-meta">
          {row('Mission', <span className="block max-h-32 overflow-auto whitespace-pre-wrap" data-testid="run-prompt">{run.prompt}</span>)}
          {row('Mode', run.mode)}
          {row('Preset', run.preset)}
          {row('Plan version', `v${version}`)}
          {row('Planning', (run.config.planningMode ?? 'single').toUpperCase(), 'planning-mode')}
          {row('Review', (run.config.reviewMode ?? 'auto').toUpperCase(), 'review-mode')}
          {row('Agents', `${activeAgents} of ${run.config.maxParallelAgents} active`, 'active-agents')}
          {row('Phase', run.state.replace(/_/g, ' '), 'run-phase')}
          {row(
            'Health',
            <span className="inline-flex items-center gap-1.5" data-health={health.level}>
              <StatusDot tone={health.tone} />
              {run.state === 'awaiting_approval' ? 'Waiting for you' : health.label}
              {health.reasons.length > 0 ? <span className="text-text-muted">{health.reasons.join(' · ')}</span> : null}
            </span>,
            'run-health',
          )}
          {row(
            'Branch',
            <span className="inline-flex items-center gap-1 font-mono text-code">
              <BranchIcon size={11} />
              {run.baseBranch ?? '?'} → {run.integrationBranch ?? 'not created yet'}
            </span>,
          )}
        </dl>
      }
    >
      {(p) => (
        <button
          type="button"
          {...p}
          data-testid="run-details-toggle"
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-small text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        >
          Details
          <ChevronDownIcon size={12} />
        </button>
      )}
    </Popover>
  )
}

function ReplanButton({ disabled }: { disabled: boolean }) {
  const [mode, setMode] = useState<CompilationMode>('AUTO')
  const [spec, setSpec] = useState<CompiledTaskSpec | null>(null)
  const { detail } = useRunCtx()
  const replan = useReplan()
  const [feedback, setFeedback] = useState('')
  const [open, setOpen] = useState(false)
  return (
    <Popover
      label="Request replanning"
      align="end"
      width={340}
      open={open}
      onOpenChange={setOpen}
      testId="replan-popover"
      content={
        <div className="flex flex-col gap-2 p-3">
          <label className="text-small font-medium" htmlFor="header-replan-feedback">
            What should the planner change?
          </label>
          <Textarea id="header-replan-feedback" rows={3} value={feedback} disabled={replan.isPending} onChange={(e) => { setFeedback(e.target.value); setSpec(null) }} />
          <CompilationPreview projectId={detail.run.projectId} raw={feedback} mode={mode} spec={spec}
            metadata={defaultIntentMetadata(feedback, 'MISSION_REPLAN')} executionScope={{ runId: detail.run.id }}
            onModeChange={m => { setMode(m); setSpec(null) }} onSpec={setSpec} />
          {replan.error ? <ErrorNote error={replan.error} /> : null}
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              loading={replan.isPending}
              disabled={feedback.trim() === ''}
              onClick={() =>
                replan.mutate(
                  { runId: detail.run.id, feedback, compilationMode: mode, ...(spec ? { compiledSpecId: spec.id } : {}) },
                  {
                    onSuccess: () => {
                      setFeedback('')
                      setOpen(false)
                    },
                  },
                )
              }
              data-testid="header-replan-submit"
            >
              Replan
            </Button>
          </div>
        </div>
      }
    >
      {(p) => (
        <Button size="sm" {...p} disabled={disabled} data-testid="header-replan">
          Replan
        </Button>
      )}
    </Popover>
  )
}

/** The single header of Mission Control: identity and actions on top, one quiet facts row below. */
export function MissionHeader() {
  const { detail, events } = useRunCtx()
  const { run, tasks, worktrees } = detail
  const controls = useRunControls()
  const cleanup = useCleanupRun()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const finished = TERMINAL_RUN_STATES.includes(run.state)
  const now = useNow(run.startedAt !== null && !finished)
  const done = tasks.filter((t) => t.state === 'completed').length
  // A capacity wait is explained in the state panel, in words; the header does not repeat its routing reasons.
  const pauseDetail = run.state === 'paused' && run.pauseReason !== 'quota' && run.pauseReason !== 'capacity' ? pauseDetailFromEvents(events) : null
  const revisions = useGraphRevisions(run.id)
  const version = planVersion(revisions.data ?? [])
  const cleanable = finished && worktrees.some((w) => w.state !== 'removed')
  const title = missionTitle(run.prompt)

  return (
    <div className="shrink-0" data-testid="run-header">
      <PageHeader
        context={
          <button
            type="button"
            className="rounded-sm text-text-muted hover:text-text-primary hover:underline"
            onClick={() => useUiStore.setState({ runId: null, taskId: null })}
            data-testid="all-runs"
          >
            Missions
          </button>
        }
        title={title}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b bg-surface px-5 py-2 text-small text-text-secondary [&_span]:whitespace-nowrap" data-testid="run-facts">
        <span data-testid="run-state" data-state={run.state}>
          <StatusBadge status={runStatus(run.state)} />
        </span>
        <span className="inline-flex items-center gap-2" data-testid="run-progress">
          <span className="tnum">
            {done}/{tasks.length} tasks
          </span>
          <ProgressBar value={done} max={Math.max(1, tasks.length)} label="Tasks completed" className="w-20" tone={run.state === 'completed' ? 'success' : 'accent'} />
        </span>
        <span className="tnum" data-testid="run-elapsed" title="Elapsed">
          {formatSpan(run.startedAt, run.finishedAt, now)}
        </span>
        <StrategyChip />
        <span data-testid="plan-version" title="Latest graph revision; v1 is the approved plan">
          Plan v{version}
        </span>
        <DetailsPopover version={version} />
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {controls.canApprovePlan ? (
              <>
                <ReplanButton disabled={controls.busy} />
              </>
            ) : null}
            {controls.canPause ? (
              <Button size="sm" icon={<PauseIcon size={12} />} onClick={controls.pause} disabled={controls.busy} data-testid="header-pause">
                Pause
              </Button>
            ) : null}
            {controls.canResume ? (
              <Button size="sm" variant="primary" icon={<PlayIcon size={12} />} onClick={controls.resume} disabled={controls.busy} data-testid="header-resume">
                Resume
              </Button>
            ) : null}
            {controls.canCancel ? (
              <Button size="sm" variant="danger" icon={<StopIcon size={12} />} onClick={() => setConfirmCancel(true)} disabled={controls.busy} data-testid="header-cancel">
                Stop
              </Button>
            ) : null}
            <Button size="sm" icon={<PlusIcon size={12} />} onClick={() => setAddOpen(true)} disabled={finished} title={finished ? 'The mission has finished; tasks can no longer be added.' : undefined} data-testid="add-task">
              Add task
            </Button>
            {finished ? (
              <Button
                size="sm"
                icon={<TrashIcon size={12} />}
                disabled={!cleanable}
                loading={cleanup.isPending}
                onClick={() => setConfirmCleanup(true)}
                title={cleanable ? 'Remove the run worktrees (branches are kept)' : 'No worktrees left to clean up'}
                data-testid="cleanup-worktrees"
              >
                Clean up worktrees
              </Button>
            ) : null}
        </span>
      </div>

      <MissionAdmissionInspector key={run.id} run={run} />
      {run.state === 'paused' && pauseDetail ? (
        <div className="border-b bg-warning-subtle px-5 py-1.5 text-small text-warning" data-testid="pause-reason">
          {pauseLabel(run.pauseReason, pauseCauseFromEvents(events))}: {pauseDetail}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          controls.cancel()
          setConfirmCancel(false)
        }}
        title="Stop this mission?"
        confirmLabel="Stop mission"
        danger
      >
        Running agents are stopped and the remaining tasks are cancelled. Work already committed is kept.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmCleanup}
        onClose={() => setConfirmCleanup(false)}
        onConfirm={() => {
          cleanup.mutate({ runId: run.id })
          setConfirmCleanup(false)
        }}
        title="Clean up worktrees?"
        confirmLabel="Clean up"
      >
        The run's worktree directories are removed. Branches, including the integration branch, are kept.
      </ConfirmDialog>
      <AddTaskDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}
