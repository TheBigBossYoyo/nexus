import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, fileWorker, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'
import { attachUsage, ManualClock, type UsageStack } from './usage-harness'

const MIN = 60_000

/** A worker whose first session of the run hits the limit (exact reset `resetInMs` ahead, or unknown), then works. */
function limitedOnce(clock: ManualClock, resetInMs: number | null, only?: string): FakeScript {
  let hit = false
  return async (spec, ctx) => {
    if (!hit && (!only || spec.prompt.includes(only))) {
      hit = true
      ctx.usage.limit(resetInMs === null ? null : clock.now() + resetInMs)
      await ctx.rateLimit({ status: 'rejected', resetsAt: ctx.usage.resetAtSeconds(), limitType: 'five_hour' })
      await ctx.completeTurn({ text: 'usage limit reached', outcome: 'quota' })
      return
    }
    await fileWorker(spec, ctx)
  }
}

describe('scenario: quota pause and automatic resume', () => {
  let h: Harness
  let stack: UsageStack | undefined
  afterEach(async () => {
    stack?.dispose()
    stack = undefined
    await h?.dispose()
  })

  const liveRows = (): number => h.repos.quotaPauses.listLive().length

  it('13: a limit during worker execution pauses the mission, keeps the task, writes a checkpoint and stops dispatch', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 30 * MIN) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    const paused = await h.waitForState(run.id, 'paused')
    expect(paused).toMatchObject({ pauseReason: 'quota', resumeState: 'executing' })
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')

    // Not a failure: no attempt consumed, nothing retried, no replacement agent.
    const task = h.task(run.id, 'big')
    expect(task).toMatchObject({ state: 'running', attempt: 1, error: null })
    expect(h.eventsOfType(run.id, 'task.failed')).toHaveLength(0)
    expect(h.eventsOfType(run.id, 'task.retry')).toHaveLength(0)
    expect(sessionsOf(h, 'worker')).toHaveLength(1)
    // The agent that hit the limit ended as stopped, not failed (Arena crashedAgents and the Overnight report count failures).
    expect(h.repos.agents.listByTask(task.id).map((a) => a.state)).toEqual(['stopped'])
    expect(h.eventsOfType(run.id, 'agent.failed')).toHaveLength(0)

    // A checkpoint, a global wait and a run wait; the gate is closed and the status says why.
    expect(h.repos.checkpoints.listByRun(run.id).some((c) => c.reason === 'quota')).toBe(true)
    const global = h.repos.quotaPauses.liveGlobal()
    const row = h.repos.quotaPauses.liveForRun(run.id)
    expect(global).toMatchObject({ scope: 'global', state: 'waiting', resetConfidence: 'EXACT' })
    expect(row).toMatchObject({ scope: 'run', runId: run.id, resumeState: 'executing' })
    expect(row?.checkpointId).toBeTruthy()
    expect(Date.parse(global?.nextCheckAt ?? '') - clock.now()).toBe(31 * MIN) // reset + 60 s
    expect(stack.usage.status()).toBe('WAITING_FOR_RESET')
    expect(stack.usage.canDispatch()).toBe(false)
    expect(h.eventsOfType(run.id, 'usage.quota_paused')).toHaveLength(1)
    expect(h.pushes.filter((m) => m.kind === 'usage.notice' && m.notice === 'limit_reached')).toHaveLength(1)

    // The scheduler stays quiet: another tick starts nothing and does not declare the run stuck.
    h.orchestrator.requestTick(run.id)
    await h.orchestrator.idle(run.id)
    expect(sessionsOf(h, 'worker')).toHaveLength(1)
    expect(h.repos.runs.require(run.id).state).toBe('paused')
  })

  it('14: the exact reset arrives, the probe succeeds, and the same task resumes its session and completes', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 30 * MIN) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    const firstAgent = h.repos.agents.listByTask(h.task(run.id, 'big').id)[0]
    const firstSession = h.repos.sessions.listByAgent(firstAgent?.id ?? '')[0]
    const worktreeBefore = h.repos.worktrees.listByRun(run.id).filter((w) => w.taskId !== null).map((w) => w.path)

    // Before the planned time nothing is probed.
    clock.advance(30 * MIN)
    await stack.controller.tick()
    expect(h.runtime.usage.probes).toBe(0)
    expect(h.repos.runs.require(run.id).state).toBe('paused')

    // reset (30 min) + resumeDelay (60 s)
    clock.advance(MIN)
    await stack.controller.tick()
    expect(h.runtime.usage.probes).toBe(1)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const workers = sessionsOf(h, 'worker')
    expect(workers).toHaveLength(2)
    expect(workers[1]?.resumeSessionId).toBe(firstSession?.sdkSessionId)
    expect(h.task(run.id, 'big')).toMatchObject({ state: 'completed', attempt: 1 })
    expect(h.repos.worktrees.listByRun(run.id).filter((w) => w.taskId !== null).map((w) => w.path)).toEqual(worktreeBefore)
    expect(liveRows()).toBe(0)
    const pauses = h.repos.quotaPauses.listRecent()
    expect(pauses.map((p) => p.state).sort()).toEqual(['resumed', 'resumed'])
    const resumes = h.repos.quotaResumes.listByPause(h.repos.quotaPauses.listByRun(run.id)[0]?.id ?? '')
    expect(resumes.map((r) => `${r.kind}:${r.result}`)).toEqual(['resume:resumed'])
    expect(h.eventsOfType(run.id, 'usage.quota_resumed')).toHaveLength(1)
    expect(h.eventsOfType(run.id, 'usage.probe')).toHaveLength(1)
    expect(h.pushes.find((m) => m.kind === 'usage.notice' && m.notice === 'resumed')).toMatchObject({ title: 'Claude capacity available' })
    // The ramp: one new session at a time for the first minute.
    expect(stack.usage.dispatchLimit(4)).toBe(1)
    clock.advance(61_000)
    expect(stack.usage.dispatchLimit(4)).toBe(4)
  })

  it('the exact reset survives the SDK second rejection signal (the plan is reset + delay, not a blind backoff)', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 45 * MIN) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    // two agent.rate_limited events: the one with the reset, then the one without
    const signals = h.eventsOfType(run.id, 'agent.rate_limited').map((e) => e.payload.resetsAt)
    expect(signals).toHaveLength(2)
    expect(signals[0]).not.toBeNull()
    expect(signals[1]).toBeNull()
    expect(h.repos.quotaPauses.liveGlobal()).toMatchObject({ resetConfidence: 'EXACT', limitType: 'five_hour' })
    expect(Date.parse(h.repos.quotaPauses.liveGlobal()?.nextCheckAt ?? '') - clock.now()).toBe(46 * MIN)
    expect(stack.usage.overview().nextResetAt).toMatchObject({ confidence: 'EXACT' })
  })

  it('15: an unknown reset is probed conservatively: the first probe fails, a later one succeeds', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, null) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    const t0 = clock.now()
    expect(h.repos.quotaPauses.liveGlobal()).toMatchObject({ resetAt: null, resetConfidence: 'UNKNOWN' })
    expect(Date.parse(h.repos.quotaPauses.liveGlobal()?.nextCheckAt ?? '') - t0).toBe(5 * MIN)
    expect(stack.usage.overview().autoResume.nextCheckAt.confidence).toBe('ESTIMATED')

    clock.advance(4 * MIN)
    await stack.controller.tick()
    expect(h.runtime.usage.probes).toBe(0)

    clock.advance(MIN)
    await stack.controller.tick() // probe 1: still limited
    expect(h.runtime.usage.probes).toBe(1)
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    const global = h.repos.quotaPauses.liveGlobal()
    expect(global).toMatchObject({ state: 'waiting', probes: 1 })
    expect(Date.parse(global?.nextCheckAt ?? '') - clock.now()).toBe(10 * MIN)
    expect(stack.usage.status()).toBe('WAITING_FOR_RESET')

    h.runtime.usage.restore() // the window resets
    clock.advance(10 * MIN)
    await stack.controller.tick() // probe 2: available
    expect(h.runtime.usage.probes).toBe(2)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.task(run.id, 'big').attempt).toBe(1)
    const probeRows = h.repos.quotaResumes.listByPause(h.repos.quotaPauses.listRecent().find((p) => p.scope === 'global')?.id ?? '')
    expect(probeRows.filter((r) => r.kind === 'probe').map((r) => r.result)).toEqual(['still_limited', 'available'])
  })

  it('falls back to one minimal session when the usage report is unsupported', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 10 * MIN) }) })
    h.runtime.usage.set({ reportSupported: false })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    clock.advance(11 * MIN)
    await stack.controller.tick()
    expect(stack.probe.stats).toEqual({ reports: 1, sessions: 1 })
    const probeSession = h.runtime.sessions.find((s) => s.prompt === 'Reply with the single word OK.')
    expect(probeSession).toMatchObject({ maxTurns: 1, tools: [] })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
  })

  it('16: a restart during WAITING_FOR_RESET keeps the wait and resumes later', async () => {
    const clock = new ManualClock()
    const script = scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 20 * MIN) })
    h = await createHarness({ script })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    const globalId = h.repos.quotaPauses.liveGlobal()?.id
    stack.dispose()
    stack = undefined

    h = await h.restart(scenarioScript({ plan: plan([plannedTask('big')]), worker: fileWorker }))
    h.orchestrator.recoverOnStartup()
    // Still paused for quota, not turned into a recovery pause.
    expect(h.repos.runs.require(run.id)).toMatchObject({ state: 'paused', pauseReason: 'quota' })
    expect(h.orchestrator.listRecoverable()).toHaveLength(0)
    stack = attachUsage(h, { clock })
    expect(stack.usage.status()).toBe('WAITING_FOR_RESET')
    expect(stack.usage.canDispatch()).toBe(false)
    expect(h.repos.quotaPauses.liveGlobal()?.id).toBe(globalId)
    expect(liveRows()).toBe(2)

    clock.advance(20 * MIN)
    await stack.controller.tick()
    expect(h.repos.runs.require(run.id).state).toBe('paused') // not yet: reset + 60 s
    clock.advance(MIN)
    await stack.controller.tick()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.task(run.id, 'big').attempt).toBe(1)
    expect(liveRows()).toBe(0)
  })

  it('a resume is idempotent: concurrent ticks and repeated resumeNow resume the run once', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 5 * MIN) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    clock.advance(6 * MIN)
    await Promise.all([stack.controller.tick(), stack.controller.tick(), stack.controller.resumeNow()])
    await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    const again = await stack.controller.resumeNow()
    expect(again).toMatchObject({ hadWait: false, resumed: 0 })
    await stack.controller.tick()
    expect(h.repos.quotaResumes.listByRun(run.id).filter((r) => r.kind === 'resume')).toHaveLength(1)
    expect(h.eventsOfType(run.id, 'usage.quota_resumed')).toHaveLength(1)
    expect(sessionsOf(h, 'worker')).toHaveLength(2)
    expect(h.runtime.usage.probes).toBe(1)
  })

  it('pauseAllOnGlobalLimit pauses a second run and both resume', async () => {
    const clock = new ManualClock()
    let started = 0
    const limit = limitedOnce(clock, 10 * MIN)
    const worker: FakeScript = async (spec, ctx) => {
      // The first worker session is run B's: it is still working when A (the second) hits the limit.
      if (++started === 1) {
        await ctx.sleep(60 * MIN)
        return
      }
      await limit(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker }) })
    stack = attachUsage(h, { clock })
    const b = await h.startRun({ prompt: 'MISSION-B' })
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'run B working')
    const a = await h.startRun({ prompt: 'MISSION-A' })
    await h.waitForState(a.id, 'paused')
    await h.waitForState(b.id, 'paused')
    await h.waitFor(() => liveRows() === 3, 'one global and two run rows')
    expect(h.repos.runs.require(b.id).pauseReason).toBe('quota')
    expect(h.repos.quotaPauses.listLive().filter((p) => p.scope === 'global')).toHaveLength(1)
    expect(h.pushes.filter((m) => m.kind === 'usage.notice' && m.notice === 'limit_reached')).toHaveLength(1)

    clock.advance(11 * MIN)
    await stack.controller.tick()
    expect((await h.waitForState(a.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect((await h.waitForState(b.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(liveRows()).toBe(0)
    expect(h.repos.quotaResumes.listByRun(a.id).filter((r) => r.kind === 'resume')).toHaveLength(1)
    expect(h.repos.quotaResumes.listByRun(b.id).filter((r) => r.kind === 'resume')).toHaveLength(1)
  })

  it('autoResume false records the pause but schedules no probe and resumes nothing; resumeNow still works', async () => {
    const clock = new ManualClock()
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 5 * MIN) }),
      settings: (s) => ({ ...s, usage: { ...s.usage, autoResume: false } }),
    })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    expect(h.repos.quotaPauses.liveGlobal()?.nextCheckAt).toBeNull()
    expect(stack.usage.overview().autoResume).toMatchObject({ enabled: false, pausedRuns: 1 })

    clock.advance(24 * 60 * MIN)
    await stack.controller.tick()
    expect(h.runtime.usage.probes).toBe(0)
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    expect(liveRows()).toBe(2)

    const result = await stack.controller.resumeNow()
    expect(result).toMatchObject({ hadWait: true, resumed: 1 })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
  })

  it('a user cancel during the wait closes its rows and reopens the gate', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 60 * MIN) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    await h.orchestrator.cancelRun(run.id)
    expect(liveRows()).toBe(0)
    expect(h.repos.quotaPauses.listByRun(run.id).map((p) => p.state)).toEqual(['cancelled'])
    expect(stack.usage.status()).toBe('AVAILABLE')
    expect(stack.usage.canDispatch()).toBe(true)

  })

  it('a manual resume of a quota-paused run closes its row as cancelled', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 60 * MIN) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    h.runtime.usage.restore()
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.repos.quotaPauses.listByRun(run.id).map((p) => p.state)).toEqual(['cancelled'])
    expect(liveRows()).toBe(0)
    expect(stack.usage.canDispatch()).toBe(true)
    expect(h.repos.quotaResumes.listByRun(run.id)).toHaveLength(0)
  })

  it('endWait leaves the run paused and reopens the gate', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 60 * MIN) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    stack.controller.endWait(run.id)
    expect(liveRows()).toBe(0)
    expect(h.repos.quotaPauses.listByRun(run.id).map((p) => ({ state: p.state, why: p.endReason }))).toEqual([{ state: 'ended', why: 'Ended by the user' }])
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    expect(stack.usage.canDispatch()).toBe(true)
    clock.advance(24 * 60 * MIN)
    await stack.controller.tick()
    expect(h.runtime.usage.probes).toBe(0)
  })

  it('an ended wait stays ended across a restart: no reopen, no notice, no automatic resume', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: limitedOnce(clock, 60 * MIN) }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    stack.controller.endWait(run.id)
    expect(liveRows()).toBe(0)
    stack.dispose()
    h.pushes.length = 0
    stack = attachUsage(h, { clock }) // the application restarted: controller.recover()
    expect(liveRows()).toBe(0)
    expect(stack.usage.canDispatch()).toBe(true)
    expect(h.pushes.filter((m) => m.kind === 'usage.notice')).toHaveLength(0)
    clock.advance(61 * MIN)
    await stack.controller.tick()
    expect(h.runtime.usage.probes).toBe(0)
    expect(h.repos.runs.require(run.id)).toMatchObject({ state: 'paused', pauseReason: 'quota' })
  })

  it('a run Claude keeps rejecting after automatic resumes continues ONE backoff, then the wait ends', async () => {
    const clock = new ManualClock()
    const alwaysLimited: FakeScript = async (_spec, ctx) => {
      await ctx.rateLimit({ status: 'rejected', resetsAt: null, limitType: 'five_hour' })
      await ctx.completeTurn({ text: 'usage limit reached', outcome: 'quota' })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker: alwaysLimited }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    const gaps: number[] = []
    for (let i = 0; i < 12; i++) {
      const g = h.repos.quotaPauses.liveGlobal()
      if (!g) break
      gaps.push(Math.round((Date.parse(g.nextCheckAt ?? '') - clock.now()) / MIN))
      clock.advance(Date.parse(g.nextCheckAt ?? '') - clock.now())
      await stack.controller.tick() // the probe says available, the run resumes, Claude rejects it again
      await h.waitFor(() => {
        const next = h.repos.quotaPauses.liveGlobal()
        return next ? next.id !== g.id : h.repos.quotaPauses.listByRun(run.id).some((p) => p.state === 'ended')
      }, 'the next wait or the end of the wait')
    }
    expect(gaps).toEqual([5, 10, 20, 30, 30, 30])
    const globals = h.repos.quotaPauses.listRecent({ limit: 50 }).filter((p) => p.scope === 'global')
    expect(new Set(globals.map((p) => p.pausedAt)).size).toBe(1) // one wait, started once
    expect(h.repos.quotaPauses.listLive()).toHaveLength(0)
    expect(globals.map((p) => p.state).filter((s) => s === 'resumed')).toHaveLength(6)
    expect(h.repos.quotaPauses.listByRun(run.id).at(-1)).toMatchObject({ state: 'ended' })
    expect(h.repos.quotaPauses.listByRun(run.id).at(-1)?.endReason).toMatch(/rejected the work again/)
    expect(h.repos.runs.require(run.id)).toMatchObject({ state: 'paused', pauseReason: 'quota' })
    expect(h.pushes.find((m) => m.kind === 'usage.notice' && m.notice === 'wait_ended')).toBeTruthy()
    expect(h.task(run.id, 'big')).toMatchObject({ attempt: 1, error: null })
    expect(stack.usage.canDispatch()).toBe(true)
  })

  it('a rejection that names no limit is not settled by the usage report: one minimal session decides', async () => {
    const clock = new ManualClock()
    let hit = false
    const worker: FakeScript = async (spec, ctx) => {
      if (!hit) {
        hit = true
        ctx.usage.limit(clock.now() + 3 * MIN)
        await ctx.rateLimit({ status: 'rejected', resetsAt: ctx.usage.resetAtSeconds(), limitType: null })
        await ctx.completeTurn({ text: 'credit balance too low', outcome: 'quota' })
        return
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    expect(h.repos.quotaPauses.liveGlobal()?.limitType).toBeNull()
    clock.advance(5 * MIN)
    await stack.controller.tick()
    expect(stack.probe.stats).toEqual({ reports: 1, sessions: 1 })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
  })

  it('after a resume the ramp also limits how many orphaned tasks restart at once', async () => {
    const clock = new ManualClock()
    let hits = 0
    let resumed = false
    const worker: FakeScript = async (_spec, ctx) => {
      if (!resumed) {
        await ctx.sleep(80)
        if (hits++ === 0) ctx.usage.limit(clock.now() + 5 * MIN)
        await ctx.rateLimit({ status: 'rejected', resetsAt: ctx.usage.resetAtSeconds(), limitType: 'five_hour' })
        await ctx.completeTurn({ text: 'usage limit reached', outcome: 'quota' })
        return
      }
      await ctx.sleep(60 * MIN) // keeps its slot until the session is stopped
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a'), plannedTask('b'), plannedTask('c')]), worker }) })
    stack = attachUsage(h, { clock })
    const run = await h.startRun({ overrides: { maxParallelAgents: 3 } })
    await h.waitForState(run.id, 'paused')
    await h.waitFor(() => liveRows() === 2 && sessionsOf(h, 'worker').length === 3, 'three limited workers and the pause rows')
    await h.orchestrator.idle(run.id)
    resumed = true
    clock.advance(6 * MIN)
    await stack.controller.tick()
    await h.waitFor(() => sessionsOf(h, 'worker').length === 4, 'the first restarted worker')
    await new Promise((r) => setTimeout(r, 300))
    expect(sessionsOf(h, 'worker')).toHaveLength(4) // one new session at a time during the ramp
    clock.advance(61_000)
    stack.usage.tickRamp()
    await h.waitFor(() => sessionsOf(h, 'worker').length === 6, 'the rest after the ramp')
  })

  it('a quota hit while the planner runs pauses planning and resumes into planning', async () => {
    const clock = new ManualClock()
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('p')]) }) })
    stack = attachUsage(h, { clock })
    h.runtime.usage.limit(clock.now() + 5 * MIN) // limited before the mission even starts planning
    const run = await h.startRun()
    expect(await h.waitForState(run.id, 'paused')).toMatchObject({ pauseReason: 'quota', resumeState: 'planning' })
    await h.waitFor(() => liveRows() === 2, 'the quota pause rows')
    clock.advance(6 * MIN)
    await stack.controller.tick()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
  })
})
