import { useState } from 'react'
import { TERMINAL_RUN_STATES } from '@shared/domain'
import { Badge, Button, StatusDot, BranchIcon, ConfirmDialog, PauseIcon, PlayIcon, PlusIcon, StatusBadge, StopIcon, TrashIcon } from '../../components/ui'
import { formatSpan } from '../../lib/format'
import { useCleanupRun, useGraphRevisions } from '../../lib/queries'
import { deriveHealth, planVersion } from '../../lib/v2logic'
import { TONE_CLASSES, runStatus } from '../../lib/status'
import { useUiStore } from '../../store/ui'
import { useRunControls } from '../../app/useRunControls'
import { AddTaskDialog } from './AddTaskDialog'
import { pauseDetailFromEvents } from './eventText'
import { useNow, useRunCtx } from './runContext'

const PROMPT_COLLAPSED_CHARS = 220

/** Run header: identity, live progress and run-level actions. */
export function MissionHeader() {
  const { detail, events } = useRunCtx()
  const { run, tasks, worktrees } = detail
  const controls = useRunControls()
  const cleanup = useCleanupRun()
  const [expanded, setExpanded] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const finished = TERMINAL_RUN_STATES.includes(run.state)
  const now = useNow(run.startedAt !== null && !finished)
  const done = tasks.filter((t) => t.state === 'completed').length
  const longPrompt = run.prompt.length > PROMPT_COLLAPSED_CHARS
  const prompt = expanded || !longPrompt ? run.prompt : `${run.prompt.slice(0, PROMPT_COLLAPSED_CHARS).trimEnd()}…`
  const pauseDetail = run.state === 'paused' ? pauseDetailFromEvents(events) : null
  const revisions = useGraphRevisions(run.id)
  const version = planVersion(revisions.data ?? [])
  const activeAgents = detail.agents.filter((a) => a.state === 'starting' || a.state === 'working').length
  const health = deriveHealth(run, tasks, detail.pendingApprovals)
  const cleanable = finished && worktrees.some((w) => w.state !== 'removed')

  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b bg-surface-1 px-4 py-2.5" data-testid="run-header">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="text-fg-muted hover:text-fg"
          onClick={() => useUiStore.setState({ runId: null, taskId: null })}
          data-testid="all-runs"
        >
          ‹ Runs
        </button>
        <Badge mono>{run.mode.toUpperCase()}</Badge>
        <Badge mono>{run.preset.toUpperCase()}</Badge>
        <span data-testid="run-state" data-state={run.state}>
          <StatusBadge status={runStatus(run.state)} />
        </span>
        <span className="font-mono text-[0.9em] text-fg-muted" data-testid="run-progress">
          tasks {done}/{tasks.length}
        </span>
        <span className="font-mono text-[0.9em] text-fg-muted" data-testid="run-elapsed">
          {formatSpan(run.startedAt, run.finishedAt, now)}
        </span>
        <span className="font-mono text-[0.9em] text-fg-muted">max agents {run.config.maxParallelAgents}</span>
        <span className="inline-flex items-center gap-1 font-mono text-[0.9em] text-fg-muted">
          <BranchIcon size={11} />
          {run.baseBranch ?? '?'} → {run.integrationBranch ?? 'not created yet'}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" icon={<PlusIcon size={12} />} onClick={() => setAddOpen(true)} disabled={finished} data-testid="add-task">
            Add task
          </Button>
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
              Cancel
            </Button>
          ) : null}
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
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[0.9em] text-fg-muted" data-testid="run-meta">
        <span data-testid="plan-version" title="Latest graph revision; v1 is the approved plan">
          plan v{version}
        </span>
        <span data-testid="planning-mode">planning {(run.config.planningMode ?? 'single').toUpperCase()}</span>
        <span data-testid="review-mode">review {(run.config.reviewMode ?? 'auto').toUpperCase()}</span>
        <span data-testid="active-agents">
          agents {activeAgents}/{run.config.maxParallelAgents} active
        </span>
        <span data-testid="run-phase">phase {run.state.replace(/_/g, ' ')}</span>
        <span
          className="inline-flex items-center gap-1.5"
          data-testid="run-health"
          data-health={health.level}
          title={health.reasons.length > 0 ? health.reasons.join(', ') : 'No failed or blocked tasks, no pending approvals'}
        >
          <StatusDot tone={health.tone} />
          <span className={TONE_CLASSES[health.tone].text}>{health.label}</span>
          {health.reasons.length > 0 ? <span className="text-fg-faint">{health.reasons.join(' · ')}</span> : null}
        </span>
      </div>

      <div className="flex items-start gap-2">
        <p className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words" data-testid="run-prompt">
          {prompt}
        </p>
        {longPrompt ? (
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} data-testid="prompt-toggle">
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        ) : null}
      </div>

      {run.state === 'paused' ? (
        <div className="text-tone-waiting" data-testid="pause-reason">
          Paused{run.pauseReason ? ` (${run.pauseReason})` : ''}
          {pauseDetail ? `: ${pauseDetail}` : ''}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          controls.cancel()
          setConfirmCancel(false)
        }}
        title="Cancel this run?"
        confirmLabel="Cancel run"
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
    </header>
  )
}
