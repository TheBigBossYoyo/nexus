import { describe, expect, it } from 'vitest'
import type { Review } from '@shared/domain'
import type { RunEvent } from '@shared/events'
import type { ContextPack, GraphRevision, GraphSnapshotTask, RepositoryFact } from '@shared/v2'
import {
  addedInRevision,
  cancelledInRevision,
  deriveHealth,
  diffSnapshots,
  formatRate,
  groupFacts,
  groupPackSections,
  highlightRevision,
  isEmptyDiff,
  latestRevision,
  planVersion,
  readArbitration,
} from '../../../src/renderer/src/lib/v2logic'
import { describeEvent, eventCategory } from '../../../src/renderer/src/views/run/eventText'
import { keysForEvent } from '../../../src/renderer/src/lib/push'
import { qk } from '../../../src/renderer/src/lib/queries'

const task = (id: string, extra: Partial<GraphSnapshotTask> = {}): GraphSnapshotTask => ({
  id,
  key: `k-${id}`,
  title: `Task ${id}`,
  role: 'implementer',
  kind: 'implementation',
  state: 'ready',
  priority: 0,
  parentTaskId: null,
  ...extra,
})

const rev = (version: number, tasks: GraphSnapshotTask[], deps: [string, string][] = []): GraphRevision => ({
  id: `r${version}`,
  runId: 'run',
  version,
  reason: `rev ${version}`,
  proposalId: null,
  createdAt: '2026-10-03T00:00:00Z',
  snapshot: { tasks, dependencies: deps.map(([taskId, dependsOnTaskId]) => ({ taskId, dependsOnTaskId })) },
})

describe('revision diff', () => {
  const v1 = rev(1, [task('a'), task('b'), task('c')], [['b', 'a'], ['c', 'b']])
  const v2 = rev(
    2,
    [task('a', { state: 'completed' }), task('b', { state: 'cancelled' }), task('d'), task('e', { kind: 'repair' })],
    [['d', 'a'], ['c', 'a']],
  )

  it('reports added, removed and changed tasks and dependency edges with keys', () => {
    const d = diffSnapshots(v1.snapshot, v2.snapshot)
    expect(d.addedTasks.map((t) => t.key)).toEqual(['k-d', 'k-e'])
    expect(d.removedTasks.map((t) => t.key)).toEqual(['k-c'])
    expect(d.changedTasks).toEqual([
      { taskId: 'a', key: 'k-a', changes: ['state: ready → completed'] },
      { taskId: 'b', key: 'k-b', changes: ['state: ready → cancelled'] },
    ])
    expect(d.addedDependencies).toEqual([
      { taskKey: 'k-c', dependsOnKey: 'k-a' },
      { taskKey: 'k-d', dependsOnKey: 'k-a' },
    ])
    expect(d.removedDependencies.map((x) => `${x.taskKey}<${x.dependsOnKey}`)).toEqual(['k-b<k-a', 'k-c<k-b'])
  })

  it('is empty for identical snapshots', () => {
    expect(isEmptyDiff(diffSnapshots(v1.snapshot, v1.snapshot))).toBe(true)
  })

  it('finds the plan version and latest revision, defaulting to v1', () => {
    expect(planVersion([])).toBe(1)
    expect(planVersion([v2, v1])).toBe(2)
    expect(latestRevision([v1, v2])?.id).toBe('r2')
    expect(latestRevision([])).toBeNull()
  })

  it('marks tasks by the revision that added them, excluding v1 and repair tasks', () => {
    const m = addedInRevision([v2, v1])
    expect(m.get('d')).toBe(2)
    expect(m.has('a')).toBe(false)
    expect(m.has('e')).toBe(false)
  })

  it('finds the revision that cancelled a task', () => {
    expect(cancelledInRevision([v1, v2]).get('b')).toBe(2)
  })

  it('highlights what a revision did relative to its predecessor', () => {
    const h = highlightRevision([v1, v2], 2)
    expect([...h.added].sort()).toEqual(['d', 'e'])
    expect([...h.changed].sort()).toEqual(['a', 'b'])
    expect([...h.removed]).toEqual(['c'])
    expect(highlightRevision([v1, v2], 1).added.size).toBe(3)
    expect(highlightRevision([v1, v2], 9).added.size).toBe(0)
  })
})

describe('deriveHealth', () => {
  const run = { state: 'executing' as const, pauseReason: null }
  it('is on track with nothing wrong', () => {
    const h = deriveHealth(run, [{ state: 'running', blockedReason: null }], [])
    expect(h.level).toBe('ok')
    expect(h.reasons).toEqual([])
  })
  it('needs attention for blocked tasks, approvals or pauses', () => {
    expect(deriveHealth(run, [{ state: 'blocked', blockedReason: 'x' }], []).level).toBe('attention')
    expect(deriveHealth(run, [], [{ id: 'a' }]).reasons).toEqual(['1 pending approval'])
    const paused = deriveHealth({ state: 'paused', pauseReason: 'quota' }, [], [])
    expect(paused.level).toBe('attention')
    expect(paused.reasons).toEqual(['paused (quota)'])
  })
  it('is at risk for failed tasks or a failed run, and lists every reason', () => {
    const failed = { state: 'failed' as const, blockedReason: null }
    const h = deriveHealth(run, [failed, failed, { state: 'blocked', blockedReason: null }], [])
    expect(h.level).toBe('at_risk')
    expect(h.reasons).toEqual(['2 failed tasks', '1 blocked task'])
    expect(deriveHealth({ state: 'failed', pauseReason: null }, [], []).level).toBe('at_risk')
  })
  it('reports finished runs as such', () => {
    expect(deriveHealth({ state: 'completed', pauseReason: null }, [{ state: 'failed', blockedReason: null }], []).level).toBe('done')
    expect(deriveHealth({ state: 'cancelled', pauseReason: null }, [], []).level).toBe('stopped')
  })
})

