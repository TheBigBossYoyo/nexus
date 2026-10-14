import type { Complexity, Run, Task, TaskDependency, TaskKind } from '@shared/domain'
import { formatEtaRange, type EtaEstimate, type ProgressConfidence, type ProgressMilestone, type ProgressSnapshot, type ProgressWait } from '@shared/progress'

/**
 * 0.9: how far a mission is and how much active work remains, computed. The inputs are the task graph as it is
 * now and how long tasks of the same kind took before on this machine. Nothing here asks a model, reads a
 * clock or touches a database: the service around it does that.
 *
 * Three things it refuses to do. It does not count tasks: a lint task and an implementation are not the same
 * amount of work. It does not hide new work: when a verifier adds repairs the percentage goes down and says
 * why. And it does not turn a wait into time: what remains is active work, and a mission that waits for the
 * network says that its end is not known.
 */

export interface DurationStats {
  n: number
  p25: number
  median: number
  p75: number
  p90: number
}

/** What a task of each size takes when nothing is known yet (seconds). Deliberately wide. */
const PRIOR: Record<Complexity, DurationStats> = {
  small: { n: 0, p25: 90, median: 240, p75: 480, p90: 900 },
  medium: { n: 0, p25: 240, median: 600, p75: 1200, p90: 2400 },
  large: { n: 0, p25: 600, median: 1500, p75: 3000, p90: 5400 },
}
/** Below this many finished tasks of a kind, the history is mixed with the prior instead of believed. */
const TRUSTED_SAMPLES = 8

export interface FinishedTask {
  kind: TaskKind
  complexity: Complexity
  seconds: number
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (at - lo)
}

export function statsOf(seconds: readonly number[]): DurationStats {
  const sorted = [...seconds].sort((a, b) => a - b)
  return { n: sorted.length, p25: quantile(sorted, 0.25), median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), p90: quantile(sorted, 0.9) }
}

/** History and prior together: the fewer the samples, the more of the prior. Never a history of three believed as it is. */
export function blend(history: DurationStats | undefined, prior: DurationStats): DurationStats {
  if (history === undefined || history.n === 0) return prior
  const w = Math.min(1, history.n / TRUSTED_SAMPLES)
  const mix = (a: number, b: number): number => a * w + b * (1 - w)
  return { n: history.n, p25: mix(history.p25, prior.p25), median: mix(history.median, prior.median), p75: mix(history.p75, prior.p75), p90: mix(history.p90, prior.p90) }
}

/** How long tasks take here, learned from the ones that finished. Robust statistics: one stuck task does not move a median. */
export class DurationModel {
  private readonly exact = new Map<string, DurationStats>()
  private readonly bySize = new Map<Complexity, DurationStats>()
  readonly samples: number
  /** Share of finished implementation tasks that needed at least one repair, and how long a repair takes. */
  readonly repairRate: number

  constructor(finished: readonly FinishedTask[], repairRate = 0.25) {
    const usable = finished.filter((t) => Number.isFinite(t.seconds) && t.seconds > 0 && t.seconds < 24 * 3600)
    this.samples = usable.length
    this.repairRate = Math.max(0, Math.min(1, repairRate))
    const groups = new Map<string, number[]>()
    const sizes = new Map<Complexity, number[]>()
    for (const t of usable) {
      const key = `${t.kind}|${t.complexity}`
      groups.set(key, [...(groups.get(key) ?? []), t.seconds])
      sizes.set(t.complexity, [...(sizes.get(t.complexity) ?? []), t.seconds])
    }
    for (const [key, seconds] of groups) this.exact.set(key, statsOf(seconds))
    for (const [size, seconds] of sizes) this.bySize.set(size, statsOf(seconds))
  }

  /** The duration of a task of this kind and size: its own history where there is enough, the size's otherwise, the prior behind both. */
  of(kind: TaskKind, complexity: Complexity): DurationStats {
    const prior = blend(this.bySize.get(complexity), PRIOR[complexity])
    return blend(this.exact.get(`${kind}|${complexity}`), prior)
  }
}

const DONE = new Set(['completed', 'cancelled'])
const RUNNING = new Set(['running', 'assigned', 'review', 'verification'])

