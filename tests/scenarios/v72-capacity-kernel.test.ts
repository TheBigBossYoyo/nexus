import { afterEach, describe, expect, it } from 'vitest'
import { hostedSessionPool, sessionReservePolicy } from '@main/modules/capacity/reserves'
import { createHarness, fileWorker, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

/**
 * 0.7.2: the real orchestrator on the real session admission. Every session of these missions is decided,
 * claimed, dispatched and released by the capacity kernel before and after it reaches the scripted runtime, as
 * in the runtime process. (`v72-capacity.test.ts` exercises the orchestrator's side alone, with a runtime that
 * answers "wait" by itself.)
 */
describe('scenario: missions through the capacity kernel', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  const one = (s: Parameters<NonNullable<Parameters<typeof createHarness>[0]['settings']>>[0]) => ({ ...s, execution: { ...s.execution, maxParallelAgents: 1 } })
  const open = (): { role: string; state: string }[] => h.capacity!.leases().filter((l) => l.state !== 'RELEASED')

  it('runs a mission to its end: every session is admitted, none waits, and no slot is left held', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha'), plannedTask('beta', { dependencies: ['alpha'] })]), worker: fileWorker }), settings: one, capacity: { maxAgents: 1 } })
    const run = await h.startRun()
    const done = await h.waitForState(run.id, ['completed', 'paused', 'failed'])
    expect(done.state).toBe('completed')
    expect(h.eventsOfType(run.id, 'capacity.waiting')).toEqual([])
    expect(h.repos.tasks.listByRun(run.id).map((t) => [t.key, t.state, t.attempt])).toEqual([['alpha', 'completed', 1], ['beta', 'completed', 1]])
    // Each session the runtime saw was decided by the kernel first, and its slot was given back.
    const routed = h.repos.agents.listByRun(run.id).filter((a) => h.repos.intelligenceArtifacts.routingHistory(h.project.id, a.id).length > 0)
    expect(routed.length).toBe(h.runtime.sessions.length)
    expect(routed.length).toBeGreaterThanOrEqual(3)
    expect(open()).toEqual([])
  })

  it('a worker that dies gives its slot back: the retry is admitted and the run never waits for capacity', async () => {
    let crashes = 1
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('alpha')]),
        worker: async (spec, ctx) => {
          if (crashes-- > 0) ctx.fail('The worker process died')
          return fileWorker(spec, ctx)
        },
      }),
      settings: one,
      capacity: { maxAgents: 1 },
    })
    const run = await h.startRun()
    const done = await h.waitForState(run.id, ['completed', 'paused', 'failed'])
    expect(done.state).toBe('completed')
    expect(sessionsOf(h, 'worker').length).toBe(2)
    // With one slot for work, a slot lost to the dead worker would have made the retry wait.
    expect(h.eventsOfType(run.id, 'capacity.waiting')).toEqual([])
    expect(open()).toEqual([])
  })

  it('waits while another consumer holds the slots, is not resumed before they are free, then finishes on its first attempt', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker: fileWorker }), settings: one, capacity: { maxAgents: 1 } })
    const { kernel } = h.capacity!
    // Another consumer of this machine's session slots holds the only one there is for work.
    const host = hostedSessionPool(h.dir)
    const policy = sessionReservePolicy([host], 1)
    const other = kernel.decide({
      projectId: h.project.id, operationId: 'another-consumer', stage: 'WORKER:other', role: 'worker', pools: [host], policy, coherentBoundary: true,
      candidates: [{ provider: 'claude', model: 'fake-claude', roles: ['worker'], poolIds: [host.id], available: true, qualityApproved: true, qualityEvidence: ['fixture'], reserve: 'NONE', paid: false }],
    })
    expect(other.action).toBe('ROUTE')
    const held = kernel.claim(other, policy)

    const run = await h.startRun()
    const paused = await h.waitForState(run.id, ['paused', 'completed', 'failed'])
    expect(paused).toMatchObject({ state: 'paused', pauseReason: 'capacity' })
    expect(h.runtime.sessions.length).toBe(0)

    // Recovery looks, finds the slot still taken, and leaves the run where it is.
    await h.capacity!.recover()
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    expect(h.runtime.sessions.length).toBe(0)

    kernel.release(held)
    await h.capacity!.recover()
    const done = await h.waitForState(run.id, ['completed', 'failed'])
    expect(done.state).toBe('completed')
    expect(h.task(run.id, 'alpha')).toMatchObject({ state: 'completed', attempt: 1 })
    expect(h.eventsOfType(run.id, 'task.failed')).toEqual([])
    expect(open()).toEqual([])
  })
})
