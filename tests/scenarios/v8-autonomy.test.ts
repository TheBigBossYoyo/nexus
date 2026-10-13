import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, ipc, plan, plannedTask, scenarioScript, writeFiles, type Harness } from './harness'

// 0.8: a mission in an enrolled project. The real orchestrator, real git and SQLite, scripted agents whose
// tool calls go through the real authorizer and the real capability broker. What is counted is what the user
// would have been interrupted by: approval requests and boundary requests.

/** A day's ordinary commands. Under 0.7 several of these asked for approval; unattended, they were refused. */
const ORDINARY: [string, string][] = [
  ['Bash', 'git status'],
  ['Bash', 'pnpm install'],
  ['Bash', 'pnpm test'],
  ['Bash', 'pnpm build'],
  ['Bash', 'node -e "console.log(1)"'],
  ['Bash', 'rm -rf scratch-build'],
  ['PowerShell', 'Remove-Item -Recurse -Force .cache'],
  ['Bash', 'git add -A && git commit -m "checkpoint"'],
  ['Bash', 'git reset --hard HEAD'],
  ['Bash', 'npx vitest run'],
]

interface Record {
  task: string
  command: string
  allowed: boolean
}

function worker(log: Record[], extra: (key: string) => [string, string][] = () => []): FakeScript {
  return async (spec, ctx) => {
    const key = /Task key: (\S+)/.exec(spec.prompt)?.[1] ?? spec.label ?? 'task'
    for (const [tool, command] of [...ORDINARY, ...extra(key)]) {
      const allowed = await ctx.useTool(tool, { command }, async () => 'ok')
      log.push({ task: key, command, allowed })
    }
    await writeFiles(spec, ctx)
    await ctx.completeTurn({ text: 'done' })
  }
}

describe('scenario: an enrolled project (0.8)', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('an ordinary mission of three tasks interrupts the user zero times', async () => {
    const log: Record[] = []
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('alpha'), plannedTask('beta'), plannedTask('gamma', { dependencies: ['alpha'] })]), worker: worker(log) }),
      autonomy: { profile: 'AUTONOMOUS_PROJECT', contained: true },
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    expect(log).toHaveLength(ORDINARY.length * 3)
    expect(log.filter((r) => !r.allowed)).toEqual([])
    // The interruption count: nothing asked, by either mechanism.
    expect(h.repos.approvals.listByRun(run.id).filter((a) => a.kind === 'tool')).toEqual([])
    expect(h.eventsOfType(run.id, 'agent.waiting')).toEqual([])
    expect(h.autonomy.missionMetrics(run.id).boundaryRequests).toBe(0)
    // The only push is the enrollment itself; nothing was ever pending.
    expect(h.pushes.filter((p) => p.kind === 'autonomy' && p.pending > 0)).toEqual([])
    // It is on record all the same, quietly.
    const counts = h.autonomy.missionMetrics(run.id).counts
    expect(counts['NORMAL_AUTONOMOUS_ACTION']).toBeGreaterThanOrEqual(ORDINARY.length * 3)
    expect(Object.keys(counts)).toEqual(['NORMAL_AUTONOMOUS_ACTION'])
  })

  it('the same mission in a project that is not enrolled asks, as 0.7 did', async () => {
    const log: Record[] = []
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker: worker(log) }) })
    const run = await h.startRun()
    await h.waitFor(() => h.repos.approvals.listPending(run.id).length === 1, 'a tool approval request')
    expect(h.repos.boundaryRequests.countForRun(run.id)).toBe(0)
    await h.orchestrator.cancelRun(run.id)
  })

  it('one out-of-scope action tried by every task, repeatedly, is one boundary request; the rest of the work completes', async () => {
    const log: Record[] = []
    const push = (): [string, string][] => [
      ['Bash', 'git push origin HEAD'],
      ['Bash', 'git push origin HEAD'],
      ['Bash', 'git push origin HEAD'],
    ]
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('alpha'), plannedTask('beta'), plannedTask('gamma')]), worker: worker(log, push) }),
      autonomy: { profile: 'AUTONOMOUS_PROJECT', contained: true },
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const pushes = log.filter((r) => r.command.startsWith('git push'))
    expect(pushes).toHaveLength(9)
    expect(pushes.every((r) => !r.allowed)).toBe(true)
    // Everything else went through, and every task finished its own work.
    expect(log.filter((r) => !r.command.startsWith('git push') && !r.allowed)).toEqual([])
    for (const key of ['alpha', 'beta', 'gamma']) expect(h.task(run.id, key).state).toBe('completed')

    // Exactly one question, counted nine times, announced once, and no approval dialog.
    const requests = await ipc(h, 'autonomy.recent', {})
    const pending = await ipc(h, 'autonomy.pending', {})
    expect(h.autonomy.missionMetrics(run.id).boundaryRequests).toBe(1)
    expect(h.repos.approvals.listByRun(run.id).filter((a) => a.kind === 'tool')).toEqual([])
    const all = [...pending, ...requests]
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ capability: 'GIT_PUSH', occurrences: 9, capabilityLabel: 'Push to a Git remote', projectName: 'scenario' })
    // The mission ended, so nobody waits for the answer any more.
    expect(all[0]?.state).toBe('EXPIRED')
    expect(h.pushes.filter((p) => p.kind === 'autonomy' && p.pending === 1)).toHaveLength(1)
    // The agent was told which request, in the tool's refusal.
    const denied = h.eventsOfType(run.id, 'agent.tool.denied')
    expect(denied).toHaveLength(9)
    expect(JSON.stringify(denied[0]?.payload)).toContain(`boundary request ${all[0]?.id}`)
  })

  it('a grant for the mission given while it runs lets the next try through', async () => {
    const log: Record[] = []
    const hold: { release: () => void } = { release: () => undefined }
    const gate = new Promise<void>((resolve) => (hold.release = resolve))
    const script: FakeScript = async (spec, ctx) => {
      const first = await ctx.useTool('Bash', { command: 'git push origin HEAD' }, async () => 'pushed')
      log.push({ task: 'only', command: 'push-1', allowed: first })
      await gate
      const second = await ctx.useTool('Bash', { command: 'git push origin HEAD' }, async () => 'pushed')
      log.push({ task: 'only', command: 'push-2', allowed: second })
      await writeFiles(spec, ctx)
      await ctx.completeTurn({ text: 'done' })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('only')]), worker: script }), autonomy: { profile: 'AUTONOMOUS_PROJECT', contained: true } })
    const run = await h.startRun()
    await h.waitFor(() => h.autonomy.pending().length === 1, 'the boundary request')
    const request = h.autonomy.pending()[0]
    expect(request?.scopes).toEqual(['ONCE', 'MISSION', 'PROJECT'])
    const answer = await ipc(h, 'autonomy.resolve', { requestId: request?.id ?? '', decision: 'ALLOW_MISSION' })
    expect(answer).toMatchObject({ state: 'GRANTED' })
    hold.release()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(log.map((r) => r.allowed)).toEqual([false, true])
    expect(h.autonomy.missionMetrics(run.id).boundaryRequests).toBe(1)
    const overview = await ipc(h, 'autonomy.overview', { projectId: h.project.id })
    expect(overview.enrollment?.profile).toBe('AUTONOMOUS_PROJECT')
    expect(overview.grants).toHaveLength(1)
    // The mission is over: its grant no longer holds.
    expect(overview.grants[0]).toMatchObject({ scope: 'MISSION', capability: 'GIT_PUSH', active: false })
  })
})