export interface ProgressInput {
  now: number
  run: Pick<Run, 'id' | 'state' | 'pauseReason' | 'startedAt' | 'createdAt' | 'finishedAt'>
  tasks: readonly Pick<Task, 'id' | 'key' | 'title' | 'kind' | 'complexity' | 'state' | 'startedAt' | 'finishedAt' | 'parentTaskId' | 'blockedReason' | 'repairCycles'>[]
  dependencies: readonly TaskDependency[]
  model: DurationModel
  /** How many tasks run at once at most. */
  parallelism: number
  /** What the work waits on, as the runtime knows it (the network supervisor, the usage service, the boundary inbox). */
  wait?: { kind: Exclude<ProgressWait, 'ACTIVE' | 'FINISHED'>; detail: string } | null
  /** The snapshot before this one, to say what changed. */
  previous?: Pick<ProgressSnapshot, 'tasks' | 'percent'> | null
  milestones?: readonly ProgressMilestone[]
  activeWorkers?: number
  waitingWorkers?: number
  refreshSeconds?: number
  /**
   * 0.9.1: the mission's own verification after its tasks (the integration's full checks, the mission verifier):
   * how long it takes on this project, and when it began (null: not yet). Without it the estimate said "finishing"
   * through a 17-minute full test suite, and never counted that suite while the tasks ran.
   */
  finale?: { stats: DurationStats; startedAt: number | null } | null
}

/** What a mission's final verification takes when this project has none on record (seconds). Deliberately wide. */
export const FINALE_PRIOR: DurationStats = { n: 0, p25: 180, median: 600, p75: 1200, p90: 1800 }

interface Remaining {
  low: number
  expected: number
  high: number
}

/** What a task still needs. A finished one needs nothing; a running one what such tasks usually still need after this long. */
function remainingOf(task: ProgressInput['tasks'][number], model: DurationModel, now: number): Remaining {
  if (DONE.has(task.state) || task.state === 'failed') return { low: 0, expected: 0, high: 0 }
  const d = model.of(task.kind, task.complexity)
  if (RUNNING.has(task.state) && task.startedAt !== null) {
    const elapsed = Math.max(0, (now - Date.parse(task.startedAt)) / 1000)
    // Past its usual time a task is not "nearly done": it is late, and how late is what is least known.
    const overrun = elapsed > d.p90
    return {
      low: Math.max(d.p25 - elapsed, overrun ? d.median * 0.1 : d.median * 0.05),
      expected: Math.max(d.median - elapsed, overrun ? elapsed * 0.25 : d.median * 0.15),
      high: Math.max(d.p90 - elapsed, overrun ? elapsed * 0.6 : d.median * 0.3),
    }
  }
  return { low: d.p25, expected: d.median, high: d.p90 }
}

/** The longest chain of remaining work through the dependencies, for each end of the range. */
function criticalPath(tasks: ProgressInput['tasks'], dependencies: readonly TaskDependency[], remaining: Map<string, Remaining>): Remaining {
  const needs = new Map<string, string[]>()
  for (const d of dependencies) needs.set(d.taskId, [...(needs.get(d.taskId) ?? []), d.dependsOnTaskId])
  // A repair runs after the task it repairs, whether or not the graph says so.
  for (const t of tasks) if (t.parentTaskId !== null) needs.set(t.id, [...(needs.get(t.id) ?? []), t.parentTaskId])
  const memo = new Map<string, Remaining>()
  const visiting = new Set<string>()
  const finish = (id: string): Remaining => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const own = remaining.get(id) ?? { low: 0, expected: 0, high: 0 }
    // A cycle would be a defect of the graph; it is not followed twice.
    if (visiting.has(id)) return own
    visiting.add(id)
    const before = (needs.get(id) ?? []).map(finish)
    visiting.delete(id)
    const result = { low: own.low + Math.max(0, ...before.map((b) => b.low)), expected: own.expected + Math.max(0, ...before.map((b) => b.expected)), high: own.high + Math.max(0, ...before.map((b) => b.high)) }
    memo.set(id, result)
    return result
  }
  const all = tasks.map((t) => finish(t.id))
  return { low: Math.max(0, ...all.map((r) => r.low)), expected: Math.max(0, ...all.map((r) => r.expected)), high: Math.max(0, ...all.map((r) => r.high)) }
}

