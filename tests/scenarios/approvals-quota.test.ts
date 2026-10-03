import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, fileWorker, plan, plannedTask, scenarioScript, sessionsOf, writeFiles, type Harness } from './harness'

describe('scenario: tool approvals', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  /** A worker that tries a gated shell command first and records whether it was allowed to run. */
  function pushingWorker(outcomes: boolean[], executed: string[]): FakeScript {
    return async (spec, ctx) => {
      const allowed = await ctx.useTool('Bash', { command: 'git push origin main' }, async () => {
        executed.push('git push origin main')
        return 'pushed'
      })
      outcomes.push(allowed)
      await writeFiles(spec, ctx)
      await ctx.completeTurn({ text: allowed ? 'pushed and wrote' : 'push denied, wrote locally' })
    }
  }

  it('a gated command creates a pending approval, the agent waits, and a denial refuses the tool', async () => {
    const outcomes: boolean[] = []
    const executed: string[] = []
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('pusher')]), worker: pushingWorker(outcomes, executed) }) })
    const run = await h.startRun()
    await h.waitFor(() => h.repos.approvals.listPending(run.id).length === 1, 'the tool approval request')

    const approval = h.repos.approvals.listPending(run.id)[0]
    expect(approval).toMatchObject({ kind: 'tool', status: 'pending', command: 'git push origin main', risk: 'medium' })
    expect(approval?.requestedBy).toContain('pusher')
    expect(approval?.reason).toContain('git push')
    const agent = h.repos.agents.require(approval?.agentId ?? '')
    expect(agent.state).toBe('waiting')
    expect(h.repos.tasks.require(approval?.taskId ?? '').key).toBe('pusher')
    // The agent is blocked on the decision: nothing ran yet.
    expect(outcomes).toEqual([])
    expect(h.eventsOfType(run.id, 'agent.waiting')).toHaveLength(1)

    h.orchestrator.resolveApproval(approval?.id ?? '', false, 'do not publish')
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(outcomes).toEqual([false])
    expect(executed).toEqual([])
    expect(h.repos.approvals.require(approval?.id ?? '')).toMatchObject({ status: 'denied', note: 'do not publish' })
    expect(h.eventsOfType(run.id, 'approval.denied')).toHaveLength(1)
    const tool = h.repos.toolEvents.listByAgent(agent.id).find((t) => t.toolName === 'Bash')
    expect(tool?.status).toBe('denied')
    expect(h.eventsOfType(run.id, 'agent.tool.denied')).toHaveLength(1)
  })

  it('approving the same request lets the command run', async () => {
    const outcomes: boolean[] = []
    const executed: string[] = []
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('pusher')]), worker: pushingWorker(outcomes, executed) }) })
    const run = await h.startRun()
    await h.waitFor(() => h.repos.approvals.listPending(run.id).length === 1, 'the tool approval request')
    h.orchestrator.resolveApproval(h.repos.approvals.listPending(run.id)[0]?.id ?? '', true)

    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(outcomes).toEqual([true])
    expect(executed).toEqual(['git push origin main'])
    expect(h.eventsOfType(run.id, 'approval.granted')).toHaveLength(1)
    const agent = h.repos.agents.listByTask(h.task(run.id, 'pusher').id)[0]
    expect(h.repos.toolEvents.listByAgent(agent?.id ?? '').find((t) => t.toolName === 'Bash')?.status).toBe('completed')
    // Resolving twice is refused.
    expect(() => h.orchestrator.resolveApproval(h.repos.approvals.listByRun(run.id)[0]?.id ?? '', true)).toThrow(/already approved/)
  })

  it('writes outside the task worktree are denied by policy without any approval request', async () => {
    const results: boolean[] = []
    const worker: FakeScript = async (spec, ctx) => {
      for (const target of [join(h.repoDir, 'outside.txt'), join(h.dir, 'elsewhere.txt')]) {
        results.push(
          await ctx.useTool('Write', { file_path: target, content: 'x' }, async () => {
            await writeFile(target, 'escaped')
            return 'written'
          }),
        )
      }
      await writeFiles(spec, ctx)
      await ctx.completeTurn({ text: 'wrote inside only' })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('boxed')]), worker }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    expect(results).toEqual([false, false])
    expect(existsSync(join(h.repoDir, 'outside.txt'))).toBe(false)
    expect(existsSync(join(h.dir, 'elsewhere.txt'))).toBe(false)
    expect(h.repos.approvals.listByRun(run.id)).toHaveLength(0)
    const agent = h.repos.agents.listByTask(h.task(run.id, 'boxed').id)[0]
    const tools = h.repos.toolEvents.listByAgent(agent?.id ?? '').filter((t) => t.toolName === 'Write')
    expect(tools.map((t) => t.status)).toEqual(['denied', 'denied', 'completed'])
    expect(tools[0]?.outputPreview).toContain('Write denied')
    expect(h.eventsOfType(run.id, 'agent.tool.denied')).toHaveLength(2)
  })

  it('a reviewer cannot write at all: the tool is not available to its role', async () => {
    const decisions: boolean[] = []
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('guarded')]),
        reviewer: async (spec, ctx) => {
          decisions.push(await ctx.useTool('Write', { file_path: join(spec.cwd, 'sneaky.txt'), content: 'x' }))
          await ctx.completeTurn({ text: 'review', structuredOutput: { summary: 'fine', findings: [] } })
        },
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(decisions).toEqual([false])
    expect(h.repos.approvals.listByRun(run.id)).toHaveLength(0)
    expect(sessionsOf(h, 'reviewer')[0]?.tools).not.toContain('Write')
  })
})

