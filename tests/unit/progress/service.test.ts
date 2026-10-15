import { describe, expect, it } from 'vitest'
import type { Run, Task } from '@shared/domain'
import type { RunEvent } from '@shared/events'
import { progressRows, type ProgressSnapshot } from '@shared/progress'
import { ProgressService, checkLabel, milestoneLine, milestoneOf, type ProgressChange } from '@main/modules/progress/service'

// 0.9: the service that keeps the progress of missions current and says when a change is worth showing.
const T0 = Date.parse('2026-10-13T19:00:00Z')
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()

function world(opts: { fullChecksSeconds?: number | null } = {}) {
  let now = T0
  let seq = 0
  const run = { id: 'run-1', projectId: 'p', state: 'executing', pauseReason: null, startedAt: iso(0), createdAt: iso(0), finishedAt: null, config: { maxParallelAgents: 2 } } as unknown as Run
  const tasks: Task[] = []
  const events: RunEvent[] = []
  const changes: { why: ProgressChange; snapshot: ProgressSnapshot }[] = []
  const recorded: { lowSeconds: number; highSeconds: number }[] = []
  const accuracy: { coverage: number; samples: number }[] = []
  let wait: { kind: 'WAITING_FOR_NETWORK' | 'WAITING_FOR_USER_BOUNDARY'; detail: string } | null = null
  const task = (key: string, state: Task['state'], over: Partial<Task> = {}): Task => {
    const t = { id: key, runId: run.id, key, title: `Task ${key}`, kind: 'implement', complexity: 'medium', state, startedAt: null, finishedAt: null, parentTaskId: null, blockedReason: null, repairCycles: 0, ...over } as unknown as Task
    const at = tasks.findIndex((x) => x.id === key)
    if (at >= 0) tasks[at] = t
    else tasks.push(t)
    return t
  }
  const emit = (type: RunEvent['type'], payload: Record<string, unknown> = {}, taskId: string | null = null): void => {
    seq += 1
    events.push({ seq, runId: run.id, taskId, agentId: null, type, payload, createdAt: new Date(now).toISOString() } as unknown as RunEvent)
  }
  const service = new ProgressService({
    now: () => now,
    run: (id) => (id === run.id ? run : null),
    tasks: () => tasks,
    dependencies: () => [],
    events: (_id, after) => events.filter((e) => e.seq > after),
    finishedTasks: () => Array.from({ length: 12 }, (_, i) => ({ kind: 'implement' as const, complexity: 'medium' as const, seconds: (16 + i) * 60 })),
    parallelism: () => 2,
    waitOf: () => wait,
    onChange: (snapshot, why) => changes.push({ why, snapshot }),
    record: (entry) => recorded.push(entry),
    recordAccuracy: (entry) => accuracy.push(entry),
    fullChecksSeconds: () => opts.fullChecksSeconds ?? null,
  })
  return { run, task, emit, service, changes, recorded, accuracy, advance: (minutes: number) => (now += minutes * 60_000), setWait: (w: typeof wait) => (wait = w), now: () => now }
}

describe('milestones', () => {
  it('are the events a person wants in a feed, and nothing of the tool calls', () => {
    const titleOf = (): string => 'Add the settings page'
    const ev = (type: string, payload: Record<string, unknown> = {}): RunEvent => ({ seq: 1, runId: 'r', taskId: 't', agentId: null, type, payload, createdAt: '2026-10-13T19:04:00' }) as unknown as RunEvent
    expect(milestoneOf(ev('task.completed', { summary: 'x' }), titleOf)?.text).toBe('Completed: Add the settings page')
    expect(milestoneOf(ev('checks.completed', { passed: true, failed: [] }), titleOf)?.text).toBe('Checks passed')
    expect(milestoneOf(ev('checks.completed', { passed: false, failed: ['a', 'b'] }), titleOf)?.text).toBe('Checks failed (2)')
    expect(milestoneOf(ev('verification.failed', { failures: 2, summary: '' }), titleOf)?.text).toBe('Verification failed: Add the settings page (2)')
    expect(milestoneOf(ev('task.created', { kind: 'repair', title: 'Fix the focus order', key: 'k', role: 'worker' }), titleOf)?.text).toBe('Repair task created: Fix the focus order')
    expect(milestoneOf(ev('task.created', { kind: 'implement', title: 'x', key: 'k', role: 'worker' }), titleOf)).toBeNull()
    for (const quiet of ['agent.tool.started', 'agent.tool.completed', 'agent.usage', 'agent.message', 'task.state_changed', 'run.state_changed']) expect(milestoneOf(ev(quiet), titleOf), quiet).toBeNull()
    expect(milestoneLine({ at: '2026-10-13T19:04:00', text: 'Unit suite passed' })).toBe('19:04 Unit suite passed')
  })

  it('shows the test files that passed only when run again, by name and at most three', () => {
    const titleOf = (): string => 'x'
    const ev = (files: string[]): RunEvent => ({ seq: 1, runId: 'r', taskId: 't', agentId: null, type: 'checks.flaky', payload: { files }, createdAt: '2026-10-13T19:04:00' }) as unknown as RunEvent
    expect(milestoneOf(ev(['tests/unit/progress/service.test.ts']), titleOf)?.text).toBe('Passed when run again: service.test.ts')
    expect(milestoneOf(ev(['tests/a.test.ts', 'src/x/b.test.ts', 'tests\\win\\c.test.ts', 'd/d.test.ts', 'e.test.ts']), titleOf)?.text).toBe('Passed when run again: a.test.ts, b.test.ts, c.test.ts and 2 more')
  })
})

