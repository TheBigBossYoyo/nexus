import { afterEach, describe, expect, it } from 'vitest'
import { createDemoScript } from '@main/modules/agent-runtime/demo-script'
import { createHarness, type Harness } from './harness'

/** The scripted agents the Playwright E2E drives must keep working, and now also show a plan revision. */
describe('scenario: the fake-runtime demo script', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('completes with the repair of ui and a plan revision proposed by the api worker', async () => {
    h = await createHarness({ script: createDemoScript() })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'], 120_000)).state).toBe('completed')
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.key).sort()).toEqual(['api', 'docs', 'integration', 'ui', 'ui-fix1'])
    const revisions = h.repos.graphRevisions.listByRun(run.id)
    expect(revisions.map((r) => r.version)).toEqual([1, 2])
    expect(h.repos.graphProposals.listByRun(run.id)).toMatchObject([{ type: 'ADD_TASK', status: 'applied', proposedBy: 'Worker/api' }])
    expect(h.task(run.id, 'docs').state).toBe('completed')
    expect(h.repos.reviews.listByTask(h.task(run.id, 'ui').id).map((r) => r.verdict)).toEqual(['changes_requested', 'approved'])
  })

  it('completes a consensus + dual-review demo run too', async () => {
    h = await createHarness({ script: createDemoScript() })
    const run = await h.startRun({ overrides: { planningMode: 'consensus', reviewMode: 'dual' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'], 120_000)).state).toBe('completed')
    expect(h.repos.planningCandidates.listByRun(run.id)).toHaveLength(3)
    expect(h.repos.planningCritiques.listByRun(run.id)).toHaveLength(1)
    expect(h.eventsOfType(run.id, 'planning.synthesized')).toHaveLength(1)
    expect(h.eventsOfType(run.id, 'review.arbitrated').length).toBeGreaterThanOrEqual(1)
    expect(h.task(run.id, 'ui').repairCycles).toBe(1)
  })
})
