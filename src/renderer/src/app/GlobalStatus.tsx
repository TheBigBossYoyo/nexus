import type { ReactNode } from 'react'
import { ACTIVE_AGENT_STATES } from '@shared/domain'
import { useActiveOvernight, usePendingApprovals } from '../lib/queries'
import { runStatus } from '../lib/status'
import { cn } from '../lib/cn'
import { overnightWord } from '../lib/wording'
import { isArenaWorkload } from '../views/overnight/workloadModel'
import { useUiStore } from '../store/ui'
import { BranchIcon, CheckIcon, CommandIcon, Kbd, StatusDot, Tooltip } from '../components/ui'
import { useCurrentProject, useSelectedRun } from './useCurrent'
import { IndicatorGlyph, UsagePopover } from './UsagePopover'

const BASE =
  'h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2 text-small text-text-primary transition-colors'
const SHOWN = 'inline-flex'
const ITEM_BUTTON = cn(SHOWN, BASE, 'hover:bg-surface-hover')
/** Lower priority items drop out when the header gets narrow, so the cluster never wraps. */
const WIDE_ONLY = 'hidden @min-[960px]/header:inline-flex'
const WIDE_ITEM = cn(BASE, WIDE_ONLY)

function Label({ children }: { children: ReactNode }) {
  return <span className="text-text-muted">{children}</span>
}

function ClaudeStatus() {
  return (
    <UsagePopover>
      {(p, { model, overview }) => (
        <button
          type="button"
          {...p}
          data-testid="usage-indicator"
          data-status={overview?.status ?? model.status}
          title={model.detail ?? 'Claude availability. Click for usage details.'}
          className={ITEM_BUTTON}
        >
          <Label>Claude</Label>
          <IndicatorGlyph model={model} />
          <span role="status" data-testid="usage-indicator-text">
            {model.label}
          </span>
        </button>
      )}
    </UsagePopover>
  )
}

function AgentsStatus() {
  const { detail } = useSelectedRun()
  const run = detail?.run
  if (!detail || !run) return null
  const active = detail.agents.filter((a) => ACTIVE_AGENT_STATES.includes(a.state)).length
  return (
    <span
      className={WIDE_ITEM}
      data-testid="active-agents"
      title="Active agents in the selected mission"
    >
      <Label>Agents</Label>
      <span className="tnum">
        {active}
        <span className="text-text-muted">/{run.config.maxParallelAgents}</span>
      </span>
    </span>
  )
}

function RunStatus() {
  const { detail } = useSelectedRun()
  const run = detail?.run
  if (!run) return null
  const st = runStatus(run.state)
  const strategy = run.config.strategy?.resolved
  return (
    <span
      className={WIDE_ITEM}
      data-testid="top-run"
      title={`${run.mode.toUpperCase()} mission${strategy ? ` · ${strategy} strategy` : ''}`}
    >
      <Label>Run</Label>
      <span className="capitalize">{strategy ? strategy.toLowerCase() : run.mode}</span>
      <span aria-hidden="true" className="text-text-muted">
        ·
      </span>
      <StatusDot tone={st.tone} />
      <span>{st.label}</span>
    </span>
  )
}

function OvernightStatus({ showOff }: { showOff: boolean }) {
  const active = useActiveOvernight().data ?? []
  const openOvernight = useUiStore((s) => s.setView)
  const first = active[0]
  if (!first) {
    if (!showOff) return null
    return (
      <span className={WIDE_ITEM} data-testid="overnight-off">
        <Label>Overnight</Label>
        <span>Off</span>
      </span>
    )
  }
  const state = overnightWord(first.state)
  return (
    <button
      type="button"
      data-testid="overnight-indicator"
      onClick={() => openOvernight('overnight')}
      title={`Overnight ${isArenaWorkload(first) ? 'campaign' : 'run'} active${active.length > 1 ? ` (${active.length})` : ''}. Open the Overnight page.`}
      className={ITEM_BUTTON}
    >
      <Label>Overnight</Label>
      <StatusDot tone="warning" />
      <span>{state}</span>
    </button>
  )
}

function GitStatus() {
  const project = useCurrentProject()
  const profile = project?.profile ?? null
  if (!project) return null
  return (
    <span
      className={WIDE_ITEM}
      data-testid="top-project"
      title={`${project.name}${profile?.currentBranch ? ` on ${profile.currentBranch}` : ''}`}
    >
      <BranchIcon size={12} className="text-text-muted" />
      <span className="max-w-32 truncate font-mono text-code">
        {profile?.currentBranch ?? project.name}
      </span>
      {profile ? (
        <>
          <span aria-hidden="true" className="text-text-muted">
            ·
          </span>
          <span className={profile.dirty ? 'text-warning' : 'text-text-secondary'}>
            {profile.dirty ? 'dirty' : 'clean'}
          </span>
        </>
      ) : null}
    </span>
  )
}

function ApprovalsStatus() {
  const count = (usePendingApprovals().data ?? []).length
  const setDrawer = useUiStore((s) => s.setDrawer)
  return (
    <button
      type="button"
      data-testid="approval-badge"
      onClick={() => setDrawer('approvals')}
      title="Pending approvals"
      className={cn(BASE, 'hover:bg-surface-hover', count === 0 ? WIDE_ONLY : SHOWN)}
    >
      <CheckIcon size={12} className={count > 0 ? 'text-warning' : 'text-text-muted'} />
      <Label>Approvals</Label>
      <span
        data-testid="approval-count"
        className={cn(
          'tnum',
          count > 0
            ? 'rounded-sm bg-warning-subtle px-1 font-semibold text-warning'
            : 'text-text-muted',
        )}
      >
        {count}
      </span>
    </button>
  )
}

function PaletteButton() {
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)
  return (
    <Tooltip text="Command palette" align="end">
      <button
        type="button"
        data-testid="open-palette"
        aria-label="Open command palette"
        onClick={() => setPaletteOpen(true)}
        className={cn(ITEM_BUTTON, 'border-border text-text-secondary')}
      >
        <CommandIcon size={12} />
        <Kbd className="border-0 bg-transparent">Ctrl K</Kbd>
      </button>
    </Tooltip>
  )
}

/** Concise global status for the right of every header. Only what is relevant to the page is shown. */
export function GlobalStatus() {
  const view = useUiStore((s) => s.view)
  const showGit = view === 'projects' || view === 'run' || view === 'agents'
  const showRun = view === 'agents'
  const showOvernightOff = view === 'home' || view === 'overnight' || view === 'projects'
  return (
    <>
      <ClaudeStatus />
      {showRun ? <AgentsStatus /> : null}
      {showRun ? <RunStatus /> : null}
      <OvernightStatus showOff={showOvernightOff} />
      {showGit ? <GitStatus /> : null}
      <ApprovalsStatus />
      <PaletteButton />
    </>
  )
}
