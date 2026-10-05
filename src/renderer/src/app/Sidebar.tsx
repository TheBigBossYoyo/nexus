import type { ReactNode } from 'react'
import { TERMINAL_RUN_STATES } from '@shared/domain'
import { useActiveOvernight, useAppInfo, useRuns } from '../lib/queries'
import { runStatus } from '../lib/status'
import { cn } from '../lib/cn'
import { shortTitle } from '../lib/wording'
import { useUiStore, type View } from '../store/ui'
import {
  ActivityIcon,
  AgentsIcon,
  ArenaIcon,
  ChevronLeftIcon,
  FolderIcon,
  HomeIcon,
  IconButton,
  IntelligenceIcon,
  MemoryIcon,
  MoonIcon,
  PerformanceIcon,
  PolicyIcon,
  ProgramsIcon,
  WorkspacesIcon,
  RunsIcon,
  SettingsIcon,
  SidebarIcon,
  StatusDot,
  Tooltip,
  ControlIcon,
  ProvidersIcon,
  UsageIcon,
} from '../components/ui'
import { NAV_GROUPS, NAV_ITEMS } from './nav'
import { useCurrentProject } from './useCurrent'
import { IndicatorGlyph, UsagePopover } from './UsagePopover'

const ICONS: Record<string, ReactNode> = {
  home: <HomeIcon size={16} />,
  projects: <FolderIcon size={16} />,
  run: <RunsIcon size={16} />,
  programs: <ProgramsIcon size={16} />,
  workspaces: <WorkspacesIcon size={16} />,
  agents: <AgentsIcon size={16} />,
  arena: <ArenaIcon size={16} />,
  policy: <PolicyIcon size={16} />,
  usage: <UsageIcon size={16} />,
  providers: <ProvidersIcon size={16} />,
  performance: <PerformanceIcon size={16} />,
  intelligence: <IntelligenceIcon size={16} />,
  control: <ControlIcon size={16} />,
  overnight: <MoonIcon size={16} />,
  activity: <ActivityIcon size={16} />,
  memory: <MemoryIcon size={16} />,
  settings: <SettingsIcon size={16} />,
}