const WAIT_TEXT: Record<Exclude<ProgressWait, 'ACTIVE' | 'FINISHED'>, string> = {
  WAITING_FOR_NETWORK: 'Waiting for the Internet',
  WAITING_FOR_PROVIDER: 'Waiting for the provider',
  WAITING_FOR_USER_BOUNDARY: 'Waiting for your decision on a boundary request',
  // A pause NEXUS made itself (failed or blocked tasks) is not the owner's: the words fit both.
  WAITING_FOR_USER: 'Paused, waiting for you',
  WAITING_FOR_EXTERNAL_PROCESS: 'Waiting for an external process',
}

function stageOf(input: ProgressInput, counts: ProgressSnapshot['tasks']): string {
  const { run, tasks } = input
  if (run.state === 'completed') return 'Completed'
  if (run.state === 'failed') return 'Failed'
  if (run.state === 'cancelled') return 'Cancelled'
  if (run.state === 'planning') return 'Planning'
  if (run.state === 'awaiting_approval') return 'Waiting for the plan to be approved'
  const running = tasks.filter((t) => RUNNING.has(t.state))
  const repairs = running.filter((t) => t.kind === 'repair' || t.parentTaskId !== null)
  const verifying = running.filter((t) => t.state === 'verification' || t.state === 'review')
  if (repairs.length > 0) return `Repairing (${repairs.length} ${repairs.length === 1 ? 'repair' : 'repairs'} in work)`
  if (verifying.length > 0 && verifying.length === running.length) return `Verifying ${verifying.length === 1 ? (verifying[0]?.title ?? 'a task').slice(0, 60) : `${verifying.length} tasks`}`
  if (running.length === 1) return `Working on: ${(running[0]?.title ?? '').slice(0, 70)}`
  if (running.length > 1) return `Working on ${running.length} tasks (${counts.completed} of ${counts.total} done)`
  if (run.state === 'verifying' || run.state === 'testing' || run.state === 'reviewing') return 'Verifying the whole'
  return counts.remaining === 0 ? 'Finishing' : `Between tasks (${counts.completed} of ${counts.total} done)`
}

