import { describe, expect, it } from 'vitest'
import type { Complexity, TaskDependency, TaskKind, TaskState } from '@shared/domain'
import { formatElapsed, formatEtaRange } from '@shared/progress'
import { DurationModel, estimateProgress, FINALE_PRIOR, etaAccuracy, type FinishedTask, type ProgressInput } from '@main/modules/progress/estimator'

// 0.9: progress and time remaining are computed from the task graph and from how long tasks took before.
const T0 = Date.parse('2026-10-13T19:00:00Z')
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()

type T = ProgressInput['tasks'][number]
function task(key: string, state: TaskState, over: Partial<T> = {}): T {
  return { id: key, key, title: `Task ${key}`, kind: 'implement', complexity: 'medium', state, startedAt: null, finishedAt: null, parentTaskId: null, blockedReason: null, repairCycles: 0, ...over }
}
const run = (state: ProgressInput['run']['state'], over: Partial<ProgressInput['run']> = {}): ProgressInput['run'] => ({ id: 'run-1', state, pauseReason: null, startedAt: at(0), createdAt: at(0), finishedAt: null, ...over })
const history = (kind: TaskKind, complexity: Complexity, minutes: number[]): FinishedTask[] => minutes.map((m) => ({ kind, complexity, seconds: m * 60 }))
/** A machine that has finished many tasks: implementation about 20 minutes, lint about 2, repairs about 6. */
const learned = new DurationModel([...history('implement', 'medium', [14, 16, 18, 19, 20, 20, 21, 22, 24, 26, 30, 45]), ...history('implement', 'small', [1.5, 2, 2, 2, 2.5, 2.5, 3, 3, 3.5, 4]), ...history('repair', 'small', [4, 5, 5, 6, 6, 6, 7, 8, 9, 12])], 0.25)
const snap = (tasks: T[], over: Partial<ProgressInput> = {}): ReturnType<typeof estimateProgress> => estimateProgress({ now: T0 + 30 * 60_000, run: run('executing'), tasks, dependencies: [], model: learned, parallelism: 2, ...over })

describe('ranges as a person reads them', () => {
  it('rounds outwards to a step that fits the size and never gives one invented number', () => {
    expect(formatEtaRange(12 * 60, 18 * 60)).toBe('12–18 min')
    expect(formatEtaRange(37 * 60, 52 * 60)).toBe('35–55 min')
    expect(formatEtaRange(80 * 60, 120 * 60)).toBe('1h20–2h')
    expect(formatEtaRange(30, 70)).toBe('under 2 min')
    expect(formatEtaRange(200 * 60, 260 * 60)).toBe('3h–4h30')
    expect(formatEtaRange(18 * 60, 12 * 60)).toBe('12–18 min')
    expect(formatElapsed(68 * 60)).toBe('1h 08m')
    expect(formatElapsed(20)).toBe('under a minute')
  })
})

describe('the duration model', () => {
  it('learns from what finished, and one stuck task does not move it', () => {
    const d = learned.of('implement', 'medium')
    expect(d.n).toBe(12)
    expect(d.median / 60).toBeGreaterThan(18)
    expect(d.median / 60).toBeLessThan(23)
    const withOutlier = new DurationModel([...history('implement', 'medium', [14, 16, 18, 19, 20, 20, 21, 22, 24, 26, 30]), { kind: 'implement', complexity: 'medium', seconds: 9 * 3600 }])
    expect(withOutlier.of('implement', 'medium').median / 60).toBeLessThan(23)
  })

  it('does not believe three samples: few are mixed with general figures, none means general figures', () => {
    const empty = new DurationModel([])
    const few = new DurationModel(history('implement', 'medium', [1, 1, 1]))
    expect(empty.of('implement', 'medium').median).toBe(480)
    expect(few.of('implement', 'medium').median).toBeGreaterThan(60)
    expect(few.of('implement', 'medium').median).toBeLessThan(480)
    // A kind never seen falls back to what tasks of that size took, whatever their kind.
    expect(learned.of('research', 'medium').median / 60).toBeGreaterThan(15)
  })
})

