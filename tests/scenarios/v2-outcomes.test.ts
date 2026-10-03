import { afterEach, describe, expect, it } from 'vitest'
import type { TaskOutcome } from '@shared/v2'
import { MIN_ROUTING_SAMPLES } from '@shared/v2'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { approvedReview, createHarness, fileWorker, ipc, plan, plannedTask, rejectedReview, scenarioScript, type Harness } from './harness'

describe('scenario: empirical outcomes', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('a task that passes first time produces an exact outcome row, and performance.summary reports it with its sample size', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('solo')]) }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const task = h.task(run.id, 'solo')
    const outcome = h.repos.taskOutcomes.getByTask(task.id)
    expect(outcome).toMatchObject({
      projectId: h.project.id,
      runId: run.id,
      role: 'worker',
      model: 'sonnet',
      tier: 'balanced',
      category: 'implement',
      attempts: 1,
      firstPassVerified: true,
      completed: true,
      reviewRejections: 0,
      repairCount: 0,
      checksFailed: 0,
      humanInterventions: 0,
    })
    expect(outcome?.elapsedMs).not.toBeNull()
    // Tokens come from what the (fake) SDK reported for the implementing agent, never an estimate.
    const agent = h.repos.agents.listByTask(task.id).find((a) => a.purpose === 'implement')
    expect(outcome?.outputTokens).toBe(agent?.metrics.outputTokens)
    expect(outcome?.outputTokens).not.toBeNull()
    // Only the implementing task is measured, not the review and verification agents.
    expect(h.repos.taskOutcomes.listByProject(h.project.id)).toHaveLength(1)

    const summary = await ipc(h, 'performance.summary', { projectId: h.project.id })
    expect(summary).toMatchObject({ totalOutcomes: 1, minSamples: MIN_ROUTING_SAMPLES })
    expect(summary.stats).toHaveLength(1)
    expect(summary.stats[0]).toMatchObject({ role: 'worker', model: 'sonnet', category: 'implement', samples: 1, sufficient: false, firstPassRate: 1, completionRate: 1 })
  })

  it('a task that needed a review rejection and a repair is not a first-pass success', async () => {
    let reviews = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('fixme')]),
        reviewer: async (_s, ctx) => ctx.completeTurn({ text: 'r', structuredOutput: ++reviews === 1 ? rejectedReview() : approvedReview }),
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const outcome = h.repos.taskOutcomes.getByTask(h.task(run.id, 'fixme').id)
    expect(outcome).toMatchObject({ attempts: 1, firstPassVerified: false, completed: true, reviewRejections: 1, repairCount: 1 })
    // The repair child itself is not a measured task.
    expect(h.repos.taskOutcomes.listByProject(h.project.id)).toHaveLength(1)
  })

  it('a task that fails for good is recorded as failed; retrying it later updates the same row', async () => {
    let succeed = false
    const worker: FakeScript = async (spec, ctx) => {
      if (!succeed) ctx.fail('still broken')
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('flaky')]), worker }) })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    const flaky = h.task(run.id, 'flaky')
    const failed = h.repos.taskOutcomes.getByTask(flaky.id) as TaskOutcome
    // Three attempts were made; the last one ran on the escalated tier.
    expect(failed).toMatchObject({ attempts: 3, completed: false, firstPassVerified: false, tier: 'strongest', model: 'opus' })

    succeed = true
    await h.orchestrator.retryTask(flaky.id)
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const rows = h.repos.taskOutcomes.listByProject(h.project.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: failed.id, taskId: flaky.id, completed: true })
    // The user's retry is an intervention on that task.
    expect(rows[0]?.humanInterventions).toBe(1)
  })

  it('measured performance changes routing only from the minimum sample size on', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: (n) => plan([plannedTask(['first', 'second', 'third'][n] ?? 'extra')]) }),
    })
    const tiers = h.repos.settings.get().models.tiers
    const workerDecision = (runId: string) => h.repos.routingDecisions.listByRun(runId).find((d) => d.role === 'worker')

    const first = await h.startRun()
    await h.waitForState(first.id, 'completed')
    expect(workerDecision(first.id)?.reasons.join(' ')).not.toMatch(/Measured performance/)

    // Three failed first-pass outcomes: with the real one that is 4 samples, one below the minimum.
    const base = h.repos.taskOutcomes.getByTask(h.task(first.id, 'first').id) as TaskOutcome
    for (let i = 0; i < MIN_ROUTING_SAMPLES - 2; i++) {
      h.repos.taskOutcomes.upsertForTask({ ...base, id: `seed-${i}`, taskId: `seed-task-${i}`, firstPassVerified: false, repairCount: 2 })
    }
    expect((await ipc(h, 'performance.summary', { projectId: h.project.id })).stats[0]).toMatchObject({ samples: MIN_ROUTING_SAMPLES - 1, sufficient: false })

    const second = await h.startRun()
    await h.waitForState(second.id, 'completed')
    // 25% first-pass over 4 samples is poor, but too few samples to act on.
    expect(workerDecision(second.id)).toMatchObject({ resolvedPolicy: 'BALANCED', resolvedModel: tiers.balanced })
    expect(workerDecision(second.id)?.reasons.join(' ')).not.toMatch(/Measured performance/)

    // Its own success is the fifth sample: now the measurement is sufficient and below 50%.
    const stat = (await ipc(h, 'performance.summary', { projectId: h.project.id })).stats[0]
    expect(stat).toMatchObject({ samples: MIN_ROUTING_SAMPLES, sufficient: true, firstPassRate: 0.4 })

    const third = await h.startRun()
    await h.waitForState(third.id, 'completed')
    const decision = workerDecision(third.id)
    expect(decision).toMatchObject({ requestedPolicy: 'BALANCED', resolvedPolicy: 'STRONGEST', resolvedModel: tiers.strongest })
    expect(decision?.reasons.join(' ')).toMatch(/Measured performance of sonnet for worker\/implement: first-pass 2\/5 = 40% \(below 50%\)/)
    expect(h.runtime.sessions.filter((s) => s.role === 'worker').at(-1)?.model).toBe(tiers.strongest)
  })
})
