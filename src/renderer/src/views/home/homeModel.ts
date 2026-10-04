import { TERMINAL_RUN_STATES, type Project, type Run } from '@shared/domain'
import type { OvernightStatus } from '@shared/overnight'
import type { HomeRun, HomeSummary } from '@shared/v3-read'

/** What the Home page renders. Built from home.summary, or composed from older queries when that is unavailable. */
export interface HomeMission {
  run: Run
  projectName: string
  /** Null when unknown (fallback mode): no progress bar is drawn without a known denominator. */
  tasksTotal: number | null
  tasksCompleted: number | null
  activeAgents: number | null
  strategy: string | null
}

export interface HomeData {
  source: 'summary' | 'composed'
  activeRuns: HomeMission[]
  recentRuns: HomeMission[]
  projects: { id: string; name: string; branch: string | null; lastOpenedAt: string }[]
  activeAgents: number | null
  overnight: OvernightStatus[]
  arena: { campaigns: number; trials: number; headline: string | null } | null
  policy: HomeSummary['policy'] | null
}

const mission = (r: HomeRun): HomeMission => ({
  run: r.run,
  projectName: r.projectName,
  tasksTotal: r.tasksTotal,
  tasksCompleted: r.tasksCompleted,
  activeAgents: r.activeAgents,
  strategy: r.strategy,
})

export function fromSummary(s: HomeSummary): HomeData {
  return {
    source: 'summary',
    activeRuns: s.activeRuns.map(mission),
    recentRuns: s.recentRuns.map(mission),
    projects: s.projects,
    activeAgents: s.activeAgents,
    overnight: s.overnight,
    arena: { campaigns: s.arena.campaigns, trials: s.arena.trials, headline: s.arena.headline },
    policy: s.policy,
  }
}

/** Degraded Home from the plain queries. Anything those cannot answer stays null instead of being invented. */
export function composeHome(input: {
  projects: readonly Project[]
  runs: readonly Run[]
  overnight: readonly OvernightStatus[]
}): HomeData {
  const names = new Map(input.projects.map((p) => [p.id, p.name]))
  const toMission = (run: Run): HomeMission => ({
    run,
    projectName: names.get(run.projectId) ?? 'Unknown project',
    tasksTotal: null,
    tasksCompleted: null,
    activeAgents: null,
    strategy: run.config.strategy?.resolved ?? null,
  })
  const sorted = [...input.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return {
    source: 'composed',
    activeRuns: sorted.filter((r) => !TERMINAL_RUN_STATES.includes(r.state)).map(toMission),
    recentRuns: sorted.slice(0, 8).map(toMission),
    projects: [...input.projects]
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
      .map((p) => ({
        id: p.id,
        name: p.name,
        branch: p.profile?.currentBranch ?? null,
        lastOpenedAt: p.lastOpenedAt,
      })),
    activeAgents: null,
    overnight: [...input.overnight],
    arena: null,
    policy: null,
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** One neutral sentence under the page title. */
export function summaryLine(d: HomeData, claudeLabel: string | null): string {
  const parts: string[] = []
  const running = d.activeRuns.length
  parts.push(running === 0 ? 'No mission is running' : `${plural(running, 'mission')} running`)
  if (d.activeAgents !== null && d.activeAgents > 0)
    parts.push(plural(d.activeAgents, 'active agent'))
  if (d.overnight.length > 0) parts.push('Overnight active')
  if (claudeLabel) parts.push(`Claude: ${claudeLabel.toLowerCase()}`)
  return parts.join(' · ')
}

export function isFirstLaunch(d: HomeData): boolean {
  return d.projects.length === 0 && d.recentRuns.length === 0
}

/** "3 of 8 tasks" with the ratio, or null when either side is unknown. */
export function taskProgress(
  m: Pick<HomeMission, 'tasksTotal' | 'tasksCompleted'>,
): { done: number; total: number } | null {
  if (m.tasksTotal === null || m.tasksCompleted === null || m.tasksTotal <= 0) return null
  return { done: Math.min(m.tasksCompleted, m.tasksTotal), total: m.tasksTotal }
}