describe('context pack grouping', () => {
  const entry = (id: string, section: string, included: boolean, chars: number) => ({
    id,
    packId: 'p',
    section,
    sourceKind: 'task' as const,
    sourceId: null,
    title: id,
    reason: 'r',
    included,
    chars,
  })
  it('groups by section in first-seen order, included first, with included totals', () => {
    const pack: Pick<ContextPack, 'entries'> = {
      entries: [entry('x1', 'Facts', false, 50), entry('t1', 'Task', true, 10), entry('x2', 'Facts', true, 30), entry('x3', 'Facts', true, 5)],
    }
    const groups = groupPackSections(pack)
    expect(groups.map((g) => g.section)).toEqual(['Facts', 'Task'])
    const facts = groups[0]
    expect(facts?.entries.map((e) => e.id)).toEqual(['x2', 'x3', 'x1'])
    expect(facts?.includedChars).toBe(35)
    expect(facts?.excludedCount).toBe(1)
  })
})

describe('fact grouping', () => {
  const fact = (id: string, kind: RepositoryFact['kind'], stale = false): RepositoryFact => ({
    id,
    projectId: 'p',
    kind,
    subject: id,
    statement: 's',
    source: 'manifest',
    confidence: 'high',
    files: [],
    fingerprint: 'f',
    stale,
    createdAt: '2026-10-03T00:00:00Z',
    verifiedAt: '2026-10-03T00:00:00Z',
  })
  it('groups by kind family in display order, dropping empty groups, fresh before stale', () => {
    const groups = groupFacts([fact('z', 'hazard'), fact('b', 'module', true), fact('a', 'module'), fact('c', 'command'), fact('d', 'boundary')])
    expect(groups.map((g) => g.id)).toEqual(['modules', 'commands', 'architecture', 'hazards'])
    expect(groups[0]?.facts.map((f) => f.id)).toEqual(['a', 'b'])
  })
})

describe('formatRate', () => {
  it('uses whole percents and always shows the sample count', () => {
    expect(formatRate(0.6667, 6)).toBe('67% (n=6)')
    expect(formatRate(1, 3)).toBe('100% (n=3)')
    expect(formatRate(Number.NaN, 0)).toBe('— (n=0)')
  })
})

describe('readArbitration', () => {
  const base: Review = {
    id: 'r',
    runId: 'run',
    taskId: 't',
    agentId: null,
    attempt: 1,
    verdict: 'approved',
    summary: 's',
    findings: [],
    createdAt: '2026-10-03T00:00:00Z',
  }
  it('is null for reviews without an arbiter result', () => {
    expect(readArbitration(base)).toBeNull()
  })
  it('reads accepted and rejected decisions and ignores malformed ones', () => {
    const withArb = {
      ...base,
      arbitration: {
        summary: 'ok',
        decisions: [{ findingIndex: 0, accepted: true, reason: 'real' }, { findingIndex: 1, accepted: false, reason: 'nit' }, { bad: 1 }],
      },
    } as Review
    const a = readArbitration(withArb)
    expect(a?.accepted).toBe(1)
    expect(a?.rejected).toBe(1)
    expect(a?.decisions).toHaveLength(2)
  })
})

describe('v0.2 events', () => {
  const ev = (type: RunEvent['type'], payload: unknown): RunEvent => ({
    id: 'e',
    seq: 1,
    runId: 'run1',
    taskId: null,
    agentId: null,
    type,
    payload: payload as never,
    createdAt: '2026-10-03T00:00:00Z',
  })
  it('describes the new events and files graph, planning and routing under one category', () => {
    expect(describeEvent(ev('graph.revised', { proposalId: null, revisionId: 'r', version: 3, summary: 'added 2' }))).toBe('Plan revised to v3: added 2')
    expect(describeEvent(ev('review.arbitrated', { accepted: 2, rejected: 1 }))).toBe('Findings arbitrated: 2 accepted, 1 rejected')
    expect(
      describeEvent(ev('routing.decided', { decisionId: 'd', role: 'implementer', policy: 'STRONGEST', model: null, reasons: ['high risk'] })),
    ).toContain('runtime default')
    expect(eventCategory('graph.proposed')).toBe('graph')
    expect(eventCategory('planning.candidate')).toBe('graph')
    expect(eventCategory('routing.decided')).toBe('graph')
    expect(eventCategory('review.arbitrated')).toBe('review')
  })
  it('invalidates the right queries', () => {
    expect(keysForEvent(ev('graph.revised', {}))).toContainEqual(qk.graphRevisions('run1'))
    expect(keysForEvent(ev('graph.proposed', {}))).toContainEqual(qk.graphProposals('run1'))
    expect(keysForEvent(ev('planning.critique', {}))).toContainEqual(qk.planningCandidates('run1'))
    expect(keysForEvent(ev('routing.decided', {}))).toContainEqual(qk.routing('run1'))
    expect(keysForEvent(ev('intelligence.refreshed', {}))).toContainEqual(qk.intelligenceRoot())
    expect(keysForEvent(ev('context.composed', {}))).toContainEqual(qk.contextRoot())
    expect(keysForEvent(ev('review.arbitrated', {}))).toContainEqual(qk.reviews('run1'))
  })
})
