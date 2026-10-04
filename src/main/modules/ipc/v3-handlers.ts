import { TERMINAL_RUN_STATES, type Run } from '@shared/domain'
import type { ipcInputs, IpcChannel, IpcOutputs } from '@shared/ipc'
import { errorMessage, NexusError } from '@shared/result'
import { TERMINAL_TRIAL_STATES, unknownValue, type UsageOverview } from '@shared/v3'
import type { HomeRun, HomeSummary } from '@shared/v3-read'
import type { z } from 'zod'
import type { ArenaService } from '@main/modules/arena'
import type { OvernightSupervisor } from '@main/modules/overnight'
import type { Repositories } from '@main/modules/persistence'
import type { PolicyService } from '@main/modules/policy'
import type { QuotaRecoveryController, UsageIntelligenceService } from '@main/modules/usage'

/** The channels added in 0.3. Their handlers live here so `handlers.ts` stays the 0.2.1 surface. */
export type V3Channel = Extract<
  IpcChannel,
  `usage.${string}` | `arena.${string}` | `policy.${string}` | `speculative.${string}` | `home.${string}` | `activity.${string}`
>

export type V3Handlers = {
  [C in V3Channel]: (input: z.output<(typeof ipcInputs)[C]>) => Promise<IpcOutputs[C]> | IpcOutputs[C]
}

const V3_CHANNELS: readonly V3Channel[] = [
  'usage.overview',
  'usage.totals',
  'usage.breakdown',
  'usage.limitHistory',
  'usage.run',
  'usage.efficiency',
  'usage.refresh',
  'usage.resumeNow',
  'usage.endWait',
  'arena.cases',
  'arena.importCase',
  'arena.trustCase',
  'arena.campaigns',
  'arena.createCampaign',
  'arena.campaign',
  'arena.trials',
  'arena.trial',
  'arena.start',
  'arena.pause',
  'arena.resume',
  'arena.cancel',
  'arena.results',
  'policy.overview',
  'policy.snapshot',
  'policy.compare',
  'policy.learn',
  'policy.promote',
  'policy.reject',
  'policy.rollback',
  'policy.pin',
  'policy.setConfig',
  'policy.decisions',
  'policy.preview',
  'policy.run',
  'speculative.list',
  'home.summary',
  'activity.recent',
]

/** Every 0.3 channel answers with a typed error: used by processes that have none of the 0.3 services. */
export function unavailableV3Handlers(): V3Handlers {
  const unavailable = (channel: string) => (): never => {
    throw new NexusError('runtime_unavailable', `${channel} is not available in this process`)
  }
  return Object.fromEntries(V3_CHANNELS.map((c) => [c, unavailable(c)])) as unknown as V3Handlers
}

export interface V3Context {
  repos: Repositories
  usage?: UsageIntelligenceService
  recovery?: QuotaRecoveryController
  arena?: ArenaService
  policy?: PolicyService
  overnight?: OvernightSupervisor
  /** Native folder picker (lives in main). */
  pickDirectory: () => Promise<string | null>
  /** Native confirmation shown before an imported Arena case is trusted. Absent in tests. */
  confirmTrust?: (message: string, detail: string) => Promise<boolean>
  activeAgentCount: () => number
}

const DAY_MS = 86_400_000
const sinceIso = (days: number | undefined): string | undefined =>
  days === undefined ? undefined : new Date(Date.now() - days * DAY_MS).toISOString()

/** A stored diff can be large; the renderer gets the head of it. */
const PATCH_PREVIEW_CHARS = 20_000

/** What the header shows when no usage service exists: nothing is known, and nothing is invented. */
function unknownOverview(): UsageOverview {
  return {
    capturedAt: new Date().toISOString(),
    provider: 'claude',
    accountMode: unknownValue(),
    subscriptionType: unknownValue(),
    status: 'AVAILABLE',
    availability: 'UNKNOWN',
    session: { sessions: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0, limitEvents: 0 },
    windows: [],
    subscriptionUtilizationPercent: unknownValue(),
    nextResetAt: unknownValue(),
    retryAfterMs: unknownValue(),
    lastLimitAt: null,
    autoResume: { enabled: false, pause: null, nextCheckAt: unknownValue(), pausedRuns: 0 },
    usageReportSupported: null,
  }
}

/** Misuse of a user action (promoting a resolved candidate, rolling back with no earlier snapshot) is an invalid state, not a crash. */
function userAction<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof NexusError) throw e
    throw new NexusError('invalid_state', errorMessage(e))
  }
}

