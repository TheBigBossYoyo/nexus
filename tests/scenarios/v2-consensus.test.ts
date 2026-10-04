import { afterEach, describe, expect, it } from 'vitest'
import { PLANNER_LENSES } from '@main/modules/planning'
import { specPurpose, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, ipc, lensLabelOf, plan, plannedTask, scenarioScript, type Harness } from './harness'

const [A, B, C] = PLANNER_LENSES.map((l) => l.label) as [string, string, string]

const planA = plan([plannedTask('risk-core'), plannedTask('risk-tests', { dependencies: ['risk-core'] })])
const planB = plan([plannedTask('parallel-left'), plannedTask('parallel-right')])
/** A dependency cycle: schema-valid, rejected by plan validation. */
const planC = plan([plannedTask('cyc-a', { dependencies: ['cyc-b'] }), plannedTask('cyc-b', { dependencies: ['cyc-a'] })])
const finalPlan = plan([plannedTask('final-core'), plannedTask('final-tests', { dependencies: ['final-core'] })])

function sessionsByPurpose(h: Harness, purpose: 'critique' | 'synthesize') {
  return h.runtime.sessions.filter((s) => specPurpose(s) === purpose)
}

describe('scenario: consensus planning', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('runs three independent planners, persists candidates (one invalid), critiques, synthesizes and executes the result', async () => {
    // The three candidate planners wait for each other: a sequential batch would never meet.
    let arrived = 0
    const met: boolean[] = []
    const overlapping = (inner: FakeScript): FakeScript => async (spec, ctx) => {
      if (lensLabelOf(spec.prompt) !== null && specPurpose(spec) !== 'synthesize') {
        arrived++
        for (let i = 0; i < 400 && arrived < 3 && !ctx.signal.aborted; i++) await ctx.sleep(10)
        met.push(arrived >= 3)
      }
      return inner(spec, ctx)
    }
    h = await createHarness({
      script: overlapping(scenarioScript({
        plan: planA,
        candidate: (label) => (label === A ? planA : label === B ? planB : planC),
        synthesis: finalPlan,
        critic: async (spec, ctx) =>
          ctx.completeTurn({
            text: 'critique',
            structuredOutput: {
              summary: 'Plan B parallelizes well; Plan A has the safer ordering.',
              findings: [{ candidate: B, severity: 'medium', issue: 'No test task.', recommendation: 'Add one.' }],
              preferredCandidate: A,
            },
          }),
      })),
    })
    const run = await h.startRun({ overrides: { planningMode: 'consensus' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(met).toEqual([true, true, true])

    // Three candidates, in one concurrent batch: two valid, one invalid with its errors.
    const candidates = h.repos.planningCandidates.listByRun(run.id)
    expect(candidates.map((c) => [c.label, c.valid])).toEqual([[A, true], [B, true], [C, false]])
    expect(candidates.map((c) => c.lens)).toEqual(['risk-first', 'parallelism-first', 'minimal-change'])
    expect(candidates[2]?.plan).toBeNull()
    expect(candidates[2]?.errors.join(' ')).toMatch(/cycle/i)
    expect(candidates[0]?.plan).toEqual(planA)
    for (const c of candidates) {
      const agent = h.repos.agents.require(c.agentId ?? '')
      // Cost and model are what the agent reported, never invented.
      expect(c.costUsd).toBe(agent.metrics.costUsd)
      expect(c.costUsd).not.toBeNull()
      expect(c.model).toBe(agent.model)
      expect(c.durationMs).not.toBeNull()
    }
    expect(h.eventsOfType(run.id, 'planning.candidate').map((e) => e.payload.valid)).toEqual([true, true, false])

    // The planners are independent: none saw another's plan, each saw only its own lens.
    const planners = h.runtime.sessions.filter((s) => s.role === 'planner' && lensLabelOf(s.prompt) !== null)
    expect(planners).toHaveLength(3)
    const unique = { [A]: 'risk-core', [B]: 'parallel-left', [C]: 'cyc-a' }
    for (const session of planners) {
      const label = lensLabelOf(session.prompt) as string
      for (const [other, marker] of Object.entries(unique)) {
        if (other !== label) expect(session.prompt, `${label} must not see ${other}`).not.toContain(marker)
      }
      const lens = PLANNER_LENSES.find((l) => l.label === label)
      expect(session.prompt).toContain(lens?.guidance)
      for (const l of PLANNER_LENSES.filter((x) => x.label !== label)) expect(session.prompt).not.toContain(l.guidance)
    }

    // The critic is a read-only reviewer that gets the valid structured plans, not the invalid one.
    const [critic] = sessionsByPurpose(h, 'critique')
    expect(sessionsByPurpose(h, 'critique')).toHaveLength(1)
    expect(critic?.role).toBe('reviewer')
    expect(critic?.tools).not.toContain('Write')
    expect(critic?.tools).not.toContain('Edit')
    expect(critic?.prompt).toContain('risk-core')
    expect(critic?.prompt).toContain('parallel-left')
    expect(critic?.prompt).not.toContain('cyc-a')
    const critiques = h.repos.planningCritiques.listByRun(run.id)
    expect(critiques).toHaveLength(1)
    expect(critiques[0]?.output.preferredCandidate).toBe(A)
    expect(h.eventsOfType(run.id, 'planning.critique')[0]?.payload).toMatchObject({ findings: 1, preferred: A })

    // The synthesizer gets the valid plans, the critique and the preferred candidate.
    const [synth] = sessionsByPurpose(h, 'synthesize')
    expect(sessionsByPurpose(h, 'synthesize')).toHaveLength(1)
    expect(synth?.role).toBe('planner')
    expect(synth?.prompt).toContain('risk-core')
    expect(synth?.prompt).toContain('parallel-left')
    expect(synth?.prompt).not.toContain('cyc-a')
    expect(synth?.prompt).toContain('No test task.')
    expect(synth?.prompt).toContain(`Preferred candidate: ${A}`)
    expect(h.eventsOfType(run.id, 'planning.synthesized')[0]?.payload).toEqual({ candidates: 3, validCandidates: 2 })

    // The synthesized plan is the one that ran.
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['final-core', 'final-tests'])
    expect(h.repos.runs.require(run.id).plan?.summary).toBe(finalPlan.summary)

    // Reported through the IPC contract.
    const view = await ipc(h, 'planning.candidates', { runId: run.id })
    expect(view.candidates).toHaveLength(3)
    expect(view.critiques).toHaveLength(1)
  })

  it('an invalid synthesis is fed back with its errors and repaired', async () => {
    let synths = 0
    h = await createHarness({
      script: scenarioScript({
        plan: planA,
        candidate: (label) => (label === C ? planC : label === A ? planA : planB),
        synthesis: finalPlan,
      }),
    })
    const base = h.runtime.script
    h.runtime.script = async (spec, ctx) => {
      if (specPurpose(spec) === 'synthesize' && synths++ === 0) {
        await ctx.completeTurn({ text: 'bad', structuredOutput: planC })
        return
      }
      await base(spec, ctx)
    }
    const run = await h.startRun({ overrides: { planningMode: 'consensus' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const synthesizers = sessionsByPurpose(h, 'synthesize')
    expect(synthesizers).toHaveLength(2)
    expect(synthesizers[0]?.prompt).not.toContain('previous synthesized plan was rejected')
    expect(synthesizers[1]?.prompt).toContain('previous synthesized plan was rejected')
    expect(h.eventsOfType(run.id, 'plan.invalid')).toHaveLength(1)
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['final-core', 'final-tests'])
  })

  it('with exactly one valid candidate it is used directly: no critic, no synthesizer', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: planA, candidate: (label) => (label === B ? planB : planC) }),
    })
    const run = await h.startRun({ overrides: { planningMode: 'consensus' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.repos.planningCandidates.listByRun(run.id).map((c) => c.valid)).toEqual([false, true, false])
    expect(sessionsByPurpose(h, 'critique')).toHaveLength(0)
    expect(sessionsByPurpose(h, 'synthesize')).toHaveLength(0)
    expect(h.eventsOfType(run.id, 'planning.synthesized')[0]?.payload).toEqual({ candidates: 3, validCandidates: 1 })
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['parallel-left', 'parallel-right'])
  })

  it('with no valid candidate it falls back to the single planner, which is told the collected errors', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: planA, candidate: () => planC }),
    })
    // The fallback planner has no lens, so it gets the plain `plan` output.
    const run = await h.startRun({ overrides: { planningMode: 'consensus' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.repos.planningCandidates.listByRun(run.id).map((c) => c.valid)).toEqual([false, false, false])
    const planners = h.runtime.sessions.filter((s) => s.role === 'planner')
    expect(planners).toHaveLength(4)
    const fallback = planners[3]
    expect(lensLabelOf(fallback?.prompt ?? '')).toBeNull()
    expect(fallback?.prompt).toContain('previous plan was rejected')
    expect(fallback?.prompt).toMatch(/Planner A \(risk-first\): .*cycle/i)
    expect(sessionsByPurpose(h, 'synthesize')).toHaveLength(0)
    expect(h.eventsOfType(run.id, 'planning.synthesized')).toHaveLength(0)
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['risk-core', 'risk-tests'])
  })

  it('a run without planningMode (v0.1 config) plans with one planner and records no candidates', async () => {
    h = await createHarness({ script: scenarioScript({ plan: planA }) })
    const run = await h.startRun()
    expect(h.repos.runs.require(run.id).config.planningMode).toBeUndefined()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.runtime.sessions.filter((s) => s.role === 'planner')).toHaveLength(1)
    expect(h.repos.planningCandidates.listByRun(run.id)).toHaveLength(0)
    expect(sessionsByPurpose(h, 'critique')).toHaveLength(0)
  })

  it('pausing while the planners work leaves no orphan sessions and resuming plans again', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    h = await createHarness({ script: scenarioScript({ plan: planA, candidate: () => planA }) })
    const base = h.runtime.script
    let started = 0
    h.runtime.script = async (spec, ctx) => {
      if (spec.role === 'planner' && lensLabelOf(spec.prompt) !== null && started < 3) {
        started++
        // The first round of planners hangs until stopped.
        await Promise.race([gate, new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))])
        if (ctx.signal.aborted) return
      }
      await base(spec, ctx)
    }
    const run = await h.startRun({ overrides: { planningMode: 'consensus' } })
    await h.waitFor(() => started === 3, 'three planner sessions')
    await h.orchestrator.pauseRun(run.id)
    await h.orchestrator.idle(run.id)
    expect(h.repos.agents.listActive(run.id)).toHaveLength(0)
    // Stopped sessions produced nothing, so nothing was recorded for them.
    expect(h.repos.planningCandidates.listByRun(run.id)).toHaveLength(0)
    expect(h.repos.tasks.listByRun(run.id)).toHaveLength(0)

    release?.()
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.repos.planningCandidates.listByRun(run.id)).toHaveLength(3)
    expect(h.repos.agents.listActive(run.id)).toHaveLength(0)
  })
})
