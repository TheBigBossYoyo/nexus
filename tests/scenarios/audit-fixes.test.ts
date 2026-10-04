import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphProposal } from '@shared/v2'
import { newId, nowIso } from '@shared/ids'
import type { FakeScript, FakeSessionContext } from '@main/modules/agent-runtime/fake-runtime'
import { MAX_APPLIED_PROPOSALS_PER_RUN, MAX_PROPOSALS_PER_AGENT, MAX_PROPOSED_TASKS_PER_RUN } from '@main/modules/orchestrator/graph-service'
import { createHarness, fileWorker, git, keyOf, passedVerification, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

function newTask(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    title: `Task ${key}`,
    description: `Implement ${key}`,
    role: 'worker',
    dependencies: [],
    suggestedFiles: [`${key}.txt`],
    acceptanceCriteria: [`${key}.txt exists`],
    complexity: 'small',
    risk: 'low',
    ...over,
  }
}

function proposal(type: string, changes: Record<string, unknown>): Record<string, unknown> {
  return { type, reason: `Because ${type} is needed`, evidence: 'Observed in the repository', changes }
}

async function propose(ctx: FakeSessionContext, input: unknown): Promise<string> {
  const tool = ctx.nexusTools?.proposeGraphChange
  if (!tool) throw new Error('propose_graph_change is not exposed to this session')
  return tool(input)
}

async function until(ctx: FakeSessionContext, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 3000 && !predicate() && !ctx.signal.aborted; i++) await ctx.sleep(10)
}

function seq(h: Harness, runId: string, type: string, taskKey: string, which: 'first' | 'last' = 'first'): number {
  const task = h.task(runId, taskKey)
  const events = h.repos.events.listByRun(runId, 0, 100_000).filter((e) => e.type === type && e.taskId === task.id)
  const event = which === 'first' ? events[0] : events.at(-1)
  if (!event) throw new Error(`No ${type} event for ${taskKey}`)
  return event.seq
}

/** State of the task, undefined while it does not exist yet (tasks are created once planning ends). */
function stateOf(h: Harness, runId: string, key: string): string | undefined {
  return h.repos.tasks.listByRun(runId).find((t) => t.key === key)?.state
}

const FOUR_TASKS = ['n1', 'n2', 'n3', 'n4'].map((k) => newTask(k))