describe('scenario: quota is not failure', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('a rejected rate limit pauses the run with reason quota without failing the task or using an attempt; resume continues', async () => {
    let limited = false
    const worker: FakeScript = async (spec, ctx) => {
      if (!limited) {
        limited = true
        await ctx.rateLimit({ status: 'rejected', resetsAt: 1_900_000_000, limitType: 'five_hour' })
        await ctx.completeTurn({ text: 'usage limit reached', outcome: 'quota' })
        return
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('big')]), worker }) })
    const run = await h.startRun()
    const paused = await h.waitForState(run.id, 'paused')
    expect(paused).toMatchObject({ pauseReason: 'quota', resumeState: 'executing' })

    const task = h.task(run.id, 'big')
    expect(task.state).toBe('running')
    expect(task.attempt).toBe(1)
    expect(task.error).toBeNull()
    expect(h.eventsOfType(run.id, 'task.failed')).toHaveLength(0)
    expect(h.eventsOfType(run.id, 'task.retry')).toHaveLength(0)
    expect(h.eventsOfType(run.id, 'agent.rate_limited')[0]?.payload).toMatchObject({ status: 'rejected', limitType: 'five_hour' })
    expect(h.eventsOfType(run.id, 'run.paused')[0]?.payload.reason).toBe('quota')
    const firstSession = h.repos.sessions.listByAgent(h.repos.agents.listByTask(task.id)[0]?.id ?? '')[0]
    expect(firstSession).toMatchObject({ state: 'ended', endReason: 'quota' })

    // It stays paused until the user resumes.
    await h.orchestrator.idle(run.id)
    expect(sessionsOf(h, 'worker')).toHaveLength(1)

    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const workers = sessionsOf(h, 'worker')
    expect(workers).toHaveLength(2)
    expect(workers[1]?.resumeSessionId).toBe(firstSession?.sdkSessionId)
    expect(h.task(run.id, 'big')).toMatchObject({ state: 'completed', attempt: 1 })
  })

  it('a quota hit while the planner runs pauses planning and resume replans', async () => {
    let limited = false
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('p')]) }) })
    const base = h.runtime.script
    h.runtime.script = async (spec, ctx) => {
      if (spec.role === 'planner' && !limited) {
        limited = true
        await ctx.rateLimit()
        await ctx.completeTurn({ text: 'limit', outcome: 'quota' })
        return
      }
      await base(spec, ctx)
    }
    const run = await h.startRun()
    const paused = await h.waitForState(run.id, 'paused')
    expect(paused).toMatchObject({ pauseReason: 'quota', resumeState: 'planning' })
    expect(h.repos.tasks.listByRun(run.id)).toHaveLength(0)

    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(sessionsOf(h, 'planner')).toHaveLength(2)
  })
})
