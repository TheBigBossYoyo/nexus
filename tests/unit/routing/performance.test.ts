import { describe, expect, it } from 'vitest'
import type { AgentMetrics, Review, Verification } from '@shared/domain'
import { MIN_ROUTING_SAMPLES, type TaskOutcome } from '@shared/v2'
import { aggregatePerformance, buildTaskOutcome } from '@main/modules/routing'
import { makeTask } from '../scheduler/factories'

let n = 0
function outcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  n++
  return {
    id: `o${n}`,
    projectId: 'p',
    runId: 'r',
    taskId: `t${n}`,
    role: 'worker',
    model: 'sonnet',
    tier: 'balanced',
    category: 'implement',
    complexity: 'small',
    risk: 'low',
    attempts: 1,
    firstPassVerified: true,
    completed: true,
    reviewRejections: 0,
    repairCount: 0,
    checksFailed: 0,
    humanInterventions: 0,
    elapsedMs: 1000,
    inputTokens: 100,
    outputTokens: 200,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    ...overrides,
  }
}

describe('aggregatePerformance', () => {
  it('returns nothing for no outcomes and skips outcomes without a model', () => {
    expect(aggregatePerformance([])).toEqual([])
    expect(aggregatePerformance([outcome({ model: null })])).toEqual([])
  })

  it('computes exact fractions and averages', () => {
    const rows = [
      outcome({ firstPassVerified: true, elapsedMs: 1000, outputTokens: 100 }),
      outcome({ firstPassVerified: false, reviewRejections: 2, repairCount: 1, elapsedMs: 3000, outputTokens: 300 }),
      outcome({ firstPassVerified: false, completed: false, checksFailed: 1, humanInterventions: 1, elapsedMs: null, outputTokens: null }),
      outcome({ firstPassVerified: true, repairCount: 2, elapsedMs: 2000, outputTokens: 200 }),
    ]
    const [s] = aggregatePerformance(rows)
    expect(s).toMatchObject({
      role: 'worker',
      model: 'sonnet',
      category: 'implement',
      samples: 4,
      sufficient: false,
      firstPassRate: 0.5,
      completionRate: 0.75,
      reviewRejectionRate: 0.25,
      averageRepairs: 0.75,
      checkFailureRate: 0.25,
      interventionRate: 0.25,
      averageElapsedMs: 2000,
      averageOutputTokens: 200,
    })
  })

  it('reports null averages when no value is present', () => {
    const [s] = aggregatePerformance([outcome({ elapsedMs: null, outputTokens: null })])
    expect(s?.averageElapsedMs).toBeNull()
    expect(s?.averageOutputTokens).toBeNull()
  })

  it('groups by role, model and category and sorts by samples descending', () => {
    const stats = aggregatePerformance([
      outcome({ model: 'opus' }),
      outcome(),
      outcome(),
      outcome({ category: 'repair' }),
      outcome({ role: 'debugger' }),
      outcome({ model: 'opus' }),
      outcome({ model: 'opus' }),
    ])
    expect(stats.map((s) => [s.role, s.model, s.category, s.samples])).toEqual([
      ['worker', 'opus', 'implement', 3],
      ['worker', 'sonnet', 'implement', 2],
      ['debugger', 'sonnet', 'implement', 1],
      ['worker', 'sonnet', 'repair', 1],
    ])
  })

  it('flags sufficiency at the threshold (default MIN_ROUTING_SAMPLES) and honours minSamples', () => {
    const rows = Array.from({ length: MIN_ROUTING_SAMPLES }, () => outcome())
    expect(aggregatePerformance(rows.slice(1))[0]?.sufficient).toBe(false)
    expect(aggregatePerformance(rows)[0]?.sufficient).toBe(true)
    expect(aggregatePerformance(rows.slice(0, 2), { minSamples: 2 })[0]?.sufficient).toBe(true)
    expect(aggregatePerformance(rows, { minSamples: 6 })[0]?.sufficient).toBe(false)
  })

  it('lists recent outcomes newest first, limited to the requested count', () => {
    const rows = Array.from({ length: 7 }, () => outcome())
    const s = aggregatePerformance(rows)[0]
    expect(s?.recent).toHaveLength(5)
    expect(s?.recent.map((r) => r.taskId)).toEqual(rows.slice(2).reverse().map((o) => o.taskId))
    expect(aggregatePerformance(rows, { recent: 2 })[0]?.recent).toHaveLength(2)
    expect(aggregatePerformance(rows, { recent: 0 })[0]?.recent).toEqual([])
  })
})

