import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, keyOf, plan, plannedTask, scenarioScript, writeFiles, type Harness } from './harness'

// 0.8: the user's answer to a boundary request restarts what waited for it. A mission with nobody watching
// (no window is part of these tests: the runtime is all there is) meets one boundary. The task that met it
// stops and says so; the rest of the mission goes on; one request waits. When the answer comes, hours later
// or at once, NEXUS puts the task back in the queue and resumes the mission by itself.

describe('scenario: a boundary decision resumes the work that waited for it (0.8)', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  /** A worker that pushes in the task called `publish`: it reports a blocker when the push is refused, and finishes when it is not. */
  function workers(log: { key: string; attempt: number; pushAllowed: boolean | null }[]): FakeScript {
    const attempts = new Map<string, number>()
    return async (spec, ctx) => {
      const key = keyOf(spec)
      const attempt = (attempts.get(key) ?? 0) + 1
      attempts.set(key, attempt)
      if (key !== 'publish') {
        log.push({ key, attempt, pushAllowed: null })
        await writeFiles(spec, ctx)
        await ctx.completeTurn({ text: 'done' })
        return
      }
      await writeFiles(spec, ctx)
      const allowed = await ctx.useTool('Bash', { command: 'git push origin HEAD' }, async () => 'pushed')
      log.push({ key, attempt, pushAllowed: allowed })
      if (!allowed && attempt === 1) {
        await ctx.nexusTools?.reportBlocker({ summary: 'The push was refused: Push to a Git remote needs the decision of the user.', evidence: 'git push origin HEAD was not run.' })
        await ctx.completeTurn({ text: 'Blocked on the push.' })
        return
      }
      await ctx.completeTurn({ text: allowed ? 'Pushed.' : 'Done; the push was declined by the user and was not made.' })
    }
  }

  it('allowed for the mission: the waiting task is started again, the mission resumes and finishes, and the user was asked once', async () => {
    const log: { key: string; attempt: number; pushAllowed: boolean | null }[] = []
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('publish'), plannedTask('other')]), worker: workers(log) }), autonomy: { profile: 'AUTONOMOUS_PROJECT', contained: true } })
    const run = await h.startRun()
    // The independent task finishes; the mission then stops at the one thing it cannot do.
    expect((await h.waitForState(run.id, ['paused', 'completed', 'failed'])).state).toBe('paused')
    expect(h.task(run.id, 'other').state).toBe('completed')
    expect(h.task(run.id, 'publish').state).toBe('blocked')
    const [request] = h.autonomy.pending()
    expect(h.autonomy.pending()).toHaveLength(1)
    expect(request).toMatchObject({ capability: 'GIT_PUSH', state: 'PENDING' })
    expect(log.filter((r) => r.key === 'publish')).toEqual([{ key: 'publish', attempt: 1, pushAllowed: false }])

    // The answer. Nothing else is done by anybody.
    h.autonomy.resolve({ requestId: request?.id ?? '', decision: 'ALLOW_MISSION' })
    expect((await h.waitForState(run.id, ['completed', 'failed'], 120_000)).state).toBe('completed')
    expect(h.task(run.id, 'publish').state).toBe('completed')
    expect(log.filter((r) => r.key === 'publish')).toEqual([
      { key: 'publish', attempt: 1, pushAllowed: false },
      { key: 'publish', attempt: 2, pushAllowed: true },
    ])
    expect(h.resumeOutcomes).toEqual([{ retried: [h.task(run.id, 'publish').id], resumed: true, notes: [] }])
    // One question in all, no approval dialog, and the decision is on the task's record.
    expect(h.repos.boundaryRequests.countForRun(run.id)).toBe(1)
    expect(h.repos.approvals.listByRun(run.id).filter((a) => a.kind === 'tool')).toEqual([])
    expect(h.repos.artifacts.listByTask(h.task(run.id, 'publish').id).map((a) => a.title)).toContain('The user allowed: Push to a Git remote')
    expect(h.eventsOfType(run.id, 'run.resumed')).toHaveLength(1)
    // What was done is said where the user answered: the inbox shows it under the decision.
    expect(h.autonomy.recent().find((r) => r.id === request?.id)?.followUp).toBe('Allowed: 1 task started again, mission resumed.')
    expect(h.autonomy.pending().every((r) => r.followUp === null)).toBe(true)
  }, 180_000)

  it('denied: the task is started again to finish without it, the mission completes, and the same thing is not asked again', async () => {
    const log: { key: string; attempt: number; pushAllowed: boolean | null }[] = []
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('publish'), plannedTask('other')]), worker: workers(log) }), autonomy: { profile: 'AUTONOMOUS_PROJECT', contained: true } })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['paused', 'completed', 'failed'])).state).toBe('paused')
    const [request] = h.autonomy.pending()
    h.autonomy.resolve({ requestId: request?.id ?? '', decision: 'DENY' })
    expect((await h.waitForState(run.id, ['completed', 'failed'], 120_000)).state).toBe('completed')
    expect(log.filter((r) => r.key === 'publish')).toEqual([
      { key: 'publish', attempt: 1, pushAllowed: false },
      { key: 'publish', attempt: 2, pushAllowed: false },
    ])
    // The second refusal came from the stored decision: there is still one request, and it is not pending.
    expect(h.repos.boundaryRequests.countForRun(run.id)).toBe(1)
    expect(h.autonomy.pending()).toEqual([])
    expect(h.repos.artifacts.listByTask(h.task(run.id, 'publish').id).map((a) => a.title)).toContain('The user denied: Push to a Git remote')
    expect(h.resumeOutcomes[0]).toMatchObject({ resumed: true })
  }, 180_000)

  it('a mission that waits for something else as well stays paused: the task is queued, and the reason is said', async () => {
    const log: { key: string; attempt: number; pushAllowed: boolean | null }[] = []
    const base = workers(log)
    let asked = false
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'question' && !asked) {
        asked = true
        await ctx.nexusTools?.reportBlocker({ summary: 'Which port should the service use?', evidence: 'config.json has two candidates' })
        await ctx.completeTurn({ text: 'Blocked on a question.' })
        return
      }
      await base(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('publish'), plannedTask('question')]), worker }), autonomy: { profile: 'AUTONOMOUS_PROJECT', contained: true } })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['paused', 'completed', 'failed'])).state).toBe('paused')
    await h.waitFor(() => h.task(run.id, 'publish').state === 'blocked' && h.task(run.id, 'question').state === 'blocked', 'both tasks blocked')
    const [request] = h.autonomy.pending()
    h.autonomy.resolve({ requestId: request?.id ?? '', decision: 'ALLOW_ONCE' })
    await h.waitFor(() => h.resumeOutcomes.length === 1, 'the auto-resume')
    expect(h.resumeOutcomes[0]?.retried).toEqual([h.task(run.id, 'publish').id])
    expect(h.resumeOutcomes[0]?.resumed).toBe(false)
    expect(h.resumeOutcomes[0]?.notes.join(' ')).toContain('Other tasks of the mission still need attention (question)')
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    // The other question was not answered by this, and the task that can go on is ready for when the mission does.
    expect(h.task(run.id, 'question').state).toBe('blocked')
    expect(h.task(run.id, 'publish').state).toBe('ready')
  }, 180_000)

  it('a grant that was taken back before the work could go on restarts nothing', async () => {
    const log: { key: string; attempt: number; pushAllowed: boolean | null }[] = []
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('publish')]), worker: workers(log) }), autonomy: { profile: 'AUTONOMOUS_PROJECT', contained: true } })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['paused', 'completed', 'failed'])).state).toBe('paused')
    const [request] = h.autonomy.pending()
    // Granted and taken back in the same breath, before the restart had its turn.
    const { grant } = h.autonomy.resolve({ requestId: request?.id ?? '', decision: 'ALLOW_MISSION' })
    h.autonomy.revokeGrant(grant?.id ?? '')
    await h.waitFor(() => h.resumeOutcomes.length === 1, 'the auto-resume')
    expect(h.resumeOutcomes[0]).toMatchObject({ retried: [], resumed: false })
    expect(h.resumeOutcomes[0]?.notes.join(' ')).toContain('taken back')
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    expect(h.task(run.id, 'publish').state).toBe('blocked')
  }, 120_000)
})
