import { afterEach, describe, expect, it } from 'vitest'
import type { ReviewFinding } from '@shared/domain'
import { specPurpose, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import {
  approvedReview,
  arbiterFindings,
  createHarness,
  finding,
  ipc,
  plan,
  plannedTask,
  scenarioScript,
  sessionsOf,
  type Harness,
} from './harness'

const REAL = finding({ title: 'Off-by-one in range check', file: 'feature.txt', lineStart: 3, lineEnd: 4, severity: 'high', confidence: 'high' })
/** The same defect as seen by the second reviewer: overlapping lines in the same file, one level lower. */
const REAL_AGAIN = finding({ title: 'Range check is off by one', file: 'feature.txt', lineStart: 4, lineEnd: 5, severity: 'medium', confidence: 'medium' })
const BOGUS = finding({ title: 'Hallucinated race in a file that does not exist', file: 'ghost.ts', lineStart: 10, lineEnd: 12, severity: 'high', confidence: 'medium' })

/** Both reviewers wait for each other, so the test proves they run concurrently (a sequential pair would never meet). */
function meeting(): { arrive: (ctx: { signal: AbortSignal; sleep(ms: number): Promise<void> }) => Promise<boolean> } {
  let here = 0
  return {
    async arrive(ctx) {
      here++
      for (let i = 0; i < 400 && here < 2 && !ctx.signal.aborted; i++) await ctx.sleep(10)
      return here >= 2
    },
  }
}

describe('scenario: adversarial review V2 (dual review and the finding arbiter)', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  const dualScript = (over: { arbiter?: FakeScript; firstA?: ReviewFinding[]; firstB?: ReviewFinding[] }) => {
    const met = meeting()
    const concurrent: boolean[] = []
    let aReviews = 0
    let bReviews = 0
    const script = scenarioScript({
      plan: plan([plannedTask('feature')]),
      reviewer: async (_spec, ctx) => {
        const first = aReviews++ === 0
        if (first) concurrent.push(await met.arrive(ctx))
        await ctx.completeTurn({ text: 'review A', structuredOutput: first ? { summary: 'A: issues.', findings: over.firstA ?? [REAL, BOGUS] } : approvedReview })
      },
      securityReviewer: async (_spec, ctx) => {
        const first = bReviews++ === 0
        if (first) concurrent.push(await met.arrive(ctx))
        await ctx.completeTurn({ text: 'review B', structuredOutput: first ? { summary: 'B: one issue.', findings: over.firstB ?? [REAL_AGAIN] } : approvedReview })
      },
      ...(over.arbiter ? { arbiter: over.arbiter } : {}),
    })
    return { script, concurrent }
  }

  /** Accepts the finding whose title matches, rejects the others, by the indexes the arbiter prompt lists. */
  const decide = (accept: (title: string) => boolean): FakeScript => async (spec, ctx) => {
    await ctx.completeTurn({
      text: 'arbitration',
      structuredOutput: {
        summary: 'Checked each finding against the code.',
        decisions: arbiterFindings(spec.prompt).map((f) => ({ findingIndex: f.index, accepted: accept(f.title), reason: accept(f.title) ? 'Confirmed in feature.txt.' : 'The file does not exist.' })),
      },
    })
  }

  it('two concurrent reviewers, duplicates merged, the arbiter rejects the hallucination and accepts the real finding', async () => {
    const { script, concurrent } = dualScript({ arbiter: decide((t) => !t.startsWith('Hallucinated')) })
    h = await createHarness({ script })
    const run = await h.startRun({ overrides: { reviewMode: 'dual' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    // Both reviewers were in flight at the same time.
    expect(concurrent).toEqual([true, true])

    const task = h.task(run.id, 'feature')
    const rows = await ipc(h, 'tasks.reviews', { taskId: task.id })
    // Cycle 1: reviewer A (changes), reviewer B (only a medium finding: approves), arbiter (changes). Cycle 2
    // (after the repair): both approve, no arbiter needed.
    expect(rows.map((r) => [r.attempt, r.verdict])).toEqual([
      [1, 'changes_requested'],
      [1, 'approved'],
      [1, 'changes_requested'],
      [2, 'approved'],
      [2, 'approved'],
    ])
    expect(rows.filter((r) => r.arbitration).length).toBe(1)
    const arbiterRow = rows[2]
    // The arbiter's row lists the deduplicated findings: the two reports of the real defect became one.
    expect(arbiterRow?.findings.map((f) => f.title).sort()).toEqual([REAL.title, BOGUS.title].sort())
    expect(arbiterRow?.arbitration?.decisions.map((d) => d.accepted).sort()).toEqual([false, true])
    expect(arbiterRow?.arbitration?.summary).toBe('Checked each finding against the code.')
    // The merged finding keeps the highest severity and confidence of its reports.
    const merged = arbiterRow?.findings.find((f) => f.title === REAL.title)
    expect(merged).toMatchObject({ severity: 'high', confidence: 'high', lineStart: 3, lineEnd: 5 })
    // The same records are returned for the whole run.
    const all = await ipc(h, 'reviews.list', { runId: run.id })
    expect(all.filter((r) => r.arbitration).map((r) => r.id)).toEqual([arbiterRow?.id])

    expect(h.eventsOfType(run.id, 'review.arbitrated').map((e) => e.payload)).toEqual([{ accepted: 1, rejected: 1 }])

    // Only the accepted finding went to the repair and to the dependants' messages.
    expect(h.repos.tasks.listByRun(run.id).filter((t) => t.parentTaskId === task.id)).toHaveLength(1)
    const repairPrompt = sessionsOf(h, 'debugger')[0]?.prompt ?? ''
    expect(repairPrompt).toContain(REAL.title)
    expect(repairPrompt).not.toContain(BOGUS.title)
    const messages = h.repos.messages.listByRun(run.id).filter((m) => m.type === 'review_finding')
    expect(messages.map((m) => m.subject)).toEqual([REAL.title])

    // The arbiter was a read-only reviewer that saw both findings with indexes and the diff, no worker reasoning.
    const arbiters = h.runtime.sessions.filter((s) => specPurpose(s) === 'arbitrate')
    expect(arbiters).toHaveLength(1)
    expect(arbiters[0]?.role).toBe('reviewer')
    expect(arbiters[0]?.tools).not.toContain('Write')
    expect(arbiters[0]?.prompt).toContain('Findings to arbitrate')
    expect(arbiters[0]?.prompt).toContain('[0] (reported by')
    expect(arbiters[0]?.prompt).toContain('Patch')
    expect(arbiters[0]?.prompt).toContain('reported by reviewer, security_reviewer')
    // Reviewer A and B got different lenses.
    expect(sessionsOf(h, 'reviewer').find((s) => s.prompt.includes('Review focus'))?.prompt).toContain('Concentrate on correctness')
    expect(sessionsOf(h, 'security_reviewer')[0]?.prompt).toContain('Concentrate on security, concurrency and failure modes')
  })

  it('when the arbiter rejects every finding the change is approved and nothing is repaired', async () => {
    const { script } = dualScript({ arbiter: decide(() => false) })
    h = await createHarness({ script })
    const run = await h.startRun({ overrides: { reviewMode: 'dual' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const task = h.task(run.id, 'feature')
    expect(task.repairCycles).toBe(0)
    expect(sessionsOf(h, 'debugger')).toHaveLength(0)
    const rows = h.repos.reviews.listByTask(task.id)
    expect(rows).toHaveLength(3)
    expect(rows[2]?.verdict).toBe('approved')
    expect(h.eventsOfType(run.id, 'review.arbitrated')[0]?.payload).toEqual({ accepted: 0, rejected: 2 })
    expect(h.repos.messages.listByRun(run.id).filter((m) => m.type === 'review_finding')).toHaveLength(0)
  })

  it('with no significant findings there is no arbiter', async () => {
    const { script } = dualScript({ firstA: [finding({ severity: 'low', title: 'Naming', file: 'feature.txt', lineStart: 1, lineEnd: 1 })], firstB: [] })
    h = await createHarness({ script })
    const run = await h.startRun({ overrides: { reviewMode: 'dual' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.runtime.sessions.filter((s) => specPurpose(s) === 'arbitrate')).toHaveLength(0)
    expect(h.repos.reviews.listByTask(h.task(run.id, 'feature').id)).toHaveLength(2)
    expect(h.eventsOfType(run.id, 'review.arbitrated')).toHaveLength(0)
  })

  it('an arbiter that never produces a valid decision fails safe: confident high findings stand, the rest drop', async () => {
    const broken: FakeScript = async (_spec, ctx) => ctx.completeTurn({ text: 'garbage', structuredOutput: { nonsense: true } })
    const confidentReal = { ...REAL, confidence: 'high' as const }
    const { script } = dualScript({ arbiter: broken, firstA: [confidentReal, BOGUS], firstB: [] })
    h = await createHarness({ script })
    const run = await h.startRun({ overrides: { reviewMode: 'dual' } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    // The arbiter got its one retry, then the fail-safe applied.
    expect(h.runtime.sessions.filter((s) => specPurpose(s) === 'arbitrate')).toHaveLength(2)
    const task = h.task(run.id, 'feature')
    const arbiterRow = (await ipc(h, 'tasks.reviews', { taskId: task.id })).find((r) => r.arbitration)
    expect(arbiterRow?.agentId).toBeNull()
    expect(arbiterRow?.arbitration?.decisions).toEqual([])
    expect(arbiterRow?.arbitration?.summary).toMatch(/fail-safe/)
    expect(arbiterRow?.verdict).toBe('changes_requested')
    // The high-confidence critical/high finding was not silently dropped; the medium-confidence hallucination was.
    expect(h.eventsOfType(run.id, 'review.arbitrated')[0]?.payload).toEqual({ accepted: 1, rejected: 1 })
    expect(sessionsOf(h, 'debugger')[0]?.prompt).toContain(REAL.title)
    expect(sessionsOf(h, 'debugger')[0]?.prompt).not.toContain(BOGUS.title)
  })

  describe('review mode selection', () => {
    const mixed = plan([plannedTask('calm'), plannedTask('risky', { risk: 'high', requiresApproval: false })])

    it('a v0.1 run config (no reviewMode) reviews low-risk tasks with one reviewer; auto uses dual only for the high-risk task', async () => {
      h = await createHarness({ script: scenarioScript({ plan: mixed }) })
      const run = await h.startRun()
      expect(h.repos.runs.require(run.id).config.reviewMode).toBeUndefined()
      expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
      const calm = h.task(run.id, 'calm')
      const risky = h.task(run.id, 'risky')
      expect(h.repos.reviews.listByTask(calm.id)).toHaveLength(1)
      expect(h.repos.agents.listByTask(calm.id).filter((a) => a.purpose === 'review').map((a) => a.role)).toEqual(['reviewer'])
      // Both reviewers approved without findings: two rows and no arbiter.
      expect(h.repos.reviews.listByTask(risky.id)).toHaveLength(2)
      expect(h.repos.agents.listByTask(risky.id).filter((a) => a.purpose === 'review').map((a) => a.role).sort()).toEqual(['reviewer', 'security_reviewer'])
      expect(h.runtime.sessions.filter((s) => specPurpose(s) === 'arbitrate')).toHaveLength(0)
    })

    it('standard mode keeps the single security reviewer for a high-risk task', async () => {
      h = await createHarness({ script: scenarioScript({ plan: mixed }) })
      const run = await h.startRun({ overrides: { reviewMode: 'standard' } })
      expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
      const risky = h.task(run.id, 'risky')
      expect(h.repos.reviews.listByTask(risky.id)).toHaveLength(1)
      expect(h.repos.agents.listByTask(risky.id).filter((a) => a.purpose === 'review').map((a) => a.role)).toEqual(['security_reviewer'])
    })

    it('dual mode reviews even a low-risk task twice', async () => {
      h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('calm')]) }) })
      const run = await h.startRun({ overrides: { reviewMode: 'dual' } })
      expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
      expect(h.repos.reviews.listByTask(h.task(run.id, 'calm').id)).toHaveLength(2)
    })
  })
})
