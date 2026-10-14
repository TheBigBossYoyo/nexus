import type { Run, Task, TaskDependency } from '@shared/domain'
import type { RunEvent } from '@shared/events'
import { DEFAULT_PROGRESS_REFRESH_SECONDS, MAX_PROGRESS_REFRESH_SECONDS, MIN_PROGRESS_REFRESH_SECONDS, type ProgressMilestone, type ProgressSnapshot, type ProgressWait } from '@shared/progress'
import { blend, DurationModel, estimateProgress, etaAccuracy, FINALE_PRIOR, statsOf, type FinishedTask } from './estimator'

/**
 * 0.9: the progress of the missions that are going on, kept current. It reads what the runtime already has
 * (runs, tasks, their dependencies, the event log), turns it into a snapshot with the estimator, and says when
 * a snapshot changed in a way worth showing. It starts no session and asks no model.
 */

export interface ProgressServiceDeps {
  now: () => number
  run: (runId: string) => Run | null
  tasks: (runId: string) => Task[]
  dependencies: (runId: string) => TaskDependency[]
  /** Events of a run after a sequence number, oldest first. */
  events: (runId: string, afterSeq: number) => RunEvent[]
  /** Tasks that finished on this machine, most recent first, at most `limit`: what the durations are learned from. */
  finishedTasks: (limit: number) => FinishedTask[]
  /** Share of finished implementation tasks that needed a repair. Absent: a general figure. */
  repairRate?: () => number | null
  parallelism: (run: Run) => number
  /** What a run waits on that the run's own state does not say: the network, a provider, a boundary request. */
  waitOf?: (run: Run) => { kind: Exclude<ProgressWait, 'ACTIVE' | 'FINISHED'>; detail: string } | null
  refreshSeconds?: () => number
  /** Told when a snapshot is new in a way a person would want to see at once (not the five-minute refresh). */
  onChange?: (snapshot: ProgressSnapshot, why: ProgressChange) => void
  /** Kept for learning: what was predicted, and at the end how good it was. */
  record?: (entry: { runId: string; at: number; lowSeconds: number; highSeconds: number; percent: number; confidence: string; wait: ProgressWait }) => void
  recordAccuracy?: (entry: { runId: string; finishedAt: number; samples: number; coverage: number; bias: number; meanWidthRatio: number }) => void
  /** 0.9.1: how long the final verification of earlier missions of this project took, in seconds, most recent first. */
  finaleSeconds?: (projectId: string) => number[]
}

export type ProgressChange = 'STAGE' | 'BLOCKER' | 'WAIT' | 'RECOVERY' | 'SCOPE' | 'COMPLETION' | 'REFRESH'

const two = (n: number): string => String(n).padStart(2, '0')

/** An event as a line a person wants in a progress feed, or null: tool calls and internal state are not milestones. */
export function milestoneOf(event: RunEvent, titleOf: (taskId: string | null) => string | null): ProgressMilestone | null {
  const at = event.createdAt
  const title = (titleOf(event.taskId) ?? 'a task').slice(0, 70)
  const p = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'plan.proposed':
      return { at, text: `Plan proposed: ${String(p['taskCount'])} tasks` }
    case 'plan.approved':
      return { at, text: 'Plan approved' }
    case 'run.started':
      return { at, text: 'Work started' }
    case 'task.completed':
      return { at, text: `Completed: ${title}` }
    case 'task.failed':
      return { at, text: `Failed: ${title}` }
    case 'task.blocked':
      return { at, text: `Blocked: ${title}` }
    case 'task.retry':
      return { at, text: `Retrying: ${title}` }
    case 'task.created':
      return p['kind'] === 'repair' ? { at, text: `Repair task created: ${String(p['title'] ?? title).slice(0, 70)}` } : null
    case 'checks.completed':
      return { at, text: p['passed'] === true ? 'Checks passed' : `Checks failed (${Array.isArray(p['failed']) ? p['failed'].length : 0})` }
    case 'review.completed':
      return { at, text: p['verdict'] === 'approved' ? `Review approved: ${title}` : `Review asked for changes: ${title} (${String(p['findings'])} findings)` }
    case 'verification.passed':
      return { at, text: `Verification passed: ${title}` }
    case 'verification.failed':
      return { at, text: `Verification failed: ${title} (${String(p['failures'])})` }
    case 'git.merged':
      return { at, text: `Merged ${String(p['branch']).split('/').pop() ?? ''}` }
    case 'git.conflict':
      return { at, text: 'Merge conflict' }
    case 'run.paused':
      return { at, text: `Paused (${String(p['reason'])})` }
    case 'run.resumed':
      return { at, text: 'Resumed' }
    case 'run.completed':
      return { at, text: 'Mission completed' }
    case 'run.failed':
      return { at, text: 'Mission failed' }
    case 'run.cancelled':
      return { at, text: 'Mission cancelled' }
    default:
      return null
  }
}

