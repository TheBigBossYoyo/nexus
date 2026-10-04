import type { ReactNode } from 'react'
import type { OvernightStatus } from '@shared/overnight'
import {
  useActiveOvernight,
  useHomeSummary,
  useOpenProject,
  useProjects,
  useRuns,
} from '../../lib/queries'
import { overnightWord } from '../../lib/wording'
import { isArenaWorkload } from '../overnight/workloadModel'
import { runStatus } from '../../lib/status'
import { formatSpan, formatTokens, formatCount } from '../../lib/format'
import { exactResetAt } from '../../lib/usageModel'
import { cn } from '../../lib/cn'
import { useNow } from '../../lib/useNow'
import { useUiStore } from '../../store/ui'
import { HomePrograms } from '../programs/HomePrograms'
import { IndicatorGlyph, useUsageIndicator } from '../../app/UsagePopover'
import {
  ArrowRightIcon,
  BranchIcon,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  FolderIcon,
  PageHeader,
  PlusIcon,
  ProgressBar,
  SourceLabel,
  Skeleton,
  StatusBadge,
  StatusDot,
  TimeAgo,
} from '../../components/ui'
import { clockText } from '../../lib/usageModel'
import {
  composeHome,
  fromSummary,
  isFirstLaunch,
  summaryLine,
  taskProgress,
  type HomeData,
  type HomeMission,
} from './homeModel'

/** Home data: home.summary when the service answers, otherwise composed from the plain queries. */
function useHomeData() {
  const summary = useHomeSummary()
  const degraded = summary.isError
  const projects = useProjects()
  const runs = useRuns(null)
  const overnight = useActiveOvernight()
  if (summary.data)
    return {
      data: fromSummary(summary.data) as HomeData | null,
      pending: false,
      error: null as unknown,
    }
  if (!degraded) return { data: null, pending: true, error: null as unknown }
  if (projects.isPending || runs.isPending)
    return { data: null, pending: true, error: null as unknown }
  if (projects.isError || runs.isError)
    return { data: null, pending: false, error: projects.error ?? runs.error }
  return {
    data: composeHome({
      projects: projects.data ?? [],
      runs: runs.data ?? [],
      overnight: overnight.data ?? [],
    }),
    pending: false,
    error: null as unknown,
  }
}

function Row({
  children,
  onClick,
  testId,
  label,
}: {
  children: ReactNode
  onClick: () => void
  testId?: string
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-testid={testId}
      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-muted"
    >
      {children}
    </button>
  )
}

