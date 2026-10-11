import { describe, expect, it } from 'vitest'
import type { CandidateResult, EvidenceSummaryRow, PolicyDecision, UsageOverview } from '@shared/v3'
import type { RunPolicyInfo, SpeculativeDetail } from '@shared/v3-read'
import {
  evidenceRows,
  missionTitle,
  pauseSummary,
  policyView,
  promptHasMore,
  quotaState,
  strategyChip,
  tournaments,
  usageRows,
} from '../../../src/renderer/src/views/run/missionModel'

const NOW = Date.parse('2026-01-01T10:00:00Z')

describe('missionTitle', () => {
  it('uses the first non-empty line', () => {
    expect(missionTitle('\n\n  Fix the login bug  \nmore detail')).toBe('Fix the login bug')
  })
  it('shortens long lines and falls back for empty prompts', () => {
    expect(missionTitle('x'.repeat(200)).length).toBeLessThanOrEqual(96)
    expect(missionTitle('   ')).toBe('Untitled mission')
  })
  it('knows when there is more to expand', () => {
    expect(promptHasMore('one line')).toBe(false)
    expect(promptHasMore('one\ntwo')).toBe(true)
  })
})

describe('strategyChip', () => {
  it('shows the requested strategy only when it differs', () => {
    const base = { speculativeCandidates: 2, policyDecisionId: null, policySnapshotId: null, taskProfileId: null, arenaTrialId: null }
    expect(strategyChip({ ...base, requested: 'ADAPTIVE', resolved: 'BUILD' })).toEqual({ label: 'Build', hint: 'requested Adaptive' })
    expect(strategyChip({ ...base, requested: 'SWARM', resolved: 'SWARM' })).toEqual({ label: 'Swarm', hint: null })
    expect(strategyChip(null)).toEqual({ label: null, hint: null })
  })
})

const row = (over: Partial<EvidenceSummaryRow>): EvidenceSummaryRow => ({
  strategy: 'BUILD',
  arenaN: 0,
  arenaCases: 0,
  arenaSuccesses: 0,
  missionN: 0,
  missionSuccesses: 0,
  effectiveN: 0,
  passRate: null,
  passInterval: null,
  meanSessions: null,
  meanObservedTokens: null,
  medianDurationMs: null,
  label: 'INSUFFICIENT',
  suppressed: false,
  ...over,
})

describe('evidenceRows', () => {
  it('keeps Arena and missions separate and marks the chosen strategy', () => {
    const rows = evidenceRows([row({ arenaN: 3, arenaSuccesses: 2, missionN: 5, missionSuccesses: 4, passRate: 0.75, label: 'MODERATE' }), row({ strategy: 'SWARM' })], 'BUILD')
    expect(rows[0]).toMatchObject({ chosen: true, arena: 'n=3, 2 passed', missions: 'n=5, 4 passed', passRate: '75%', label: 'Moderate' })
    expect(rows[1]).toMatchObject({ chosen: false, arena: '—', missions: '—', passRate: '—' })
  })
})

describe('policyView', () => {
  it('says so plainly without a decision', () => {
    expect(policyView(null).kind).toBe('none')
    const user = policyView({
      strategy: { requested: 'SWARM', resolved: 'SWARM', speculativeCandidates: 2, policyDecisionId: null, policySnapshotId: null, taskProfileId: null, arenaTrialId: null },
      profile: null,
      decision: null,
      outcome: null,
    })
    expect(user.kind).toBe('user')
    expect(user.headline).toContain('chosen by you')
  })
  it('describes a decision', () => {
    const decision = {
      strategy: 'BUILD',
      layer: 'evidence',
      reason: 'Higher pass rate',
      policyVersion: 4,
      exploration: false,
      evidenceSummary: [row({})],
      resourceNotes: ['Quota is fine'],
      contextKey: 'bugfix|small|low',
    } as unknown as PolicyDecision
    const v = policyView({ strategy: null, profile: null, decision, outcome: null } as RunPolicyInfo)
    expect(v).toMatchObject({ kind: 'decision', layer: 'Evidence', version: 'Policy v4', reason: 'Higher pass rate' })
    expect(v.profile).toBe('Bug fix · small size · low risk')
  })
})

