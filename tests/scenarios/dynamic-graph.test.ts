import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Run } from '@shared/domain'
import type { FakeScript, FakeSessionContext } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, fileWorker, git, keyOf, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

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

/** The agent-side call of the propose_graph_change tool. */
async function propose(ctx: FakeSessionContext, input: unknown): Promise<string> {
  const tool = ctx.nexusTools?.proposeGraphChange
  if (!tool) throw new Error('propose_graph_change is not exposed to this session')
  return tool(input)
}

/** Waits (polling) until the predicate holds or the session is stopped. */
async function until(ctx: FakeSessionContext, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 3000 && !predicate() && !ctx.signal.aborted; i++) await ctx.sleep(10)
}

/** Task keys, states, priorities and dependency edges of the run: what a proposal must leave alone when rejected. */
function graphOf(h: Harness, runId: string): string {
  const tasks = h.repos.tasks.listByRun(runId)
  const key = (id: string): string => tasks.find((t) => t.id === id)?.key ?? id
  return JSON.stringify({
    tasks: tasks.map((t) => [t.key, t.state, t.priority]),
    deps: h.repos.dependencies.listByRun(runId).map((d) => `${key(d.taskId)}>${key(d.dependsOnTaskId)}`).sort(),
  })
}

function eventSeq(h: Harness, runId: string, type: string, taskKey: string): number {
  const task = h.task(runId, taskKey)
  const event = h.repos.events.listByRun(runId, 0, 100_000).find((e) => e.type === type && e.taskId === task.id)
  if (!event) throw new Error(`No ${type} event for ${taskKey}`)
  return event.seq
}

