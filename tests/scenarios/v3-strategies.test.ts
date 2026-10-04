import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completeWith, scriptsByRole, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { runProcess } from '@main/modules/process'
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
    expect(spec).toMatchObject({ candidateCount: 2 })
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
    expect(spec!.state).toBe('adopted')

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
    // Candidates were clones: the user's repository never had a branch for them.
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
    expect(spec?.state).toBe('adopted')
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

  it('SPECULATIVE: a candidate cannot see another candidate through Git, and a message reaches every candidate', async () => {
    const seen: Record<string, { branches: string; otherCommitVisible: boolean; remotes: string }> = {}
    const instructions: Record<string, string[]> = { a: [], b: [] }
    let aHead: string | null = null
    let release = false
    const gitIn = async (cwd: string, ...args: string[]) => runProcess('git', args, { cwd })
    const worker: FakeScript = async (spec, ctx) => {
      const label = candidateOf(spec.cwd) as 'a' | 'b'
      if (label === 'a') {
        // Candidate a commits its work early, so there is something for b to look for.
        await writeFiles(spec, ctx, { 'answer.txt': 'wrong' })
        await gitIn(spec.cwd, 'add', '-A')
        await gitIn(spec.cwd, '-c', 'user.name=a', '-c', 'user.email=a@example.com', 'commit', '-q', '-m', 'candidate a work')
        aHead = (await gitIn(spec.cwd, 'rev-parse', 'HEAD')).stdout.trim()
      } else {
        while (aHead === null) await ctx.sleep(20)
        // Everything an agent could ask Git: all branches, all remotes, and the other candidate's commit itself.
        seen['b'] = {
          branches: (await gitIn(spec.cwd, 'branch', '-a', '--format=%(refname)')).stdout,
          remotes: (await gitIn(spec.cwd, 'remote', '-v')).stdout,
          otherCommitVisible: (await gitIn(spec.cwd, 'cat-file', '-e', `${aHead}^{commit}`)).exitCode === 0,
        }
        await writeFiles(spec, ctx, { 'answer.txt': 'right' })
      }
      // Both wait for the user's instruction, which must reach each of them.
      while (!release) {
        await ctx.sleep(20)
        if (ctx.signal.aborted) return
      }
      const message = await ctx.nextMessage()
      if (message) instructions[label]!.push(message)
      await ctx.completeTurn({ text: `Candidate ${label} finished` })
    }
    h = await createHarness({ script: scriptsByRole({ worker, reviewer, verifier }), files: { 'check.mjs': CHECK_SCRIPT }, commands: { test: 'node check.mjs' } })
    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Answer', strategy: 'SPECULATIVE' })
    await h.waitFor(() => seen['b'] !== undefined, 'candidate b to have inspected its repository')
    await h.orchestrator.instruct(h.task(run.id, 'implement').id, 'Use lower case.')
    release = true
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    // Candidate b's repository holds no branch, remote or object of candidate a.
    expect(seen['b']!.branches).not.toContain('-cand-a')
    // Its only branches are the project's checked-out branch and its own.
    expect(seen['b']!.branches.trim().split('\n').sort()).toEqual(['refs/heads/main', expect.stringMatching(/-cand-b$/)])
    expect(seen['b']!.remotes.trim()).toBe('')
    expect(seen['b']!.otherCommitVisible).toBe(false)
    // The same instruction reached both candidates.
    expect(instructions['a']!.join(' ')).toContain('Use lower case.')
    expect(instructions['b']!.join(' ')).toContain('Use lower case.')
    // No candidate branch ever existed in the user's repository.
    expect(await git(h.repoDir, 'branch', '--list', 'nexus/*-cand-*')).toBe('')
  })

  it('SPECULATIVE: a pause after the LAST candidate finished still runs the tournament (never checks the empty task worktree)', async () => {
    let stall = true
    const stalled = new Set<string>()
    const worker: FakeScript = async (spec, ctx) => {
      const label = candidateOf(spec.cwd)
      // The inverse of the previous scenario: the candidate created first is the one still working.
      if (label === 'a' && stall) {
        stalled.add('a')
        await ctx.sleep(120_000)
        if (ctx.signal.aborted) return
      }
      await writeFiles(spec, ctx, { 'answer.txt': label === 'a' ? 'wrong' : 'right' })
      await ctx.completeTurn({ text: `Candidate ${label ?? '?'} finished` })
    }
    h = await createHarness({ script: scriptsByRole({ worker, reviewer, verifier }), files: { 'check.mjs': CHECK_SCRIPT }, commands: { test: 'node check.mjs' } })
    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Answer', strategy: 'SPECULATIVE' })
    await h.waitFor(() => stalled.has('a'), 'candidate a to be working')
    await h.waitFor(() => h.repos.candidateResults.listByRun(run.id).some((c) => c.label === 'b' && c.headCommit !== null), 'candidate b to finish')
    await h.orchestrator.pauseRun(run.id)
    expect(h.pipelineStage(h.task(run.id, 'implement'))).toBe('implement')

    stall = false
    await h.orchestrator.resumeRun(run.id)
    const done = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')
    const [spec] = h.repos.speculativeRuns.listByRun(run.id)
    expect(spec?.state).toBe('adopted')
    expect(h.repos.tournamentDecisions.getBySpeculativeRun(spec!.id)).toMatchObject({ winnerLabel: 'b', confidence: 'decisive' })
    // No repair was needed: the checks never ran on an empty worktree.
    expect(h.repos.tasks.listByRun(run.id).filter((t) => t.parentTaskId !== null)).toEqual([])
    expect(readFileSync(join(h.integration(run.id).path, 'answer.txt'), 'utf8').trim()).toBe('right')
    for (const c of h.repos.candidateResults.listBySpeculativeRun(spec!.id)) expect(existsSync(c.worktreePath)).toBe(false)
  })

  it('SPECULATIVE: a restart after the tournament but before adoption adopts the stored winner', async () => {
    const worker: FakeScript = async (spec, ctx) => {
      await writeFiles(spec, ctx, { 'answer.txt': candidateOf(spec.cwd) === 'a' ? 'wrong' : 'right' })
      await ctx.completeTurn({ text: 'finished' })
    }
    const script = scriptsByRole({ worker, reviewer: async (_s, ctx) => ctx.sleep(120_000), verifier })
    h = await createHarness({ script, files: { 'check.mjs': CHECK_SCRIPT }, commands: { test: 'node check.mjs' } })
    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Answer', strategy: 'SPECULATIVE' })
    await h.waitFor(() => h.repos.speculativeRuns.listByRun(run.id)[0]?.state === 'adopted', 'the winner to be adopted')
    await h.orchestrator.pauseRun(run.id)
    const [spec] = h.repos.speculativeRuns.listByRun(run.id)
    const winner = h.repos.candidateResults.get(spec!.winnerCandidateId!)!
    // Put the durable state back to "decided, not yet adopted", as a crash right after the tournament leaves it:
    // the task worktree at its base commit, the winner's repository still there.
    const task = h.task(run.id, 'implement')
    const worktree = h.repos.worktrees.get(task.worktreeId!)!
    await git(worktree.path, 'reset', '--hard', spec!.baseCommit)
    h.repos.speculativeRuns.update(spec!.id, { state: 'decided', finishedAt: null })
    await git(h.repoDir, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', h.repoDir, winner.worktreePath)
    await git(winner.worktreePath, 'checkout', '--quiet', '-B', winner.branch, spec!.baseCommit)
    await writeFile(join(winner.worktreePath, 'answer.txt'), 'right\n')
    await git(winner.worktreePath, 'add', '-A')
    await git(winner.worktreePath, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'winner')
    h.repos.candidateResults.update(winner.id, { headCommit: await git(winner.worktreePath, 'rev-parse', 'HEAD'), cleanedAt: null })

    h = await h.restart(scriptsByRole({ worker, reviewer, verifier }))
    h.orchestrator.recoverOnStartup()
    await h.orchestrator.recover(run.id, 'resume')
    expect((await h.waitForState(run.id, ['completed', 'failed'])).state).toBe('completed')
    expect(h.repos.speculativeRuns.listByRun(run.id).map((s) => s.state)).toEqual(['adopted'])
    // The stored winner was adopted; no candidate was run again and nothing was re-implemented.
    expect(h.runtime.sessions.filter((s) => s.role === 'worker')).toEqual([])
    expect(readFileSync(join(h.integration(run.id).path, 'answer.txt'), 'utf8').trim()).toBe('right')
    expect(existsSync(winner.worktreePath)).toBe(false)
  })

  it('SPECULATIVE: cancelling the run removes the candidate repositories', async () => {
    const started = new Set<string>()
    const worker: FakeScript = async (spec, ctx) => {
      started.add(candidateOf(spec.cwd) ?? '?')
      await ctx.sleep(120_000)
    }
    h = await createHarness({ script: scriptsByRole({ worker, reviewer, verifier }) })
    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Answer', strategy: 'SPECULATIVE' })
    await h.waitFor(() => started.size === 2, 'both candidates to be working')
    const paths = h.repos.candidateResults.listByRun(run.id).map((c) => c.worktreePath)
    expect(paths.every((p) => existsSync(p))).toBe(true)
    await h.orchestrator.cancelRun(run.id)
    await h.orchestrator.idle(run.id)
    expect(paths.some((p) => existsSync(p))).toBe(false)
    expect(h.repos.speculativeRuns.listByRun(run.id).map((s) => s.state)).toEqual(['cancelled'])
    expect(h.repos.candidateResults.listByRun(run.id).every((c) => c.cleanedAt !== null)).toBe(true)
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