function overview(over: Partial<UsageOverview['autoResume']> = {}, reset: string | null = null): UsageOverview {
  return {
    nextResetAt: reset ? { value: reset, source: 'RUNTIME', confidence: 'EXACT' } : { value: null, source: 'UNKNOWN', confidence: 'UNKNOWN' },
    autoResume: { enabled: true, pause: null, nextCheckAt: { value: null, source: 'UNKNOWN', confidence: 'UNKNOWN' }, pausedRuns: 1, ...over },
  } as unknown as UsageOverview
}

describe('quotaState', () => {
  it('is null unless the run is quota paused', () => {
    expect(quotaState({ state: 'executing', pauseReason: null }, null, NOW)).toBeNull()
    expect(quotaState({ state: 'paused', pauseReason: 'user' }, null, NOW)).toBeNull()
  })
  it('reassures and handles an unknown reset', () => {
    const q = quotaState({ state: 'paused', pauseReason: 'quota' }, overview(), NOW)
    expect(q?.lines.join(' ')).toContain('Finished tasks are kept, and unfinished work resumes from its last checkpoint')
    expect(q?.lines.join(' ')).not.toContain('No work has been lost')
    expect(q?.lines.join(' ')).toContain('did not report')
    expect(q?.lines.join(' ')).toContain('Automatic resume is on')
  })
  it('shows a reset only when it is exact', () => {
    const q = quotaState({ state: 'paused', pauseReason: 'quota' }, overview({ enabled: false }, '2026-01-01T12:00:00Z'), NOW)
    expect(q?.lines.join(' ')).toContain('resets at')
    expect(q?.lines.join(' ')).toContain('Automatic resume is off')
  })
})

describe('tournaments', () => {
  const cand = (label: string, outcome: CandidateResult['outcome'], diffPatch: string | null): CandidateResult =>
    ({
      id: `c-${label}`,
      speculativeRunId: 's1',
      label,
      outcome,
      diffPatch,
      evidence: { checksPassed: outcome === 'winner', checksFailedCount: outcome === 'winner' ? 0 : 2, filesChanged: 3, linesChanged: 40, durationMs: 61_000, inputTokens: 1200, outputTokens: 300 },
    }) as unknown as CandidateResult
  const detail = {
    runs: [{ id: 's1', taskId: 't1', state: 'decided' }],
    candidates: [cand('b', 'rejected', 'diff --git a b'), cand('a', 'winner', 'diff')],
    decisions: [{ speculativeRunId: 's1', winnerLabel: 'a', confidence: 'decisive', reason: 'checks', comparisons: [{ criterion: 'checks passed', better: 'a', worse: 'b', detail: 'passed vs 2 failed' }] }],
  } as unknown as SpeculativeDetail
  it('orders candidates, labels outcomes and keeps loser diffs', () => {
    const [t] = tournaments(detail)
    expect(t?.candidates.map((c) => c.label)).toEqual(['A', 'B'])
    expect(t?.candidates[0]).toMatchObject({ outcome: 'Winner', checks: 'Passed', hasDiff: false })
    expect(t?.candidates[1]).toMatchObject({ outcome: 'Rejected', checks: 'Failed (2)', hasDiff: true, tokens: '1.2k in / 300 out' })
    expect(t?.decision?.winner).toBe('A')
    expect(t?.decision?.comparisons[0]).toMatchObject({ criterion: 'checks passed', summary: 'A over B' })
  })
  it('is empty without data', () => {
    expect(tournaments(null)).toEqual([])
  })
})

describe('usageRows and pauseSummary', () => {
  it('formats observed figures', () => {
    const [r] = usageRows([{ key: 'k', label: 'worker', sessions: 2, turns: 10, inputTokens: 2500, outputTokens: 800, durationMs: 90_000 }])
    expect(r).toMatchObject({ sessions: '2', input: '2.5k', output: '800', duration: '1m 30s' })
  })
  it('summarises a pause', () => {
    const base = { probes: 3, resetAt: null, resetConfidence: 'UNKNOWN', endedAt: '2026-01-01T09:00:00Z', endReason: null, resumes: [{ result: 'resumed' }] }
    expect(pauseSummary(base, NOW)).toBe('Resumed · 3 probes · reset time not reported')
    expect(pauseSummary({ ...base, endedAt: null, resumes: [], probes: 1 }, NOW)).toBe('Waiting · 1 probe · reset time not reported')
  })
})