describe('audit fixes: graph approvals outlive the proposer', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  /** `a` proposes four tasks (needs approval) and ends its turn at once; `hold` keeps the run alive until released. */
  async function startProposerThatFinishes(): Promise<{ runId: string; release: () => void }> {
    let released = false
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'a') await propose(ctx, proposal('ADD_TASK', { tasks: FOUR_TASKS }))
      if (keyOf(spec) === 'hold') await until(ctx, () => released)
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a'), plannedTask('hold')]), worker }) })
    const run = await h.startRun()
    await h.waitFor(() => h.repos.approvals.listPending(run.id).some((a) => a.kind === 'graph'), 'the graph approval')
    // The proposer's turn ends, its pipeline completes and its agent finishes while the approval is pending.
    await h.waitFor(() => stateOf(h, run.id, 'a') === 'completed', 'the proposer to complete')
    return { runId: run.id, release: () => (released = true) }
  }

  it('the approval is still answerable after the proposer finished; approving applies the proposal', async () => {
    const { runId, release } = await startProposerThatFinishes()
    const approval = h.repos.approvals.listPending(runId).find((a) => a.kind === 'graph')
    expect(approval?.status).toBe('pending')
    expect(h.repos.graphProposals.listByRun(runId)[0]?.status).toBe('awaiting_approval')

    h.orchestrator.resolveApproval(approval?.id ?? '', true)
    expect(h.repos.graphProposals.listByRun(runId)[0]?.status).toBe('applied')
    expect(h.repos.tasks.listByRun(runId).map((t) => t.key)).toEqual(expect.arrayContaining(['n1', 'n2', 'n3', 'n4']))
    expect(h.repos.settings.getValue(`graph-approval:${approval?.id}`)).toBeNull()

    release()
    expect((await h.waitForState(runId, ['completed', 'failed', 'paused'])).state).toBe('completed')
    for (const key of ['n1', 'n2', 'n3', 'n4']) expect(h.task(runId, key).state).toBe('completed')
  })

  it('denying it after the proposer finished rejects the proposal and removes its settings key', async () => {
    const { runId, release } = await startProposerThatFinishes()
    const approval = h.repos.approvals.listPending(runId).find((a) => a.kind === 'graph')
    h.orchestrator.resolveApproval(approval?.id ?? '', false, 'not now')
    expect(h.repos.graphProposals.listByRun(runId)[0]).toMatchObject({ status: 'rejected' })
    expect(h.repos.graphProposals.listByRun(runId)[0]?.rejectionReason).toContain('not now')
    expect(h.repos.settings.getValue(`graph-approval:${approval?.id}`)).toBeNull()
    expect(h.repos.tasks.listByRun(runId).map((t) => t.key)).toEqual(['a', 'hold'])
    release()
    expect((await h.waitForState(runId, ['completed', 'failed', 'paused'])).state).toBe('completed')
  })

  it('cancelling the run while the approval is pending rejects the proposal with a reason and deletes the key', async () => {
    const { runId } = await startProposerThatFinishes()
    const approval = h.repos.approvals.listPending(runId).find((a) => a.kind === 'graph')
    await h.orchestrator.cancelRun(runId)
    const row = h.repos.graphProposals.listByRun(runId)[0]
    expect(row?.status).toBe('rejected')
    expect(row?.rejectionReason).toMatch(/cancelled/)
    expect(h.repos.approvals.require(approval?.id ?? '').status).toBe('expired')
    expect(h.repos.settings.getValue(`graph-approval:${approval?.id}`)).toBeNull()
  })

  it('a tool approval still expires with its agent (only graph approvals outlive it)', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a')]) }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const agent = h.repos.agents.listByRun(run.id)[0]
    const tool = h.orchestrator.core.approvals.create({ runId: run.id, taskId: null, agentId: agent?.id ?? null, kind: 'tool', action: 'x', reason: 'x', command: null, requestedBy: 'x', risk: 'low' })
    const graphApproval = h.orchestrator.core.approvals.create({ runId: run.id, taskId: null, agentId: agent?.id ?? null, kind: 'graph', action: 'y', reason: 'y', command: null, requestedBy: 'y', risk: 'low' })
    expect(h.orchestrator.core.approvals.expire({ runId: run.id, agentId: agent?.id ?? '', kind: 'tool' })).toBe(1)
    expect(h.repos.approvals.require(tool.id).status).toBe('expired')
    expect(h.repos.approvals.require(graphApproval.id).status).toBe('pending')
  })
})

