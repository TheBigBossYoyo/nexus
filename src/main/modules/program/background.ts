import type { PushMessage } from '@shared/events'
import { newId } from '@shared/ids'
import { BackgroundSettingsSchema, DEFAULT_BACKGROUND_SETTINGS, type BackgroundJob, type BackgroundJobKind, type BackgroundSettings, type BacklogProposal, type BacklogProvenance } from '@shared/program'
import { errorMessage, NexusError } from '@shared/result'
import type { Run } from '@shared/domain'
import type { EventBus } from '@main/modules/events'
import type { Repositories } from '@main/modules/persistence'
import type { ProgramRunHost } from './engine'
import { buildBackgroundPrompt, parseFindings } from './reasoning'

export interface BackgroundDeps {
  repos: Repositories
  bus: EventBus
  host: ProgramRunHost
  /** Stores proposals as backlog items (the engine's deduplicating insert). */
  addBacklog: (projectId: string, programId: string | null, proposals: readonly BacklogProposal[], provenance: BacklogProvenance) => { id: string }[]
  repositoryFacts: (projectId: string) => string
  push?: (message: PushMessage) => void
  now?: () => number
  logger?: (line: string) => void
}

const SETTINGS_KEY = 'background-engineering'
const TERMINAL_RUN: readonly Run['state'][] = ['completed', 'failed', 'cancelled']

/**
 * Background engineering: optional analysis jobs on a project (dependency audit, test gaps, dead code and
 * so on). It is off until the user turns it on, a job runs only when someone asks for it, every job is a
 * read-only run, and its only output is PROPOSALS in the backlog. It never changes a repository.
 */
export class BackgroundEngineering {
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly deps: BackgroundDeps) {
    this.unsubscribe = deps.bus.subscribe((event) => {
      if (this.disposed || (event.type !== 'run.completed' && event.type !== 'run.failed' && event.type !== 'run.cancelled')) return
      const job = deps.repos.backgroundJobs.getByRun(event.runId)
      if (job) this.settle(job.id)
    })
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  private iso(): string {
    return new Date(this.deps.now ? this.deps.now() : Date.now()).toISOString()
  }

  settings(): BackgroundSettings {
    const stored = BackgroundSettingsSchema.safeParse(this.deps.repos.settings.getValue(SETTINGS_KEY))
    return stored.success ? stored.data : DEFAULT_BACKGROUND_SETTINGS
  }

  setSettings(settings: BackgroundSettings): BackgroundSettings {
    const parsed = BackgroundSettingsSchema.parse(settings)
    this.deps.repos.settings.setValue(SETTINGS_KEY, parsed)
    return parsed
  }

  list(projectId: string): BackgroundJob[] {
    return this.deps.repos.backgroundJobs.listByProject(projectId)
  }

  /** Starts one job. Refused unless background engineering is on and this kind is enabled. */
  async start(projectId: string, kind: BackgroundJobKind): Promise<BackgroundJob> {
    const { repos, host } = this.deps
    const settings = this.settings()
    if (!settings.enabled) throw new NexusError('invalid_state', 'Background engineering is switched off. Turn it on in the settings first.')
    if (!settings.kinds.includes(kind)) throw new NexusError('invalid_state', `The background job ${kind} is not enabled.`)
    repos.projects.require(projectId)
    if (repos.backgroundJobs.listOpen().some((j) => j.projectId === projectId && j.kind === kind)) {
      throw new NexusError('invalid_state', `A ${kind} job is already running for this project.`)
    }
    const at = this.iso()
    const job = repos.backgroundJobs.insert({ id: newId(), projectId, kind, state: 'queued', runId: null, proposals: 0, summary: null, error: null, createdAt: at, startedAt: null, finishedAt: null })
    try {
      // Read-only by construction: an `ask` run has no worktree and its agent has no write tools.
      const run = await host.createRun({ projectId, mode: 'ask', preset: 'eco', prompt: buildBackgroundPrompt(kind, this.deps.repositoryFacts(projectId)), overrides: { requirePlanApproval: false } })
      const started = repos.backgroundJobs.update(job.id, { state: 'running', runId: run.id, startedAt: this.iso() })
      this.announce(projectId)
      return started
    } catch (e) {
      const failed = repos.backgroundJobs.update(job.id, { state: 'failed', error: errorMessage(e), finishedAt: this.iso() })
      this.announce(projectId)
      return failed
    }
  }

  async cancel(jobId: string): Promise<BackgroundJob> {
    const job = this.deps.repos.backgroundJobs.require(jobId)
    if (job.state !== 'queued' && job.state !== 'running') return job
    if (job.runId) await Promise.resolve(this.deps.host.cancelRun(job.runId)).catch((e: unknown) => this.deps.logger?.(`background: cancel ${job.runId}: ${errorMessage(e)}`))
    const cancelled = this.deps.repos.backgroundJobs.update(jobId, { state: 'cancelled', finishedAt: this.iso() })
    this.announce(job.projectId)
    return cancelled
  }

  /** Startup: a job whose run ended while NEXUS was closed is settled; one whose run is gone is failed. */
  recover(): void {
    for (const job of this.deps.repos.backgroundJobs.listOpen()) this.settle(job.id)
  }

  private settle(jobId: string): void {
    const { repos } = this.deps
    try {
      const job = repos.backgroundJobs.require(jobId)
      if (job.state !== 'queued' && job.state !== 'running') return
      const run = job.runId ? repos.runs.get(job.runId) : null
      if (run && !TERMINAL_RUN.includes(run.state)) return
      if (!run || run.state !== 'completed') {
        repos.backgroundJobs.update(jobId, { state: run?.state === 'cancelled' ? 'cancelled' : 'failed', error: run?.error ?? (run ? `The analysis run was ${run.state}.` : 'The analysis run no longer exists.'), finishedAt: this.iso() })
        return this.announce(job.projectId)
      }
      const text = repos.tasks.listByRun(run.id).find((t) => t.resultSummary)?.resultSummary ?? null
      const parsed = parseFindings(text)
      if (!parsed.ok) {
        repos.backgroundJobs.update(jobId, { state: 'failed', error: parsed.error, finishedAt: this.iso() })
        return this.announce(job.projectId)
      }
      const added = this.deps.addBacklog(job.projectId, null, parsed.value.proposals, { source: 'background_job', runId: run.id, milestoneKey: null, jobId })
      repos.backgroundJobs.update(jobId, { state: 'completed', proposals: added.length, summary: parsed.value.summary, finishedAt: this.iso() })
      this.announce(job.projectId)
    } catch (e) {
      this.deps.logger?.(`background: settle ${jobId}: ${errorMessage(e)}`)
    }
  }

  private announce(projectId: string): void {
    try {
      this.deps.push?.({ kind: 'backlog', projectId })
    } catch {
      // A push is a hint to refresh; losing one is harmless.
    }
  }
}
