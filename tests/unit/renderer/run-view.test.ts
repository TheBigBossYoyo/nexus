import { describe, expect, it } from 'vitest'
import type { ReviewFinding, Task } from '@shared/domain'
import type { RunEvent } from '@shared/events'
import { buildGraphModel, layoutGraph, isEdgeSatisfied } from '../../../src/renderer/src/views/run/graph/graphModel'
import {
  describeEvent,
  eventCategory,
  eventTone,
  mergeEvents,
  pauseDetailFromEvents,
  toolActivityFromEvents,
} from '../../../src/renderer/src/views/run/eventText'
import { annotateFile, normalizePath, ownersByPath, parsePatch, sortFindings } from '../../../src/renderer/src/views/run/diffModel'
import { validateAddTask } from '../../../src/renderer/src/views/run/addTaskForm'

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    runId: 'r1',
    key: id,
    title: id,
    description: 'd',
    role: 'worker',
    kind: 'implement',
    state: 'ready',
    priority: 0,
    complexity: 'small',
    risk: 'low',
    parallelizable: true,
    requiresApproval: false,
    approvalGranted: false,
    suggestedFiles: [],
    acceptanceCriteria: [],
    attempt: 0,
    repairCycles: 0,
    parentTaskId: null,
    modelTierOverride: null,
    branch: null,
    worktreeId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    resultSummary: null,
    blockedReason: null,
    error: null,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

function event<T extends RunEvent['type']>(seq: number, type: T, payload: unknown, extra: Partial<RunEvent> = {}): RunEvent {
  return {
    id: `e${seq}`,
    seq,
    runId: 'r1',
    taskId: null,
    agentId: null,
    type,
    payload: payload as RunEvent['payload'],
    createdAt: '2026-01-01T10:00:00Z',
    ...extra,
  }
}

describe('task graph model', () => {
  const tasks = [task('a'), task('b'), task('c'), task('fix', { parentTaskId: 'b', kind: 'repair' })]
  const deps = [
    { taskId: 'b', dependsOnTaskId: 'a' },
    { taskId: 'c', dependsOnTaskId: 'b' },
    { taskId: 'c', dependsOnTaskId: 'ghost' },
  ]

  it('builds dependency and repair edges and drops unknown endpoints', () => {
    const m = buildGraphModel(tasks, deps)
    expect(m.edges.map((e) => `${e.id}:${e.kind}`).sort()).toEqual(['a->b:dependency', 'b->c:dependency', 'b->fix:repair'])
  })

  it('signature ignores task state changes but reacts to new nodes or edges', () => {
    const before = buildGraphModel(tasks, deps).signature
    const running = tasks.map((t) => (t.id === 'a' ? { ...t, state: 'running' as const } : t))
    expect(buildGraphModel(running, deps).signature).toBe(before)
    expect(buildGraphModel([...tasks, task('d')], deps).signature).not.toBe(before)
    expect(buildGraphModel(tasks, [...deps, { taskId: 'c', dependsOnTaskId: 'a' }]).signature).not.toBe(before)
  })

  it('lays dependencies out top to bottom', () => {
    const m = buildGraphModel(tasks, deps)
    const pos = layoutGraph(m)
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c', 'fix'])
    expect(pos.a!.y).toBeLessThan(pos.b!.y)
    expect(pos.b!.y).toBeLessThan(pos.c!.y)
    expect(layoutGraph(m)).toEqual(pos)
  })

  it('treats an edge as satisfied once its source completed', () => {
    const m = buildGraphModel(tasks, deps)
    const edge = m.edges.find((e) => e.id === 'a->b')!
    const byId = new Map(tasks.map((t) => [t.id, t]))
    expect(isEdgeSatisfied(edge, byId)).toBe(false)
    byId.set('a', { ...byId.get('a')!, state: 'completed' })
    expect(isEdgeSatisfied(edge, byId)).toBe(true)
  })
})