/** "19:04 Unit suite passed", in local time. */
export function milestoneLine(m: ProgressMilestone): string {
  const d = new Date(m.at)
  return `${two(d.getHours())}:${two(d.getMinutes())} ${m.text}`
}

interface Kept {
  snapshot: ProgressSnapshot
  seq: number
  /** When the mission's own final checks began (its integration's checks.started), or null. */
  finaleStartedAt: number | null
  milestones: ProgressMilestone[]
  predictions: { at: number; lowSeconds: number; highSeconds: number }[]
  shownAt: number
  closed: boolean
}

export class ProgressService {
  private readonly kept = new Map<string, Kept>()
  private model: DurationModel | null = null
  private modelAt = 0

  constructor(private readonly deps: ProgressServiceDeps) {}

  private refreshMs(): number {
    const s = this.deps.refreshSeconds?.() ?? DEFAULT_PROGRESS_REFRESH_SECONDS
    return Math.min(MAX_PROGRESS_REFRESH_SECONDS, Math.max(MIN_PROGRESS_REFRESH_SECONDS, s)) * 1000
  }

  /** The history, read again at most every ten minutes: it changes with every finished task, and slowly. */
  private durations(): DurationModel {
    const now = this.deps.now()
    if (this.model === null || now - this.modelAt > 10 * 60_000) {
      this.model = new DurationModel(this.deps.finishedTasks(2000), this.deps.repairRate?.() ?? undefined)
      this.modelAt = now
    }
    return this.model
  }

  private readonly finales = new Map<string, { at: number; stats: ReturnType<typeof statsOf> }>()

  /** How long this project's final verification takes: its history blended with a wide prior, read every ten minutes. */
  private finaleStats(projectId: string): ReturnType<typeof statsOf> {
    const now = this.deps.now()
    const known = this.finales.get(projectId)
    if (known !== undefined && now - known.at < 10 * 60_000) return known.stats
    const seconds = (this.deps.finaleSeconds?.(projectId) ?? []).filter((s) => Number.isFinite(s) && s > 0).slice(0, 20)
    // Few missions of one project: three of them are already its best measure, so the history is trusted sooner than for tasks.
    const history = seconds.length > 0 ? statsOf(seconds) : undefined
    const stats = history !== undefined && history.n >= 3 ? history : blend(history !== undefined ? { ...history, n: history.n * 3 } : undefined, FINALE_PRIOR)
    this.finales.set(projectId, { at: now, stats })
    return stats
  }

  /** The snapshot of a run as of now, or null when there is no such run. Computing it tells nobody. */
  snapshot(runId: string): ProgressSnapshot | null {
    return this.compute(runId)?.snapshot ?? null
  }

