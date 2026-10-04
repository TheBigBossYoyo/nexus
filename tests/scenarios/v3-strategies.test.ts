import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completeWith, scriptsByRole, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { approvedReview, createHarness, git, passedVerification, plan, plannedTask, writeFiles, type Harness } from './harness'

/** Exits 0 only when answer.txt holds the right answer: the objective check a tournament decides on. */
const CHECK_SCRIPT = `import { readFileSync } from 'node:fs'
let answer = ''
try { answer = readFileSync('answer.txt', 'utf8').trim() } catch { process.exit(2) }
process.exit(answer === 'right' ? 0 : 1)
`

const reviewer = completeWith({ text: 'review', structuredOutput: approvedReview })
const verifier = completeWith({ text: 'verify', structuredOutput: passedVerification })

/** The candidate label of a speculative session, from its worktree directory (`implement-cand-a`). */
const candidateOf = (cwd: string): string | null => /-cand-([a-c])/.exec(basename(cwd))?.[1] ?? null

describe('v0.3 strategies', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('SINGLE: one worker task, no planner session, normal review and verification', async () => {
    const worker: FakeScript = async (spec, ctx) => {
      await writeFiles(spec, ctx, { 'answer.txt': 'right' })
      await ctx.completeTurn({ text: 'Wrote the answer' })
    }
    h = await createHarness({ script: scriptsByRole({ worker, reviewer, verifier }), files: { 'check.mjs': CHECK_SCRIPT }, commands: { test: 'node check.mjs' } })

    const run = await h.orchestrator.createRun({
      projectId: h.project.id,
      mode: 'build',
      preset: 'balanced',
      prompt: 'Write the right answer to answer.txt',
      strategy: 'SINGLE',
      acceptanceCriteria: ['answer.txt holds the right answer'],
    })
    expect(run.config.strategy).toMatchObject({ requested: 'SINGLE', resolved: 'SINGLE', speculativeCandidates: 0 })
    expect(run.config.maxParallelAgents).toBe(1)

    const done = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')
    const tasks = h.repos.tasks.listByRun(run.id)
    expect(tasks.map((t) => [t.key, t.role, t.state])).toEqual([['implement', 'worker', 'completed']])
    expect(tasks[0]?.acceptanceCriteria).toEqual(['answer.txt holds the right answer'])
    expect(h.runtime.sessions.filter((s) => s.role === 'planner')).toHaveLength(0)
    expect(h.runtime.sessions.filter((s) => s.role === 'reviewer')).toHaveLength(1)
    expect(h.runtime.sessions.filter((s) => s.role === 'verifier')).toHaveLength(1)
    expect(h.eventsOfType(run.id, 'strategy.selected').map((e) => e.payload.resolved)).toEqual(['SINGLE'])
    expect(readFileSync(join(h.integration(run.id).path, 'answer.txt'), 'utf8').trim()).toBe('right')
    expect(h.repos.speculativeRuns.listByRun(run.id)).toEqual([])
  })

  it('a run started without a strategy behaves as before 0.3', async () => {
    h = await createHarness({
      script: scriptsByRole({
        planner: completeWith({ text: 'plan', structuredOutput: plan([plannedTask('alpha')]) }),
        worker: async (spec, ctx) => {
          await writeFiles(spec, ctx)
          await ctx.completeTurn({ text: 'done' })
        },
        reviewer,
        verifier,
      }),
    })
    const run = await h.startRun()
    expect(run.config.strategy).toBeUndefined()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.eventsOfType(run.id, 'strategy.selected')).toEqual([])
  })

  it('BUILD, SWARM and CONSENSUS configure the same engine through the run configuration', async () => {
    h = await createHarness({
      script: scriptsByRole({ planner: async (_spec, ctx) => ctx.sleep(60_000), worker: async () => undefined, reviewer, verifier }),
    })
    const create = (strategy: 'BUILD' | 'SWARM' | 'CONSENSUS', overrides = {}) =>
      h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Do it', strategy, overrides })

    const build = await create('BUILD')
    expect(build).toMatchObject({ mode: 'build', config: { planningMode: 'single', reviewMode: 'auto', maxParallelAgents: 4 } })
    const swarm = await create('SWARM')
    expect(swarm).toMatchObject({ mode: 'swarm', config: { planningMode: 'single', maxParallelAgents: 8 } })
    const consensus = await create('CONSENSUS')
    expect(consensus).toMatchObject({ mode: 'build', config: { planningMode: 'consensus', reviewMode: 'dual' } })
    // An explicit override of the caller wins over what the strategy configures.
    const capped = await create('SWARM', { maxParallelAgents: 3 })
    expect(capped.config.maxParallelAgents).toBe(3)
    for (const run of [build, swarm, consensus, capped]) await h.orchestrator.cancelRun(run.id)
  })

  it('SPECULATIVE: two isolated candidates, the one whose checks pass wins, the loser is recorded and removed', async () => {
    const prompts = new Map<string, string>()
    const worker: FakeScript = async (spec, ctx) => {
      const label = candidateOf(spec.cwd)
      if (label) prompts.set(label, spec.prompt)
      // Candidate a is wrong; candidate b is right. Only the objective check can tell them apart.
      await writeFiles(spec, ctx, { 'answer.txt': label === 'a' ? 'wrong' : 'right' })
      await ctx.completeTurn({ text: `Candidate ${label ?? '?'} finished` })
    }
    h = await createHarness({ script: scriptsByRole({ worker, reviewer, verifier }), files: { 'check.mjs': CHECK_SCRIPT }, commands: { test: 'node check.mjs' } })
    const headBefore = await git(h.repoDir, 'rev-parse', 'HEAD')

    const run = await h.orchestrator.createRun({
      projectId: h.project.id,
      mode: 'build',
      preset: 'balanced',
      prompt: 'Write the right answer to answer.txt',
      strategy: 'SPECULATIVE',
    })
    expect(run.config.strategy).toMatchObject({ resolved: 'SPECULATIVE', speculativeCandidates: 2 })
    const done = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')

    const [spec] = h.repos.speculativeRuns.listByRun(run.id)
    expect(spec).toMatchObject({ state: 'decided', candidateCount: 2 })
    const candidates = h.repos.candidateResults.listBySpeculativeRun(spec!.id)
    expect(candidates.map((c) => [c.label, c.outcome, c.rank, c.evidence.checksPassed])).toEqual([
      ['a', 'rejected', 2, false],
      ['b', 'winner', 1, true],
    ])
    // Independent: separate sessions, separate worktrees and branches, the same baseline.
    expect(new Set(candidates.map((c) => c.sdkSessionId)).size).toBe(2)
    expect(new Set(candidates.map((c) => c.worktreePath)).size).toBe(2)
    expect(new Set(candidates.map((c) => c.branch)).size).toBe(2)
    expect(spec!.baseCommit).toMatch(/^[0-9a-f]{40}$/)

    // Same task, same criteria; a prompt names only the candidate's own worktree.
    const [promptA, promptB] = [prompts.get('a')!, prompts.get('b')!]
    const [a, b] = candidates as [typeof candidates[number], typeof candidates[number]]
    expect(promptA.split(a.worktreePath).join('<wt>').split(a.branch).join('<br>')).toBe(
      promptB.split(b.worktreePath).join('<wt>').split(b.branch).join('<br>'),
    )
    expect(promptA).not.toContain(b.worktreePath)
    expect(promptB).not.toContain(a.worktreePath)
    expect(promptA.toLowerCase()).not.toContain('candidate')

    const decision = h.repos.tournamentDecisions.getBySpeculativeRun(spec!.id)
    expect(decision).toMatchObject({ winnerLabel: 'b', ranking: ['b', 'a'], confidence: 'decisive' })
    expect(decision?.comparisons[0]?.criterion).toBe('checks passed')

    // The winner went through the normal review and verification and is what was merged.
    expect(h.runtime.sessions.filter((s) => s.role === 'reviewer')).toHaveLength(1)
    expect(h.runtime.sessions.filter((s) => s.role === 'verifier')).toHaveLength(1)
    expect(readFileSync(join(h.integration(run.id).path, 'answer.txt'), 'utf8').trim()).toBe('right')

    // The loser's evidence was stored before its worktree and branch were removed.
    expect(a.diffPatch).toContain('wrong')
    expect(a.cleanedAt).not.toBeNull()
    expect(b.cleanedAt).not.toBeNull()
    for (const c of candidates) expect(existsSync(c.worktreePath)).toBe(false)
    const branches = await git(h.repoDir, 'branch', '--list', 'nexus/*')
    expect(branches).not.toContain('-cand-')

    // The user's repository was never written to.
    expect(await git(h.repoDir, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(await git(h.repoDir, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(h.repoDir, 'answer.txt'))).toBe(false)
    expect(h.eventsOfType(run.id, 'speculative.decided')[0]?.payload).toMatchObject({ winner: 'b', confidence: 'decisive' })
  })

  it('SPECULATIVE: when no candidate passes its checks the best one goes through the normal repair loop', async () => {
    const worker: FakeScript = async (spec, ctx) => {
      await writeFiles(spec, ctx, { 'answer.txt': 'wrong' })
      await ctx.completeTurn({ text: 'finished' })
    }
    const fixer: FakeScript = async (spec, ctx) => {
      await writeFiles(spec, ctx, { 'answer.txt': 'right' })
      await ctx.completeTurn({ text: 'fixed' })
    }
    h = await createHarness({
      script: scriptsByRole({ worker, debugger: fixer, reviewer, verifier }),
      files: { 'check.mjs': CHECK_SCRIPT },
      commands: { test: 'node check.mjs' },
    })
    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Answer', strategy: 'SPECULATIVE' })
    const done = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')
    const [spec] = h.repos.speculativeRuns.listByRun(run.id)
    expect(spec?.state).toBe('decided')
    expect(h.repos.tournamentDecisions.getBySpeculativeRun(spec!.id)?.confidence).toBe('marginal')
    expect(h.repos.tasks.listByRun(run.id).filter((t) => t.parentTaskId !== null)).toHaveLength(1)
    expect(readFileSync(join(h.integration(run.id).path, 'answer.txt'), 'utf8').trim()).toBe('right')
  })

  it('SPECULATIVE: a pause while candidates run keeps the finished candidate and resumes the other session', async () => {
    let stall = true
    const stalled = new Set<string>()
    const worker: FakeScript = async (spec, ctx) => {
      const label = candidateOf(spec.cwd)
      if (label === 'b' && stall) {
        stalled.add('b')
        await ctx.sleep(120_000)
        if (ctx.signal.aborted) return
      }
      await writeFiles(spec, ctx, { 'answer.txt': label === 'a' ? 'wrong' : 'right' })
      await ctx.completeTurn({ text: `Candidate ${label ?? '?'} finished` })
    }
    h = await createHarness({ script: scriptsByRole({ worker, reviewer, verifier }), files: { 'check.mjs': CHECK_SCRIPT }, commands: { test: 'node check.mjs' } })
    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Answer', strategy: 'SPECULATIVE' })

    // Candidate a finishes (implemented, checks failed) while candidate b is still working.
    await h.waitFor(() => stalled.has('b'), 'candidate b to be working')
    await h.waitFor(() => h.repos.candidateResults.listByRun(run.id).some((c) => c.label === 'a' && c.headCommit !== null), 'candidate a to finish')
    const paused = await h.orchestrator.pauseRun(run.id)
    expect(paused.state).toBe('paused')
    const [spec] = h.repos.speculativeRuns.listByRun(run.id)
    expect(spec?.state).toBe('running')
    expect(h.repos.tournamentDecisions.listByRun(run.id)).toEqual([])
    const task = h.task(run.id, 'implement')
    expect(task).toMatchObject({ state: 'running', attempt: 1 })
    const before = h.repos.candidateResults.listBySpeculativeRun(spec!.id)
    const bSession = before.find((c) => c.label === 'b')?.agentId
    expect(bSession).toBeTruthy()

    stall = false
    await h.orchestrator.resumeRun(run.id)
    const done = await h.waitForState(run.id, ['completed', 'failed'])
    expect(done.state).toBe('completed')

    // One speculative run, the same candidates and worktrees; a was not run again, b resumed its session.
    expect(h.repos.speculativeRuns.listByRun(run.id)).toHaveLength(1)
    const after = h.repos.candidateResults.listBySpeculativeRun(spec!.id)
    expect(after.map((c) => [c.label, c.outcome])).toEqual([
      ['a', 'rejected'],
      ['b', 'winner'],
    ])
    expect(after.map((c) => c.worktreePath)).toEqual(before.map((c) => c.worktreePath))
    const workerSessions = h.runtime.sessions.filter((s) => s.role === 'worker')
    expect(workerSessions.filter((s) => candidateOf(s.cwd) === 'a')).toHaveLength(1)
    const bRuns = workerSessions.filter((s) => candidateOf(s.cwd) === 'b')
    expect(bRuns).toHaveLength(2)
    expect(bRuns[1]?.resumeSessionId).toBe(h.repos.sessions.listByAgent(bSession!)[0]?.sdkSessionId)
    expect(h.task(run.id, 'implement').attempt).toBe(1)
    expect(readFileSync(join(h.integration(run.id).path, 'answer.txt'), 'utf8').trim()).toBe('right')
  })

  it('SPECULATIVE: if no candidate produces a result the task retries as a normal single implementation', async () => {
    let calls = 0
    const worker: FakeScript = async (spec, ctx) => {
      calls++
      if (candidateOf(spec.cwd)) return ctx.fail(new Error('candidate crashed'))
      await writeFiles(spec, ctx, { 'answer.txt': 'right' })
      await ctx.completeTurn({ text: 'done on the retry' })
    }
    h = await createHarness({ script: scriptsByRole({ worker, reviewer, verifier }), files: { 'check.mjs': CHECK_SCRIPT }, commands: { test: 'node check.mjs' } })
    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Answer', strategy: 'SPECULATIVE' })
    const done = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    const [spec] = h.repos.speculativeRuns.listByRun(run.id)
    expect(spec?.state).toBe('failed')
    expect(h.repos.tournamentDecisions.getBySpeculativeRun(spec!.id)).toMatchObject({ winnerLabel: null, confidence: 'none' })
    for (const c of h.repos.candidateResults.listBySpeculativeRun(spec!.id)) expect(existsSync(c.worktreePath)).toBe(false)
    // The speculative attempt is not repeated: there is exactly one speculative run for the task.
    expect(h.repos.speculativeRuns.listByRun(run.id)).toHaveLength(1)
    if (done.state === 'paused') {
      // No automatic retry happened: retry by hand, as a user would, and the task runs unspeculated.
      await h.orchestrator.retryTask(h.task(run.id, 'implement').id)
      await h.orchestrator.resumeRun(run.id)
      expect((await h.waitForState(run.id, ['completed', 'failed'])).state).toBe('completed')
    } else {
      expect(done.state).toBe('completed')
    }
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(h.repos.speculativeRuns.listByRun(run.id)).toHaveLength(1)
  })
})