describe('buildTaskOutcome', () => {
  const metrics: AgentMetrics = {
    turns: 3,
    toolCalls: 4,
    filesRead: 1,
    filesChanged: 1,
    commands: 0,
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: null,
    costUsd: null,
    contextWindow: null,
  }
  const review = (verdict: Review['verdict']): Review => ({
    id: 'rv',
    runId: 'r',
    taskId: 't',
    agentId: null,
    attempt: 1,
    verdict,
    summary: 's',
    findings: [],
    createdAt: 'x',
  })
  const verification = (kind: Verification['kind'], passed: boolean): Verification => ({
    id: 'v',
    runId: 'r',
    taskId: 't',
    agentId: null,
    attempt: 1,
    kind,
    passed,
    summary: 's',
    criteria: [],
    commands: [],
    failures: [],
    createdAt: 'x',
  })
  const task = (o = {}) =>
    makeTask('t', {
      state: 'completed',
      attempt: 1,
      kind: 'implement',
      complexity: 'medium',
      risk: 'high',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.500Z',
      ...o,
    })
  const build = (o: Partial<Parameters<typeof buildTaskOutcome>[0]> = {}) =>
    buildTaskOutcome({
      projectId: 'p',
      run: { id: 'r' },
      task: task(),
      implementAgent: { model: 'sonnet', metrics },
      tier: 'balanced',
      reviews: [review('approved')],
      verifications: [verification('checks', true), verification('verifier', true)],
      repairChildren: [],
      interventions: 0,
      now: '2026-02-01T00:00:00.000Z',
      ...o,
    })

  it('derives a clean first-pass outcome', () => {
    expect(build()).toEqual({
      id: 'outcome-t',
      projectId: 'p',
      runId: 'r',
      taskId: 't',
      role: 'worker',
      model: 'sonnet',
      tier: 'balanced',
      category: 'implement',
      complexity: 'medium',
      risk: 'high',
      attempts: 1,
      firstPassVerified: true,
      completed: true,
      reviewRejections: 0,
      repairCount: 0,
      checksFailed: 0,
      humanInterventions: 0,
      elapsedMs: 5500,
      inputTokens: 1200,
      outputTokens: 340,
      createdAt: '2026-02-01T00:00:00.000Z',
    })
  })

  it('is not first-pass after a retry, a repair child, a rejected review or a failed verifier', () => {
    expect(build({ task: task({ attempt: 2 }) }).firstPassVerified).toBe(false)
    expect(build({ repairChildren: [makeTask('rep', { parentTaskId: 't' })] }).firstPassVerified).toBe(false)
    expect(build({ reviews: [review('changes_requested')] }).firstPassVerified).toBe(false)
    expect(build({ verifications: [verification('verifier', false)] }).firstPassVerified).toBe(false)
    expect(build({ task: task({ state: 'failed' }) })).toMatchObject({ completed: false, firstPassVerified: false })
  })

  it('counts rejections, failed checks and repairs; a failed checks run alone does not break first-pass', () => {
    const o = build({
      reviews: [review('changes_requested'), review('approved'), review('changes_requested')],
      verifications: [verification('checks', false), verification('checks', false), verification('checks', true)],
      repairChildren: [makeTask('r1', { parentTaskId: 't' })],
      interventions: 2,
    })
    expect(o).toMatchObject({ reviewRejections: 2, checksFailed: 2, repairCount: 1, humanInterventions: 2 })
    expect(build({ verifications: [verification('checks', false)] }).firstPassVerified).toBe(true)
    expect(build({ task: task({ repairCycles: 3 }) }).repairCount).toBe(3)
  })

  it('leaves unknowns null', () => {
    expect(build({ implementAgent: null })).toMatchObject({ model: null, inputTokens: null, outputTokens: null })
    expect(build({ implementAgent: { model: 'sonnet', metrics: null } })).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    })
    expect(build({ task: task({ startedAt: null }) }).elapsedMs).toBeNull()
    expect(build({ task: task({ finishedAt: null }) }).elapsedMs).toBeNull()
    expect(
      build({ implementAgent: { model: 'm', metrics: { ...metrics, inputTokens: null, outputTokens: null } } }),
    ).toMatchObject({ inputTokens: null, outputTokens: null })
  })
})