  private compute(runId: string): Kept | null {
    const run = this.deps.run(runId)
    if (run === null) return null
    const before = this.kept.get(runId)
    const tasks = this.deps.tasks(runId)
    const titles = new Map(tasks.map((t) => [t.id, t.title]))
    const milestones = [...(before?.milestones ?? [])]
    let seq = before?.seq ?? 0
    let finaleStartedAt = before?.finaleStartedAt ?? null
    for (const event of this.deps.events(runId, seq)) {
      seq = Math.max(seq, event.seq)
      if (event.type === 'checks.started' && event.taskId === null) finaleStartedAt = Date.parse(event.createdAt)
      const m = milestoneOf(event, (id) => (id === null ? null : (titles.get(id) ?? null)))
      if (m !== null) milestones.push(m)
    }
    const now = this.deps.now()
    const snapshot = estimateProgress({
      now,
      run,
      tasks,
      dependencies: this.deps.dependencies(runId),
      model: this.durations(),
      parallelism: this.deps.parallelism(run),
      wait: this.deps.waitOf?.(run) ?? null,
      previous: before?.snapshot ?? null,
      milestones: milestones.slice(-40),
      refreshSeconds: this.refreshMs() / 1000,
      finale: { stats: this.finaleStats(run.projectId), startedAt: finaleStartedAt },
    })
    const kept: Kept = { snapshot, seq, finaleStartedAt, milestones: milestones.slice(-40), predictions: before?.predictions ?? [], shownAt: before?.shownAt ?? 0, closed: before?.closed ?? false }
    this.kept.set(runId, kept)
    return kept
  }

  /**
   * Looks at a run again because something happened in it (an event) or because time passed (the tick), and
   * tells the listener when the change is one to show at once: a new stage, a blocker, a wait that began or
   * ended, more scope, the end; or when the refresh interval is up. Returns the snapshot.
   */
  refresh(runId: string): ProgressSnapshot | null {
    const before = this.kept.get(runId)
    if (before?.closed === true) return before.snapshot
    const kept = this.compute(runId)
    if (kept === null) return null
    const { snapshot } = kept
    const old = before?.snapshot
    const now = this.deps.now()
    let why: ProgressChange | null = null
    if (snapshot.wait === 'FINISHED') why = 'COMPLETION'
    else if (old === undefined) why = 'STAGE'
    else if (snapshot.scopeChange !== null) why = 'SCOPE'
    else if (old.wait !== snapshot.wait) why = snapshot.wait === 'ACTIVE' ? 'RECOVERY' : 'WAIT'
    else if (old.blocker !== snapshot.blocker && snapshot.blocker !== null) why = 'BLOCKER'
    else if (old.stage !== snapshot.stage || old.tasks.completed !== snapshot.tasks.completed) why = 'STAGE'
    else if (now - kept.shownAt >= this.refreshMs()) why = 'REFRESH'
    if (why === null) return snapshot
    kept.shownAt = now
    if (snapshot.eta.lowSeconds !== null && snapshot.eta.highSeconds !== null && snapshot.wait !== 'FINISHED') {
      kept.predictions.push({ at: now, lowSeconds: snapshot.eta.lowSeconds, highSeconds: snapshot.eta.highSeconds })
      if (kept.predictions.length > 500) kept.predictions.shift()
      this.deps.record?.({ runId, at: now, lowSeconds: snapshot.eta.lowSeconds, highSeconds: snapshot.eta.highSeconds, percent: snapshot.percent, confidence: snapshot.eta.confidence, wait: snapshot.wait })
    }
    if (snapshot.wait === 'FINISHED') {
      kept.closed = true
      // How good the estimates of this mission were, kept so that the estimator can be judged and improved.
      const accuracy = etaAccuracy(kept.predictions, now)
      if (accuracy !== null) this.deps.recordAccuracy?.({ runId, finishedAt: now, ...accuracy })
    }
    try {
      this.deps.onChange?.(snapshot, why)
    } catch {
      // A listener that fails does not stop the progress from being kept.
    }
    return snapshot
  }

  /** Every run this service has looked at and that has not ended: the tick refreshes these. */
  open(): string[] {
    return [...this.kept.entries()].filter(([, k]) => !k.closed).map(([id]) => id)
  }

  /** A run ended and was reported: its account is dropped. */
  forget(runId: string): void {
    this.kept.delete(runId)
  }
}