function ActiveMissions({ data }: { data: HomeData }) {
  const openRun = useUiStore((s) => s.openRun)
  const setView = useUiStore((s) => s.setView)
  const now = useNow(data.activeRuns.length > 0, 15_000)
  return (
    <Card
      title="Active missions"
      data-testid="home-active-missions"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setView('run')}>
          All missions
        </Button>
      }
    >
      {data.activeRuns.length === 0 ? (
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="text-text-secondary">No mission is running.</span>
          <Button size="sm" onClick={() => setView('projects')}>
            Start a mission
          </Button>
        </div>
      ) : (
        <ul className="m-0 -mx-2 flex list-none flex-col gap-1 p-0">
          {data.activeRuns.map((m) => {
            const st = runStatus(m.run.state)
            const progress = taskProgress(m)
            return (
              <li key={m.run.id}>
                <Row
                  onClick={() => openRun(m.run.id, m.run.projectId)}
                  testId={`home-active-${m.run.id}`}
                  label={`Open mission ${m.run.prompt}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{m.run.prompt}</span>
                      <StatusBadge status={st} className="shrink-0" />
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-text-muted">
                      <span>{m.projectName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">
                        {m.strategy ? m.strategy.toLowerCase() : m.run.mode}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tnum">
                        {formatSpan(m.run.startedAt ?? m.run.createdAt, null, now)}
                      </span>
                      {m.activeAgents !== null ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="tnum">
                            {m.activeAgents} agent{m.activeAgents === 1 ? '' : 's'}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {progress ? (
                      <div className="mt-1.5 flex items-center gap-3 pl-3.5">
                        <ProgressBar
                          value={progress.done}
                          max={progress.total}
                          label="Tasks completed"
                          className="max-w-64"
                        />
                        <span className="tnum shrink-0 text-small text-text-secondary">
                          {progress.done}/{progress.total} tasks
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <ArrowRightIcon size={14} className="shrink-0 text-text-muted" />
                </Row>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function RecentMissions({ data }: { data: HomeData }) {
  const openRun = useUiStore((s) => s.openRun)
  const rows: HomeMission[] = data.recentRuns.slice(0, 6)
  return (
    <Card title="Recent missions" data-testid="home-recent-missions">
      {rows.length === 0 ? (
        <p className="m-0 text-text-secondary">Missions you start will be listed here.</p>
      ) : (
        <ul className="m-0 -mx-2 list-none p-0">
          {rows.map((m) => {
            const st = runStatus(m.run.state)
            return (
              <li key={m.run.id}>
                <Row
                  onClick={() => openRun(m.run.id, m.run.projectId)}
                  testId={`home-recent-${m.run.id}`}
                  label={`Open mission ${m.run.prompt}`}
                >
                  <span className="min-w-0 flex-1 truncate" title={m.run.prompt}>
                    {m.run.prompt}
                  </span>
                  <span
                    className="hidden max-w-32 min-w-0 shrink truncate text-small text-text-muted sm:inline"
                    title={m.projectName}
                  >
                    {m.projectName}
                  </span>
                  <span className="flex w-28 shrink-0 justify-end">
                    <StatusBadge status={st} />
                  </span>
                  <TimeAgo
                    iso={m.run.createdAt}
                    className="w-16 shrink-0 text-right text-small text-text-muted"
                  />
                </Row>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function ClaudeCard() {
  const setView = useUiStore((s) => s.setView)
  const { overview, model, now } = useUsageIndicator()
  const reset = overview ? exactResetAt(overview) : null
  return (
    <Card
      title="Claude"
      data-testid="home-claude"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setView('usage')}>
          Usage
        </Button>
      }
    >
      <div className="flex items-center gap-2" role="status">
        <IndicatorGlyph model={model} />
        <span className="font-medium">{model.label}</span>
      </div>
      <dl className="m-0 mt-3 grid grid-cols-[minmax(0,1fr)_auto_3.75rem] items-center gap-x-2 gap-y-1.5">
        <dt className="text-text-muted">Observed tokens</dt>
        <dd className="tnum m-0 text-right">
          {overview
            ? `${formatTokens(overview.session.inputTokens)} in · ${formatTokens(overview.session.outputTokens)} out`
            : '—'}
        </dd>
        <dd className="m-0">
          {overview ? <SourceLabel confidence="OBSERVED" source="LOCAL_AGGREGATION" /> : null}
        </dd>
        <dt className="text-text-muted">Sessions</dt>
        <dd className="tnum m-0 text-right">
          {overview ? formatCount(overview.session.sessions) : '—'}
        </dd>
        <dd className="m-0">
          {overview ? <SourceLabel confidence="OBSERVED" source="LOCAL_AGGREGATION" /> : null}
        </dd>
        <dt className="text-text-muted">Limit</dt>
        <dd className="m-0 text-right">
          {reset ? (
            <span className="tnum">Resets {clockText(reset, now)}</span>
          ) : (
            <span className="text-text-secondary">No limit known</span>
          )}
        </dd>
        <dd className="m-0">
          {reset ? <SourceLabel confidence="EXACT" source="RUNTIME" /> : null}
        </dd>
      </dl>
    </Card>
  )
}

function OvernightCard({ overnight }: { overnight: readonly OvernightStatus[] }) {
  const setView = useUiStore((s) => s.setView)
  const first = overnight[0]
  return (
    <Card
      title="Overnight"
      data-testid="home-overnight"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setView('overnight')}>
          Open
        </Button>
      }
    >
      {first ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2" role="status">
            <StatusDot tone="warning" />
            <span className="font-medium">
              {overnightWord(first.state)}
            </span>
          </div>
          <div className="text-small text-text-secondary">
            {isArenaWorkload(first) ? 'Arena campaign' : 'Mission'} deadline{' '}
            <span className="tnum">{clockText(first.deadlineAt, Date.now())}</span>
          </div>
        </div>
      ) : (
        <p className="m-0 text-text-secondary">Off. No unattended mission or campaign is running.</p>
      )}
    </Card>
  )
}

function PolicyCard({ policy }: { policy: HomeData['policy'] }) {
  const setView = useUiStore((s) => s.setView)
  return (
    <Card
      title="Adaptive policy"
      data-testid="home-policy"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setView('policy')}>
          Policy
        </Button>
      }
    >
      {policy ? (
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
          <dt className="text-text-muted">Version</dt>
          <dd className="m-0 tnum text-right">
            v{policy.version}
            {policy.pinned ? ' (pinned)' : ''}
          </dd>
          <dt className="text-text-muted">Preferences</dt>
          <dd className="m-0 tnum text-right">{policy.preferences}</dd>
          <dt className="text-text-muted">Candidates waiting</dt>
          <dd className="m-0 tnum text-right">{policy.candidates}</dd>
          <dt className="text-text-muted">Exploration</dt>
          <dd className="m-0 text-right capitalize">{policy.exploration.toLowerCase()}</dd>
        </dl>
      ) : (
        <p className="m-0 text-text-secondary">The default policy chooses strategies by rule.</p>
      )}
    </Card>
  )
}

function ArenaCard({ arena }: { arena: HomeData['arena'] }) {
  const setView = useUiStore((s) => s.setView)
  return (
    <Card
      title="Recent Arena results"
      data-testid="home-arena"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setView('arena')}>
          Arena
        </Button>
      }
    >
      {arena?.headline ? (
        <p className="m-0">{arena.headline}</p>
      ) : (
        <p className="m-0 text-text-secondary">
          No Arena results yet. Compare strategies in{' '}
          <button
            type="button"
            className="font-medium text-accent underline underline-offset-2"
            onClick={() => setView('arena')}
          >
            Arena
          </button>
          .
        </p>
      )}
    </Card>
  )
}

function ProjectsCard({ data }: { data: HomeData }) {
  const setView = useUiStore((s) => s.setView)
  const selectProject = useUiStore((s) => s.selectProject)
  const open = useOpenProject()
  return (
    <Card
      title="Projects"
      data-testid="home-projects"
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={<PlusIcon size={12} />}
          loading={open.isPending}
          onClick={() =>
            open.mutate(
              {},
              {
                onSuccess: (p) => {
                  if (p) {
                    selectProject(p.id)
                    setView('projects')
                  }
                },
              },
            )
          }
        >
          Open
        </Button>
      }
    >
      <ul className="m-0 -mx-2 list-none p-0">
        {data.projects.slice(0, 5).map((p) => (
          <li key={p.id}>
            <Row
              label={`Open project ${p.name}`}
              onClick={() => {
                selectProject(p.id)
                setView('projects')
              }}
            >
              <FolderIcon size={14} className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.branch ? (
                <span className="inline-flex shrink-0 items-center gap-1 font-mono text-code text-text-muted">
                  <BranchIcon size={11} />
                  {p.branch}
                </span>
              ) : null}
            </Row>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="home-loading" aria-busy="true">
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  )
}

function FirstLaunch() {
  const setView = useUiStore((s) => s.setView)
  const selectProject = useUiStore((s) => s.selectProject)
  const open = useOpenProject()
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 pt-10" data-testid="home-first-launch">
    <Card>
      <EmptyState
        icon={<FolderIcon size={22} />}
        title="Open a project to start"
        action={
          <Button
            variant="primary"
            icon={<PlusIcon size={12} />}
            loading={open.isPending}
            data-testid="home-open-project"
            onClick={() =>
              open.mutate(
                {},
                {
                  onSuccess: (p) => {
                    if (p) {
                      selectProject(p.id)
                      setView('projects')
                    }
                  },
                },
              )
            }
          >
            Open project
          </Button>
        }
      >
        A project is a Git repository. NEXUS profiles it, plans a mission, and runs agents in
        separate worktrees; your working tree is never written to.
      </EmptyState>
    </Card>
      <ol className="m-0 grid list-none grid-cols-3 gap-3 p-0 text-small text-text-secondary" aria-label="How it works">
        {['Open a project', 'Describe the mission', 'Review the plan'].map((t, i) => (
          <li key={t} className="flex items-center gap-2">
            <span className="tnum inline-flex size-5 items-center justify-center rounded-full border text-caption text-text-muted">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
    </div>
  )
}

export function HomeView() {
  const home = useHomeData()
  const { model } = useUsageIndicator()
  const data = home.data
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="home-view">
      <PageHeader title="Home" />
      <div className="@container min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
          {home.pending ? (
            <HomeSkeleton />
          ) : home.error || !data ? (
            <ErrorNote error={home.error ?? 'Home could not be loaded.'} />
          ) : isFirstLaunch(data) ? (
            <FirstLaunch />
          ) : (
            <>
              <p className="m-0 text-text-secondary" data-testid="home-summary-line">
                {summaryLine(data, model.label)}
              </p>
              <div className={cn('grid gap-5', '@3xl:grid-cols-[minmax(0,1fr)_340px]')}>
                <div className="flex min-w-0 flex-col gap-5">
                  <ActiveMissions data={data} />
                  <HomePrograms />
                  <RecentMissions data={data} />
                </div>
                <div className="flex min-w-0 flex-col gap-5">
                  <ClaudeCard />
                  <OvernightCard overnight={data.overnight} />
                  <PolicyCard policy={data.policy} />
                  <ArenaCard arena={data.arena} />
                  <ProjectsCard data={data} />
                </div>
              </div>
              {data.source === 'composed' ? (
                <p className="m-0 text-small text-text-muted">
                  Showing basic information. Task progress and Arena and policy details are not
                  available right now.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