/** Simple geometric product mark: a square with an N built from three strokes. */
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="shrink-0">
      <rect width="22" height="22" rx="6" className="fill-accent" />
      <path
        d="M6.75 15.5V6.5l8.5 9v-9"
        fill="none"
        stroke="var(--color-accent-fg)"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function NavButton({
  view,
  label,
  collapsed,
  badge,
  shortcut,
}: {
  view: View
  label: string
  collapsed: boolean
  badge?: ReactNode
  shortcut?: string
}) {
  const current = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const selected = current === view
  const button = (
    <button
      type="button"
      data-testid={`nav-${view}`}
      aria-current={selected ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? undefined : shortcut ? `${label} (${shortcut})` : label}
      onClick={() => setView(view)}
      className={cn(
        'relative flex h-[var(--row-h)] w-full items-center gap-2.5 rounded-md px-2.5 text-left font-medium transition-colors',
        collapsed && 'justify-center px-0',
        selected
          ? 'bg-accent-subtle text-accent'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      <span className="shrink-0">{ICONS[view]}</span>
      {collapsed ? null : <span className="min-w-0 flex-1 truncate">{label}</span>}
      {collapsed ? null : badge}
      {collapsed && badge ? <span className="absolute right-1.5 top-1.5">{badge}</span> : null}
    </button>
  )
  return collapsed ? (
    <Tooltip text={shortcut ? `${label} (${shortcut})` : label} side="right">
      {button}
    </Tooltip>
  ) : (
    button
  )
}

/** Up to five recent missions of the current project. Expanded navigation only. */
function RecentMissions() {
  const project = useCurrentProject()
  const runs = useRuns(project?.id ?? null)
  const selectedRunId = useUiStore((s) => s.runId)
  const view = useUiStore((s) => s.view)
  const openRun = useUiStore((s) => s.openRun)
  const setView = useUiStore((s) => s.setView)
  if (!project) return null
  const recent = [...(runs.data ?? [])]
    .filter((r) => r.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const total = recent.length
  const shown = recent.slice(0, 3)
  if (total === 0) return null
  return (
    <div className="mt-0.5 flex flex-col" aria-label="Recent missions" role="group">
      {shown.map((r) => {
        const st = runStatus(r.state)
        const selected = r.id === selectedRunId && view === 'run'
        return (
          <button
            key={r.id}
            type="button"
            data-testid={`sidebar-run-${r.id}`}
            onClick={() => openRun(r.id, r.projectId)}
            title={`${r.prompt}\n${st.label}`}
            className={cn(
              'flex h-6 w-full items-center gap-2 rounded-md pl-[34px] pr-2 text-left text-small transition-colors',
              selected
                ? 'bg-accent-subtle text-accent'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
            )}
          >
            <StatusDot tone={st.tone} />
            <span className="min-w-0 flex-1 truncate">{shortTitle(r.prompt)}</span>
          </button>
        )
      })}
      {total > shown.length ? (
        <button
          type="button"
          onClick={() => {
            useUiStore.setState({ runId: null, taskId: null })
            setView('run')
          }}
          className="flex h-6 w-full items-center rounded-md pl-[34px] pr-2 text-left text-small text-text-muted hover:bg-surface-hover hover:text-text-primary"
          data-testid="sidebar-view-all"
        >
          View all ({total})
        </button>
      ) : null}
    </div>
  )
}

function ClaudeRow({ collapsed }: { collapsed: boolean }) {
  return (
    <UsagePopover align="start" side="top">
      {(p, { model }) => (
        <button
          type="button"
          {...p}
          data-testid="sidebar-claude"
          aria-label={`Claude, ${model.label}`}
          title={collapsed ? `Claude · ${model.label}` : undefined}
          className={cn(
            'flex h-[var(--row-h)] w-full items-center gap-2 rounded-md px-2.5 text-left text-small transition-colors hover:bg-surface-hover',
            collapsed && 'justify-center px-0',
          )}
        >
          <IndicatorGlyph model={model} />
          {collapsed ? null : (
            <span className="min-w-0 flex-1 truncate">
              <span className="text-text-muted">Claude · </span>
              <span className="text-text-primary">{model.label}</span>
            </span>
          )}
        </button>
      )}
    </UsagePopover>
  )
}

/** Left navigation: expanded (labels) or an icon rail. Collapse state is persisted; Ctrl+B toggles it. */
export function Sidebar() {
  const collapsed = useUiStore((s) => s.navCollapsed)
  const toggle = useUiStore((s) => s.toggleNav)
  const setView = useUiStore((s) => s.setView)
  const info = useAppInfo().data
  const runs = useRuns(null).data ?? []
  const overnightActive = (useActiveOvernight().data ?? []).length > 0
  const liveRuns = runs.filter((r) => !TERMINAL_RUN_STATES.includes(r.state)).length

  const badgeFor = (view: View): ReactNode => {
    if (view === 'run' && liveRuns > 0)
      return (
        <span
          className="tnum rounded-sm bg-surface-hover px-1 text-caption font-medium text-text-secondary"
          title={`${liveRuns} active`}
        >
          {liveRuns}
        </span>
      )
    if (view === 'overnight' && overnightActive) return <StatusDot tone="warning" />
    return null
  }

  return (
    <nav
      aria-label="Primary"
      data-collapsed={collapsed}
      style={{ width: collapsed ? 'var(--nav-w-collapsed)' : 'var(--nav-w)' }}
      className="flex h-full shrink-0 flex-col overflow-hidden border-r bg-background transition-[width] duration-150"
    >
      <button
        type="button"
        onClick={() => setView('home')}
        aria-label="NEXUS home"
        className={cn(
          'flex h-12 shrink-0 items-center gap-2.5 px-3.5 text-left',
          collapsed && 'justify-center px-0',
        )}
      >
        <Mark />
        {collapsed ? null : (
          <span className="text-heading font-semibold tracking-[0.14em] text-text-primary">
            NEXUS
          </span>
        )}
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
        {NAV_GROUPS.map((g, gi) => (
          <div key={g.id} role="group" aria-label={g.label} className={cn(gi > 0 && 'mt-1')}>
            {collapsed ? (
              gi > 0 ? (
                <div className="mx-2 my-2 h-px bg-border" />
              ) : null
            ) : (
              <div className="px-2.5 pb-1 pt-3 text-caption font-medium text-text-muted">
                {g.label}
              </div>
            )}
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {NAV_ITEMS.filter((n) => n.group === g.id).map((n) => {
                const index = NAV_ITEMS.indexOf(n)
                return (
                  <li key={n.view}>
                    <NavButton
                      view={n.view}
                      label={n.label}
                      collapsed={collapsed}
                      badge={badgeFor(n.view)}
                      {...(index < 9 ? { shortcut: `Ctrl ${index + 1}` } : {})}
                    />
                    {n.view === 'run' && !collapsed ? <RecentMissions /> : null}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t p-2">
        <ClaudeRow collapsed={collapsed} />
        <div
          className={cn(
            'mt-1 flex items-center',
            collapsed ? 'flex-col gap-1' : 'justify-between pl-2.5',
          )}
        >
          <span
            className="font-mono text-caption text-text-muted"
            data-testid="app-version"
            title={info ? `NEXUS ${info.version}` : undefined}
          >
            {info ? (collapsed ? '' : `v${info.version}`) : ''}
          </span>
          <IconButton
            label={collapsed ? 'Expand navigation (Ctrl B)' : 'Collapse navigation (Ctrl B)'}
            aria-expanded={!collapsed}
            onClick={toggle}
            data-testid="nav-toggle"
            size="sm"
          >
            {collapsed ? <SidebarIcon size={14} /> : <ChevronLeftIcon size={14} />}
          </IconButton>
        </div>
      </div>
    </nav>
  )
}
