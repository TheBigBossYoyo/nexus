import { afterEach, describe, expect, it } from 'vitest'
import { AsyncQueue } from '@main/modules/agent-runtime/async-queue'
import type { AgentEvent, AgentSessionHandle, SessionSpec } from '@main/modules/agent-runtime/types'
import { createHarness, fileWorker, plan, plannedTask, scenarioScript, type Harness } from './harness'

/**
 * 0.7.2: a session that waits for a provider's capacity. The admission front door answers such a session with
 * a `capacity.wait` event and no provider session; here the runtime itself is made to answer that way, so the
 * orchestrator's side is exercised without the capacity kernel.
 */

/** A handle that waited for capacity: the event, then the end. No request was sent. */
function waited(spec: SessionSpec): AgentSessionHandle {
  const events = new AsyncQueue<AgentEvent>()
  events.push({ type: 'capacity.wait', routingId: 'route-1', provider: null, reasons: ['claude:fake: PROVIDER_UNAVAILABLE'] })
  events.push({ type: 'session.ended', reason: 'stopped', error: null })
  events.close()
  return { agentId: spec.agentId, sessionId: () => null, events, send: () => undefined, end: () => undefined, interrupt: async () => undefined, stop: async () => undefined, stopConfirmed: () => true }
}

describe('scenario: waiting for provider capacity', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('pauses the run for capacity, resumes it, and a wait is never counted as an attempt of the task', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker: fileWorker }) })
    // The worker's first three sessions find no capacity; the fourth runs.
    let waits = 3
    const real = h.runtime.startSession.bind(h.runtime)
    h.runtime.startSession = (spec: SessionSpec) => (spec.role === 'worker' && waits-- > 0 ? waited(spec) : real(spec))

    const run = await h.startRun()
    for (let i = 0; i < 3; i++) {
      const paused = await h.waitForState(run.id, 'paused')
      expect(paused.pauseReason, `wait ${i}`).toBe('capacity')
      // Nothing failed and nothing was tried: the task is still on its first attempt, with no error.
      const task = h.task(run.id, 'alpha')
      expect(task.attempt, `attempt after wait ${i}`).toBe(1)
      expect(task.error).toBeNull()
      await h.orchestrator.resumeRun(run.id)
    }
    const done = await h.waitForState(run.id, 'completed')
    expect(done.state).toBe('completed')
    const task = h.task(run.id, 'alpha')
    expect(task).toMatchObject({ state: 'completed', attempt: 1 })
    // The waits are on record as waits: sessions that ended for capacity, and the event that says why.
    const agents = h.repos.agents.listByRun(run.id).filter((a) => a.role === 'worker')
    expect(agents.map((a) => h.repos.sessions.latestForAgent(a.id)?.endReason)).toEqual(['capacity', 'capacity', 'capacity', 'completed'])
    expect(h.eventsOfType(run.id, 'capacity.waiting')).toHaveLength(3)
    // No intervention was asked for and no task failed.
    expect(h.eventsOfType(run.id, 'task.failed')).toEqual([])
  })
})