describe('the progress service', () => {
  it('tells of a new stage, a wait, a recovery, more scope and the end, each once and with its reason; a quiet refresh only when the interval is up', () => {
    const w = world()
    w.task('a', 'running', { startedAt: iso(0) })
    w.task('b', 'ready')
    w.emit('run.started')
    w.service.refresh('run-1')
    expect(w.changes.map((c) => c.why)).toEqual(['STAGE'])

    // Nothing happened and little time passed: nobody is told.
    w.advance(2)
    w.service.refresh('run-1')
    expect(w.changes).toHaveLength(1)

    // Five minutes after the last one shown: a refresh.
    w.advance(4)
    w.service.refresh('run-1')
    expect(w.changes.at(-1)?.why).toBe('REFRESH')

    w.setWait({ kind: 'WAITING_FOR_NETWORK', detail: 'Wi-Fi disconnected' })
    w.service.refresh('run-1')
    expect(w.changes.at(-1)?.why).toBe('WAIT')
    expect(w.changes.at(-1)?.snapshot.summary).toContain('when that ends is not known')
    w.service.refresh('run-1')
    expect(w.changes.filter((c) => c.why === 'WAIT')).toHaveLength(1)

    w.setWait(null)
    w.service.refresh('run-1')
    expect(w.changes.at(-1)?.why).toBe('RECOVERY')

    w.task('a', 'verification', { startedAt: iso(0), repairCycles: 1 })
    w.task('a-repair', 'ready', { kind: 'repair', parentTaskId: 'a' } as Partial<Task>)
    w.emit('task.created', { kind: 'repair', title: 'Fix a', key: 'a-repair', role: 'worker' }, 'a-repair')
    const before = w.changes.at(-1)?.snapshot.percent ?? 0
    w.service.refresh('run-1')
    expect(w.changes.at(-1)?.why).toBe('SCOPE')
    expect(w.changes.at(-1)?.snapshot.scopeChange).toContain('Scope expanded')
    expect(w.changes.at(-1)?.snapshot.percent).toBeLessThanOrEqual(before)
    expect(w.changes.at(-1)?.snapshot.lastEvent?.text).toBe('Repair task created: Fix a')

    for (const key of ['a', 'b', 'a-repair']) w.task(key, 'completed', { startedAt: iso(0), finishedAt: iso(30) })
    w.advance(30)
    w.run.state = 'completed'
    w.run.finishedAt = new Date(w.now()).toISOString()
    w.emit('run.completed', { summary: 'done' })
    w.service.refresh('run-1')
    expect(w.changes.at(-1)).toMatchObject({ why: 'COMPLETION', snapshot: { percent: 100, wait: 'FINISHED' } })
    // After the end nothing more is said, and the account can be dropped.
    w.service.refresh('run-1')
    expect(w.changes.filter((c) => c.why === 'COMPLETION')).toHaveLength(1)
    expect(w.service.open()).toEqual([])
  })

  it('names the checks of a task while they run, and goes back to the estimator\'s stage when they complete', () => {
    const w = world()
    w.task('a', 'running', { startedAt: iso(0) })
    w.service.refresh('run-1')
    w.emit('checks.started', { commands: ['pnpm run typecheck', 'pnpm test'] }, 'a')
    w.service.refresh('run-1')
    expect(w.changes.at(-1)).toMatchObject({ why: 'STAGE', snapshot: { stage: 'Running checks of Task a: pnpm run typecheck, pnpm test' } })
    w.emit('checks.completed', { passed: true, failed: [] }, 'a')
    w.service.refresh('run-1')
    expect(w.service.snapshot('run-1')?.stage).toBe('Working on: Task a')
  })

  it('names the checks of a running task during a boundary wait, with the boundary said after them', () => {
    const w = world()
    w.task('a', 'running', { startedAt: iso(0) })
    w.setWait({ kind: 'WAITING_FOR_USER_BOUNDARY', detail: 'git push' })
    w.emit('checks.started', { commands: ['pnpm run typecheck', 'pnpm test'] }, 'a')
    const s = w.service.refresh('run-1')
    expect(s?.stage).toBe('Running checks of Task a: pnpm run typecheck, pnpm test (a boundary request waits for your decision)')
    expect(s?.wait).toBe('WAITING_FOR_USER_BOUNDARY')
  })

  it('names the final checks of the mission while they run, but leaves a wait as it is', () => {
    const w = world()
    w.task('a', 'completed', { startedAt: iso(0), finishedAt: iso(10) })
    w.run.state = 'verifying'
    w.emit('checks.started', { commands: ['pnpm run build', 'pnpm test'] }, null)
    // The estimate's word on their length stays (here a first mission of the project: not known yet).
    expect(w.service.refresh('run-1')?.stage).toBe('Final checks: pnpm run build, pnpm test (its first time on this project, so its length is not known yet)')
    w.setWait({ kind: 'WAITING_FOR_NETWORK', detail: 'Wi-Fi disconnected' })
    expect(w.service.refresh('run-1')?.stage).not.toContain('Final checks')
  })

  // 0.9.1: a first mission of a small project (checks of one second) was shown at least 7 minutes, then at least 3 for its last minute.
  it('estimates a first mission final checks from the check durations its tasks measured, else from the wide prior', () => {
    const finish = (w: ReturnType<typeof world>) => {
      w.task('a', 'completed', { startedAt: iso(0), finishedAt: iso(3) })
      w.run.state = 'verifying'
      w.emit('checks.started', { commands: ['npm test'] }, null)
      return w.service.refresh('run-1')?.eta.highSeconds ?? 0
    }
    expect(finish(world({ fullChecksSeconds: 2 }))).toBeLessThan(300)
    expect(finish(world())).toBeGreaterThan(1000)
  })

  it('names a check by what it runs, not by the files a scoped command lists', () => {
    expect(checkLabel('pnpm exec vitest run --passWithNoTests tests/a.test.ts tests/b b.test.ts')).toBe('vitest (2 files)')
    expect(checkLabel('pnpm exec eslint src/x.ts')).toBe('eslint (1 file)')
    expect(checkLabel('pnpm typecheck')).toBe('pnpm typecheck')
    expect(checkLabel('cargo test --all')).toBe('cargo test --all')
  })

  it('keeps what it predicted and, at the end, how good that was', () => {
    const w = world()
    w.task('a', 'running', { startedAt: iso(0) })
    w.service.refresh('run-1')
    w.advance(6)
    w.service.refresh('run-1')
    expect(w.recorded.length).toBeGreaterThanOrEqual(2)
    expect(w.recorded.every((r) => r.highSeconds >= r.lowSeconds)).toBe(true)
    w.task('a', 'completed', { startedAt: iso(0), finishedAt: iso(20) })
    w.advance(14)
    w.run.state = 'completed'
    w.service.refresh('run-1')
    expect(w.accuracy).toHaveLength(1)
    expect(w.accuracy[0]?.samples).toBeGreaterThanOrEqual(2)
    expect(w.accuracy[0]?.coverage).toBeGreaterThanOrEqual(0)
  })

  it('answers null for a run it does not know, and a listener that throws does not stop it', () => {
    const w = world()
    expect(w.service.snapshot('nope')).toBeNull()
    const loud = new ProgressService({ now: () => T0, run: () => w.run, tasks: () => [], dependencies: () => [], events: () => [], finishedTasks: () => [], parallelism: () => 1, onChange: () => { throw new Error('listener') } })
    expect(loud.refresh('run-1')?.stage).toBeDefined()
  })
})

describe('what the panel shows', () => {
  it('names active work as active work, and says the clock is not known while the mission waits', () => {
    const w = world()
    w.task('a', 'completed', { startedAt: iso(0), finishedAt: iso(20) })
    w.task('b', 'waiting')
    w.setWait({ kind: 'WAITING_FOR_NETWORK', detail: 'Wi-Fi disconnected at 19:25' })
    w.advance(68)
    const rows = Object.fromEntries(progressRows(w.service.snapshot('run-1') as ProgressSnapshot).map((r) => [r.label, r.value]))
    expect(rows['Elapsed']).toBe('1h 08m')
    expect(rows['Active work remaining']).toMatch(/min|h/)
    expect(rows['On the clock']).toBe('not known while it waits')
    expect(rows['Blockers']).toContain('Wi-Fi disconnected at 19:25')
    expect(rows['Tasks']).toBe('1 of 2 done')
    expect(rows['Next refresh']).toMatch(/^\d\d:\d\d$/)
  })
})