describe('audit fixes: proposal limits and modes', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('H4: a writing proposal is applied in a mission run (only ASK and AUDIT are read-only)', async () => {
    const replies: string[] = []
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'a') replies.push(await propose(ctx, proposal('ADD_TASK', { tasks: [newTask('extra')] })))
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a')]), worker }) })
    const run = await h.startRun({ mode: 'mission' })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(replies[0]).toMatch(/Applied as plan v2/)
    expect(h.repos.graphProposals.listByRun(run.id)[0]?.status).toBe('applied')
    expect(h.task(run.id, 'extra')).toMatchObject({ state: 'completed', role: 'worker' })
  })

  function seedApplied(runId: string, count: number, tasksEach: number): void {
    for (let i = 0; i < count; i++) {
      const tasks = Array.from({ length: tasksEach }, (_, k) => newTask(`seed-${i}-${k}`))
      h.repos.graphProposals.insert({
        id: newId(),
        runId,
        proposedByAgentId: null,
        proposedBy: 'seed',
        taskId: null,
        type: 'ADD_TASK',
        reason: 'seed',
        evidence: 'seed',
        changes: { tasks, targetTask: null, dependsOn: null, blocksProposer: false, priority: null },
        status: 'applied',
        rejectionReason: null,
        revisionId: null,
        createdAt: nowIso(),
        resolvedAt: nowIso(),
      } as GraphProposal)
    }
  }

  async function runWithSeed(applied: number, tasksEach: number, propose1: Record<string, unknown>): Promise<{ runId: string; reply: string }> {
    let reply = ''
    let runIdSeen = ''
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'a') {
        seedApplied(runIdSeen, applied, tasksEach)
        reply = await propose(ctx, proposal('ADD_TASK', propose1))
        // Keep the proposal from racing the end of the run: it is decided by the test.
        await until(ctx, () => h.repos.approvals.listPending(runIdSeen).some((a) => a.kind === 'graph') || /Applied/.test(reply))
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a')]), worker }) })
    const run = await h.startRun()
    runIdSeen = run.id
    await h.waitFor(() => reply !== '', 'the proposal reply')
    return { runId: run.id, reply }
  }

  it('H5: past the run-wide applied-proposal limit, a task-adding proposal needs approval instead of applying', async () => {
    const { runId, reply } = await runWithSeed(MAX_APPLIED_PROPOSALS_PER_RUN, 0, { tasks: [newTask('one')] })
    expect(reply).toMatch(/Awaiting user approval/)
    expect(reply).toMatch(new RegExp(`already applied ${MAX_APPLIED_PROPOSALS_PER_RUN} proposals`))
    const approval = h.repos.approvals.listPending(runId).find((a) => a.kind === 'graph')
    expect(approval?.command).toContain('Approval needed')
    h.orchestrator.resolveApproval(approval?.id ?? '', true)
    expect(h.task(runId, 'one').key).toBe('one')
    await h.waitForState(runId, ['completed', 'failed', 'paused'])
  })

  it('H5: past the run-wide task limit approval is needed; under it the proposal still applies', async () => {
    const over = await runWithSeed(5, 5, { tasks: [newTask('one')] }) // 25 tasks already added by proposals
    expect(over.reply).toMatch(/Awaiting user approval/)
    expect(over.reply).toMatch(new RegExp(`limit of ${MAX_PROPOSED_TASKS_PER_RUN}`))
    await h.dispose()
    const under = await runWithSeed(4, 6, { tasks: [newTask('one')] }) // 24 + 1 = 25: allowed
    expect(under.reply).toMatch(/Applied as plan/)
    await h.waitForState(under.runId, ['completed', 'failed', 'paused'])
  })

  it('H5: the per-proposer limit is keyed on the task, so a new agent for the same task does not reset it', async () => {
    let release = false
    const worker: FakeScript = async (spec, ctx) => {
      await until(ctx, () => release)
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('t')]), worker }) })
    const run = await h.startRun()
    await h.waitFor(() => stateOf(h, run.id, 't') === 'running', 't to run')
    const taskId = h.task(run.id, 't').id
    const results: string[] = []
    for (let i = 0; i <= MAX_PROPOSALS_PER_AGENT; i++) {
      // Every call comes from a different agent (as after a retry or resume) of the same task.
      const r = h.orchestrator.core.graph.propose(h.repos.runs.require(run.id), { agentId: `agent-${i}`, label: 'Worker', taskId }, proposal('REPRIORITIZE', { targetTask: 't', priority: i + 1 }))
      results.push(r.message)
    }
    expect(results.slice(0, MAX_PROPOSALS_PER_AGENT).every((m) => !/Rate limit/.test(m))).toBe(true)
    expect(results.at(-1)).toMatch(/Rate limit/)
    release = true
    await h.waitForState(run.id, ['completed', 'failed', 'paused'])
  })

  it('M1: reprioritising or rewiring another agent\'s task needs approval; the proposer\'s own does not', async () => {
    const replies: string[] = []
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'a') {
        replies.push(await propose(ctx, proposal('REPRIORITIZE', { targetTask: 'a', priority: 5 })))
        replies.push(await propose(ctx, proposal('REPRIORITIZE', { targetTask: 'c', priority: 9 })))
        await until(ctx, () => h.repos.approvals.listPending(h.repos.runs.listByState('executing')[0]?.id ?? '').length > 0)
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a'), plannedTask('c', { dependencies: ['a'] })]), worker }) })
    const run = await h.startRun()
    await h.waitFor(() => replies.length === 2, 'both replies')
    expect(replies[0]).toMatch(/Applied/)
    expect(replies[1]).toMatch(/Awaiting user approval \(changes the priority of 'c'/)
    expect(h.task(run.id, 'c').priority).toBe(0)
    h.orchestrator.resolveApproval(h.repos.approvals.listPending(run.id)[0]?.id ?? '', true)
    expect(h.task(run.id, 'c').priority).toBe(9)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
  })
})

