import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, fileWorker, plan, plannedTask, rejectedReview, approvedReview, scenarioScript, sessionsOf, type Harness } from './harness'

describe('scenario: adaptive model routing', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('a worker that fails twice is promoted: the routing decision says why and the session gets the stronger model', async () => {
    let calls = 0
    const worker: FakeScript = async (spec, ctx) => {
      calls++
      if (calls <= 2) ctx.fail(`crash ${calls}`)
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('solo')]), worker }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const tiers = h.repos.settings.get().models.tiers
    const task = h.task(run.id, 'solo')
    const decisions = h.repos.routingDecisions.listByTask(task.id).filter((d) => d.role === 'worker')
    expect(decisions.map((d) => d.requestedPolicy)).toEqual(['BALANCED', 'BALANCED', 'BALANCED'])
    expect(decisions.map((d) => d.resolvedPolicy)).toEqual(['BALANCED', 'STRONGEST', 'STRONGEST'])
    // The next session after two failures carries the promotion and its reason.
    const third = decisions[2]
    expect(third).toMatchObject({ resolvedTier: 'strongest', resolvedModel: tiers.strongest, purpose: 'implement' })
    expect(third?.reasons.join(' ')).toMatch(/escalated to STRONGEST/)
    expect(decisions[1]?.reasons.join(' ')).toMatch(/Attempt 2 after an earlier failure: BALANCED -> STRONGEST/)

    // What the runtime was asked to start is what was decided.
    expect(sessionsOf(h, 'worker').map((s) => s.model)).toEqual(decisions.map((d) => d.resolvedModel))
    expect(sessionsOf(h, 'worker')[2]?.model).toBe(tiers.strongest)

    // Every agent of the run has exactly one decision, announced by an event that carries the same facts.
    const agents = h.repos.agents.listByRun(run.id)
    for (const agent of agents) {
      expect(h.repos.routingDecisions.listByRun(run.id).filter((d) => d.agentId === agent.id), agent.label).toHaveLength(1)
    }
    const events = h.eventsOfType(run.id, 'routing.decided')
    expect(events).toHaveLength(agents.length)
    const thirdEvent = events.find((e) => e.payload.decisionId === third?.id)
    expect(thirdEvent?.payload).toMatchObject({ role: 'worker', policy: 'STRONGEST', model: tiers.strongest })
  })

  it('a HIGH review finding routes the repair to the strongest policy and the repaired task then verifies', async () => {
    let reviews = 0
    h = await createHarness({
      // The debugger normally runs on the strongest tier; make it BALANCED so the finding's effect is visible.
      settings: (s) => ({ ...s, models: { ...s.models, rolePolicy: { ...s.models.rolePolicy, debugger: 'balanced' } } }),
      script: scenarioScript({
        plan: plan([plannedTask('feature')]),
        reviewer: async (_spec, ctx) => {
          reviews++
          await ctx.completeTurn({ text: 'review', structuredOutput: reviews === 1 ? rejectedReview({ severity: 'high', title: 'Unvalidated input' }) : approvedReview })
        },
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const tiers = h.repos.settings.get().models.tiers
    const repair = h.repos.routingDecisions.listByRun(run.id).find((d) => d.role === 'debugger')
    expect(repair).toMatchObject({ requestedPolicy: 'BALANCED', resolvedPolicy: 'STRONGEST', resolvedModel: tiers.strongest, purpose: 'diagnose' })
    expect(repair?.reasons.join(' ')).toMatch(/Repair cycle 1 after a HIGH finding: BALANCED -> STRONGEST/)
    expect(sessionsOf(h, 'debugger')[0]?.model).toBe(tiers.strongest)

    const parent = h.task(run.id, 'feature')
    expect(h.repos.verifications.listByTask(parent.id).filter((v) => v.kind === 'verifier').map((v) => v.passed)).toEqual([true])
  })

  it('a medium finding alone does not escalate the repair (verification failures keep the role policy)', async () => {
    let verifications = 0
    h = await createHarness({
      settings: (s) => ({ ...s, models: { ...s.models, rolePolicy: { ...s.models.rolePolicy, debugger: 'balanced' } } }),
      script: scenarioScript({
        plan: plan([plannedTask('feature')]),
        verifier: async (spec, ctx) => {
          const missionLevel = spec.cwd.endsWith('integration')
          if (!missionLevel) verifications++
          await ctx.completeTurn({
            text: 'verify',
            structuredOutput:
              !missionLevel && verifications === 1
                ? { summary: 'Not met.', criteria: [{ criterion: 'feature.txt exists', passed: false, evidence: 'no' }], failures: [{ criterion: 'feature.txt exists', evidence: 'no', likelyCause: '', relevantFiles: [] }] }
                : { summary: 'ok', criteria: [], failures: [] },
          })
        },
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const repair = h.repos.routingDecisions.listByRun(run.id).find((d) => d.role === 'debugger')
    expect(repair?.resolvedPolicy).toBe('BALANCED')
    expect(repair?.reasons.join(' ')).not.toMatch(/finding/)
  })
})