describe('scenario: dynamic graph adaptation', () => {
  let h: Harness
  let restarted: Harness | undefined
  afterEach(async () => {
    await restarted?.dispose()
    restarted = undefined
    await h?.dispose()
  })

  async function finish(run: Run, states: Run['state'][] = ['completed', 'failed', 'paused']): Promise<Run> {
    return h.waitForState(run.id, states)
  }

  it('a worker adds a missing prerequisite, yields, and resumes in a worktree that contains the prerequisite', async () => {
    const replies: string[] = []
    const resumedWith: { sawPrereq: boolean; prompt: string }[] = []
    let proposed = false
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'main') {
        if (!proposed) {
          proposed = true
          replies.push(await propose(ctx, proposal('ADD_TASK', { tasks: [newTask('prereq')], blocksProposer: true })))
          await ctx.completeTurn({ text: 'Stopped: main needs prereq first' })
          return
        }
        resumedWith.push({ sawPrereq: existsSync(join(spec.cwd, 'prereq.txt')), prompt: spec.prompt })
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('main'), plannedTask('after', { dependencies: ['main'] })]), worker }) })
    const run = await h.startRun()
    expect((await finish(run)).state).toBe('completed')

    // The graph expanded: version 1 is the plan, version 2 the proposal.
    const revisions = h.repos.graphRevisions.listByRun(run.id)
    expect(revisions.map((r) => r.version)).toEqual([1, 2])
    const proposals = h.repos.graphProposals.listByRun(run.id)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ status: 'applied', type: 'ADD_TASK', revisionId: revisions[1]?.id, taskId: h.task(run.id, 'main').id })
    expect(revisions[1]?.proposalId).toBe(proposals[0]?.id)
    expect(revisions[0]?.snapshot.tasks.map((t) => t.key)).toEqual(['main', 'after'])
    expect(revisions[1]?.snapshot.tasks.map((t) => t.key)).toEqual(['main', 'after', 'prereq'])
    expect(h.eventsOfType(run.id, 'graph.revised').map((e) => e.payload.version)).toEqual([1, 2])
    expect(h.eventsOfType(run.id, 'graph.proposed')).toHaveLength(1)
    const mainId = h.task(run.id, 'main').id
    expect(h.repos.dependencies.listForTask(mainId).map((d) => d.dependsOnTaskId)).toEqual([h.task(run.id, 'prereq').id])
    expect(replies[0]).toMatch(/Applied as plan v2/)
    expect(replies[0]).toMatch(/Finish your turn NOW/)

    // main yielded (state queued, explained) and its attempt was not consumed by the resume.
    const yielded = h.eventsOfType(run.id, 'task.state_changed').find((e) => e.taskId === mainId && e.payload.to === 'queued')
    expect(yielded?.payload).toMatchObject({ from: 'running', reason: expect.stringContaining('waiting for prereq') })
    expect(h.task(run.id, 'main').attempt).toBe(1)
    expect(h.task(run.id, 'main').state).toBe('completed')

    // prereq went through the whole pipeline before main resumed.
    const prereq = h.task(run.id, 'prereq')
    expect(prereq.state).toBe('completed')
    expect(h.repos.reviews.listByTask(prereq.id)).toHaveLength(1)
    expect(h.repos.verifications.listByTask(prereq.id).filter((v) => v.kind === 'verifier' && v.passed)).toHaveLength(1)
    const merged = h.repos.events.listByRun(run.id, 0, 100_000).filter((e) => e.type === 'git.merged')
    expect(merged).toHaveLength(3)
    const prereqMerged = merged.find((e) => e.taskId === prereq.id)
    const mainResumed = h.repos.events.listByRun(run.id, 0, 100_000).filter((e) => e.type === 'task.started' && e.taskId === mainId)
    expect(mainResumed).toHaveLength(2)
    expect(mainResumed[1]?.seq).toBeGreaterThan(prereqMerged?.seq ?? Infinity)

    // The resumed session is fresh, knows why, and its worktree already holds the prerequisite's file.
    expect(sessionsOf(h, 'worker').filter((s) => keyOf(s) === 'main')).toHaveLength(2)
    expect(resumedWith).toHaveLength(1)
    expect(resumedWith[0]?.sawPrereq).toBe(true)
    expect(resumedWith[0]?.prompt).toContain('Resuming after a prerequisite')
    expect(resumedWith[0]?.prompt).toContain('Stopped: main needs prereq first')
    expect(resumedWith[0]?.prompt).toContain('prereq')
    const files = (await git(h.integration(run.id).path, 'ls-files')).split('\n')
    expect(files).toEqual(expect.arrayContaining(['main.txt', 'prereq.txt', 'after.txt']))
  })

  it('splits a not-yet-started task and the proposer\'s own task: originals are cancelled and dependants wait for every subtask', async () => {
    const replies: string[] = []
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'big') {
        replies.push(
          await propose(
            ctx,
            proposal('SPLIT_TASK', {
              targetTask: 'late',
              tasks: [newTask('l1', { acceptanceCriteria: ['late.txt exists'] }), newTask('l2')],
            }),
          ),
        )
        await until(ctx, () => h.repos.graphProposals.listByStatus(h.repos.runs.listByState('executing')[0]?.id ?? '', 'awaiting_approval').length === 0)
        replies.push(
          await propose(
            ctx,
            proposal('SPLIT_TASK', {
              targetTask: 'big',
              tasks: [newTask('s1', { acceptanceCriteria: ['big.txt exists'] }), newTask('s2')],
            }),
          ),
        )
        await ctx.completeTurn({ text: 'Split myself' })
        return
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('big'), plannedTask('dep1', { dependencies: ['big'] }), plannedTask('late', { dependencies: ['dep1'] })]),
        worker,
      }),
    })
    const run = await h.startRun()
    // Splitting another agent's (unstarted) task cancels it, so it needs the user's approval.
    await h.waitFor(() => h.repos.approvals.listPending(run.id).some((a) => a.kind === 'graph'), 'the split approval')
    h.orchestrator.resolveApproval(h.repos.approvals.listPending(run.id)[0]?.id ?? '', true)
    expect((await finish(run)).state).toBe('completed')

    expect(replies[0]).toMatch(/Awaiting user approval/)
    expect(replies[1]).toMatch(/Applied as plan v3/)
    expect(replies[1]).toMatch(/cancelled/)
    expect(h.repos.graphRevisions.listByRun(run.id).map((r) => r.version)).toEqual([1, 2, 3])
    for (const key of ['big', 'late']) expect(h.task(run.id, key).state).toBe('cancelled')
    for (const key of ['s1', 's2', 'l1', 'l2', 'dep1']) expect(h.task(run.id, key).state).toBe('completed')

    const keysOf = (taskKey: string): string[] =>
      h.repos.dependencies
        .listForTask(h.task(run.id, taskKey).id)
        .map((d) => h.repos.tasks.require(d.dependsOnTaskId).key)
        .sort()
    expect(keysOf('dep1')).toEqual(['s1', 's2'])
    expect(keysOf('l1')).toEqual(['dep1'])
    expect(keysOf('l2')).toEqual(['dep1'])

    // Dependants never started off the cancelled original; the cancelled task was not checked, reviewed or merged.
    expect(eventSeq(h, run.id, 'task.started', 'dep1')).toBeGreaterThan(eventSeq(h, run.id, 'task.completed', 's1'))
    expect(eventSeq(h, run.id, 'task.started', 'dep1')).toBeGreaterThan(eventSeq(h, run.id, 'task.completed', 's2'))
    expect(eventSeq(h, run.id, 'task.started', 'l1')).toBeGreaterThan(eventSeq(h, run.id, 'task.completed', 'dep1'))
    expect(h.repos.reviews.listByTask(h.task(run.id, 'big').id)).toHaveLength(0)
    expect(h.repos.verifications.listByTask(h.task(run.id, 'big').id)).toHaveLength(0)
    expect(h.repos.events.listByRun(run.id, 0, 100_000).filter((e) => e.type === 'git.merged' && e.taskId === h.task(run.id, 'big').id)).toHaveLength(0)
    expect(h.task(run.id, 'big').attempt).toBe(1)
  })

  it('rejects a proposal that would create a dependency cycle and tells the agent why', async () => {
    const replies: string[] = []
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'a') {
        replies.push(await propose(ctx, proposal('ADD_DEPENDENCY', { targetTask: 'a', dependsOn: 'b' })))
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a'), plannedTask('b', { dependencies: ['a'] })]), worker }) })
    const run = await h.startRun()
    expect((await finish(run)).state).toBe('completed')

    const proposals = h.repos.graphProposals.listByRun(run.id)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.status).toBe('rejected')
    expect(proposals[0]?.rejectionReason).toMatch(/cycle/)
    expect(proposals[0]?.revisionId).toBeNull()
    expect(h.eventsOfType(run.id, 'graph.rejected')).toHaveLength(1)
    expect(h.eventsOfType(run.id, 'graph.rejected')[0]?.payload.errors.join(' ')).toMatch(/cycle/)
    expect(h.repos.graphRevisions.listByRun(run.id)).toHaveLength(1)
    expect(h.repos.dependencies.listByRun(run.id)).toHaveLength(1)
    expect(replies[0]).toMatch(/Rejected/)
    expect(replies[0]).toMatch(/cycle/)
    expect(replies[0]).toMatch(/Do not work around/)
    expect(h.task(run.id, 'a').attempt).toBe(1)
  })

  // A clean shutdown and a crash (a snapshot taken while the old instance was still running) must both recover.
  it.each([{ crash: false }, { crash: true }])('keeps revisions, proposals, added tasks and dependencies across an application restart (crash: $crash), and resumes to completion', async ({ crash }) => {
    let proposed = false
    let stalled = false
    const worker: FakeScript = async (spec, ctx) => {
      const key = keyOf(spec)
      if (key === 'main' && !proposed) {
        proposed = true
        await propose(ctx, proposal('ADD_TASK', { tasks: [newTask('extra')], blocksProposer: true }))
        await ctx.completeTurn({ text: 'Waiting for extra' })
        return
      }
      if (key === 'extra') {
        stalled = true
        await ctx.sleep(120_000)
        if (ctx.signal.aborted) return
      }
      await fileWorker(spec, ctx)
    }
    const planned = plan([plannedTask('main'), plannedTask('after', { dependencies: ['main'] })])
    h = await createHarness({ script: scenarioScript({ plan: planned, worker }) })
    const run = await h.startRun()
    await h.waitFor(() => stalled && h.task(run.id, 'main').state === 'queued', 'extra mid-session while main is yielded')

    restarted = await h.restart(scenarioScript({ plan: planned, worker: fileWorker }), { crash })
    const versions = restarted.repos.graphRevisions.listByRun(run.id)
    expect(versions.map((r) => r.version)).toEqual([1, 2])
    expect(restarted.repos.graphProposals.listByRun(run.id)).toMatchObject([{ status: 'applied', revisionId: versions[1]?.id }])
    expect(restarted.task(run.id, 'extra').key).toBe('extra')
    expect(restarted.repos.dependencies.listForTask(restarted.task(run.id, 'main').id).map((d) => d.dependsOnTaskId)).toEqual([restarted.task(run.id, 'extra').id])
    expect(restarted.repos.events.listByRun(run.id, 0, 100_000).filter((e) => e.type === 'graph.revised')).toHaveLength(2)

    restarted.orchestrator.recoverOnStartup()
    expect(restarted.repos.runs.require(run.id).state).toBe('paused')
    await restarted.orchestrator.resumeRun(run.id)
    const done = await restarted.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')
    for (const key of ['main', 'extra', 'after']) expect(restarted.task(run.id, key).state).toBe('completed')
    expect(restarted.task(run.id, 'main').attempt).toBe(1)
    // The resumed task still saw the prerequisite's work.
    const files = (await git(restarted.integration(run.id).path, 'ls-files')).split('\n')
    expect(files).toEqual(expect.arrayContaining(['main.txt', 'extra.txt', 'after.txt']))
    // Restarting changed no history.
    expect(restarted.repos.graphRevisions.listByRun(run.id).map((r) => r.version)).toEqual([1, 2])
  })

  describe('proposals that need the user', () => {
    /** `a` proposes `change` and then waits until the test releases it; `b` depends on `a`, so it cannot start meanwhile. */
    async function startGated(change: Record<string, unknown>): Promise<{ run: Run; replies: string[]; release: () => void }> {
      const replies: string[] = []
      let released = false
      const worker: FakeScript = async (spec, ctx) => {
        if (keyOf(spec) === 'a') {
          replies.push(await propose(ctx, change))
          await until(ctx, () => released)
        }
        await fileWorker(spec, ctx)
      }
      h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a'), plannedTask('b', { dependencies: ['a'] })]), worker }) })
      const run = await h.startRun()
      await h.waitFor(() => h.repos.approvals.listPending(run.id).some((a) => a.kind === 'graph'), 'a graph approval')
      return { run, replies, release: () => (released = true) }
    }

    it('REPLAN waits for approval; approving re-validates and applies it', async () => {
      const { run, replies, release } = await startGated(proposal('REPLAN', { tasks: [newTask('c', { dependencies: ['a'] })] }))
      const approval = h.repos.approvals.listPending(run.id).find((a) => a.kind === 'graph')
      expect(approval).toMatchObject({ kind: 'graph', requestedBy: expect.stringContaining('a'), taskId: h.task(run.id, 'a').id })
      expect(approval?.action).toMatch(/Replan/)
      expect(approval?.reason).toBe('Because REPLAN is needed')
      expect(approval?.command).toContain('+ task c')
      expect(approval?.command).toContain('- cancel b')
      expect(replies[0]).toMatch(/Awaiting user approval/)
      expect(h.repos.graphProposals.listByRun(run.id)[0]?.status).toBe('awaiting_approval')
      expect(h.repos.graphRevisions.listByRun(run.id)).toHaveLength(1)
      expect(h.task(run.id, 'b').state).not.toBe('cancelled')

      h.orchestrator.resolveApproval(approval?.id ?? '', true)
      expect(h.repos.graphProposals.listByRun(run.id)[0]).toMatchObject({ status: 'applied' })
      expect(h.repos.graphRevisions.listByRun(run.id).map((r) => r.version)).toEqual([1, 2])
      expect(h.task(run.id, 'b').state).toBe('cancelled')
      expect(h.task(run.id, 'c').state).toBe('ready')

      release()
      expect((await finish(run)).state).toBe('completed')
      expect(h.task(run.id, 'c').state).toBe('completed')
      expect(h.task(run.id, 'a').state).toBe('completed')
    })

    it('denying a proposal rejects it with the user\'s note and leaves the graph alone', async () => {
      const { run, release } = await startGated(proposal('CANCEL_TASK', { targetTask: 'b' }))
      const before = graphOf(h, run.id)
      const approval = h.repos.approvals.listPending(run.id).find((a) => a.kind === 'graph')
      h.orchestrator.resolveApproval(approval?.id ?? '', false, 'b is still needed')
      const rejected = h.repos.graphProposals.listByRun(run.id)[0]
      expect(rejected).toMatchObject({ status: 'rejected', revisionId: null })
      expect(rejected?.rejectionReason).toContain('b is still needed')
      expect(h.eventsOfType(run.id, 'graph.rejected')).toHaveLength(1)
      expect(graphOf(h, run.id)).toBe(before)
      expect(h.repos.graphRevisions.listByRun(run.id)).toHaveLength(1)

      release()
      expect((await finish(run)).state).toBe('completed')
      expect(h.task(run.id, 'b').state).toBe('completed')
    })

    it('a proposal that became invalid while awaiting approval is rejected at approval time', async () => {
      const { run, release } = await startGated(proposal('CANCEL_TASK', { targetTask: 'b' }))
      await h.orchestrator.cancelTask(h.task(run.id, 'b').id) // the user got there first
      const revisionsBefore = h.repos.graphRevisions.listByRun(run.id).length
      const approval = h.repos.approvals.listPending(run.id).find((a) => a.kind === 'graph')
      h.orchestrator.resolveApproval(approval?.id ?? '', true)
      const rejected = h.repos.graphProposals.listByRun(run.id)[0]
      expect(rejected?.status).toBe('rejected')
      expect(rejected?.rejectionReason).toMatch(/no longer valid/)
      expect(rejected?.rejectionReason).toMatch(/cancelled/)
      expect(h.repos.graphRevisions.listByRun(run.id)).toHaveLength(revisionsBefore)

      release()
      expect((await finish(run)).state).toBe('completed')
    })

    it('an approved cancellation of another agent\'s running task stops that agent', async () => {
      let victimStarted = false
      let victimAborted = false
      let proposerReply = ''
      const worker: FakeScript = async (spec, ctx) => {
        const key = keyOf(spec)
        if (key === 'victim') {
          victimStarted = true
          await ctx.sleep(120_000)
          victimAborted = ctx.signal.aborted
          return
        }
        if (key === 'killer') {
          await until(ctx, () => victimStarted)
          proposerReply = await propose(ctx, proposal('CANCEL_TASK', { targetTask: 'victim' }))
          await until(ctx, () => victimAborted)
        }
        await fileWorker(spec, ctx)
      }
      h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('victim'), plannedTask('killer')]), worker }) })
      const run = await h.startRun()
      await h.waitFor(() => h.repos.approvals.listPending(run.id).some((a) => a.kind === 'graph'), 'a graph approval')
      expect(proposerReply).toMatch(/Awaiting user approval/)
      expect(h.task(run.id, 'victim').state).toBe('running')
      h.orchestrator.resolveApproval(h.repos.approvals.listPending(run.id)[0]?.id ?? '', true)
      expect((await finish(run)).state).toBe('completed')
      expect(victimAborted).toBe(true)
      expect(h.task(run.id, 'victim').state).toBe('cancelled')
      expect(h.repos.reviews.listByTask(h.task(run.id, 'victim').id)).toHaveLength(0)
      expect(h.task(run.id, 'killer').state).toBe('completed')
    })
  })

  it('rejects malformed input, proposals against terminal tasks and proposals beyond the per-agent limit without touching the graph', async () => {
    const replies: string[] = []
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'second') {
        for (const bad of [
          // Terminal task: first is completed by now and immutable.
          proposal('CANCEL_TASK', { targetTask: 'first' }),
          null,
          'not even an object',
          {},
          { type: 'DELETE_EVERYTHING', reason: 'x', evidence: 'y', changes: {} },
          { type: 'ADD_TASK', reason: 'x', evidence: 'y', changes: { tasks: [{ key: 'Bad Key' }] } },
        ]) {
          replies.push(await propose(ctx, bad))
        }
        // Valid shape but nothing to change; the agent has used 5 proposals by the seventh call.
        replies.push(await propose(ctx, proposal('REPRIORITIZE', { targetTask: 'second', priority: 0 })))
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('first'), plannedTask('second', { dependencies: ['first'] })]), worker }) })
    const run = await h.startRun()
    // Tasks are drafts until the run starts; remember the graph once it is executing and before `second` ran.
    expect((await finish(run)).state).toBe('completed')

    expect(replies).toHaveLength(7)
    expect(replies[0]).toMatch(/immutable/)
    expect(replies.every((r) => r.startsWith('Rejected'))).toBe(true)
    expect(replies[3]).toMatch(/type/)
    expect(replies[5]).toMatch(/key/)
    expect(replies[6]).toMatch(/Rate limit/)
    expect(h.repos.graphRevisions.listByRun(run.id)).toHaveLength(1)
    expect(h.repos.dependencies.listByRun(run.id)).toHaveLength(1)
    expect(h.repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['first', 'second'])
    const rows = h.repos.graphProposals.listByRun(run.id)
    // The two shapeless inputs leave no row; the rest are all rejected and none applied.
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.every((p) => p.status === 'rejected' && p.revisionId === null)).toBe(true)
    expect(rows.some((p) => /Rate limit/.test(p.rejectionReason ?? ''))).toBe(true)
    expect(h.eventsOfType(run.id, 'graph.revised')).toHaveLength(1)
    expect(h.eventsOfType(run.id, 'graph.rejected')).toHaveLength(rows.length)
  })

  it('records a revision for every user change to the graph', async () => {
    let released = false
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'a') await until(ctx, () => released)
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a'), plannedTask('b', { dependencies: ['a'] })]), worker }) })
    const run = await h.startRun()
    await h.waitFor(() => h.repos.tasks.listByRun(run.id).find((t) => t.key === 'a')?.state === 'running', 'a to run')

    const added = h.orchestrator.addTask({
      runId: run.id,
      title: 'Extra work',
      description: 'Do extra work',
      role: 'worker',
      dependsOn: [],
      suggestedFiles: [],
      acceptanceCriteria: ['user-task-1.txt exists'],
      complexity: 'small',
    })
    h.orchestrator.setPriority(h.task(run.id, 'b').id, 7)
    await h.orchestrator.cancelTask(h.task(run.id, 'b').id)
    released = true
    expect((await finish(run)).state).toBe('completed')

    const revisions = h.repos.graphRevisions.listByRun(run.id)
    expect(revisions.map((r) => r.version)).toEqual([1, 2, 3, 4])
    expect(revisions.slice(1).every((r) => r.proposalId === null)).toBe(true)
    expect(revisions[1]?.reason).toContain(`added task ${added.key}`)
    expect(revisions[2]?.reason).toMatch(/priority of b from 0 to 7/)
    expect(revisions[3]?.reason).toContain('cancelled task b')
    expect(revisions[1]?.snapshot.tasks.map((t) => t.key)).toContain(added.key)
    expect(revisions[2]?.snapshot.tasks.find((t) => t.key === 'b')?.priority).toBe(7)
    expect(revisions[3]?.snapshot.tasks.find((t) => t.key === 'b')?.state).toBe('cancelled')
    expect(h.eventsOfType(run.id, 'graph.revised').map((e) => e.payload.version)).toEqual([1, 2, 3, 4])
    expect(h.repos.graphProposals.listByRun(run.id)).toHaveLength(0)
  })

  describe('repository intelligence', () => {
    it('refreshes at run creation and turns the decisions of a verified task into repository facts', async () => {
      const worker: FakeScript = async (spec, ctx) => {
        if (keyOf(spec) === 'a') {
          await ctx.nexusTools?.recordDecision({ title: 'Use a queue', decision: 'Jobs go through an in-memory queue.', rationale: 'Simplest thing that works.' })
        }
        await fileWorker(spec, ctx)
      }
      h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a')]), worker }) })
      const run = await h.startRun()
      expect((await finish(run)).state).toBe('completed')

      const refreshed = h.eventsOfType(run.id, 'intelligence.refreshed')
      expect(refreshed).toHaveLength(1)
      const refreshedSeq = h.repos.events.listByRun(run.id, 0, 100_000).find((e) => e.type === 'intelligence.refreshed')?.seq ?? Infinity
      const planningSeq = h.repos.events.listByRun(run.id, 0, 100_000).find((e) => e.type === 'plan.proposed')?.seq ?? 0
      expect(refreshedSeq).toBeLessThan(planningSeq)

      const decision = h.repos.facts.listByProject(h.project.id).find((f) => f.kind === 'decision')
      expect(decision).toMatchObject({ subject: 'Use a queue', source: 'agent', confidence: 'medium', stale: false, files: ['a.txt'] })
      expect(decision?.statement).toContain('in-memory queue')
      expect(decision?.fingerprint).toMatch(/^[0-9a-f]{40}$/)
    })

    it('a failing refresh never blocks the run', async () => {
      h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a')]) }) })
      vi.spyOn(h.repos.facts, 'listByProject').mockImplementation(() => {
        throw new Error('facts store unavailable')
      })
      const run = await h.startRun()
      expect((await finish(run)).state).toBe('completed')
      expect(h.eventsOfType(run.id, 'intelligence.refreshed')).toHaveLength(0)
    })
  })
})
