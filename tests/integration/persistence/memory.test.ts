import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { toFtsQuery } from '@main/modules/persistence'
import { makeProject, makeRun, openMemory, seed } from './fixtures'

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: newId(),
    scope: 'project',
    projectId: null,
    runId: null,
    taskId: null,
    agentId: null,
    kind: 'fact',
    title: 'untitled',
    content: 'content',
    tags: [],
    filePaths: [],
    source: 'verifier',
    evidence: null,
    status: 'approved',
    createdAt: nowIso(),
    ...over,
  }
}

describe('memory repository', () => {
  it('round-trips entries with provenance and updates them', () => {
    const { repos } = openMemory()
    const { project, run, t1, agent } = seed(repos)
    const m = repos.memory.insert(
      entry({
        projectId: project.id,
        runId: run.id,
        taskId: t1.id,
        agentId: agent.id,
        title: 'Windows file locks',
        content: 'Retry rm on EBUSY',
        tags: ['windows', 'git'],
        filePaths: ['src\\main\\git.ts'],
        source: 'architect',
        evidence: 'commit abc123',
        status: 'proposed',
      }),
    )
    expect(repos.memory.require(m.id)).toEqual(m)
    const promoted = repos.memory.update(m.id, { status: 'approved' })
    expect(promoted.status).toBe('approved')
    expect(repos.memory.delete(m.id)).toBe(true)
    expect(repos.memory.get(m.id)).toBeNull()
  })

  it('ranks by bm25 and returns provenance with each hit', () => {
    const { repos } = openMemory()
    const { project } = seed(repos)
    const strong = repos.memory.insert(
      entry({
        projectId: project.id,
        title: 'Database migrations',
        content: 'Migrations run in a transaction. Migrations are TypeScript modules.',
        source: 'architect',
        evidence: 'docs/ARCHITECTURE.md',
      }),
    )
    const weak = repos.memory.insert(
      entry({ projectId: project.id, title: 'Logging', content: 'Logs rotate daily; see also migrations once.' }),
    )
    repos.memory.insert(entry({ projectId: project.id, title: 'Unrelated', content: 'Dark theme colors' }))
    const hits = repos.memory.search('migrations', { projectId: project.id })
    expect(hits.map((h) => h.id)).toEqual([strong.id, weak.id])
    expect(hits[0]).toMatchObject({ source: 'architect', evidence: 'docs/ARCHITECTURE.md' })
  })

  it('matches tags, file paths and stems', () => {
    const { repos } = openMemory()
    repos.memory.insert(entry({ title: 'a', content: 'b', tags: ['sqlite'], filePaths: ['src/main/persistence/database.ts'] }))
    expect(repos.memory.search('SQLITE')).toHaveLength(1)
    expect(repos.memory.search('database.ts')).toHaveLength(1)
    const m = repos.memory.insert(entry({ title: 'Running processes', content: 'x' }))
    expect(repos.memory.search('runs').map((e) => e.id)).toContain(m.id)
  })

  it('returns only approved entries unless another status is asked for', () => {
    const { repos } = openMemory()
    const approved = repos.memory.insert(entry({ title: 'lockfile', status: 'approved' }))
    const proposed = repos.memory.insert(entry({ title: 'lockfile idea', status: 'proposed' }))
    repos.memory.insert(entry({ title: 'lockfile bad', status: 'rejected' }))
    expect(repos.memory.search('lockfile').map((e) => e.id)).toEqual([approved.id])
    expect(repos.memory.search('lockfile', { status: 'proposed' }).map((e) => e.id)).toEqual([proposed.id])
    expect(repos.memory.search('lockfile', { status: 'any' })).toHaveLength(3)
  })

  it('filters by project (global entries stay visible), scope, run and limit', () => {
    const { repos } = openMemory()
    const { project, run } = seed(repos)
    const otherProject = repos.projects.insert(makeProject({ rootPath: 'C:\\other' }))
    const otherRun = repos.runs.insert(makeRun(project.id))
    const mine = repos.memory.insert(entry({ title: 'cache note', projectId: project.id }))
    const theirs = repos.memory.insert(entry({ title: 'cache note', projectId: otherProject.id }))
    const global = repos.memory.insert(entry({ title: 'cache note', scope: 'global' }))
    const myRun = repos.memory.insert(entry({ title: 'cache note', scope: 'run', projectId: project.id, runId: run.id }))
    const notMyRun = repos.memory.insert(
      entry({ title: 'cache note', scope: 'run', projectId: project.id, runId: otherRun.id }),
    )

    const ids = (r: MemoryEntry[]) => r.map((e) => e.id).sort()
    expect(ids(repos.memory.search('cache', { projectId: project.id, runId: run.id }))).toEqual(
      ids([mine, global, myRun]),
    )
    expect(ids(repos.memory.search('cache', { projectId: project.id }))).toEqual(ids([mine, global, myRun, notMyRun]))
    expect(repos.memory.search('cache', { scope: 'global' }).map((e) => e.id)).toEqual([global.id])
    expect(repos.memory.search('cache', { limit: 2 })).toHaveLength(2)
    expect(ids(repos.memory.list({ projectId: otherProject.id }))).toEqual(ids([theirs, global]))
  })

  it('keeps the FTS index in sync on update and delete', () => {
    const { repos } = openMemory()
    const m = repos.memory.insert(entry({ title: 'alpha', content: 'first' }))
    expect(repos.memory.search('alpha')).toHaveLength(1)
    repos.memory.update(m.id, { title: 'beta' })
    expect(repos.memory.search('alpha')).toHaveLength(0)
    expect(repos.memory.search('beta')).toHaveLength(1)
    repos.memory.delete(m.id)
    expect(repos.memory.search('beta')).toHaveLength(0)
  })

  it('cannot be broken by hostile query text', () => {
    const { repos } = openMemory()
    repos.memory.insert(entry({ title: 'quote handling', content: 'say "hello" (world) NEAR AND OR NOT *' }))
    const hostile = [
      '"unbalanced',
      'title:foo',
      'foo AND',
      'NOT',
      '(((',
      'a OR OR b',
      '* ^ -',
      'NEAR(a b)',
      "'; DROP TABLE memory; --",
      'hello"world',
      '',
      '   ',
      '---',
    ]
    for (const q of hostile) expect(() => repos.memory.search(q)).not.toThrow()
    expect(repos.memory.search('"hello" (world)')).toHaveLength(1)
    expect(repos.memory.search('NOT')).toHaveLength(1)
    expect(repos.memory.search('')).toEqual([])
  })

  it('toFtsQuery quotes and dedupes terms', () => {
    expect(toFtsQuery('Foo foo "bar" AND')).toBe('"foo" OR "bar" OR "and"')
    expect(toFtsQuery('-- ()')).toBeNull()
    expect(toFtsQuery('naïve café')).toBe('"naïve" OR "café"')
  })
})
