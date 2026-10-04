import { describe, expect, it } from 'vitest'
import type { Review, ReviewFinding, Verification } from '@shared/domain'
import { newId } from '@shared/ids'
import type { ArenaTrial } from '@shared/v3'
import { collectTrialMetrics } from '@main/modules/arena/metrics'
import { makeAgent, makeProject, makeRun, makeTask, openMemory } from '../../integration/persistence/fixtures'

const finding = (severity: ReviewFinding['severity']): ReviewFinding => ({
  title: 't',
  description: 'd',
  evidence: 'e',
  severity,
  category: 'correctness',
  file: null,
  lineStart: null,
  lineEnd: null,
  confidence: 'high',
  suggestedCorrection: null,
})

const trialRow = (runId: string): ArenaTrial => ({
  id: newId(),
  campaignId: 'c',
  caseId: 'case',
  caseVersionId: 'v',
  strategy: 'BUILD',
  repetition: 1,
  ordinal: 0,
  state: 'running',
  projectId: null,
  runId,
  repoPath: null,
  baselineCommit: null,
  resultCommit: null,
  policySnapshotId: null,
  taskProfileId: null,
  models: {},
  detail: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
})

describe('collectTrialMetrics', () => {
  it('reports null for what was not measured and zero for what did not happen', () => {
    const { repos } = openMemory()
    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(makeRun(project.id))
    const m = collectTrialMetrics(repos, trialRow(run.id), run)
    expect(m.buildPassed).toBeNull()
    expect(m.testsPassed).toBeNull()
    expect(m.verifierPassed).toBeNull()
    expect(m.acceptanceTotal).toBeNull()
    expect(m.wallClockMs).toBeNull()
    expect(m.turns).toBeNull()
    expect(m.inputTokens).toBeNull()
    expect(m.toolCalls).toBeNull()
    expect(m.hiddenPassed).toBeNull()
    expect(m.sessions).toBe(0)
    expect(m.repairs).toBe(0)
    expect(m.quotaPauses).toBe(0)
  })

  it('derives every metric from durable rows', () => {
    const { repos } = openMemory()
    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(
      makeRun(project.id, { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z' }),
    )
    const t1 = repos.tasks.insert(makeTask(run.id, 'a'))
    const t2 = repos.tasks.insert(makeTask(run.id, 'b', { state: 'completed' }))
    repos.tasks.insert(makeTask(run.id, 'a-repair', { kind: 'repair', parentTaskId: t1.id, state: 'completed' }))
    repos.tasks.insert(makeTask(run.id, 'mission-fix-1', { state: 'completed' }))

    const checks = (passed: boolean, at: string): Verification => ({
      id: newId(),
      runId: run.id,
      taskId: null,
      agentId: null,
      attempt: 1,
      kind: 'checks',
      passed,
      summary: '',
      criteria: [],
      commands: [
        { name: 'build', command: 'b', cwd: '.', exitCode: 0, timedOut: false, durationMs: 1, output: '' },
        { name: 'test', command: 't', cwd: '.', exitCode: passed ? 0 : 1, timedOut: false, durationMs: 1, output: '' },
      ],
      failures: [],
      createdAt: at,
    })
    repos.verifications.insert(checks(false, '2026-01-01T00:01:00.000Z'))
    repos.verifications.insert(checks(true, '2026-01-01T00:01:30.000Z'))
    repos.verifications.insert({ ...checks(true, '2026-01-01T00:01:40.000Z'), id: newId(), kind: 'verifier', commands: [], passed: true })
    repos.criteria.insert({ id: newId(), runId: run.id, taskId: null, text: 'c1', status: 'passed', evidence: null, updatedAt: '2026-01-01T00:01:40.000Z' })
    repos.criteria.insert({ id: newId(), runId: run.id, taskId: null, text: 'c2', status: 'failed', evidence: null, updatedAt: '2026-01-01T00:01:40.000Z' })

    const review = (taskId: string, verdict: Review['verdict'], severities: ReviewFinding['severity'][], at: string): Review => ({
      id: newId(),
      runId: run.id,
      taskId,
      agentId: null,
      attempt: 1,
      verdict,
      summary: 's',
      findings: severities.map(finding),
      createdAt: at,
    })
    // t1: first review had a critical, a later approval resolves it. t2: last review still has 1 high + 1 medium.
    repos.reviews.insert(review(t1.id, 'changes_requested', ['critical'], '2026-01-01T00:00:10.000Z'))
    repos.reviews.insert(review(t1.id, 'approved', [], '2026-01-01T00:00:20.000Z'))
    repos.reviews.insert(review(t2.id, 'changes_requested', ['high', 'medium', 'low'], '2026-01-01T00:00:30.000Z'))

    const a1 = repos.agents.insert(
      makeAgent(run.id, t1.id, { state: 'failed', metrics: { turns: 5, toolCalls: 7, filesRead: 0, filesChanged: 0, commands: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: null, costUsd: null, contextWindow: null } }),
    )
    const a2 = repos.agents.insert(
      makeAgent(run.id, t2.id, { metrics: { turns: 3, toolCalls: 1, filesRead: 0, filesChanged: 0, commands: 0, inputTokens: null, outputTokens: 30, cacheReadTokens: null, costUsd: null, contextWindow: null } }),
    )
    for (const agentId of [a1.id, a1.id, a2.id]) {
      repos.sessions.insert({ id: newId(), agentId, sdkSessionId: null, model: null, state: 'ended', endReason: null, handoff: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null })
    }

    repos.events.insert({ runId: run.id, type: 'user.intervention', payload: { action: 'retry_task' } })
    repos.events.insert({ runId: run.id, type: 'user.intervention', payload: { action: 'pause' } })
    repos.events.insert({ runId: run.id, agentId: a2.id, type: 'agent.failed', payload: { error: 'x' } })
    repos.events.insert({ runId: run.id, type: 'run.recovered', payload: { action: 'resume', staleAgents: 1 } })

    repos.quotaPauses.insert({
      id: newId(),
      runId: run.id,
      scope: 'run',
      state: 'resumed',
      pausedAt: '2026-01-01T00:00:30.000Z',
      limitType: null,
      resetAt: null,
      resetConfidence: 'UNKNOWN',
      nextCheckAt: null,
      probes: 0,
      checkpointId: null,
      resumeState: null,
      endedAt: '2026-01-01T00:00:50.000Z',
      endReason: null,
      createdAt: '2026-01-01T00:00:30.000Z',
      updatedAt: '2026-01-01T00:00:50.000Z',
    })

    const m = collectTrialMetrics(repos, trialRow(run.id), run, { hiddenPassed: true })
    expect(m.hiddenPassed).toBe(true)
    expect(m.buildPassed).toBe(true)
    expect(m.testsPassed).toBe(true) // the final checks passed, the earlier failure does not count
    expect(m.typecheckPassed).toBeNull()
    expect(m.verifierPassed).toBe(true)
    expect(m.acceptanceTotal).toBe(2)
    expect(m.acceptancePassed).toBe(1)
    expect([m.criticalFindings, m.highFindings, m.mediumFindings]).toEqual([0, 1, 1])
    expect(m.repairs).toBe(2)
    expect(m.wallClockMs).toBe(120_000)
    expect(m.sessions).toBe(3)
    expect(m.turns).toBe(8)
    expect(m.toolCalls).toBe(8)
    expect(m.inputTokens).toBe(100)
    expect(m.outputTokens).toBe(50)
    expect(m.humanInterventions).toBe(2)
    expect(m.manualRetries).toBe(1)
    expect(m.crashedAgents).toBe(2)
    expect(m.recoveredSessions).toBe(1)
    expect(m.unfinishedTasks).toBe(1)
    expect(m.quotaPauses).toBe(1)
    expect(m.quotaWaitMs).toBe(20_000)
  })
})
