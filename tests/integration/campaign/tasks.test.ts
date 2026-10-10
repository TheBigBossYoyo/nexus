import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CAMPAIGN_TASKS, type Files } from '../../manual/campaign/tasks'

/**
 * The tasks of the real quality campaign, checked without any model: a hidden evaluation that passes on the
 * starting repository measures nothing, and one that no solution can pass wastes real usage. So for every
 * repository of every task: its own tests pass as given, the hidden evaluation fails as given, and with the
 * reference solution both pass.
 */

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function write(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function nodeTest(dir: string, args: string[] = []): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync('node', ['--test', ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('campaign tasks', () => {
  it('cover the eight categories, one task each', () => {
    expect(CAMPAIGN_TASKS.map((t) => t.category)).toEqual(['localized bugfix', 'cross-module bug', 'normal feature', 'refactor', 'architecture task', 'security-sensitive task', 'Program-style task', 'Workspace / cross-repository task'])
    expect(new Set(CAMPAIGN_TASKS.map((t) => t.key)).size).toBe(8)
  })

  for (const task of CAMPAIGN_TASKS) {
    for (const repo of task.repos) {
      it(`${task.key} / ${repo.name}: the hidden evaluation fails as given and passes with the reference solution`, () => {
        const dir = mkdtempSync(join(tmpdir(), `nexus-campaign-task-${task.key}-`))
        dirs.push(dir)
        write(dir, repo.files)
        const own = nodeTest(dir)
        expect(own.ok, `own tests as given:\n${own.output.slice(-1500)}`).toBe(true)

        write(dir, repo.hidden)
        const before = nodeTest(dir, Object.keys(repo.hidden))
        expect(before.ok, 'the hidden evaluation must fail on the starting repository').toBe(false)

        write(dir, repo.solution)
        const after = nodeTest(dir, Object.keys(repo.hidden))
        expect(after.ok, `hidden evaluation with the reference solution:\n${after.output.slice(-2500)}`).toBe(true)
        const all = nodeTest(dir)
        expect(all.ok, `every test with the reference solution:\n${all.output.slice(-1500)}`).toBe(true)
        // The request never contains the hidden evaluation's file names or a knowledge entry's text.
        for (const name of Object.keys(repo.hidden)) expect(task.prompt).not.toContain(name)
      }, 120_000)
    }
  }

  it('workspace: the reference solution keeps the consumer copy identical to the provider', () => {
    const ws = CAMPAIGN_TASKS.find((t) => t.kind === 'workspace')!
    const [provider, consumer] = ws.repos
    expect(consumer!.solution[ws.contract!.copyPath]).toBe(provider!.solution[ws.contract!.path])
    expect(consumer!.files[ws.contract!.copyPath]).toBe(provider!.files[ws.contract!.path])
  })
})
