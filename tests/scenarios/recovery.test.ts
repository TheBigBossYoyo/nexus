import { afterEach, describe, expect, it } from 'vitest'
import type { Run } from '@shared/domain'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, fileWorker, keyOf, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

const twoStepPlan = plan([plannedTask('first'), plannedTask('second', { dependencies: ['first'] })])

/** Stalls `second` mid-session (until stopped); everything else behaves normally. */
function stallingWorker(onStalled: () => void): FakeScript {
  return async (spec, ctx) => {
    if (keyOf(spec) === 'second') {
      onStalled()
      await ctx.sleep(120_000)
      if (ctx.signal.aborted) return
    }
    await fileWorker(spec, ctx)
  }
}

describe('scenario: the application shuts down mid-run and state is restored', () => {
  let original: Harness
  let restarted: Harness | undefined
  afterEach(async () => {
    await restarted?.dispose()
    await original?.dispose()
  })

  async function startStalledRun(): Promise<{ run: Run; sdkSessionId: string }> {
    let stalled = false
    original = await createHarness({
      script: scenarioScript({ plan: twoStepPlan, worker: stallingWorker(() => (stalled = true)) }),
    })
    const run = await original.startRun()
    await original.waitFor(() => stalled, 'second task to be mid-session')
    const agent = original.repos.agents.listByTask(original.task(run.id, 'second').id)[0]
    await original.waitFor(() => original.repos.sessions.latestForAgent(agent?.id ?? '')?.sdkSessionId != null, 'session id')
    const sdkSessionId = original.repos.sessions.latestForAgent(agent?.id ?? '')?.sdkSessionId ?? ''
    return { run, sdkSessionId }
  }

  it('after a crash the run is paused for recovery, stale agents are stopped, and resume completes the run', async () => {
    const { run, sdkSessionId } = await startStalledRun()
    const secondId = original.task(run.id, 'second').id
    expect(original.repos.runs.require(run.id).state).toBe('executing')
    expect(sdkSessionId).toMatch(/^fake-session-/)

    // A hard kill: the new process starts from the database exactly as it was while the agent was live.
    restarted = await original.restart(scenarioScript({ plan: twoStepPlan, worker: fileWorker }), { crash: true })
    const staleBefore = restarted.repos.agents.listActive(run.id)
    expect(staleBefore.map((a) => a.state)).toContain('working')

    const recoverable = restarted.orchestrator.recoverOnStartup()
    expect(recoverable).toHaveLength(1)
    expect(recoverable[0]).toMatchObject({ projectName: 'scenario', staleAgents: 1 })
    expect(recoverable[0]?.activeTasks).toBeGreaterThanOrEqual(1)
    expect(recoverable[0]?.worktrees).toBeGreaterThanOrEqual(2)
    const paused = restarted.repos.runs.require(run.id)
    expect(paused).toMatchObject({ state: 'paused', pauseReason: 'recovery', resumeState: 'executing' })
    expect(restarted.orchestrator.listRecoverable().map((r) => r.run.id)).toEqual([run.id])

    // Stale agents and sessions are closed in the database; earlier rows are intact.
    expect(restarted.repos.agents.listActive(run.id)).toHaveLength(0)
    const staleAgent = restarted.repos.agents.listByTask(secondId)[0]
    expect(staleAgent?.state).toBe('stopped')
    expect(staleAgent?.error).toMatch(/^Stale/)
    expect(restarted.repos.sessions.listByAgent(staleAgent?.id ?? '')[0]).toMatchObject({ state: 'ended', endReason: 'app_restart' })
    expect(restarted.task(run.id, 'first').state).toBe('completed')
    expect(restarted.repos.events.listByRun(run.id, 0, 10_000).some((e) => e.type === 'task.completed')).toBe(true)
    expect(restarted.repos.events.listByRun(run.id, 0, 10_000).filter((e) => e.type === 'run.recovered')).toHaveLength(1)
    expect(restarted.repos.reviews.listByRun(run.id)).toHaveLength(1)

    // Nothing runs until the user decides.
    await restarted.orchestrator.idle(run.id)
    expect(restarted.runtime.sessions).toHaveLength(0)

    await restarted.orchestrator.recover(run.id, 'resume')
    const done = await restarted.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')

    // The interrupted task continued its SDK session instead of starting over; the finished task was not redone.
    const workers = sessionsOf(restarted, 'worker')
    expect(workers).toHaveLength(1)
    expect(workers[0]?.resumeSessionId).toBe(sdkSessionId)
    expect(workers[0]?.prompt).toContain('Continue the task')
    const second = restarted.task(run.id, 'second')
    expect(second.state).toBe('completed')
    expect(second.attempt).toBe(1)
    expect(restarted.orchestrator.listRecoverable()).toEqual([])
  })

  it('after a clean shutdown the run is recoverable and resumes with the previous session id', async () => {
    const { run, sdkSessionId } = await startStalledRun()
    restarted = await original.restart(scenarioScript({ plan: twoStepPlan, worker: fileWorker }))
    expect(restarted.repos.runs.require(run.id).state).toBe('executing')

    restarted.orchestrator.recoverOnStartup()
    expect(restarted.repos.runs.require(run.id)).toMatchObject({ state: 'paused', pauseReason: 'recovery' })
    await restarted.orchestrator.recover(run.id, 'resume')
    expect((await restarted.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(sessionsOf(restarted, 'worker')[0]?.resumeSessionId).toBe(sdkSessionId)
    expect(restarted.repos.tasks.listByRun(run.id).map((t) => t.state)).toEqual(['completed', 'completed'])
  })

  it('recovery action "cancel" cancels the run and its unfinished tasks', async () => {
    const { run } = await startStalledRun()
    restarted = await original.restart(scenarioScript({ plan: twoStepPlan, worker: fileWorker }), { crash: true })
    restarted.orchestrator.recoverOnStartup()

    const cancelled = await restarted.orchestrator.recover(run.id, 'cancel')
    expect(cancelled.state).toBe('cancelled')
    expect(restarted.task(run.id, 'first').state).toBe('completed')
    expect(restarted.task(run.id, 'second').state).toBe('cancelled')
    expect(restarted.orchestrator.listRecoverable()).toEqual([])
    await restarted.orchestrator.idle(run.id)
    expect(restarted.runtime.sessions).toHaveLength(0)
  })

  it('recovery action "inspect" keeps the run paused but no longer flags it, and it can still be resumed', async () => {
    const { run } = await startStalledRun()
    restarted = await original.restart(scenarioScript({ plan: twoStepPlan, worker: fileWorker }), { crash: true })
    restarted.orchestrator.recoverOnStartup()

    const inspected = await restarted.orchestrator.recover(run.id, 'inspect')
    expect(inspected).toMatchObject({ state: 'paused', pauseReason: 'user' })
    expect(restarted.orchestrator.listRecoverable()).toEqual([])
    await restarted.orchestrator.idle(run.id)
    expect(restarted.runtime.sessions).toHaveLength(0)

    await restarted.orchestrator.resumeRun(run.id)
    expect((await restarted.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
  })
})
