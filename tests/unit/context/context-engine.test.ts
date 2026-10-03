import { describe, expect, it } from 'vitest'
import type { Decision, MemoryEntry, ReviewFinding, Run } from '@shared/domain'
import type { RepositoryFact } from '@shared/v2'
import { composeContext, MAX_EXCLUDED_ENTRIES, packForPrompt, withBlock, type ComposeContextInput } from '@main/modules/context/context-engine'
import { makeTask } from '../scheduler/factories'

const checks = { build: null, test: 'pnpm test', lint: null, typecheck: null }

const run = {
  id: 'run-1',
  projectId: 'p1',
  mode: 'build',
  preset: 'balanced',
  state: 'executing',
  prompt: 'x',
  plan: null,
  baseBranch: 'main',
  baseCommit: 'abc',
  integrationBranch: 'nexus/run-1',
  config: { checks },
} as unknown as Run

const task = makeTask('endpoint', { title: 'Implement the server endpoint', description: 'Add the handler.', suggestedFiles: ['src/api/server.ts'], attempt: 1 })

function fact(over: Partial<RepositoryFact> & Pick<RepositoryFact, 'id' | 'subject'>): RepositoryFact {
  return { projectId: 'p1', kind: 'module', statement: 'statement', source: 'agent', confidence: 'high', files: [], fingerprint: 'f', stale: false, createdAt: 't', verifiedAt: 't', ...over }
}

function input(over: Partial<ComposeContextInput> = {}): ComposeContextInput {
  return {
    run,
    task,
    purpose: 'implement',
    missionCriteria: [],
    dependencies: [],
    tasks: [task],
    decisions: [],
    facts: [],
    memorySelected: [],
    memoryExcluded: [],
    messages: [],
    repo: { worktreePath: 'C:\\wt', branch: 'b', baseCommit: 'abc', projectName: 'demo', checks },
    priorReview: null,
    ...over,
  }
}

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  title: 'Bug',
  description: 'desc',
  evidence: 'ev',
  severity: 'high',
  category: 'correctness',
  file: null,
  lineStart: null,
  lineEnd: null,
  confidence: 'high',
  suggestedCorrection: null,
  ...over,
})

