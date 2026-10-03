import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Handoff, Run, RunState } from '@shared/domain'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import {
  approvedReview,
  createHarness,
  failedVerification,
  fileWorker,
  git,
  keyOf,
  passedVerification,
  plan,
  plannedTask,
  rejectedReview,
  scenarioScript,
  sessionsOf,
  writeFiles,
  type Harness,
} from './harness'

const HOUR_MS = 3_600_000
const TERMINAL_OR_PAUSED: RunState[] = ['completed', 'failed', 'paused']

/** A worker that waits (until stopped) while `gate.open` is false. */
function gatedWorker(gate: { open: boolean }): FakeScript {
  return async (spec, ctx) => {
    while (!gate.open && !ctx.signal.aborted) await ctx.sleep(20)
    if (ctx.signal.aborted) return
    await fileWorker(spec, ctx)
  }
}

/** Check command that passes once `fixed.txt` exists in the worktree it runs in. */
const NEEDS_FIXED = `const { existsSync } = require('node:fs')
if (existsSync('fixed.txt')) { console.log('all good'); process.exit(0) }
console.error('check failed: fixed.txt is missing')
process.exit(3)
`

const writeFixed: FakeScript = async (spec, ctx) => {
  await writeFiles(spec, ctx, { 'fixed.txt': 'fixed' })
  await ctx.completeTurn({ text: 'Applied a fix' })
}

describe('scenario: the duration limit bounds active time', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('a user Resume after the limit paused the run grants a fresh window', async () => {
    const gate = { open: false }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('slow')]), worker: gatedWorker(gate) }) })
    const run = await h.startRun()
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'the worker to start')

    // Pretend the run has been active for five hours of its four-hour limit.
    h.repos.runs.update(run.id, { startedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString() })
    h.repos.settings.setValue(`run-active:${run.id}`, { usedMs: 5 * HOUR_MS, since: new Date().toISOString() })
    h.orchestrator.requestTick(run.id)
    const paused = await h.waitForState(run.id, 'paused')
    expect(paused.pauseReason).toBe('user')
    expect(h.eventsOfType(run.id, 'run.paused').at(-1)?.payload).toMatchObject({ detail: expect.stringContaining('duration limit') })

    gate.open = true
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')
    expect(h.eventsOfType(run.id, 'run.paused')).toHaveLength(1)
  })

  it('time spent paused does not count towards the limit', async () => {
    const gate = { open: false }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('slow')]), worker: gatedWorker(gate) }) })
    const run = await h.startRun()
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'the worker to start')

    await h.orchestrator.pauseRun(run.id)
    // The run sat paused overnight: wall-clock time since it started is far beyond the limit.
    h.repos.runs.update(run.id, { startedAt: new Date(Date.now() - 10 * HOUR_MS).toISOString() })
    gate.open = true
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')
    expect(h.eventsOfType(run.id, 'run.paused')).toHaveLength(1)
  })
})

describe('scenario: a pause during checks does not redo the implementation', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('resumes at the checks stage with the finished implementer session untouched', async () => {
    // The check waits for a marker file next to the worktrees directory (<dir>/go) before it passes.
    const check = `const { existsSync } = require('node:fs')
const { resolve } = require('node:path')
const go = resolve(process.cwd(), '..', '..', '..', 'go')
const deadline = Date.now() + 30000
const poll = () => (existsSync(go) || Date.now() > deadline ? process.exit(0) : setTimeout(poll, 25))
poll()
`
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('feat')]) }),
      files: { 'check.js': check },
      commands: { test: 'node check.js' },
    })
    const run = await h.startRun()
    await h.waitFor(() => h.eventsOfType(run.id, 'checks.started').length === 1, 'the checks to start')
    expect(h.task(run.id, 'feat').state).toBe('running')

    // The pause waits for the running check, so release it while pausing.
    const pausing = h.orchestrator.pauseRun(run.id)
    await writeFile(join(h.dir, 'go'), 'go')
    await pausing
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    expect(h.task(run.id, 'feat')).toMatchObject({ state: 'running', attempt: 1 })

    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')
    expect(sessionsOf(h, 'worker')).toHaveLength(1)
    expect(h.task(run.id, 'feat').attempt).toBe(1)
    expect(h.repos.agents.listByTask(h.task(run.id, 'feat').id).filter((a) => a.role === 'worker')).toHaveLength(1)
  })
})

