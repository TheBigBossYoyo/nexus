import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completeWith, scriptsByRole, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { approvedReview, createHarness, fileWorker, git, passedVerification, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

const validPlan = plan([plannedTask('alpha')])

describe('scenario: planning, validation and plan approval', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  const invalidPlans: Record<string, unknown> = {
    'a dependency cycle': plan([plannedTask('a', { dependencies: ['b'] }), plannedTask('b', { dependencies: ['a'] })]),
    'an unknown dependency': plan([plannedTask('a', { dependencies: ['ghost'] })]),
    'a schema violation': { summary: 'No tasks and no criteria', tasks: 'many' },
  }

  for (const [name, bad] of Object.entries(invalidPlans)) {
    it(`rejects ${name} and repairs it on the next planner attempt`, async () => {
      h = await createHarness({ script: scenarioScript({ plan: (attempt) => (attempt === 0 ? bad : validPlan) }) })
      const run = await h.startRun()
      expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

      const invalid = h.eventsOfType(run.id, 'plan.invalid')
      expect(invalid).toHaveLength(1)
      expect(invalid[0]?.payload.attempt).toBe(1)
      const errors = invalid[0]?.payload.errors ?? []
      expect(errors.length).toBeGreaterThan(0)

      const planners = sessionsOf(h, 'planner')
      expect(planners).toHaveLength(2)
      // The second planner prompt carries the exact reasons the first plan was rejected.
      expect(planners[0]?.prompt).not.toContain('previous plan was rejected')
      expect(planners[1]?.prompt).toContain('previous plan was rejected')
      for (const error of errors) expect(planners[1]?.prompt).toContain(error)

      // Only the valid plan produced tasks.
      expect(h.repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['alpha'])
      expect(h.eventsOfType(run.id, 'plan.proposed')).toHaveLength(1)
    })
  }

  it('fails the run after three invalid plans without creating any task', async () => {
    h = await createHarness({ script: scenarioScript({ plan: () => invalidPlans['an unknown dependency'] }) })
    const run = await h.startRun()
    const failed = await h.waitForState(run.id, 'failed')
    expect(failed.error).toContain('did not produce a valid plan after 3 attempts')
    expect(sessionsOf(h, 'planner')).toHaveLength(3)
    expect(h.eventsOfType(run.id, 'plan.invalid').map((e) => e.payload.attempt)).toEqual([1, 2, 3])
    expect(h.repos.tasks.listByRun(run.id)).toHaveLength(0)
    expect(h.eventsOfType(run.id, 'run.failed')).toHaveLength(1)
    expect(sessionsOf(h, 'worker')).toHaveLength(0)
  })

  it('a planner that fails to produce structured output is retried and then fails the run', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: validPlan }),
    })
    h.runtime.script = async (spec, ctx) => {
      if (spec.role === 'planner') await ctx.completeTurn({ text: 'no plan for you', outcome: 'structured_output_failed' })
    }
    const run = await h.startRun()
    const failed = await h.waitForState(run.id, 'failed')
    expect(failed.error).toContain('did not produce a valid plan')
    expect(sessionsOf(h, 'planner')).toHaveLength(3)
  })

  it('with plan approval required the run waits, and approvePlan starts execution', async () => {
    h = await createHarness({ script: scenarioScript({ plan: validPlan }) })
    const run = await h.startRun({ overrides: { requirePlanApproval: true } })
    await h.waitForState(run.id, 'awaiting_approval')

    const pending = h.repos.approvals.listPending(run.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ kind: 'plan', status: 'pending', taskId: null })
    // Tasks exist as drafts but nothing has started.
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.state)).toEqual(['draft'])
    expect(sessionsOf(h, 'worker')).toHaveLength(0)
    // No task has a worktree. The run's own snapshot exists since 0.7.2: the planner read it, not the user's
    // checkout, so that the plan describes the commit the workers will execute.
    const worktrees = h.repos.worktrees.listByRun(run.id)
    expect(worktrees.filter((w) => w.taskId !== null)).toHaveLength(0)
    expect(worktrees.map((w) => w.taskId)).toEqual([null])
    const planner = sessionsOf(h, 'planner')[0]!
    expect(planner.cwd).toBe(worktrees[0]!.path)
    expect(planner.cwd).not.toBe(h.repoDir)
    expect(await git(worktrees[0]!.path, 'rev-parse', 'HEAD')).toBe(h.repos.runs.require(run.id).baseCommit)
    // The user's checkout was not touched by it.
    expect(await git(h.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(await git(h.repoDir, 'status', '--porcelain')).toBe('')

    await h.orchestrator.approvePlan(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.repos.approvals.listByRun(run.id).map((a) => [a.kind, a.status])).toEqual([['plan', 'approved']])
    expect(h.eventsOfType(run.id, 'plan.approved')).toHaveLength(1)
  })

  it('denying the plan approval cancels the run before any work starts', async () => {
    h = await createHarness({ script: scenarioScript({ plan: validPlan }) })
    const run = await h.startRun({ overrides: { requirePlanApproval: true } })
    await h.waitForState(run.id, 'awaiting_approval')
    const approval = h.repos.approvals.listPending(run.id)[0]
    h.orchestrator.resolveApproval(approval?.id ?? '', false, 'not what I asked for')

    await h.waitFor(() => h.repos.runs.require(run.id).state === 'cancelled', 'run to be cancelled')
    await h.orchestrator.idle(run.id)
    expect(h.repos.approvals.require(approval?.id ?? '')).toMatchObject({ status: 'denied', note: 'not what I asked for' })
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.state)).toEqual(['cancelled'])
    expect(sessionsOf(h, 'worker')).toHaveLength(0)
  })

  it('replan regenerates the tasks from user feedback and expires the old approval', async () => {
    h = await createHarness({
      script: scenarioScript({
        plan: (attempt) => (attempt === 0 ? validPlan : plan([plannedTask('beta'), plannedTask('gamma', { dependencies: ['beta'] })])),
      }),
    })
    const run = await h.startRun({ overrides: { requirePlanApproval: true } })
    await h.waitForState(run.id, 'awaiting_approval')
    const firstApproval = h.repos.approvals.listPending(run.id)[0]
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['alpha'])

    await h.orchestrator.replan(run.id, 'Split it in two steps')
    await h.waitFor(
      () => h.repos.runs.require(run.id).state === 'awaiting_approval' && h.repos.tasks.listByRun(run.id).length === 2,
      'the revised plan',
    )
    await h.orchestrator.idle(run.id)

    expect(h.repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['beta', 'gamma'])
    expect(h.repos.approvals.require(firstApproval?.id ?? '').status).toBe('expired')
    const pending = h.repos.approvals.listPending(run.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).not.toBe(firstApproval?.id)
    expect(h.eventsOfType(run.id, 'plan.rejected')[0]?.payload.feedback).toBe('Split it in two steps')
    // The planner saw the feedback and the previous plan.
    const revision = sessionsOf(h, 'planner')[1]
    expect(revision?.prompt).toContain('Split it in two steps')
    expect(revision?.prompt).toContain('alpha')
    // Criteria were regenerated rather than duplicated.
    expect(h.repos.criteria.listByRun(run.id).filter((c) => c.taskId === null)).toHaveLength(1)

    await h.orchestrator.approvePlan(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.state)).toEqual(['completed', 'completed'])
  })

  it('a task marked requiresApproval waits for its own approval while other tasks proceed', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('safe'), plannedTask('risky', { requiresApproval: true, risk: 'high' })]) }),
    })
    const run = await h.startRun()
    await h.waitFor(() => h.repos.tasks.listByRun(run.id).some((t) => t.key === 'safe' && t.state === 'completed'), 'safe to complete')
    await h.waitFor(() => h.repos.approvals.listPending(run.id).length === 1, 'the task approval')
    await h.orchestrator.idle(run.id)

    const approval = h.repos.approvals.listPending(run.id)[0]
    expect(approval).toMatchObject({ kind: 'task', taskId: h.task(run.id, 'risky').id, risk: 'high' })
    expect(h.task(run.id, 'risky').state).toBe('ready')
    expect(h.repos.runs.require(run.id).state).toBe('executing')
    expect(sessionsOf(h, 'worker')).toHaveLength(1)

    h.orchestrator.resolveApproval(approval?.id ?? '', true)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.task(run.id, 'risky')).toMatchObject({ state: 'completed', approvalGranted: true })
    // Asked once only.
    expect(h.repos.approvals.listByRun(run.id)).toHaveLength(1)
  })

  it('denying a task approval cancels that task and nothing else', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('safe'), plannedTask('risky', { requiresApproval: true })]) }),
    })
    const run = await h.startRun()
    await h.waitFor(() => h.repos.approvals.listPending(run.id).length === 1, 'the task approval')
    h.orchestrator.resolveApproval(h.repos.approvals.listPending(run.id)[0]?.id ?? '', false)
    await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(h.task(run.id, 'risky').state).toBe('cancelled')
    expect(h.task(run.id, 'safe').state).toBe('completed')
    expect(sessionsOf(h, 'worker')).toHaveLength(1)
  })
})

