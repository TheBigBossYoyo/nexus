import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { NexusError } from '@shared/result'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { createHarness, git, keyOf, plan, plannedTask, scenarioScript, sessionsOf, writeFiles, type Harness } from './harness'

async function snapshotTree(root: string, dir = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(out, await snapshotTree(root, rel))
    else out[rel] = (await readFile(join(root, rel))).toString('base64')
  }
  return out
}

describe('scenario: the user\'s checkout is never touched', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('a dirty working tree survives a full run byte for byte; the work lives only on nexus/* branches', async () => {
    const docsWorker: FakeScript = async (spec, ctx) => {
      // Edits a file the user is also editing, plus a new file; both must stay inside the worktree.
      const files = keyOf(spec) === 'docs' ? { 'README.md': '# rewritten by the agent', 'docs.txt': 'docs' } : undefined
      const ok = await writeFiles(spec, ctx, files)
      await ctx.completeTurn({ text: ok ? 'done' : 'denied' })
    }
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('docs', { suggestedFiles: ['README.md', 'docs.txt'] }), plannedTask('api')]),
        worker: docsWorker,
      }),
    })
    // The user has unstaged edits, a staged edit and untracked files (one nested).
    await writeFile(join(h.repoDir, 'README.md'), '# scenario repo\nmy local notes, not committed\n')
    await writeFile(join(h.repoDir, 'shared.txt'), 'line 1\nstaged line\n')
    await git(h.repoDir, 'add', 'shared.txt')
    await writeFile(join(h.repoDir, 'scratch.txt'), 'untracked scratch')
    await mkdir(join(h.repoDir, 'notes'))
    await writeFile(join(h.repoDir, 'notes', 'idea.md'), 'untracked idea\r\nwith CRLF\r\n')

    const before = {
      tree: await snapshotTree(h.repoDir),
      status: await git(h.repoDir, 'status', '--porcelain=v1', '-z'),
      head: await git(h.repoDir, 'rev-parse', 'HEAD'),
      branch: await git(h.repoDir, 'symbolic-ref', '--short', 'HEAD'),
      index: await git(h.repoDir, 'ls-files', '--stage'),
      stash: await git(h.repoDir, 'stash', 'list'),
    }

    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    expect(await snapshotTree(h.repoDir)).toEqual(before.tree)
    expect(await git(h.repoDir, 'status', '--porcelain=v1', '-z')).toBe(before.status)
    expect(await git(h.repoDir, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(await git(h.repoDir, 'symbolic-ref', '--short', 'HEAD')).toBe(before.branch)
    expect(await git(h.repoDir, 'ls-files', '--stage')).toBe(before.index)
    expect(await git(h.repoDir, 'stash', 'list')).toBe(before.stash)
    expect(existsSync(join(h.repoDir, 'docs.txt'))).toBe(false)
    expect(existsSync(join(h.repoDir, 'api.txt'))).toBe(false)

    // All new work is on nexus/<run>/* branches; the user's branch ref did not move.
    const branches = (await git(h.repoDir, 'branch', '--format=%(refname:short)')).split('\n')
    expect(branches.filter((b) => !b.startsWith('nexus/'))).toEqual(['main'])
    const integrationBranch = h.repos.runs.require(run.id).integrationBranch ?? ''
    expect(integrationBranch).toMatch(/^nexus\/.+\/integration$/)
    expect((await git(h.repoDir, 'ls-tree', '-r', '--name-only', integrationBranch)).split('\n')).toEqual(
      expect.arrayContaining(['docs.txt', 'api.txt', 'README.md']),
    )
    // The agent started from the committed HEAD, not from the user's uncommitted edits.
    expect(await git(h.repoDir, 'show', `${integrationBranch}:README.md`)).toBe('# rewritten by the agent')
    expect(await git(h.repoDir, 'show', `${integrationBranch}:shared.txt`)).toBe('line 1')
    expect(await git(h.repoDir, 'rev-parse', 'main')).toBe(before.head)
    // Every worktree lives under the NEXUS data dir, never inside the user's repository.
    for (const w of h.repos.worktrees.listByRun(run.id)) expect(w.path.startsWith(h.worktreesDir)).toBe(true)
  })

  it('rejects BUILD mode in a folder that is not a Git repository but accepts ASK mode there', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('x')]), researcher: async (_spec, ctx) => ctx.completeTurn({ text: 'The answer is 42.' }) }),
    })
    const plainDir = join(h.dir, 'plain-folder')
    await mkdir(plainDir)
    await writeFile(join(plainDir, 'notes.txt'), 'hello')
    const base = h.project.profile
    const project: Project = h.repos.projects.insert({
      id: newId(),
      name: 'plain',
      rootPath: plainDir,
      profile: base ? { ...base, repoRoot: plainDir, isGitRepo: false, currentBranch: null, headCommit: null } : null,
      respectProjectClaudeConfig: false,
      createdAt: nowIso(),
      lastOpenedAt: nowIso(),
    })

    for (const mode of ['build', 'swarm', 'repair'] as const) {
      const error = await h.orchestrator
        .createRun({ projectId: project.id, mode, preset: 'balanced', prompt: 'do things' })
        .then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(NexusError)
      expect((error as NexusError).code).toBe('not_a_repository')
      expect((error as NexusError).message).toContain('not a Git repository')
    }
    expect(h.repos.runs.listByProject(project.id)).toHaveLength(0)

    const run = await h.orchestrator.createRun({ projectId: project.id, mode: 'ask', preset: 'balanced', prompt: 'What is in this folder?' })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(run.baseBranch).toBeNull()
    expect(h.repos.worktrees.listByRun(run.id)).toHaveLength(0)
    const tasks = h.repos.tasks.listByRun(run.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ kind: 'ask', state: 'completed', resultSummary: 'The answer is 42.' })
    expect(await readdir(plainDir)).toEqual(['notes.txt'])
    expect(sessionsOf(h, 'researcher')[0]?.cwd).toBe(plainDir)
  })
})