describe('scenario: repair attempts across retries', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('retrying a task that needed a repair creates a new, uniquely keyed repair child', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('feat')]) }),
      files: { 'check.js': "console.error('always failing'); process.exit(3)\n" },
      commands: { test: 'node check.js' },
    })
    const run = await h.startRun({ overrides: { maxIterations: 1 } })
    await h.waitForState(run.id, 'paused')
    const feat = h.task(run.id, 'feat')
    expect(feat.state).toBe('failed')
    expect(h.repos.tasks.listByParent(feat.id).map((t) => t.key)).toEqual(['feat-fix1'])

    await h.orchestrator.retryTask(feat.id)
    await h.orchestrator.resumeRun(run.id)
    await h.waitFor(() => h.repos.tasks.listByParent(feat.id).length === 2 && h.task(run.id, 'feat').state === 'failed', 'the second repair to fail')
    await h.orchestrator.idle(run.id)

    expect(h.repos.tasks.listByParent(feat.id).map((t) => t.key)).toEqual(['feat-fix1', 'feat-fix2'])
    // The task failed the regular way (bounded repair loop), not with a pipeline error.
    expect(h.task(run.id, 'feat').error?.what).toContain('still failing after 1 repair cycle')
  })

  it('a failed repair child does not block the run once its parent was retried and completed', async () => {
    let debuggers = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feat')]),
        debugger: async (spec, ctx) => {
          debuggers++
          if (debuggers === 1) ctx.fail('debugger crashed')
          await writeFixed(spec, ctx)
        },
      }),
      files: { 'check.js': NEEDS_FIXED },
      commands: { test: 'node check.js' },
    })
    const run = await h.startRun()
    await h.waitForState(run.id, 'paused')
    const feat = h.task(run.id, 'feat')
    expect(feat.state).toBe('failed')
    const dead = h.repos.tasks.listByParent(feat.id)[0]
    expect(dead).toMatchObject({ key: 'feat-fix1', state: 'failed' })

    // A repair attempt is not retried on its own.
    await expect(h.orchestrator.retryTask(dead?.id ?? '')).rejects.toMatchObject({ code: 'invalid_state' })

    await h.orchestrator.retryTask(feat.id)
    await h.orchestrator.resumeRun(run.id)
    const done = await h.waitForState(run.id, TERMINAL_OR_PAUSED)
    expect(done.state).toBe('completed')
    expect(h.task(run.id, 'feat').state).toBe('completed')
    expect(h.repos.tasks.listByParent(feat.id).map((t) => `${t.key}:${t.state}`)).toEqual(['feat-fix1:failed', 'feat-fix2:completed'])
  })
})

describe('scenario: cancelling a repair child', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('stops its debugger, fails the parent as "repair cancelled" and the parent can be retried', async () => {
    let debuggers = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feat')]),
        debugger: async (spec, ctx) => {
          debuggers++
          if (debuggers === 1) {
            await ctx.sleep(120_000)
            if (ctx.signal.aborted) return
          }
          await writeFixed(spec, ctx)
        },
      }),
      files: { 'check.js': NEEDS_FIXED },
      commands: { test: 'node check.js' },
    })
    const run = await h.startRun()
    const feat = await (async () => {
      await h.waitFor(() => sessionsOf(h, 'debugger').length === 1, 'the debugger to start')
      return h.task(run.id, 'feat')
    })()
    const child = h.repos.tasks.listByParent(feat.id)[0]
    expect(child).toMatchObject({ key: 'feat-fix1', state: 'running' })

    await h.orchestrator.cancelTask(child?.id ?? '')
    await h.waitForState(run.id, 'paused')

    expect(h.repos.tasks.require(child?.id ?? '').state).toBe('cancelled')
    expect(h.task(run.id, 'feat')).toMatchObject({ state: 'failed', error: { what: 'Repair cancelled by user', retryable: true } })
    // The debugger session was stopped and nothing crashed the pipeline.
    expect(h.repos.agents.listByTask(child?.id ?? '').every((a) => a.state === 'stopped')).toBe(true)
    expect(h.repos.agents.listActive(run.id)).toHaveLength(0)
    expect(h.task(run.id, 'feat').error?.what).not.toBe('Task pipeline error')

    await h.orchestrator.retryTask(feat.id)
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')
    expect(h.repos.tasks.listByParent(feat.id).map((t) => `${t.key}:${t.state}`)).toEqual(['feat-fix1:cancelled', 'feat-fix2:completed'])
  })
})

