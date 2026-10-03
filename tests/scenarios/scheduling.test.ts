import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { runProcess } from '@main/modules/process'
import { createHarness, git, keyOf, plan, plannedTask, scenarioScript, writeFiles, type Harness } from './harness'

describe('scenario: dependency ordering and file-overlap serialization', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('task C waits for A and B and starts in a worktree that already contains both merged results', async () => {
    const seenAtStart: Record<string, string[]> = {}
    const worker: FakeScript = async (spec, ctx) => {
      const key = keyOf(spec)
      seenAtStart[key] = ['a.txt', 'b.txt', 'c.txt'].filter((f) => existsSync(join(spec.cwd, f)))
      await ctx.sleep(40)
      await writeFiles(spec, ctx)
      await ctx.completeTurn({ text: `Created ${key}.txt` })
    }
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('a'), plannedTask('b'), plannedTask('c', { dependencies: ['a', 'b'] })]),
        worker,
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    expect(seenAtStart['a']).toEqual([])
    expect(seenAtStart['b']).toEqual([])
    expect(seenAtStart['c']).toEqual(['a.txt', 'b.txt'])

    // Durable ordering: C starts after both dependencies completed and were merged.
    const seqOf = (type: 'task.started' | 'task.completed' | 'git.merged', key: string): number => {
      const taskId = h.task(run.id, key).id
      return h.eventsOfType(run.id, type).find((e) => e.taskId === taskId)?.seq ?? -1
    }
    expect(seqOf('task.started', 'c')).toBeGreaterThan(seqOf('git.merged', 'a'))
    expect(seqOf('task.started', 'c')).toBeGreaterThan(seqOf('git.merged', 'b'))
    expect(seqOf('git.merged', 'a')).toBeGreaterThan(-1)

    // C's own branch has the dependency files in its history; the integration branch has all three.
    const cBranch = h.task(run.id, 'c').branch ?? ''
    const files = (await git(h.repoDir, 'ls-tree', '-r', '--name-only', cBranch)).split('\n')
    expect(files).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'c.txt']))
    const integrationFiles = (await git(h.repoDir, 'ls-tree', '-r', '--name-only', h.repos.runs.require(run.id).integrationBranch ?? '')).split('\n')
    expect(integrationFiles).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'c.txt']))
  })

  it('serializes tasks with overlapping suggested files while a disjoint task runs alongside', async () => {
    const intervals: { key: string; start: number; end: number }[] = []
    let clock = 0
    let cStarted = false
    const worker: FakeScript = async (spec, ctx) => {
      const key = keyOf(spec)
      const start = ++clock
      if (key === 'c') cStarted = true
      // The overlapping tasks hold their slot until the disjoint task is also running.
      if (key !== 'c') for (let i = 0; i < 400 && !cStarted; i++) await ctx.sleep(10)
      await writeFiles(spec, ctx)
      await ctx.completeTurn({ text: `Created ${key}.txt` })
      intervals.push({ key, start, end: ++clock })
    }
    h = await createHarness({
      script: scenarioScript({
        plan: plan([
          plannedTask('a', { suggestedFiles: ['src/shared.ts', 'a.txt'] }),
          plannedTask('b', { suggestedFiles: ['src/shared.ts', 'b.txt'] }),
          plannedTask('c', { suggestedFiles: ['docs/other.md', 'c.txt'] }),
        ]),
        worker,
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const serialized = h.eventsOfType(run.id, 'task.serialized')
    expect(serialized).toHaveLength(1)
    const event = serialized[0]
    const deferred = h.repos.tasks.require(event?.taskId ?? '')
    const first = h.repos.tasks.require(event?.payload.conflictsWith ?? '')
    expect(new Set([deferred.key, first.key])).toEqual(new Set(['a', 'b']))
    expect(event?.payload.files).toContain('src/shared.ts')

    const span = (key: string) => intervals.find((i) => i.key === key) as { start: number; end: number }
    // The overlapping pair never overlapped in time; the deferred one began after the first one ended.
    expect(span(deferred.key).start).toBeGreaterThan(span(first.key).end)
    // The disjoint task ran alongside the first of the pair.
    expect(span('c').start).toBeLessThan(span(first.key).end)
    expect(span('c').end).toBeLessThan(span(deferred.key).end)
    expect(h.repos.tasks.listByRun(run.id).every((t) => t.state === 'completed')).toBe(true)
  })

  it('detects a genuine merge conflict, routes it to repair and never leaves the integration worktree mid-merge', async () => {
    let started = 0
    const worker: FakeScript = async (spec, ctx) => {
      const key = keyOf(spec)
      started++
      // Both tasks must have branched from the same integration tip before either one merges.
      for (let i = 0; i < 400 && started < 2; i++) await ctx.sleep(10)
      await writeFiles(spec, ctx, { 'shared.txt': `line 1 changed by ${key}` })
      await ctx.completeTurn({ text: `Edited shared.txt (${key})` })
    }
    const midMerge: boolean[] = []
    const debuggerScript: FakeScript = async (spec, ctx) => {
      const run = h.repos.runs.listByProject(h.project.id)[0]
      const integration = h.integration(run?.id ?? '')
      midMerge.push(await h.git.isMergeInProgress(integration.path))
      const merged = await runProcess('git', ['merge', '--no-commit', '--no-ff', run?.integrationBranch ?? ''], { cwd: spec.cwd })
      expect(merged.exitCode).toBe(1)
      const ok = await writeFiles(spec, ctx, { 'shared.txt': 'line 1 resolved: both changes kept' })
      await git(spec.cwd, 'add', '-A')
      await git(spec.cwd, 'commit', '--no-edit')
      await ctx.completeTurn({ text: ok ? 'Resolved the merge conflict' : 'denied' })
    }
    h = await createHarness({
      script: scenarioScript({
        plan: plan([
          plannedTask('x', { suggestedFiles: ['x.txt'] }),
          plannedTask('y', { suggestedFiles: ['y.txt'] }),
        ]),
        worker,
        debugger: debuggerScript,
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const conflicts = h.eventsOfType(run.id, 'git.conflict')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.payload.files).toEqual(['shared.txt'])
    const conflicted = h.repos.tasks.require(conflicts[0]?.taskId ?? '')

    const repairs = h.repos.tasks.listByRun(run.id).filter((t) => t.kind === 'repair')
    expect(repairs).toHaveLength(1)
    expect(repairs[0]?.parentTaskId).toBe(conflicted.id)
    expect(repairs[0]?.state).toBe('completed')
    expect(conflicted.repairCycles).toBe(1)
    expect(conflicted.state).toBe('completed')

    // The integration worktree was never mid-merge, neither during the repair nor at the end.
    expect(midMerge).toEqual([false])
    const integration = h.integration(run.id)
    expect(await h.git.isMergeInProgress(integration.path)).toBe(false)
    expect((await h.git.status(integration.path)).clean).toBe(true)
    expect(await readFile(join(integration.path, 'shared.txt'), 'utf8')).toContain('line 1 resolved')
    expect(h.eventsOfType(run.id, 'git.merged')).toHaveLength(2)
  })
})
