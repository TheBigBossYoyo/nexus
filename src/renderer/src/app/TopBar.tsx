import { useState } from 'react'
import { ACTIVE_AGENT_STATES } from '@shared/domain'
import { useAuthStatus, usePendingApprovals } from '../lib/queries'
import { summarizeAuth } from '../lib/authSummary'
import { runStatus, TONE_CLASSES } from '../lib/status'
import { shortId } from '../lib/format'
import { cn } from '../lib/cn'
import { useUiStore } from '../store/ui'
import {
  BranchIcon,
  Button,
  CommandIcon,
  ConfirmDialog,
  KeyIcon,
  PauseIcon,
  PlayIcon,
  StatusBadge,
  StatusDot,
  StopIcon,
  Badge,
  CheckIcon,
} from '../components/ui'
import { useCurrentProject, useSelectedRun } from './useCurrent'
import { useRunControls } from './useRunControls'

function AuthIndicator() {
  const query = useAuthStatus()
  const setView = useUiStore((s) => s.setView)
  const status = query.data
  const summary = status ? summarizeAuth(status) : null
  const tone = summary?.tone ?? (query.isError ? 'danger' : 'neutral')
  const text = summary?.short ?? (query.isError ? 'Auth check failed' : 'Checking auth')
  const keyExposed = !!status && status.apiKeyEnvDetected && !status.apiKeyEnvStripped
  return (
    <button
      type="button"
      data-testid="auth-indicator"
      onClick={() => setView('auth')}
      title={status ? `${summary?.label ?? ''}. Click for details.` : 'Open authentication details'}
      className="inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-transparent px-2 hover:border-border-strong hover:bg-surface-3"
    >
      <StatusDot tone={tone} />
      <KeyIcon size={12} className="text-fg-faint" />
      <span className={cn('text-[0.9rem]', TONE_CLASSES[tone].text)}>{text}</span>
      {keyExposed ? <Badge tone="warning">API key set</Badge> : null}
    </button>
  )
}

function ApprovalBadge() {
  const count = (usePendingApprovals().data ?? []).length
  const setDrawer = useUiStore((s) => s.setDrawer)
  return (
    <button
      type="button"
      data-testid="approval-badge"
      onClick={() => setDrawer('approvals')}
      title="Pending approvals"
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-[3px] border px-2 text-[0.9rem]',
        count > 0
          ? 'border-tone-waiting bg-tone-waiting font-semibold text-accent-fg'
          : 'border-transparent text-fg-muted hover:border-border-strong hover:bg-surface-3',
      )}
    >
      <CheckIcon size={12} />
      Approvals
      <span data-testid="approval-count" className="font-mono">
        {count}
      </span>
    </button>
  )
}

function RunControls() {
  const c = useRunControls()
  const [confirmCancel, setConfirmCancel] = useState(false)
  if (!c.run) return null
  return (
    <div className="flex items-center gap-1">
      {c.canApprovePlan ? (
        <Button size="sm" variant="primary" icon={<CheckIcon size={12} />} onClick={c.approvePlan} disabled={c.busy} data-testid="approve-plan">
          Approve plan
        </Button>
      ) : null}
      {c.canPause ? (
        <Button size="sm" icon={<PauseIcon size={12} />} onClick={c.pause} disabled={c.busy} data-testid="run-pause">
          Pause
        </Button>
      ) : null}
      {c.canResume ? (
        <Button size="sm" icon={<PlayIcon size={12} />} onClick={c.resume} disabled={c.busy} data-testid="run-resume">
          Resume
        </Button>
      ) : null}
      {c.canCancel ? (
        <Button size="sm" variant="danger" icon={<StopIcon size={12} />} onClick={() => setConfirmCancel(true)} disabled={c.busy} data-testid="run-cancel">
          Cancel
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          c.cancel()
          setConfirmCancel(false)
        }}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        danger
      >
        Running agents are stopped and no further tasks are scheduled. Worktrees and branches are kept.
      </ConfirmDialog>
    </div>
  )
}

export function TopBar() {
  const project = useCurrentProject()
  const { detail } = useSelectedRun()
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)
  const profile = project?.profile ?? null
  const run = detail?.run ?? null
  const active = detail ? detail.agents.filter((a) => ACTIVE_AGENT_STATES.includes(a.state)).length : null

  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b bg-surface-1 px-3" data-testid="top-bar">
      <span className="font-mono text-[0.9rem] font-semibold tracking-[0.2em] text-fg">NEXUS</span>
      <span className="h-4 w-px bg-border-strong" />
      <div className="flex min-w-0 items-center gap-2" data-testid="top-project">
        <span className="truncate font-medium">{project?.name ?? 'No project'}</span>
        {profile?.currentBranch ? (
          <span className="inline-flex items-center gap-1 font-mono text-[0.88em] text-fg-muted">
            <BranchIcon size={12} />
            {profile.currentBranch}
            {profile.dirty ? <span className="text-tone-warning" title="Uncommitted changes">*</span> : null}
          </span>
        ) : null}
      </div>
      {run ? (
        <div className="flex items-center gap-2" data-testid="top-run">
          <span className="h-4 w-px bg-border-strong" />
          <Badge mono>{run.mode.toUpperCase()}</Badge>
          <StatusBadge status={runStatus(run.state)} />
          <span className="font-mono text-[0.85em] text-fg-faint">{shortId(run.id)}</span>
          <span className="text-fg-muted" data-testid="active-agents">
            agents <span className="font-mono text-fg">{active ?? 0}</span>
            <span className="font-mono text-fg-faint">/{run.config.maxParallelAgents}</span>
          </span>
        </div>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <RunControls />
        <ApprovalBadge />
        <AuthIndicator />
        <button
          type="button"
          data-testid="open-palette"
          onClick={() => setPaletteOpen(true)}
          className="inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-border-strong px-2 text-fg-muted hover:bg-surface-3"
          title="Command palette (Ctrl+K)"
        >
          <CommandIcon size={12} />
          <span className="font-mono text-[0.85em]">Ctrl K</span>
        </button>
      </div>
    </header>
  )
}