describe('scenario: user instructions reach the implementing session', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('an instruction sent while the reviewer runs goes to the repair debugger, not the reviewer', async () => {
    let reviews = 0
    let reviewerInbox: string | null = 'untouched'
    let runId = ''
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feat')]),
        reviewer: async (_spec, ctx) => {
          reviews++
          if (reviews === 1) {
            h.orchestrator.instruct(h.task(runId, 'feat').id, 'use library X')
            reviewerInbox = await Promise.race([ctx.nextMessage(), ctx.sleep(80).then(() => null)])
            await ctx.completeTurn({ text: 'review', structuredOutput: rejectedReview() })
          } else {
            await ctx.completeTurn({ text: 'review', structuredOutput: approvedReview })
          }
        },
      }),
    })
    const run = await h.startRun()
    runId = run.id
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')

    expect(reviewerInbox).toBeNull()
    expect(sessionsOf(h, 'debugger')[0]?.prompt).toContain('use library X')
    const message = h.repos.messages.listByRun(run.id).find((m) => m.type === 'user_instruction')
    expect(h.repos.messages.listRecipients(message?.id ?? '')).toEqual([{ taskId: h.task(run.id, 'feat').id, deliveredAt: expect.any(String) }])
  })

  it('an instruction sent while the run is paused is part of the resume prompt', async () => {
    let started = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feat')]),
        worker: async (spec, ctx) => {
          started++
          if (started === 1) {
            await ctx.sleep(120_000)
            if (ctx.signal.aborted) return
          }
          await fileWorker(spec, ctx)
        },
      }),
    })
    const run = await h.startRun()
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'the worker to start')
    await h.orchestrator.pauseRun(run.id)

    const message = h.orchestrator.instruct(h.task(run.id, 'feat').id, 'prefer the streaming API')
    expect(h.repos.messages.listUndeliveredForTask(h.task(run.id, 'feat').id).map((m) => m.id)).toEqual([message.id])

    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')
    const resumed = sessionsOf(h, 'worker')[1]
    expect(resumed?.resumeSessionId).toBeDefined()
    expect(resumed?.prompt).toContain('Continue the task')
    expect(resumed?.prompt).toContain('prefer the streaming API')
    expect(h.repos.messages.listUndeliveredForTask(h.task(run.id, 'feat').id)).toEqual([])
  })
})

