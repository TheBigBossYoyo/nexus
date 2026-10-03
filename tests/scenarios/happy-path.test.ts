import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completeWith, scriptsByRole, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { approvedReview, createHarness, passedVerification, plan, plannedTask, type Harness } from './harness'

/** A worker that writes `<task key>.txt` in its worktree through the policy-checked Write tool. */
export const fileWorker: FakeScript = async (spec, ctx) => {
  const key = basename(spec.cwd)
  const target = join(spec.cwd, `${key}.txt`)
  const allowed = await ctx.useTool('Write', { file_path: target, content: key }, async () => {
    await writeFile(target, `${key}\n`)
    return 'written'
  })
  await ctx.completeTurn({ text: allowed ? `Created ${key}.txt` : 'Write was denied' })
}

describe('scenario: plan → parallel workers → review → verification → merge', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('runs two independent tasks in parallel, then a dependant, and completes after verification', async () => {
    let concurrentWorkers = 0
    let maxConcurrentWorkers = 0
    const worker: FakeScript = async (spec, ctx) => {
      concurrentWorkers++
      maxConcurrentWorkers = Math.max(maxConcurrentWorkers, concurrentWorkers)
      await ctx.sleep(60)
      await fileWorker(spec, ctx)
      concurrentWorkers--
    }
    h = await createHarness({
      script: scriptsByRole({
        planner: completeWith({
          text: 'plan',
          structuredOutput: plan([
            plannedTask('alpha'),
            plannedTask('beta'),
            plannedTask('gamma', { dependencies: ['alpha', 'beta'] }),
          ]),
        }),
        worker,
        reviewer: completeWith({ text: 'review', structuredOutput: approvedReview }),
        verifier: completeWith({ text: 'verify', structuredOutput: passedVerification }),
      }),
    })

    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Create three files' })
    const done = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')

    const tasks = h.repos.tasks.listByRun(run.id)
    expect(tasks.map((t) => t.state)).toEqual(['completed', 'completed', 'completed'])
    expect(maxConcurrentWorkers).toBe(2)

    // Each writing task had its own worktree and branch.
    const worktrees = h.repos.worktrees.listByRun(run.id)
    const taskTrees = worktrees.filter((w) => w.taskId !== null)
    expect(new Set(taskTrees.map((w) => w.path)).size).toBe(3)
    expect(new Set(taskTrees.map((w) => w.branch)).size).toBe(3)

    // gamma started only after alpha and beta were merged into the integration branch.
    const started = (key: string): number =>
      h.events.find((e) => e.type === 'task.started' && e.taskId === tasks.find((t) => t.key === key)?.id)?.seq ?? -1
    const completed = (key: string): number =>
      h.events.find((e) => e.type === 'task.completed' && e.taskId === tasks.find((t) => t.key === key)?.id)?.seq ?? -1
    expect(started('gamma')).toBeGreaterThan(completed('alpha'))
    expect(started('gamma')).toBeGreaterThan(completed('beta'))

    // All work is on the integration branch; the user's checkout is untouched.
    const integration = worktrees.find((w) => w.taskId === null)
    expect(integration).toBeDefined()
    for (const key of ['alpha', 'beta', 'gamma']) {
      expect(existsSync(join(integration?.path ?? '', `${key}.txt`))).toBe(true)
      expect(existsSync(join(h.repoDir, `${key}.txt`))).toBe(false)
    }

    // Independent review and verification happened for every task, plus mission verification.
    expect(h.repos.reviews.listByRun(run.id)).toHaveLength(3)
    const verifications = h.repos.verifications.listByRun(run.id)
    expect(verifications.filter((v) => v.kind === 'verifier' && v.taskId !== null)).toHaveLength(3)
    expect(verifications.some((v) => v.kind === 'verifier' && v.taskId === null && v.passed)).toBe(true)

    // Reviewer context contains the diff but nothing from the worker's transcript.
    const reviewSpec = h.runtime.sessions.find((s) => s.role === 'reviewer')
    expect(reviewSpec?.prompt).toContain('.txt')
    expect(reviewSpec?.prompt).not.toContain('Created alpha.txt')
    expect(reviewSpec?.tools).not.toContain('Write')
  })
})
