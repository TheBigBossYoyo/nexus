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

/** A session that starts only once `gate` has opened: work that is still going on while another task is held. */
function gated(spec: SessionSpec, start: (spec: SessionSpec) => AgentSessionHandle, gate: Promise<void>): AgentSessionHandle {
  let inner: AgentSessionHandle | null = null
  const opened = gate.then(() => (inner = start(spec)))
  async function* events(): AsyncGenerator<AgentEvent> {
    yield* (await opened).events
  }
  return {
    agentId: spec.agentId, sessionId: () => inner?.sessionId() ?? null, events: events(),
    send: (text) => void opened.then((handle) => handle.send(text)), end: () => void opened.then((handle) => handle.end()),
    interrupt: async () => (await opened).interrupt(), stop: async () => (await opened).stop(), stopConfirmed: () => inner?.stopConfirmed?.() ?? false,
  }
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

  it('holds the one task that waits and goes on with the rest of the run: the run does not pause', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha'), plannedTask('beta')]), worker: fileWorker }) })
    // The sessions of alpha find no capacity twice. Beta has capacity throughout and is still at work when alpha
    // is given its third session: its own session is let go on from that moment.
    let waits = 2
    let alphaRuns: () => void = () => undefined
    const alphaRunning = new Promise<void>((resolve) => (alphaRuns = resolve))
    const real = h.runtime.startSession.bind(h.runtime)
    h.runtime.startSession = (spec: SessionSpec) => {
      if (spec.role !== 'worker') return real(spec)
      if (!spec.label?.includes('alpha')) return gated(spec, real, alphaRunning)
      if (waits-- > 0) return waited(spec)
      alphaRuns()
      return real(spec)
    }

    const run = await h.startRun({ overrides: { maxParallelAgents: 2 } })
    const done = await h.waitForState(run.id, 'completed')
    expect(done.state).toBe('completed')
    // The run was never paused: beta worked while alpha was held, and alpha was given a session again by itself.
    expect(h.eventsOfType(run.id, 'run.paused')).toEqual([])
    expect(h.task(run.id, 'beta')).toMatchObject({ state: 'completed', attempt: 1 })
    expect(h.task(run.id, 'alpha')).toMatchObject({ state: 'completed', attempt: 1, error: null })
    const alpha = h.repos.agents.listByTask(h.task(run.id, 'alpha').id).filter((a) => a.role === 'worker')
    expect(alpha.map((a) => h.repos.sessions.latestForAgent(a.id)?.endReason)).toEqual(['capacity', 'capacity', 'completed'])
    expect(h.eventsOfType(run.id, 'capacity.waiting')).toHaveLength(2)
    expect(h.eventsOfType(run.id, 'task.failed')).toEqual([])
    expect(h.eventsOfType(run.id, 'task.lease_expired')).toEqual([])
  })

  it('pauses the run for capacity once the held task is all that is left, and completes after the resume', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha'), plannedTask('beta', { dependencies: ['alpha'] })]), worker: fileWorker }) })
    let waits = 1
    const real = h.runtime.startSession.bind(h.runtime)
    h.runtime.startSession = (spec: SessionSpec) => (spec.role === 'worker' && waits-- > 0 ? waited(spec) : real(spec))
    const run = await h.startRun({ overrides: { maxParallelAgents: 2 } })
    const paused = await h.waitForState(run.id, 'paused')
    expect(paused.pauseReason).toBe('capacity')
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, 'completed')).state).toBe('completed')
    expect(h.task(run.id, 'alpha')).toMatchObject({ state: 'completed', attempt: 1 })
  })
})