describe('audit fixes: yielding, merging and finishing', () => {
  let h: Harness
  let restarted: Harness | undefined
  afterEach(async () => {
    await restarted?.dispose()
    restarted = undefined
    await h?.dispose()
  })

  it('M2: a task cancelled while it waits for the merge lock is not merged', async () => {
    let verifying = false
    let releaseVerifier = false
    const verifier: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'a') {
        verifying = true
        await until(ctx, () => releaseVerifier)
      }
      await ctx.completeTurn({ text: 'verify', structuredOutput: passedVerification })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a')]), verifier }) })
    const run = await h.startRun()
    await h.waitFor(() => verifying, 'a to be verified')
    let unlock: () => void = () => undefined
    const held = new Promise<void>((resolve) => (unlock = resolve))
    void h.orchestrator.withMergeLock(run.id, () => held)
    releaseVerifier = true
    // The pipeline now reaches the merge step and queues behind the held lock.
    await h.waitFor(() => h.repos.verifications.listByTask(h.task(run.id, 'a').id).some((v) => v.kind === 'verifier' && v.passed), 'a to pass verification')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await h.orchestrator.cancelTask(h.task(run.id, 'a').id)
    unlock()
    await h.waitForState(run.id, ['completed', 'failed', 'paused', 'cancelled'])
    expect(h.task(run.id, 'a').state).toBe('cancelled')
    expect(h.eventsOfType(run.id, 'git.merged').filter((e) => e.taskId === h.task(run.id, 'a').id)).toHaveLength(0)
    const files = (await git(h.integration(run.id).path, 'ls-files')).split('\n')
    expect(files).not.toContain('a.txt')
  })

  /** `main` adds `prereq` (blocking itself); `afterProposal` decides what it does before ending its turn. */
  function yieldingWorker(afterProposal: (ctx: FakeSessionContext, h: () => Harness, runId: () => string) => Promise<void>, calls: Map<string, number>, getRun: () => string): FakeScript {
    return async (spec, ctx) => {
      const key = keyOf(spec)
      const n = (calls.get(key) ?? 0) + 1
      calls.set(key, n)
      if (key === 'main' && n === 1) {
        await propose(ctx, proposal('ADD_TASK', { tasks: [newTask('prereq')], blocksProposer: true }))
        await afterProposal(ctx, () => h, getRun)
        if (ctx.signal.aborted) return
        await ctx.completeTurn({ text: 'Stopped: main needs prereq first' })
        return
      }
      if (key === 'prereq' && n === 1 && stall) {
        await ctx.sleep(120_000)
        if (ctx.signal.aborted) return
      }
      await fileWorker(spec, ctx)
    }
  }
  let stall = false

  it('M3: a running task with unmet prerequisites is queued, not relaunched, after pause and resume', async () => {
    stall = true
    const calls = new Map<string, number>()
    let runId = ''
    const worker = yieldingWorker(async (ctx) => ctx.sleep(120_000), calls, () => runId) // the turn outlives the pause
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('main')]), worker }) })
    const run = await h.startRun()
    runId = run.id
    await h.waitFor(() => (calls.get('prereq') ?? 0) >= 1 && h.repos.graphProposals.listByRun(run.id).some((p) => p.status === 'applied'), 'the proposal and prereq to start')
    expect(h.task(run.id, 'main').state).toBe('running')
    await h.orchestrator.pauseRun(run.id)
    stall = false
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    // main did not restart until prereq was merged, and then it resumed on the updated integration branch.
    expect(seq(h, run.id, 'task.started', 'main', 'last')).toBeGreaterThan(seq(h, run.id, 'git.merged', 'prereq'))
    const resumed = sessionsOf(h, 'worker').filter((s) => keyOf(s) === 'main').at(-1)
    expect(resumed?.prompt).toContain('Resuming after a prerequisite')
    expect(h.repos.settings.getValue(`graph-yield:${h.task(run.id, 'main').id}`)).toBeNull()
  })

  it('M3: the same after an application restart', async () => {
    stall = true
    const calls = new Map<string, number>()
    let runId = ''
    const worker = yieldingWorker(async (ctx) => ctx.sleep(120_000), calls, () => runId)
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('main')]), worker }) })
    const run = await h.startRun()
    runId = run.id
    await h.waitFor(() => (calls.get('prereq') ?? 0) >= 1 && h.repos.graphProposals.listByRun(run.id).some((p) => p.status === 'applied'), 'the proposal and prereq to start')
    stall = false
    restarted = await h.restart(scenarioScript({ plan: plan([plannedTask('main')]), worker: yieldingWorker(async () => undefined, new Map([['main', 1]]), () => runId) }))
    restarted.orchestrator.recoverOnStartup()
    await restarted.orchestrator.resumeRun(run.id)
    expect((await restarted.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(seq(restarted, run.id, 'task.started', 'main', 'last')).toBeGreaterThan(seq(restarted, run.id, 'git.merged', 'prereq'))
    expect(sessionsOf(restarted, 'worker').filter((s) => keyOf(s) === 'main').at(-1)?.prompt).toContain('Resuming after a prerequisite')
  })

  it('M4: a prerequisite that completed before the proposer\'s turn ended still yields, resuming on the updated branch', async () => {
    stall = false
    const calls = new Map<string, number>()
    let runId = ''
    const worker = yieldingWorker(
      async (ctx, hh, id) => until(ctx, () => hh().repos.tasks.listByRun(id()).find((t) => t.key === 'prereq')?.state === 'completed'),
      calls,
      () => runId,
    )
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('main')]), worker }) })
    const run = await h.startRun()
    runId = run.id
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const sessions = sessionsOf(h, 'worker').filter((s) => keyOf(s) === 'main')
    expect(sessions).toHaveLength(2)
    expect(sessions[1]?.prompt).toContain('Resuming after a prerequisite')
    // The attempt was not consumed by the yield, and no marker is left behind.
    expect(h.task(run.id, 'main').attempt).toBe(1)
    expect(h.repos.settings.getValue(`graph-yield:${h.task(run.id, 'main').id}`)).toBeNull()
    const files = (await git(h.integration(run.id).path, 'ls-files')).split('\n')
    expect(files).toEqual(expect.arrayContaining(['main.txt', 'prereq.txt']))
  })

  it('M5: a task added just before the run would complete is verified first', async () => {
    let added: string | null = null
    let runId = ''
    // No mission criteria: finalization goes from the diff straight to completion, the window the race needs.
    const worker: FakeScript = async (spec, ctx) => {
      for (const c of h.repos.criteria.listByRun(runId)) if (c.taskId === null) h.repos.criteria.delete(c.id)
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a')]), worker }) })
    const original = h.git.diff.bind(h.git)
    vi.spyOn(h.git, 'diff').mockImplementation(async (...args) => {
      // The only diff against the integration worktree is finalization's: the mission is being verified.
      if (added === null && runId !== '' && args[0] === h.integration(runId).path) {
        added = h.orchestrator.addTask({
          runId,
          title: 'Late work',
          description: 'Do late work',
          role: 'worker',
          dependsOn: [],
          suggestedFiles: [],
          acceptanceCriteria: ['user-task-1.txt exists'],
          complexity: 'small',
        }).id
      }
      return original(...args)
    })
    const run = await h.startRun()
    runId = run.id
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(added).not.toBeNull()
    const late = h.repos.tasks.require(added ?? '')
    expect(late.state).toBe('completed')
    expect(h.repos.verifications.listByTask(late.id).some((v) => v.kind === 'verifier' && v.passed)).toBe(true)
    expect(h.repos.events.listByRun(run.id, 0, 100_000).find((e) => e.type === 'run.completed')?.seq).toBeGreaterThan(seq(h, run.id, 'task.completed', 'user-task-1'))
  })

  it('M6: an ASK run paused during the facts refresh resumes without planning again', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('unused')]) }) })
    const original = h.git.run.bind(h.git)
    let slow = true
    vi.spyOn(h.git, 'run').mockImplementation(async (...args) => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 400))
      return original(...args)
    })
    const run = await h.startRun({ mode: 'ask', prompt: 'How does it work?' })
    await h.orchestrator.pauseRun(run.id)
    slow = false
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    expect(h.repos.tasks.listByRun(run.id)).toHaveLength(1)
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(h.repos.tasks.listByRun(run.id)).toHaveLength(1)
    expect(sessionsOf(h, 'planner')).toHaveLength(0)
  })

  it('M8: a task the user adds gets the kind the planner rule gives its role', async () => {
    let release = false
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'a') await until(ctx, () => release)
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a')]), worker }) })
    const run = await h.startRun()
    await h.waitFor(() => stateOf(h, run.id, 'a') === 'running', 'a to run')
    const base = { runId: run.id, description: 'd', dependsOn: [], suggestedFiles: [], acceptanceCriteria: ['c'], complexity: 'small' as const }
    const arch = h.orchestrator.addTask({ ...base, title: 'Design', role: 'architect' })
    const dbg = h.orchestrator.addTask({ ...base, title: 'Debug', role: 'debugger' })
    expect(arch.kind).toBe('design')
    expect(dbg.kind).toBe('repair')
    release = true
    await h.waitForState(run.id, ['completed', 'failed', 'paused'])
  })
})