describe('scenario: usage accounting', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  const workerAgents = (run: Run, key: string) => h.repos.agents.listByTask(h.task(run.id, key).id).filter((a) => a.role === 'worker')
  const sum = (values: (number | null)[]): number => values.reduce<number>((n, v) => n + (v ?? 0), 0)

  it('a session with several turns is counted once, not once per cumulative report', async () => {
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feat')]),
        worker: async (spec, ctx) => {
          await writeFiles(spec, ctx)
          await ctx.completeTurn({ text: 'first turn' })
          await ctx.completeTurn({ text: 'second turn' })
        },
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')

    const [agent] = workerAgents(run, 'feat')
    expect(agent?.metrics).toMatchObject({ turns: 2, inputTokens: 2000 })
    expect(agent?.metrics.costUsd).toBeCloseTo(0.002, 6)
    const rows = h.repos.usage.listByAgent(agent?.id ?? '')
    expect(sum(rows.map((r) => r.inputTokens))).toBe(2000)
    expect(sum(rows.map((r) => r.costUsd))).toBeCloseTo(0.002, 6)
  })

  it('a resumed session continues the totals: earlier spend is not counted again by the new agent', async () => {
    let started = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feat')]),
        worker: async (spec, ctx) => {
          started++
          if (started === 1) {
            await ctx.completeTurn({ text: 'partial work' })
            await ctx.sleep(120_000)
            return
          }
          await fileWorker(spec, ctx)
        },
      }),
    })
    const run = await h.startRun()
    await h.waitFor(() => h.repos.tasks.listByRun(run.id).length > 0 && workerAgents(run, 'feat')[0]?.metrics.turns === 1, 'the first turn to be recorded')
    await h.orchestrator.pauseRun(run.id)
    await h.orchestrator.resumeRun(run.id)
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')

    const agents = workerAgents(run, 'feat')
    expect(agents).toHaveLength(2)
    expect(sessionsOf(h, 'worker')[1]?.resumeSessionId).toBe(agentSession(h, agents[0]?.id ?? ''))
    // Two turns of 1000 input tokens and 0.001 USD in total, however many agent rows they are spread over.
    expect(sum(agents.map((a) => a.metrics.inputTokens))).toBe(2000)
    expect(sum(agents.map((a) => a.metrics.costUsd))).toBeCloseTo(0.002, 6)
    expect(sum(agents.map((a) => a.metrics.turns))).toBe(2)
    expect(sum(h.repos.usage.listByRun(run.id).filter((u) => agents.some((a) => a.id === u.agentId)).map((u) => u.costUsd))).toBeCloseTo(0.002, 6)
  })

  it('rotation counts the exhausted session, the handoff request and the fresh session exactly once each', async () => {
    const handoff: Handoff = {
      completedWork: ['wrote the parser skeleton'],
      commits: [],
      filesChanged: ['parser.ts'],
      unresolvedIssues: [],
      importantFindings: [],
      nextSteps: ['finish it'],
    }
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('parser')]),
        worker: async (spec, ctx) => {
          if (spec.outputSchema) await ctx.completeTurn({ text: 'handoff', structuredOutput: handoff })
          else if (spec.prompt.includes('Resuming task')) await fileWorker(spec, ctx)
          else await ctx.completeTurn({ text: 'out of turns', outcome: 'max_turns' })
        },
      }),
      settings: (s) => ({ ...s, execution: { ...s.execution, sessionRotationTurns: 5 } }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')

    const [agent, ...others] = workerAgents(run, 'parser')
    expect(others).toHaveLength(0)
    // Session 1 (1000) + handoff request on session 1 (cumulative 2000, so +1000) + fresh session (1000).
    expect(agent?.metrics).toMatchObject({ turns: 3, inputTokens: 3000 })
    expect(agent?.metrics.costUsd).toBeCloseTo(0.003, 6)
    expect(sum(h.repos.usage.listByAgent(agent?.id ?? '').map((u) => u.inputTokens))).toBe(3000)
  })
})

function agentSession(harness: Harness, agentId: string): string | undefined {
  return harness.repos.sessions.latestForAgent(agentId)?.sdkSessionId ?? undefined
}

describe('scenario: the integration worktree and task worktrees stay clean', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  // Writes an untracked file and rewrites a tracked one, the way a formatter or a snapshot test would.
  const NOISY_CHECK = `const fs = require('node:fs')
fs.writeFileSync('report.tmp', 'generated')
fs.writeFileSync('formatted.txt', 'rewritten by check\\n')
process.exit(0)
`

  it('a mission-level repair merges although the mission checks dirtied the integration worktree', async () => {
    let missionVerifications = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feat')]),
        verifier: async (spec, ctx) => {
          const missionLevel = keyOf(spec) === 'integration'
          if (missionLevel) missionVerifications++
          await ctx.completeTurn({
            text: 'verify',
            structuredOutput: missionLevel && missionVerifications === 1 ? failedVerification('feat.txt is correct') : passedVerification,
          })
        },
      }),
      files: { 'check.js': NOISY_CHECK, 'formatted.txt': 'original\n' },
      commands: { test: 'node check.js' },
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')

    expect(h.task(run.id, 'mission-fix-1').state).toBe('completed')
    const integration = h.integration(run.id)
    expect((await h.git.status(integration.path)).clean).toBe(true)
    expect(existsSync(join(integration.path, 'report.tmp'))).toBe(false)
    expect(await git(integration.path, 'show', 'HEAD:formatted.txt')).toBe('original')
  })

  it('what the checks changed in a task worktree is neither reviewed nor merged', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('feat')]) }),
      files: { 'check.js': NOISY_CHECK, 'formatted.txt': 'original\n' },
      commands: { test: 'node check.js' },
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')

    for (const role of ['reviewer', 'verifier']) {
      for (const session of sessionsOf(h, role)) expect(session.prompt).not.toContain('rewritten by check')
    }
    const integration = h.integration(run.id)
    expect(await git(integration.path, 'show', 'HEAD:formatted.txt')).toBe('original')
    expect(await git(integration.path, 'ls-files', 'report.tmp')).toBe('')
    expect(existsSync(join(integration.path, 'feat.txt'))).toBe(true)
  })
})