/** The snapshot of a mission: how far, what now, how much active work remains, and what it waits on. */
export function estimateProgress(input: ProgressInput): ProgressSnapshot {
  const { now, run, tasks, model } = input
  const finished = run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled'
  const remaining = new Map(tasks.map((t) => [t.id, remainingOf(t, model, now)]))
  const counts: ProgressSnapshot['tasks'] = {
    total: tasks.length,
    completed: tasks.filter((t) => t.state === 'completed').length,
    running: tasks.filter((t) => RUNNING.has(t.state)).length,
    waiting: tasks.filter((t) => t.state === 'waiting' || t.state === 'blocked').length,
    failed: tasks.filter((t) => t.state === 'failed').length,
    remaining: tasks.filter((t) => !DONE.has(t.state) && t.state !== 'failed').length,
  }

  // Work done and work left, in expected seconds. A finished task counts for what it took (or for what such a
  // task takes, when its times are not on record), so a long task that is done weighs as a long task.
  let done = 0
  for (const t of tasks) {
    if (t.state !== 'completed') continue
    const took = t.startedAt !== null && t.finishedAt !== null ? (Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 1000 : Number.NaN
    done += Number.isFinite(took) && took > 0 ? took : model.of(t.kind, t.complexity).median
  }
  // Running tasks have done part of their work: what they usually take, less what they still need.
  for (const t of tasks) if (RUNNING.has(t.state)) done += Math.max(0, model.of(t.kind, t.complexity).median - (remaining.get(t.id)?.expected ?? 0))
  // The final verification: after every task, once. Running, it is what remains of it; not begun, all of it.
  let finale: Remaining | null = null
  if (input.finale != null && !finished && !(run.state === 'planning' || run.state === 'awaiting_approval' || tasks.length === 0)) {
    const d = input.finale.stats
    if (input.finale.startedAt !== null) {
      const elapsed = Math.max(0, (now - input.finale.startedAt) / 1000)
      const overrun = elapsed > d.p90
      finale = { low: Math.max(d.p25 - elapsed, overrun ? d.median * 0.1 : d.median * 0.05), expected: Math.max(d.median - elapsed, overrun ? elapsed * 0.25 : d.median * 0.15), high: Math.max(d.p90 - elapsed, overrun ? elapsed * 0.6 : d.median * 0.3) }
      done += Math.min(elapsed, d.median)
    } else finale = { low: d.p25, expected: d.median, high: d.p90 }
  }
  const left = [...remaining.values()].reduce((sum, r) => sum + r.expected, 0) + (finale?.expected ?? 0)
  // Work that is not in the graph yet but usually comes: repairs of the implementation tasks still to be verified.
  const unverified = tasks.filter((t) => (t.kind === 'implement' || t.kind === 'repair') && !DONE.has(t.state) && t.state !== 'failed' && t.repairCycles === 0).length
  const repairAllowance = unverified * model.repairRate * model.of('repair', 'small').median
  const planning = run.state === 'planning' || run.state === 'awaiting_approval' || tasks.length === 0
  const percent = finished && run.state === 'completed' ? 100 : planning ? 0 : Math.max(0, Math.min(99, Math.round((done / Math.max(1, done + left + repairAllowance)) * 100)))

  // Wall-clock active time: no shorter than the longest chain, no shorter than all the work spread over the workers.
  const path = criticalPath(tasks, input.dependencies, remaining)
  const parallel = Math.max(1, input.parallelism)
  const sum = (pick: (r: Remaining) => number): number => [...remaining.values()].reduce((s, r) => s + pick(r), 0)
  const low = Math.max(path.low, sum((r) => r.low) / parallel) + (finale?.low ?? 0)
  const high = Math.max(path.high, sum((r) => r.high) / parallel) + repairAllowance * 1.5 + (finale?.high ?? 0)

  let confidence: ProgressConfidence = 'MEDIUM'
  let uncertainty: string | null = null
  const open = tasks.filter((t) => !DONE.has(t.state) && t.state !== 'failed')
  const informed = open.filter((t) => model.of(t.kind, t.complexity).n >= TRUSTED_SAMPLES).length
  const late = open.filter((t) => RUNNING.has(t.state) && t.startedAt !== null && (now - Date.parse(t.startedAt)) / 1000 > model.of(t.kind, t.complexity).p90)
  if (planning) {
    confidence = 'LOW'
    uncertainty = 'There is no plan yet: the work is not known.'
  } else if (late.length > 0) {
    confidence = 'LOW'
    uncertainty = `${late.length === 1 ? `"${(late[0]?.title ?? '').slice(0, 50)}" has` : `${late.length} tasks have`} run longer than such tasks usually do.`
  } else if (model.samples < TRUSTED_SAMPLES || informed < open.length / 2) {
    confidence = 'LOW'
    uncertainty = 'Few tasks of this kind have finished on this machine yet; the estimate rests on general figures.'
  } else if (informed === open.length && open.length > 0 && high <= low * 2.5) {
    confidence = 'HIGH'
  } else if (unverified > 0) {
    uncertainty = `${unverified} ${unverified === 1 ? 'task is' : 'tasks are'} not verified yet; repairs may follow.`
  }

  const wait: ProgressWait = finished ? 'FINISHED' : input.wait != null ? input.wait.kind : run.state === 'paused' ? (run.pauseReason === 'quota' || run.pauseReason === 'capacity' ? 'WAITING_FOR_PROVIDER' : 'WAITING_FOR_USER') : 'ACTIVE'
  const nothingLeft = finished || (!planning && open.length === 0 && finale === null)
  const eta: EtaEstimate = nothingLeft
    ? { lowSeconds: 0, highSeconds: 0, text: finished ? 'done' : 'finishing', confidence: 'HIGH', uncertainty: null }
    : planning
      ? { lowSeconds: null, highSeconds: null, text: 'not known before there is a plan', confidence, uncertainty }
      : { lowSeconds: Math.round(low), highSeconds: Math.round(high), text: formatEtaRange(low, high), confidence, uncertainty }

  // What changed in the known scope since the last look. Said, and the percentage follows it down.
  let scopeChange: string | null = null
  if (input.previous != null && counts.total > input.previous.tasks.total) {
    const added = tasks.slice().filter((t) => t.kind === 'repair' || t.parentTaskId !== null).length
    const more = counts.total - input.previous.tasks.total
    scopeChange = added > 0 && tasks.filter((t) => (t.kind === 'repair' || t.parentTaskId !== null) && !DONE.has(t.state)).length > 0 ? `Scope expanded: ${more} ${more === 1 ? 'repair was' : 'tasks were'} added after verification.` : `Scope expanded: ${more} ${more === 1 ? 'task was' : 'tasks were'} added.`
  }

  const blocked = tasks.find((t) => (t.state === 'blocked' || t.state === 'waiting') && t.blockedReason)
  const blocker = input.wait != null ? `${WAIT_TEXT[input.wait.kind]}: ${input.wait.detail}`.slice(0, 300) : blocked ? `${blocked.title.slice(0, 60)}: ${(blocked.blockedReason ?? '').slice(0, 200)}` : null

  const active = eta.lowSeconds === null ? 'How much work remains is not known yet.' : nothingLeft ? (finished ? 'Finished.' : 'Finishing.') : `${eta.text} of active work remain.`
  const waiting = wait === 'ACTIVE' || wait === 'FINISHED' ? '' : ` ${WAIT_TEXT[wait]}; when that ends is not known, so neither is the time on the clock.`
  const milestones = [...(input.milestones ?? [])].slice(-12)
  const elapsedFrom = Date.parse(run.startedAt ?? run.createdAt)
  const elapsedTo = finished && run.finishedAt !== null ? Date.parse(run.finishedAt) : now
  return {
    subject: { kind: 'run', id: run.id },
    at: new Date(now).toISOString(),
    percent,
    stage: wait !== 'ACTIVE' && wait !== 'FINISHED' ? WAIT_TEXT[wait] : finale !== null && input.finale?.startedAt != null && open.length === 0 ? `Verifying the whole mission (usually about ${Math.max(1, Math.round((input.finale.stats.median) / 60))} min on this project)` : stageOf(input, counts),
    elapsedSeconds: Math.max(0, Math.round((elapsedTo - elapsedFrom) / 1000)),
    eta,
    wait,
    summary: `${active}${waiting}`,
    tasks: counts,
    workers: { active: input.activeWorkers ?? counts.running, waiting: input.waitingWorkers ?? counts.waiting },
    blocker,
    scopeChange,
    lastEvent: milestones.at(-1) ?? null,
    milestones,
    nextRefreshAt: finished ? null : new Date(now + (input.refreshSeconds ?? 300) * 1000).toISOString(),
  }
}

/** How good the estimates of a finished mission were: did the ranges hold the truth, and which way were they off. */
export function etaAccuracy(predictions: readonly { at: number; lowSeconds: number; highSeconds: number }[], finishedAt: number, waitedSeconds = 0): { samples: number; coverage: number; bias: number; meanWidthRatio: number } | null {
  const usable = predictions.filter((p) => p.at < finishedAt && p.highSeconds > 0)
  if (usable.length === 0) return null
  let covered = 0
  let bias = 0
  let width = 0
  for (const p of usable) {
    // Active time that really remained after the prediction: the clock, less what was spent waiting.
    const actual = Math.max(0, (finishedAt - p.at) / 1000 - waitedSeconds)
    if (actual >= p.lowSeconds && actual <= p.highSeconds) covered += 1
    const mid = (p.lowSeconds + p.highSeconds) / 2
    bias += (mid - actual) / Math.max(60, actual)
    // A range that is always enormous always covers: the width is reported beside the coverage.
    width += (p.highSeconds - p.lowSeconds) / Math.max(60, actual)
  }
  return { samples: usable.length, coverage: covered / usable.length, bias: bias / usable.length, meanWidthRatio: width / usable.length }
}
