import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, fileWorker, keyOf, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

/** Keys listed in `stall` hang (abortably) until their session is stopped; the others work normally. */
function stalling(stall: () => Set<string>, started: Set<string>): FakeScript {
  return async (spec, ctx) => {
    const key = keyOf(spec)
    if (stall().has(key)) {
      started.add(key)
      await ctx.sleep(120_000)
      if (ctx.signal.aborted) return
    }
    await fileWorker(spec, ctx)
  }
}

describe('scenario: user intervention during a run', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('cancelling a task stops its agent, blocks its dependants and leaves independent tasks running', async () => {
    const started = new Set<string>()
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('a'), plannedTask('b', { dependencies: ['a'] }), plannedTask('c')]),
        worker: stalling(() => new Set(['a']), started),
      }),
    })
    const run = await h.startRun()
    await h.waitFor(() => started.has('a'), 'task a to be running')
    await h.waitFor(() => h.task(run.id, 'c').state === 'completed', 'independent task c to complete')

    const a = h.task(run.id, 'a')
    const agent = h.repos.agents.listByTask(a.id)[0]
    expect(agent?.state).toBe('working')
    await h.orchestrator.cancelTask(a.id)

    const paused = await h.waitForState(run.id, 'paused')
    expect(paused.pauseReason).toBe('user')
    expect(h.eventsOfType(run.id, 'run.paused')[0]?.payload.detail).toContain('Intervention required')
    expect(h.task(run.id, 'a').state).toBe('cancelled')
    expect(h.task(run.id, 'b')).toMatchObject({ state: 'blocked' })
    expect(h.task(run.id, 'b').blockedReason).toContain('dependency')
    expect(h.task(run.id, 'c').state).toBe('completed')
    // The agent really stopped and the dependant never got a session.
    expect(h.repos.agents.require(agent?.id ?? '').state).toBe('stopped')
    expect(h.repos.sessions.listByAgent(agent?.id ?? '')[0]?.endReason).toBe('cancelled')
    expect(sessionsOf(h, 'worker').map((s) => keyOf(s)).sort()).toEqual(['a', 'c'])
    expect(h.eventsOfType(run.id, 'task.cancelled').map((e) => e.taskId)).toEqual([a.id])
  })

  it('cancelling a run stops every session, cancels unfinished tasks and starts nothing afterwards', async () => {
    const started = new Set<string>()
    h = await createHarness({
      script: scenarioScript({
        plan: plan([
          plannedTask('done'),
          plannedTask('a'),
          plannedTask('b'),
          plannedTask('c', { dependencies: ['a'] }),
        ]),
        worker: stalling(() => new Set(['a', 'b']), started),
      }),
    })
    const run = await h.startRun()
    await h.waitFor(() => started.has('a') && started.has('b'), 'tasks a and b to be running')
    await h.waitFor(() => h.task(run.id, 'done').state === 'completed', 'task done to complete')
    const liveAgents = h.repos.agents.listActive(run.id)
    expect(liveAgents.length).toBeGreaterThanOrEqual(2)

    const cancelled = await h.orchestrator.cancelRun(run.id)
    expect(cancelled.state).toBe('cancelled')
    const states = Object.fromEntries(h.repos.tasks.listByRun(run.id).map((t) => [t.key, t.state]))
    expect(states).toEqual({ done: 'completed', a: 'cancelled', b: 'cancelled', c: 'cancelled' })
    expect(h.repos.agents.listActive(run.id)).toHaveLength(0)
    expect(h.repos.agents.listByRun(run.id).filter((x) => x.state === 'working')).toHaveLength(0)
    expect(h.eventsOfType(run.id, 'run.cancelled')).toHaveLength(1)

    const sessionsBefore = h.runtime.sessions.length
    await h.orchestrator.idle(run.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.runtime.sessions).toHaveLength(sessionsBefore)
    expect(h.repos.runs.require(run.id).state).toBe('cancelled')
    // Cancelling again is a harmless no-op.
    expect((await h.orchestrator.cancelRun(run.id)).state).toBe('cancelled')
  })

  it('pausing mid-flight and resuming continues the interrupted task without redoing completed ones', async () => {
    const started = new Set<string>()
    let stallOnce = true
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'two' && stallOnce) {
        stallOnce = false
        started.add('two')
        await ctx.sleep(120_000)
        if (ctx.signal.aborted) return
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('one'), plannedTask('two', { dependencies: ['one'] })]), worker }),
    })
    const run = await h.startRun()
    await h.waitFor(() => started.has('two'), 'task two to be running')
    expect(h.task(run.id, 'one').state).toBe('completed')

    const paused = await h.orchestrator.pauseRun(run.id)
    expect(paused).toMatchObject({ state: 'paused', pauseReason: 'user', resumeState: 'executing' })
    expect(h.repos.agents.listActive(run.id)).toHaveLength(0)
    await h.orchestrator.idle(run.id)
    const before = h.runtime.sessions.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.runtime.sessions).toHaveLength(before)

    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const workers = sessionsOf(h, 'worker')
    expect(workers.map((s) => keyOf(s))).toEqual(['one', 'two', 'two'])
    // The resumed session continues the interrupted one; the completed task was never restarted.
    expect(workers[2]?.resumeSessionId).toBe(h.repos.sessions.listByAgent(h.repos.agents.listByTask(h.task(run.id, 'two').id)[0]?.id ?? '')[0]?.sdkSessionId)
    expect(h.task(run.id, 'two').attempt).toBe(1)
    expect(h.task(run.id, 'one').attempt).toBe(1)
    expect(h.eventsOfType(run.id, 'run.resumed')).toHaveLength(1)
  })

  it('stopping an agent fails its task for the user to retry', async () => {
    const started = new Set<string>()
    let stallOnce = true
    const worker: FakeScript = async (spec, ctx) => {
      if (stallOnce) {
        stallOnce = false
        started.add(keyOf(spec))
        await ctx.sleep(120_000)
        if (ctx.signal.aborted) return
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('solo')]), worker }) })
    const run = await h.startRun()
    await h.waitFor(() => started.has('solo'), 'solo to be running')
    const agent = h.repos.agents.listByTask(h.task(run.id, 'solo').id)[0]
    await h.orchestrator.stopAgent(agent?.id ?? '')

    await h.waitForState(run.id, 'paused')
    expect(h.task(run.id, 'solo')).toMatchObject({ state: 'failed' })
    expect(h.task(run.id, 'solo').error?.what).toBe('Agent stopped by user')
    expect(h.repos.agents.require(agent?.id ?? '').state).toBe('stopped')

    await h.orchestrator.retryTask(h.task(run.id, 'solo').id)
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
  })
})
