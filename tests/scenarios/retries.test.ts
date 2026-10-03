import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, fileWorker, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

describe('scenario: worker failure, retry, escalation and intervention', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('retries after a crash, escalates the model tier on the second failure and then succeeds', async () => {
    let calls = 0
    const worker: FakeScript = async (spec, ctx) => {
      calls++
      if (calls === 1) ctx.fail('simulated crash')
      if (calls === 2) {
        await ctx.completeTurn({ text: 'could not finish', outcome: 'error' })
        return
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('solo')]), worker }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const task = h.task(run.id, 'solo')
    expect(task.state).toBe('completed')
    expect(task.attempt).toBe(3)
    expect(task.modelTierOverride).toBe('strongest')

    const settings = h.repos.settings.get()
    // First retry keeps the tier, the second failure escalates to the strongest tier's model.
    expect(sessionsOf(h, 'worker').map((s) => s.model)).toEqual([
      settings.models.tiers.balanced,
      settings.models.tiers.balanced,
      settings.models.tiers.strongest,
    ])
    expect(h.eventsOfType(run.id, 'task.retry')).toHaveLength(2)
    const escalated = h.eventsOfType(run.id, 'task.escalated')
    expect(escalated).toHaveLength(1)
    expect(escalated[0]?.payload.toTier).toBe('strongest')

    // Every attempt is a separate recorded agent; the failed ones are marked failed.
    const agents = h.repos.agents.listByTask(task.id).filter((a) => a.role === 'worker')
    expect(agents.map((a) => a.state)).toEqual(['failed', 'failed', 'stopped'])
  })

  it('gives up after maxRetriesPerTask, pauses for intervention, and finishes after retryTask + resumeRun', async () => {
    let succeed = false
    const worker: FakeScript = async (spec, ctx) => {
      if (!succeed) ctx.fail('still broken')
      await fileWorker(spec, ctx)
    }
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('flaky'), plannedTask('after', { dependencies: ['flaky'] })]), worker }),
    })
    const run = await h.startRun()
    const paused = await h.waitForState(run.id, 'paused')
    expect(paused.pauseReason).toBe('user')

    const flaky = h.task(run.id, 'flaky')
    expect(flaky.state).toBe('failed')
    expect(flaky.error?.what).toContain('crashed')
    // maxRetriesPerTask = 2 means exactly three attempts, never more.
    expect(sessionsOf(h, 'worker')).toHaveLength(3)
    expect(flaky.attempt).toBe(3)
    expect(h.task(run.id, 'after').state).toBe('blocked')
    const pauseEvents = h.eventsOfType(run.id, 'run.paused')
    expect(pauseEvents).toHaveLength(1)
    expect(pauseEvents[0]?.payload.detail).toContain('Intervention required')

    // The run stays paused: no more sessions are started on its own.
    await h.orchestrator.idle(run.id)
    expect(sessionsOf(h, 'worker')).toHaveLength(3)

    succeed = true
    await h.orchestrator.retryTask(flaky.id)
    await h.orchestrator.resumeRun(run.id)
    const done = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.state)).toEqual(['completed', 'completed'])
    // The unblocked dependant ran after its dependency was fixed.
    expect(sessionsOf(h, 'worker')).toHaveLength(5)
  })
})