describe('scenario: AUDIT and ASK modes are read-only', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('AUDIT rejects plans with writing roles and runs the read-only plan without worktrees', async () => {
    const auditPlan = plan([
      plannedTask('scan-api', { role: 'researcher', suggestedFiles: [], acceptanceCriteria: [] }),
      plannedTask('scan-ui', { role: 'researcher', suggestedFiles: [], acceptanceCriteria: [] }),
      plannedTask('report', { role: 'researcher', dependencies: ['scan-api', 'scan-ui'], suggestedFiles: [], acceptanceCriteria: [] }),
    ])
    h = await createHarness({
      script: scenarioScript({
        plan: (attempt) => (attempt === 0 ? plan([plannedTask('fix-everything')]) : auditPlan),
        researcher: completeWith({ text: 'Findings: nothing alarming.' }),
      }),
    })
    const headBefore = await git(h.repoDir, 'rev-parse', 'HEAD')
    const run = await h.startRun({ mode: 'audit', prompt: 'Audit the code base' })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const invalid = h.eventsOfType(run.id, 'plan.invalid')
    expect(invalid).toHaveLength(1)
    expect(invalid[0]?.payload.errors.join(' ')).toContain('AUDIT mode is read-only')

    const tasks = h.repos.tasks.listByRun(run.id)
    expect(tasks.map((t) => [t.key, t.kind, t.state])).toEqual([
      ['scan-api', 'audit', 'completed'],
      ['scan-ui', 'audit', 'completed'],
      ['report', 'synthesis', 'completed'],
    ])
    // No worktree, no integration branch, no writes anywhere.
    expect(h.repos.worktrees.listByRun(run.id)).toHaveLength(0)
    expect(h.repos.runs.require(run.id).integrationBranch).toBeNull()
    expect(await readdir(h.worktreesDir).catch(() => [])).toEqual([])
    expect(await git(h.repoDir, 'branch', '--format=%(refname:short)')).toBe('main')
    expect(await git(h.repoDir, 'rev-parse', 'HEAD')).toBe(headBefore)
    for (const s of sessionsOf(h, 'researcher')) {
      expect(s.cwd).toBe(h.repoDir)
      expect(s.tools).not.toContain('Write')
      expect(s.tools).not.toContain('Edit')
    }
    expect(sessionsOf(h, 'worker')).toHaveLength(0)
    expect(sessionsOf(h, 'reviewer')).toHaveLength(0)
    expect(h.repos.artifacts.listByRun(run.id).filter((a) => a.kind === 'report')).toHaveLength(3)
  })

  // 0.9.1: the owner's first audit of an enrolled project had every shell command refused: its sessions worked in
  // the user's checkout, which the sandbox account cannot reach.
  it('AUDIT of a contained project reads a snapshot inside the worktrees of NEXUS, runs no final checks and removes it', async () => {
    const auditPlan = plan([
      plannedTask('scan', { role: 'researcher', suggestedFiles: [], acceptanceCriteria: [] }),
      plannedTask('report', { role: 'researcher', dependencies: ['scan'], suggestedFiles: [], acceptanceCriteria: [] }),
    ])
    h = await createHarness({
      script: scenarioScript({ plan: auditPlan, researcher: completeWith({ text: 'Findings: none.' }) }),
      commands: { test: 'node -e "process.exit(1)"' },
      execution: { shellFor: () => undefined, runProjectCommand: async () => null, contained: () => true },
    })
    const headBefore = await git(h.repoDir, 'rev-parse', 'HEAD')
    const run = await h.startRun({ mode: 'audit', prompt: 'Audit the code base' })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const sessions = [...sessionsOf(h, 'planner'), ...sessionsOf(h, 'researcher')]
    expect(sessions.length).toBeGreaterThanOrEqual(3)
    for (const s of sessions) expect(s.cwd.toLowerCase().startsWith(h.worktreesDir.toLowerCase())).toBe(true)
    // The failing test command was never run: there is nothing to check in a snapshot.
    expect(h.eventsOfType(run.id, 'checks.completed')).toHaveLength(0)
    expect(await git(h.repoDir, 'rev-parse', 'HEAD')).toBe(headBefore)
    // The snapshot and its branch go when the mission ends.
    for (let i = 0; i < 100 && h.repos.worktrees.listByRun(run.id).some((w) => w.state !== 'removed'); i++) await new Promise((r) => setTimeout(r, 100))
    expect(h.repos.worktrees.listByRun(run.id).every((w) => w.state === 'removed')).toBe(true)
    for (let i = 0; i < 50 && (await git(h.repoDir, 'branch', '--format=%(refname:short)')) !== 'main'; i++) await new Promise((r) => setTimeout(r, 100))
    expect(await git(h.repoDir, 'branch', '--format=%(refname:short)')).toBe('main')
  })

  it('AUDIT also rejects a user-added writing task', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('scan', { role: 'researcher', suggestedFiles: [], acceptanceCriteria: [] })]) }) })
    const run = await h.startRun({ mode: 'audit' })
    await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(() =>
      h.orchestrator.addTask({
        runId: run.id,
        title: 'Fix it',
        description: 'Fix it',
        role: 'worker',
        dependsOn: [],
        suggestedFiles: [],
        acceptanceCriteria: ['fixed'],
        complexity: 'small',
      }),
    ).toThrow(/read-only|completed/)
  })

  it('ASK runs a single read-only session without a planner, a worktree or a branch', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: validPlan, researcher: completeWith({ text: 'It is a tiny scenario repo.' }) }),
    })
    const run = await h.startRun({ mode: 'ask', prompt: 'What is this repository?' })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    expect(h.runtime.sessions).toHaveLength(1)
    expect(sessionsOf(h, 'planner')).toHaveLength(0)
    const session = sessionsOf(h, 'researcher')[0]
    expect(session?.cwd).toBe(h.repoDir)
    expect(session?.tools).not.toContain('Write')
    expect(session?.prompt).toContain('What is this repository?')
    expect(h.repos.worktrees.listByRun(run.id)).toHaveLength(0)
    expect(await git(h.repoDir, 'branch', '--format=%(refname:short)')).toBe('main')
    const tasks = h.repos.tasks.listByRun(run.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ kind: 'ask', role: 'researcher', state: 'completed', resultSummary: 'It is a tiny scenario repo.' })
  })

  it('the planner reads the commit the run executes, also when the user checkout moves while it plans', async () => {
    let seen: { cwd: string; shared: string; extra: boolean } | null = null
    const planner: FakeScript = async (spec, ctx) => {
      // The user goes on working in their checkout while the run plans: a new commit and an uncommitted file.
      await writeFile(join(h.repoDir, 'shared.txt'), 'line 1 changed by the user\n')
      await git(h.repoDir, 'commit', '-qam', 'user work during planning')
      await writeFile(join(h.repoDir, 'uncommitted.txt'), 'not part of any commit\n')
      seen = { cwd: spec.cwd, shared: await readFile(join(spec.cwd, 'shared.txt'), 'utf8'), extra: existsSync(join(spec.cwd, 'uncommitted.txt')) }
      await ctx.completeTurn({ text: 'plan', structuredOutput: validPlan })
    }
    h = await createHarness({ script: scriptsByRole({ planner, worker: fileWorker, reviewer: completeWith({ text: 'review', structuredOutput: approvedReview }), verifier: completeWith({ text: 'verify', structuredOutput: passedVerification }) }) })
    const base = await git(h.repoDir, 'rev-parse', 'HEAD')
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.repos.runs.require(run.id).baseCommit).toBe(base)
    // What the planner saw is the base commit: the same state every worker's worktree starts from.
    expect(seen).not.toBeNull()
    expect(seen!.shared.trim()).toBe('line 1')
    expect(seen!.extra).toBe(false)
    expect(seen!.cwd).not.toBe(h.repoDir)
    // And the user's work is where they left it.
    expect((await readFile(join(h.repoDir, 'shared.txt'), 'utf8')).trim()).toBe('line 1 changed by the user')
    expect(existsSync(join(h.repoDir, 'uncommitted.txt'))).toBe(true)
  })
})
