import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, git, scenarioScript, plan, plannedTask, type Harness } from './harness'

/**
 * 0.7.2: a read-only run that asks for it reads a worktree of its own at its base commit. The workspace planner
 * uses this, so that it plans from the commit that was admitted and not from whatever the checkout has become.
 */
describe('scenario: a read-only run on the admitted snapshot', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('reads the base commit, not the newer or uncommitted state of the checkout, and leaves nothing behind', async () => {
    const seen: { cwd: string; later: boolean; dirty: boolean; original: boolean }[] = []
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('unused')]),
        researcher: async (spec, ctx) => {
          seen.push({ cwd: spec.cwd, later: existsSync(join(spec.cwd, 'later.txt')), dirty: existsSync(join(spec.cwd, 'uncommitted.txt')), original: existsSync(join(spec.cwd, 'shared.txt')) })
          await ctx.completeTurn({ text: 'answer' })
        },
      }),
    })
    const admitted = await git(h.repoDir, 'rev-parse', 'HEAD')
    // The checkout moves on after the admission: a new commit and a file nobody committed.
    await writeFile(join(h.repoDir, 'later.txt'), 'committed after the admission\n')
    await git(h.repoDir, 'add', '-A')
    await git(h.repoDir, 'commit', '-m', 'later')
    await writeFile(join(h.repoDir, 'uncommitted.txt'), 'never committed\n')
    const branchesBefore = await git(h.repoDir, 'branch', '--list')

    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'ask', preset: 'balanced', prompt: 'What does this repository hold?', baseRef: admitted, readSnapshot: true })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    expect(seen).toHaveLength(1)
    expect(seen[0]!.cwd).not.toBe(h.repoDir)
    expect(seen[0]).toMatchObject({ original: true, later: false, dirty: false })

    // The snapshot is gone with the run: no worktree, no branch, and the user's checkout is as it was.
    await h.waitFor(() => h.repos.worktrees.listByRun(run.id).every((w) => w.state === 'removed'), 'the snapshot to be removed')
    expect(existsSync(seen[0]!.cwd)).toBe(false)
    let branches = ''
    for (let i = 0; i < 100 && branches !== branchesBefore; i++) {
      // Deleting the snapshot's branch rewrites .git/config; on Windows a read while it is replaced can fail with
      // "unable to access '.git/config': Permission denied" (seen once in a full run, 0.9.1). That is a moment, not an answer.
      branches = await git(h.repoDir, 'branch', '--list').catch(() => '')
      if (branches !== branchesBefore) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(branches).toBe(branchesBefore)
    expect(existsSync(join(h.repoDir, 'uncommitted.txt'))).toBe(true)
    expect(await git(h.repoDir, 'status', '--porcelain')).toBe('?? uncommitted.txt')
  })

  it('without the option a read-only run reads the checkout, as before', async () => {
    const seen: string[] = []
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('unused')]),
        researcher: async (spec, ctx) => {
          seen.push(spec.cwd)
          await ctx.completeTurn({ text: 'answer' })
        },
      }),
    })
    const run = await h.startRun({ mode: 'ask', prompt: 'What does this repository hold?' })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(seen).toEqual([h.repoDir])
    expect(h.repos.worktrees.listByRun(run.id)).toEqual([])
  })
})