describe('scenario: an interrupted merge does not block a run resumed after "inspect"', () => {
  let original: Harness
  let restarted: Harness | undefined
  afterEach(async () => {
    await restarted?.dispose()
    await original?.dispose()
  })

  it('reconciles the worktrees on every resume', async () => {
    const gate = { open: false }
    const worker: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'second') {
        while (!gate.open && !ctx.signal.aborted) await ctx.sleep(20)
        if (ctx.signal.aborted) return
      }
      await fileWorker(spec, ctx)
    }
    const twoSteps = plan([plannedTask('first'), plannedTask('second', { dependencies: ['first'] })])
    original = await createHarness({ script: scenarioScript({ plan: twoSteps, worker }) })
    const run = await original.startRun()
    await original.waitFor(() => sessionsOf(original, 'worker').some((s) => keyOf(s) === 'second'), 'second to start')

    restarted = await original.restart(scenarioScript({ plan: twoSteps }), { crash: true })
    restarted.orchestrator.recoverOnStartup()
    const integration = restarted.integration(run.id)
    // What a kill during `git merge` leaves behind: MERGE_HEAD and staged changes.
    await git(integration.path, 'switch', '-c', 'side')
    await writeFile(join(integration.path, 'side.txt'), 'side\n')
    await git(integration.path, 'add', '-A')
    await git(integration.path, 'commit', '-m', 'side work')
    await git(integration.path, 'switch', integration.branch)
    await git(integration.path, 'merge', '--no-commit', '--no-ff', 'side')
    expect(await restarted.git.isMergeInProgress(integration.path)).toBe(true)

    await restarted.orchestrator.recover(run.id, 'inspect')
    await restarted.orchestrator.resumeRun(run.id)
    expect((await restarted.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')
    expect(await restarted.git.isMergeInProgress(integration.path)).toBe(false)
    expect(restarted.task(run.id, 'second').state).toBe('completed')
  })
})

describe('scenario: pending task approvals survive a restart without duplicates', () => {
  let original: Harness
  let restarted: Harness | undefined
  afterEach(async () => {
    await restarted?.dispose()
    await original?.dispose()
  })

  it('does not announce an already pending approval again', async () => {
    const approvalPlan = plan([plannedTask('gated', { requiresApproval: true })])
    original = await createHarness({ script: scenarioScript({ plan: approvalPlan }) })
    const run = await original.startRun()
    await original.waitFor(() => original.repos.approvals.listPending(run.id).length === 1, 'the task approval')

    restarted = await original.restart(scenarioScript({ plan: approvalPlan }))
    restarted.orchestrator.recoverOnStartup()
    await restarted.orchestrator.recover(run.id, 'resume')
    await restarted.orchestrator.idle(run.id)

    const pending = restarted.repos.approvals.listPending(run.id).filter((a) => a.kind === 'task')
    expect(pending).toHaveLength(1)
    restarted.orchestrator.resolveApproval(pending[0]?.id ?? '', true)
    expect((await restarted.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')
  })

  it('a stale denial does not cancel a task that already started', async () => {
    const approvalPlan = plan([plannedTask('gated', { requiresApproval: true })])
    original = await createHarness({ script: scenarioScript({ plan: approvalPlan }) })
    const run = await original.startRun()
    await original.waitFor(() => original.repos.approvals.listPending(run.id).length === 1, 'the task approval')
    const approval = original.repos.approvals.listPending(run.id)[0]
    const task = original.task(run.id, 'gated')
    // The task was started by other means (e.g. a duplicate request was approved earlier).
    original.repos.tasks.update(task.id, { approvalGranted: true })
    original.orchestrator.requestTick(run.id)
    await original.waitFor(() => original.task(run.id, 'gated').state !== 'ready', 'the task to start')

    original.orchestrator.resolveApproval(approval?.id ?? '', false)
    expect((await original.waitForState(run.id, TERMINAL_OR_PAUSED)).state).toBe('completed')
    expect(original.task(run.id, 'gated').state).toBe('completed')
  })
})