// 0.9.1: a repair-mode mission was shown "Repairing (1 repair in work)" while it diagnosed, as if a failure were fixed.
describe('the stage of repairs', () => {
  it('names a repair only for a task added to fix a failure', () => {
    const diagnose = task('diagnose', 'running', { kind: 'repair', startedAt: at(28) })
    expect(snap([diagnose], { run: run('executing', { mode: 'repair' }) }).stage).toBe('Working on: Task diagnose')
    expect(snap([task('fix', 'running', { kind: 'repair', parentTaskId: 'a', startedAt: at(28) })], { run: run('executing', { mode: 'repair' }) }).stage).toBe('Repairing (1 repair in work)')
    expect(snap([task('mission-fix-1', 'running', { startedAt: at(28) })]).stage).toBe('Repairing (1 repair in work)')
    expect(snap([diagnose], { run: run('executing', { mode: 'build' }) }).stage).toBe('Repairing (1 repair in work)')
  })
})

describe('progress of a mission', () => {
  it('weighs tasks by their work: four lint tasks done and one implementation left is not 80%', () => {
    const tasks = [1, 2, 3, 4].map((i) => task(`lint-${i}`, 'completed', { complexity: 'small', startedAt: at(i), finishedAt: at(i + 2) })).concat([task('feature', 'ready')])
    const s = snap(tasks)
    expect(s.tasks).toMatchObject({ total: 5, completed: 4, remaining: 1 })
    expect(s.percent).toBeLessThan(40)
    expect(s.percent).toBeGreaterThan(15)
  })

  it('gives a range with its confidence, from history: HIGH when every open task is of a kind seen often', () => {
    const s = snap([task('a', 'completed', { startedAt: at(0), finishedAt: at(20) }), task('b', 'ready', { complexity: 'small', repairCycles: 1 })])
    expect(s.eta.lowSeconds).not.toBeNull()
    expect(s.eta.text).toMatch(/min/)
    expect(s.eta.confidence).toBe('HIGH')
    expect((s.eta.highSeconds as number) / 60).toBeLessThan(10)
  })

  it('says LOW and why when nothing of the kind has finished here yet', () => {
    const s = snap([task('a', 'ready'), task('b', 'ready')], { model: new DurationModel([]) })
    expect(s.eta.confidence).toBe('LOW')
    expect(s.eta.uncertainty).toContain('Few tasks of this kind')
    expect((s.eta.highSeconds as number) > (s.eta.lowSeconds as number) * 2).toBe(true)
  })

  it('follows the dependencies: a chain takes the sum, tasks side by side take the longest', () => {
    const chain: TaskDependency[] = [{ taskId: 'b', dependsOnTaskId: 'a' }, { taskId: 'c', dependsOnTaskId: 'b' }]
    const three = [task('a', 'ready'), task('b', 'ready'), task('c', 'ready')]
    const inChain = snap(three, { dependencies: chain, parallelism: 3 })
    const sideBySide = snap(three, { dependencies: [], parallelism: 3 })
    expect((inChain.eta.lowSeconds as number) / (sideBySide.eta.lowSeconds as number)).toBeGreaterThan(2.5)
    // With one worker, side by side is one after another all the same.
    const oneWorker = snap(three, { dependencies: [], parallelism: 1 })
    expect((oneWorker.eta.lowSeconds as number) / (sideBySide.eta.lowSeconds as number)).toBeGreaterThan(2.5)
  })

  it('a running task has done part of its work, and one that runs long is said to be late, not nearly done', () => {
    const halfway = snap([task('a', 'running', { startedAt: at(20) })])
    expect(halfway.percent).toBeGreaterThan(25)
    expect(halfway.percent).toBeLessThan(75)
    expect(halfway.stage).toBe('Working on: Task a')
    const late = snap([task('a', 'running', { startedAt: at(0) })], { now: T0 + 120 * 60_000 })
    expect(late.eta.confidence).toBe('LOW')
    expect(late.eta.uncertainty).toContain('run longer than such tasks usually do')
    expect(late.eta.highSeconds as number).toBeGreaterThan(30 * 60)
  })

  it('goes backwards when verification adds repairs, and says so', () => {
    const before = snap([task('a', 'completed', { startedAt: at(0), finishedAt: at(20) }), task('b', 'verification', { startedAt: at(5), repairCycles: 0 })])
    const after = snap(
      [task('a', 'completed', { startedAt: at(0), finishedAt: at(20) }), task('b', 'verification', { startedAt: at(5), repairCycles: 1 }), task('b-repair-1', 'ready', { kind: 'repair', complexity: 'medium', parentTaskId: 'b' }), task('b-repair-2', 'ready', { kind: 'repair', complexity: 'medium', parentTaskId: 'b' })],
      { previous: before },
    )
    expect(after.percent).toBeLessThan(before.percent)
    expect(after.scopeChange).toBe('Scope expanded: 2 tasks were added after verification.')
    expect(after.eta.highSeconds as number).toBeGreaterThan(before.eta.highSeconds as number)
    expect(snap([task('a', 'ready')], { previous: before }).scopeChange).toBeNull()
  })

  it('keeps active time apart from waiting: a mission that waits for the network says its end is not known', () => {
    const s = snap([task('a', 'completed', { startedAt: at(0), finishedAt: at(20) }), task('b', 'waiting')], { wait: { kind: 'WAITING_FOR_NETWORK', detail: 'Wi-Fi disconnected at 19:25' } })
    expect(s.wait).toBe('WAITING_FOR_NETWORK')
    expect(s.stage).toBe('Waiting for the Internet')
    expect(s.summary).toMatch(/of active work remain\. Waiting for the Internet; when that ends is not known/)
    expect(s.blocker).toContain('Wi-Fi disconnected at 19:25')
    expect(s.eta.lowSeconds).not.toBeNull()
    const quota = snap([task('b', 'waiting')], { run: run('paused', { pauseReason: 'quota' }) })
    expect(quota.wait).toBe('WAITING_FOR_PROVIDER')
    expect(snap([task('b', 'waiting')], { run: run('paused', { pauseReason: 'user' }) }).wait).toBe('WAITING_FOR_USER')
  })

  it('a boundary request that waits while a task runs says what is worked on, and gives the estimate', () => {
    const wait = { kind: 'WAITING_FOR_USER_BOUNDARY' as const, detail: 'git push origin' }
    const s = snap([task('a', 'completed', { startedAt: at(0), finishedAt: at(20) }), task('b', 'running', { startedAt: at(20) })], { wait })
    expect(s.stage).toBe('Working on: Task b (a boundary request waits for your decision)')
    expect(s.summary).toMatch(/of active work remain\.$/)
    expect(s.summary).not.toContain('when that ends is not known')
    expect(s.eta.lowSeconds).not.toBeNull()
    expect(s.wait).toBe('WAITING_FOR_USER_BOUNDARY')
    expect(s.blocker).toContain('git push origin')
  })

  it('a boundary request with nothing else running says it waits, and withholds the clock', () => {
    const wait = { kind: 'WAITING_FOR_USER_BOUNDARY' as const, detail: 'git push origin' }
    const s = snap([task('a', 'completed', { startedAt: at(0), finishedAt: at(20) }), task('b', 'waiting'), task('c', 'ready')], { wait })
    expect(s.stage).toBe('Waiting for your decision on a boundary request')
    expect(s.summary).toContain('Waiting for your decision on a boundary request; when that ends is not known')
    expect(s.wait).toBe('WAITING_FOR_USER_BOUNDARY')
    expect(s.blocker).toContain('git push origin')
  })

  it('a wait for the network stops the running tasks too', () => {
    const s = snap([task('b', 'running', { startedAt: at(20) })], { wait: { kind: 'WAITING_FOR_NETWORK', detail: 'Wi-Fi disconnected' } })
    expect(s.stage).toBe('Waiting for the Internet')
    expect(s.summary).toContain('when that ends is not known')
  })

  it('before there is a plan it gives no number at all', () => {
    const s = snap([], { run: run('planning') })
    expect(s.percent).toBe(0)
    expect(s.eta.lowSeconds).toBeNull()
    expect(s.eta.text).toBe('not known before there is a plan')
    expect(s.stage).toBe('Planning')
  })

  it('a finished mission is 100% with no next refresh; a failed one is not 100%', () => {
    const done = snap([task('a', 'completed', { startedAt: at(0), finishedAt: at(20) })], { run: run('completed', { finishedAt: at(25) }) })
    expect(done).toMatchObject({ percent: 100, wait: 'FINISHED', nextRefreshAt: null, elapsedSeconds: 25 * 60 })
    expect(done.eta.text).toBe('done')
    const failed = snap([task('a', 'completed', { startedAt: at(0), finishedAt: at(20) }), task('b', 'failed')], { run: run('failed', { finishedAt: at(25) }) })
    expect(failed.percent).toBeLessThan(100)
    expect(failed.stage).toBe('Failed')
  })

  it('refreshes in five minutes unless told otherwise, and carries the last milestones only', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ at: at(i), text: `milestone ${i}` }))
    const s = snap([task('a', 'ready')], { milestones: many })
    expect(Date.parse(s.nextRefreshAt as string) - Date.parse(s.at)).toBe(300_000)
    expect(s.milestones).toHaveLength(12)
    expect(s.lastEvent?.text).toBe('milestone 39')
    expect(Date.parse(snap([task('a', 'ready')], { refreshSeconds: 600 }).nextRefreshAt as string) - T0 - 30 * 60_000).toBe(600_000)
  })

  it('a cycle in the graph does not hang it', () => {
    const s = snap([task('a', 'ready'), task('b', 'ready')], { dependencies: [{ taskId: 'a', dependsOnTaskId: 'b' }, { taskId: 'b', dependsOnTaskId: 'a' }] })
    expect(s.eta.lowSeconds).not.toBeNull()
  })
})