describe('event rendering', () => {
  it('describes events in words and categorizes them', () => {
    const e = event(1, 'task.failed', { what: 'tests failed', where: 'src/a.ts', why: null, retryable: true })
    expect(describeEvent(e)).toBe('Task failed: tests failed at src/a.ts (retryable)')
    expect(eventCategory('checks.completed')).toBe('verification')
    expect(eventCategory('message.sent')).toBe('agent')
    expect(eventCategory('plan.approved')).toBe('run')
    expect(eventCategory('git.merged')).toBe('git')
  })

  it('shows a flaky check with the warning tone', () => {
    const e = event(1, 'checks.flaky', { files: ['a.test.ts', 'b.test.ts'] })
    expect(describeEvent(e)).toBe('Failed once, passed when run again: a.test.ts, b.test.ts')
    expect(eventTone(e)).toBe('warning')
  })

  it('pairs tool starts with completions and keeps denials', () => {
    const rows = toolActivityFromEvents([
      event(1, 'agent.tool.started', { toolUseId: 't1', toolName: 'Bash', summary: 'pnpm test' }, { agentId: 'a1' }),
      event(2, 'agent.tool.started', { toolUseId: 't2', toolName: 'Edit', summary: 'a.ts' }, { agentId: 'a1' }),
      event(3, 'agent.tool.completed', { toolUseId: 't1', toolName: 'Bash', isError: true }, { agentId: 'a1' }),
      event(4, 'agent.tool.denied', { toolName: 'Bash', reason: 'rm -rf' }, { agentId: 'a1' }),
    ])
    expect(rows.map((r) => r.status)).toEqual(['error', 'running', 'denied'])
  })

  it('takes the pause detail from the latest paused event, else the state change reason', () => {
    expect(
      pauseDetailFromEvents([
        event(1, 'run.state_changed', { from: 'executing', to: 'paused', reason: 'quota' }),
        event(2, 'run.paused', { reason: 'quota', detail: 'resets at 17:00' }),
      ]),
    ).toBe('resets at 17:00')
    expect(pauseDetailFromEvents([event(1, 'run.state_changed', { from: 'executing', to: 'paused', reason: 'user asked' })])).toBe('user asked')
    expect(pauseDetailFromEvents([event(1, 'run.started', {})])).toBeNull()
  })

  it('merges pages by seq without duplicates', () => {
    const a = [event(1, 'run.started', {}), event(2, 'run.resumed', {})]
    const merged = mergeEvents(a, [event(2, 'run.resumed', {}), event(3, 'run.cancelled', {})])
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(mergeEvents(merged, [event(3, 'run.cancelled', {})])).toBe(merged)
  })
})

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+two changed
+three
 four
`

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  title: 'f',
  description: 'd',
  evidence: 'e',
  severity: 'medium',
  category: 'correctness',
  file: 'src/a.ts',
  lineStart: 2,
  lineEnd: null,
  confidence: 'high',
  suggestedCorrection: null,
  ...over,
})

describe('diff model', () => {
  it('parses a patch and anchors findings to the matching new-side line', () => {
    const parsed = parsePatch(PATCH)
    expect(parsed.error).toBeNull()
    expect(parsed.files).toHaveLength(1)
    const hunks = parsed.files[0]!.hunks
    const { anchored, unanchored } = annotateFile(hunks, [finding({ lineStart: 2 }), finding({ lineStart: null }), finding({ lineStart: 99 })])
    expect(Object.values(anchored).flat()).toHaveLength(1)
    expect(unanchored).toHaveLength(2)
  })

  it('treats an empty patch as no files', () => {
    expect(parsePatch('')).toEqual({ files: [], error: null })
  })

  it('normalizes paths, derives owners and sorts findings by severity', () => {
    expect(normalizePath('.\\src\\a.ts')).toBe('src/a.ts')
    const owners = ownersByPath([
      { taskKey: 't1', files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }] },
      { taskKey: 't2', files: [{ path: 'src\\a.ts', status: 'modified', additions: 1, deletions: 0 }] },
    ])
    expect(owners.get('src/a.ts')).toEqual(['t1', 't2'])
    expect(sortFindings([finding({ severity: 'nit' }), finding({ severity: 'critical' })]).map((f) => f.severity)).toEqual(['critical', 'nit'])
  })
})

describe('add task validation', () => {
  it('requires a title and description', () => {
    const base = { title: '', description: '', role: 'worker' as const, dependsOn: [] as string[], suggestedFiles: '', criteria: '', complexity: 'small' as const, } satisfies Record<string, unknown>
    expect(Object.keys(validateAddTask(base)).sort()).toEqual(['description', 'title'])
    expect(validateAddTask({ ...base, title: 'x', description: 'y' })).toEqual({})
  })
})