export function createV3Handlers(ctx: V3Context): V3Handlers {
  const { repos } = ctx
  const need = <T>(service: T | undefined, name: string): T => {
    if (!service) throw new NexusError('runtime_unavailable', `${name} is not available in this process`)
    return service
  }
  const usage = (): UsageIntelligenceService => need(ctx.usage, 'Usage intelligence')
  const recovery = (): QuotaRecoveryController => need(ctx.recovery, 'Quota recovery')
  const arena = (): ArenaService => need(ctx.arena, 'Arena')
  const policy = (): PolicyService => need(ctx.policy, 'The policy engine')

  const homeRun = (run: Run): HomeRun => {
    const tasks = repos.tasks.listByRun(run.id).filter((t) => t.parentTaskId === null)
    return {
      run,
      projectName: repos.projects.get(run.projectId)?.name ?? '',
      tasksTotal: tasks.length,
      tasksCompleted: tasks.filter((t) => t.state === 'completed').length,
      activeAgents: repos.agents.listByRun(run.id).filter((a) => a.state === 'working' || a.state === 'starting' || a.state === 'waiting').length,
      strategy: run.config.strategy?.resolved ?? null,
    }
  }

  return {
    // ───────────── usage ─────────────
    'usage.overview': () => ctx.usage?.overview() ?? unknownOverview(),
    'usage.totals': ({ runId, projectId, campaignId, sinceDays }) =>
      usage().totals({
        ...(runId ? { runId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(campaignId ? { arenaCampaignId: campaignId } : {}),
        ...(sinceDays ? { since: sinceIso(sinceDays) as string } : {}),
      }),
    'usage.breakdown': ({ by, runId, campaignId, sinceDays, limit }) =>
      usage().breakdown(
        by,
        {
          ...(runId ? { runId } : {}),
          ...(campaignId ? { arenaCampaignId: campaignId } : {}),
          ...(sinceDays ? { since: sinceIso(sinceDays) as string } : {}),
        },
        limit ?? 50,
      ),
    'usage.limitHistory': ({ limit, offset }) => usage().limitHistory({ limit: limit ?? 50, offset: offset ?? 0 }),
    'usage.run': ({ runId }) => usage().runUsage(runId),
    'usage.efficiency': () => usage().efficiency(),
    'usage.refresh': () => usage().refresh(),
    'usage.resumeNow': async () => {
      await recovery().resumeNow()
      return usage().overview()
    },
    'usage.endWait': async ({ runId }) => {
      await recovery().endWait(runId)
      return usage().overview()
    },

    // ───────────── arena ─────────────
    'arena.cases': () => arena().listCases(),
    'arena.importCase': async () => {
      const dir = await ctx.pickDirectory()
      if (!dir) return null
      return arena().importCase(dir)
    },
    'arena.trustCase': async ({ caseVersionId }) => {
      // Trusting a case lets NEXUS run its commands. The renderer's own dialog is a convenience; this native
      // one is the control, because a script running in the renderer cannot click it.
      const version = repos.arenaCaseVersions.require(caseVersionId)
      if (!version.trusted && ctx.confirmTrust) {
        const d = version.definition
        const commands = [...d.setup, ...Object.values(d.checks).filter((c): c is string => typeof c === 'string'), d.hiddenEvaluation.command]
        const ok = await ctx.confirmTrust(`Trust the Arena case "${d.name}"?`, `NEXUS will run these commands on this computer:\n\n${commands.map((c) => `  ${c}`).join('\n')}`)
        if (!ok) throw new NexusError('invalid_state', 'The case was not trusted.')
      }
      return arena().trustCase(caseVersionId)
    },
    'arena.campaigns': ({ limit, offset }) => arena().listCampaigns({ limit: limit ?? 25, offset: offset ?? 0 }),
    'arena.createCampaign': async ({ start, ...input }) => {
      const campaign = await arena().createCampaign(input)
      return start ? arena().start(campaign.id) : campaign
    },
    'arena.campaign': ({ campaignId }) => arena().campaignDetail(campaignId),
    'arena.trials': ({ campaignId, limit, offset }) => arena().trials(campaignId, { limit: limit ?? 100, offset: offset ?? 0 }),
    'arena.trial': ({ trialId }) => arena().trial(trialId),
    'arena.start': ({ campaignId }) => arena().start(campaignId),
    'arena.pause': ({ campaignId }) => arena().pause(campaignId),
    'arena.resume': ({ campaignId }) => arena().resume(campaignId),
    'arena.cancel': ({ campaignId }) => arena().cancel(campaignId),
    'arena.results': ({ campaignId, sinceDays }) =>
      arena().results({ ...(campaignId ? { campaignId } : {}), ...(sinceDays ? { sinceDays } : {}) }),

    // ───────────── policy ─────────────
    'policy.overview': () => policy().overview(),
    'policy.snapshot': ({ snapshotId }) => {
      const snapshot = policy().snapshot(snapshotId)
      if (!snapshot) throw new NexusError('not_found', `policy snapshot not found: ${snapshotId}`)
      return snapshot
    },
    'policy.compare': ({ a, b }) => userAction(() => policy().compare(a, b)),
    'policy.learn': () => policy().learn(),
    'policy.promote': ({ candidateId }) => userAction(() => policy().promote(candidateId)),
    'policy.reject': ({ candidateId }) => userAction(() => policy().reject(candidateId)),
    'policy.rollback': () => userAction(() => policy().rollback()),
    'policy.pin': ({ snapshotId }) => userAction(() => policy().pin(snapshotId)),
    'policy.setConfig': (input) =>
      userAction(() =>
        policy().setConfig({
          ...(input.exploration ? { exploration: input.exploration } : {}),
          ...(input.speculation ? { speculation: input.speculation } : {}),
        }),
      ),
    'policy.decisions': ({ limit, offset }) => policy().decisions({ limit: limit ?? 50, offset: offset ?? 0 }),
    'policy.preview': (input) => policy().preview(input),
    'policy.run': ({ runId }) => {
      repos.runs.require(runId)
      return (
        ctx.policy?.runInfo(runId) ?? {
          strategy: repos.runs.require(runId).config.strategy ?? null,
          profile: repos.taskProfiles.getByRun(runId),
          decision: repos.policyDecisions.getByRun(runId),
          outcome: repos.missionOutcomes.getByRun(runId),
        }
      )
    },

    // ───────────── speculative execution ─────────────
    'speculative.list': ({ runId }) => ({
      runs: repos.speculativeRuns.listByRun(runId),
      candidates: repos.candidateResults
        .listByRun(runId)
        .map((c) => ({ ...c, diffPatch: c.diffPatch ? c.diffPatch.slice(0, PATCH_PREVIEW_CHARS) : null })),
      decisions: repos.tournamentDecisions.listByRun(runId),
    }),

    // ───────────── home and activity ─────────────
    'home.summary': (): HomeSummary => {
      const projects = repos.projects.list()
      // Runs of Arena trials belong to hidden projects and are shown in the Arena, not here.
      const runs = repos.runs.listRecentUser(60)
      const active = runs.filter((r) => !TERMINAL_RUN_STATES.includes(r.state))
      const campaigns = ctx.arena ? ctx.arena.listCampaigns({ limit: 1, offset: 0 }) : { campaigns: [], total: 0 }
      const overview = ctx.policy?.overview() ?? null
      const latest = campaigns.campaigns[0] ?? null
      return {
        activeRuns: active.slice(0, 5).map(homeRun),
        recentRuns: runs.filter((r) => TERMINAL_RUN_STATES.includes(r.state)).slice(0, 8).map(homeRun),
        projects: projects.slice(0, 8).map((p) => ({ id: p.id, name: p.name, branch: p.profile?.currentBranch ?? null, lastOpenedAt: p.lastOpenedAt })),
        activeAgents: ctx.activeAgentCount(),
        usage: ctx.usage?.overview() ?? unknownOverview(),
        overnight: ctx.overnight?.active() ?? [],
        arena: {
          campaigns: campaigns.total,
          trials: repos.arenaTrials.count(),
          latest,
          headline: latest && ctx.arena ? arenaHeadline(ctx.arena, latest.campaign.id, latest.counts) : null,
        },
        policy: {
          version: overview?.active.version ?? 0,
          preferences: overview?.active.preferences.length ?? 0,
          candidates: overview?.candidates.filter((c) => c.status === 'proposed').length ?? 0,
          exploration: overview?.active.config.exploration ?? 'off',
          pinned: Boolean(overview?.pointer.pinnedId),
        },
      }
    },
    'activity.recent': ({ limit, beforeSeq }) => repos.events.listRecent(limit ?? 200, beforeSeq),
  }
}

/**
 * One sentence about the latest campaign, only when it has finished trials to talk about. It states
 * counts, never a conclusion the sample cannot carry.
 */
function arenaHeadline(arena: ArenaService, campaignId: string, counts: Record<string, number>): string | null {
  const finished = TERMINAL_TRIAL_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0)
  if (finished === 0) return null
  const rows = arena.campaignDetail(campaignId).comparison.filter((r) => r.n > 0)
  if (rows.length === 0) return null
  const best = [...rows].sort((a, b) => (b.passRate ?? 0) - (a.passRate ?? 0) || b.n - a.n)[0]!
  const n = rows.reduce((sum, r) => sum + r.n, 0)
  return `${best.strategy} passed ${best.passed} of ${best.n} (n=${n} trials, ${best.label.toLowerCase()} evidence)`
}