describe('how good the estimates were', () => {
  it('measures coverage, bias and width, so that enormous ranges do not pass as good ones', () => {
    const end = T0 + 60 * 60_000
    const good = etaAccuracy([{ at: T0, lowSeconds: 50 * 60, highSeconds: 70 * 60 }, { at: T0 + 30 * 60_000, lowSeconds: 25 * 60, highSeconds: 40 * 60 }], end)
    expect(good).toMatchObject({ samples: 2, coverage: 1 })
    expect(Math.abs(good?.bias ?? 1)).toBeLessThan(0.15)
    const optimistic = etaAccuracy([{ at: T0, lowSeconds: 10 * 60, highSeconds: 20 * 60 }], end)
    expect(optimistic?.coverage).toBe(0)
    expect(optimistic?.bias).toBeLessThan(-0.5)
    const enormous = etaAccuracy([{ at: T0, lowSeconds: 60, highSeconds: 10 * 3600 }], end)
    expect(enormous?.coverage).toBe(1)
    expect(enormous?.meanWidthRatio).toBeGreaterThan(5)
    expect(etaAccuracy([], end)).toBeNull()
  })
})

// 0.9.1: the mission's own final verification (the integration's full checks). The first mission NEXUS ran on
// itself said "finishing" through a 17-minute full suite, and never counted it while its tasks ran.
describe('the final verification of the mission', () => {
  const finale = { stats: { n: 5, p25: 900, median: 1020, p75: 1100, p90: 1300 }, startedAt: null }

  it('is counted after the tasks while they run', () => {
    const tasks = [task('a', 'running', { kind: 'implement', complexity: 'small', startedAt: at(29) })]
    const without = snap(tasks)
    const withFinale = snap(tasks, { finale })
    expect((withFinale.eta.lowSeconds ?? 0) - (without.eta.lowSeconds ?? 0)).toBe(900)
    expect((withFinale.eta.highSeconds ?? 0) - (without.eta.highSeconds ?? 0)).toBe(1300)
  })

  it('is what remains once every task is done, with its own stage, instead of "finishing"', () => {
    const tasks = [task('a', 'completed', { kind: 'implement', complexity: 'small', startedAt: at(1), finishedAt: at(10) })]
    const s = snap(tasks, { run: run('verifying'), finale: { ...finale, startedAt: T0 + 25 * 60_000 } })
    expect(s.eta.text).not.toBe('finishing')
    expect(s.eta.lowSeconds).toBe(600)
    expect(s.eta.highSeconds).toBe(1000)
    expect(s.stage).toBe('Verifying the whole mission (usually about 17 min on this project)')
    expect(s.percent).toBeLessThan(99)
  })

  it('names no duration before this project measured one (the prior is a guess, not this project)', () => {
    const tasks = [task('a', 'completed', { kind: 'implement', complexity: 'small', startedAt: at(1), finishedAt: at(10) })]
    const s = snap(tasks, { run: run('verifying'), finale: { stats: FINALE_PRIOR, startedAt: T0 + 25 * 60_000 } })
    expect(s.stage).toBe('Verifying the whole mission (its first time on this project, so its length is not known yet)')
  })
})