describe('composeContext', () => {
  it('always includes the task, its criteria and the worktree, and renders them', () => {
    const { prompt, pack } = composeContext(input())
    expect(pack.entries.filter((e) => e.included).map((e) => e.sourceKind)).toEqual(['task', 'criteria', 'worktree'])
    expect(prompt).toContain('Implement the server endpoint')
    expect(pack.totalChars).toBe(prompt.length)
    expect(pack.taskId).toBe(task.id)
    expect(pack.agentId).toBeNull()
  })

  it('selects facts by files, drops stale and irrelevant ones with reasons, and respects the fact budget', () => {
    const relevant = Array.from({ length: 4 }, (_, i) => fact({ id: `rel${i}`, subject: `src/api/m${i}`, files: ['src/api/server.ts'], statement: `RELEVANT-${i}` }))
    const stale = fact({ id: 'old', subject: 'src/api/old', files: ['src/api/server.ts'], stale: true, statement: 'STALE-TEXT' })
    const unrelated = fact({ id: 'far', subject: 'docs/guide', files: ['docs/guide.md'], statement: 'FAR-TEXT' })
    const { prompt, pack } = composeContext(input({ facts: [...relevant, stale, unrelated], factLimit: 3 }))
    const byId = new Map(pack.entries.map((e) => [e.sourceId, e]))
    expect(relevant.filter((f) => byId.get(f.id)?.included)).toHaveLength(3)
    expect(byId.get('rel3')?.reason).toMatch(/over the section budget of 3/)
    expect(byId.get('old')).toMatchObject({ included: false })
    expect(byId.get('old')?.reason).toMatch(/Stale/)
    expect(byId.get('far')?.reason).toMatch(/Not relevant/)
    expect(prompt).toContain('## Repository intelligence')
    expect(prompt).not.toContain('STALE-TEXT')
    expect(prompt).not.toContain('FAR-TEXT')
  })

  it('classifies decisions by who recorded them', () => {
    const upstream = makeTask('up', { role: 'worker' })
    const architect = makeTask('arch', { role: 'architect' })
    const stranger = makeTask('stranger', { role: 'worker' })
    const decision = (id: string, taskId: string | null): Decision => ({ id, runId: 'run-1', taskId, agentId: null, title: `D-${id}`, decision: `TEXT-${id}`, rationale: 'because', createdAt: 't' })
    const { prompt, pack } = composeContext(
      input({
        dependencies: [upstream],
        tasks: [task, upstream, architect, stranger],
        decisions: [decision('run', null), decision('up', upstream.id), decision('arch', architect.id), decision('far', stranger.id)],
      }),
    )
    const included = Object.fromEntries(pack.entries.filter((e) => e.sourceKind === 'decision').map((e) => [e.title, e.included]))
    expect(included).toEqual({ 'D-run': true, 'D-up': true, 'D-arch': true, 'D-far': false })
    expect(prompt).toContain('TEXT-up')
    expect(prompt).not.toContain('TEXT-far')
  })

  it('keeps memory that shares a term or file with the task and drops the rest, including stop-word matches', () => {
    const memory = (id: string, title: string, content: string, filePaths: string[] = []): MemoryEntry => ({
      id, scope: 'project', projectId: 'p1', runId: null, taskId: null, agentId: null, kind: 'note', title, content, tags: [], filePaths, source: 'user', evidence: null, status: 'approved', createdAt: 't',
    })
    const { prompt, pack } = composeContext(
      input({
        memorySelected: [memory('m1', 'Server handlers', 'MEM-ONE validate input'), memory('m2', 'By file', 'MEM-TWO', ['src/api/server.ts']), memory('m3', 'Compost', 'MEM-THREE water the bin')],
        memoryExcluded: [memory('m4', 'Elsewhere', 'MEM-FOUR')],
      }),
    )
    const byId = new Map(pack.entries.map((e) => [e.sourceId, e]))
    expect([...['m1', 'm2', 'm3', 'm4']].map((id) => byId.get(id)?.included)).toEqual([true, true, false, false])
    expect(prompt).toContain('MEM-ONE')
    expect(prompt).not.toContain('MEM-THREE')
  })

  it('shows prior review findings only to implement and diagnose sessions, and only the significant ones', () => {
    const prior = { reviewId: 'rev', findings: [finding({ title: 'Blocking' }), finding({ title: 'Cosmetic', severity: 'low' })] }
    const implement = composeContext(input({ priorReview: prior }))
    expect(implement.prompt).toContain('## Review findings to address')
    expect(implement.prompt).toContain('Blocking')
    expect(implement.prompt).not.toContain('Cosmetic')
    expect(implement.pack.entries.find((e) => e.title.includes('Cosmetic'))).toMatchObject({ included: false })
    const research = composeContext(input({ purpose: 'research', priorReview: prior }))
    expect(research.prompt).not.toContain('Review findings to address')
    expect(research.pack.entries.filter((e) => e.sourceKind === 'review_finding').every((e) => !e.included)).toBe(true)
  })

  it('records at most MAX_EXCLUDED_ENTRIES excluded candidates and keeps every included one', () => {
    const facts = Array.from({ length: 100 }, (_, i) => fact({ id: `x${i}`, subject: `other/${i}`, files: [`other/${i}.ts`], statement: 'zzz' }))
    const { pack } = composeContext(input({ facts }))
    expect(pack.entries.filter((e) => !e.included)).toHaveLength(MAX_EXCLUDED_ENTRIES)
    expect(pack.entries.filter((e) => e.included).length).toBeGreaterThanOrEqual(3)
  })

  it('packForPrompt and withBlock describe prompts built elsewhere', () => {
    const pack = packForPrompt({ run, task, purpose: 'diagnose', agentId: 'a1', prompt: 'hello world', blocks: [{ section: 'Failure', sourceKind: 'failure', title: 'f', reason: 'why', chars: 5 }] })
    expect(pack).toMatchObject({ agentId: 'a1', purpose: 'diagnose', totalChars: 11, taskId: task.id })
    expect(pack.entries).toHaveLength(1)
    const more = withBlock({ prompt: 'x', pack }, { section: 'Resume', sourceKind: 'handoff', title: 'r', reason: 'because', chars: 3 }, 'resume\n\nx')
    expect(more.pack.entries.map((e) => e.section)).toEqual(['Resume', 'Failure'])
    expect(more.pack.totalChars).toBe(9)
    expect(more.pack.entries.every((e) => e.packId === pack.id)).toBe(true)
  })
})
