import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { MAX_SPECULATIVE_CANDIDATES, type CandidateEvidence } from '@shared/v3'
import { configureStrategy, planOverrides, STRATEGY_REGISTRY } from '@main/modules/strategy/strategies'
import { rankCandidates, TOURNAMENT_RULES } from '@main/modules/strategy/tournament'

const evidence = (overrides: Partial<CandidateEvidence> = {}): CandidateEvidence => ({
  implemented: true,
  checksPassed: true,
  checksFailedCount: 0,
  acceptancePassed: null,
  criticalFindings: null,
  highFindings: null,
  filesChanged: 2,
  linesChanged: 40,
  durationMs: 1000,
  inputTokens: 1000,
  outputTokens: 200,
  ...overrides,
})

describe('candidate tournament', () => {
  it('prefers the candidate whose checks pass, whatever its size or cost', () => {
    const result = rankCandidates([
      { label: 'a', evidence: evidence({ checksPassed: false, checksFailedCount: 1, linesChanged: 3, inputTokens: 10 }) },
      { label: 'b', evidence: evidence({ checksPassed: true, linesChanged: 900, inputTokens: 90_000 }) },
    ])
    expect(result.winner).toBe('b')
    expect(result.ranking).toEqual(['b', 'a'])
    expect(result.confidence).toBe('decisive')
    expect(result.comparisons[0]?.criterion).toBe('checks passed')
    expect(result.reason).toContain('checks passed')
  })

  it('never selects a candidate that produced no result over one that did', () => {
    const result = rankCandidates([
      { label: 'a', evidence: evidence({ implemented: false, checksPassed: null, checksFailedCount: null }) },
      { label: 'b', evidence: evidence({ checksPassed: false, checksFailedCount: 3 }) },
    ])
    expect(result.winner).toBe('b')
    expect(result.comparisons[0]?.criterion).toBe('produced a result')
  })

  it('reports no winner when no candidate produced a result', () => {
    const none = evidence({ implemented: false, checksPassed: null, checksFailedCount: null })
    const result = rankCandidates([
      { label: 'a', evidence: none },
      { label: 'b', evidence: none },
    ])
    expect(result.winner).toBeNull()
    expect(result.confidence).toBe('none')
  })

  it('uses review findings before size when checks tie', () => {
    const result = rankCandidates([
      { label: 'a', evidence: evidence({ highFindings: 2, criticalFindings: 0, linesChanged: 10 }) },
      { label: 'b', evidence: evidence({ highFindings: 0, criticalFindings: 0, linesChanged: 500 }) },
    ])
    expect(result.winner).toBe('b')
    expect(result.confidence).toBe('decisive')
  })

  it('calls a decision made only on size marginal', () => {
    const result = rankCandidates([
      { label: 'a', evidence: evidence({ linesChanged: 80 }) },
      { label: 'b', evidence: evidence({ linesChanged: 20 }) },
    ])
    expect(result.winner).toBe('b')
    expect(result.confidence).toBe('marginal')
    expect(result.comparisons[0]?.criterion).toBe('smaller change (lines)')
  })

  it('falls back to the label, and says so, when every measured rule ties', () => {
    const result = rankCandidates([
      { label: 'b', evidence: evidence() },
      { label: 'a', evidence: evidence() },
    ])
    expect(result.winner).toBe('a')
    expect(result.confidence).toBe('marginal')
    expect(result.reason).toContain('by label')
    expect(result.comparisons[0]?.criterion).toContain('label')
  })

  it('places a value that was not measured after every measured one, and never above a known pass', () => {
    const sized = rankCandidates([
      { label: 'a', evidence: evidence({ linesChanged: null, filesChanged: null }) },
      { label: 'b', evidence: evidence({ linesChanged: 5, filesChanged: 1 }) },
    ])
    expect(sized.winner).toBe('b')
    expect(sized.confidence).toBe('marginal')

    // Checks not measured sits between passed and failed.
    const checks = rankCandidates([
      { label: 'a', evidence: evidence({ checksPassed: null, checksFailedCount: null }) },
      { label: 'b', evidence: evidence({ checksPassed: false, checksFailedCount: 1 }) },
      { label: 'c', evidence: evidence({ checksPassed: true }) },
    ])
    expect(checks.ranking).toEqual(['c', 'a', 'b'])
  })

  it('is a total order: the winner never depends on the order candidates are given in', () => {
    // The case an audit found: with "not measured" treated as a tie, a candidate whose checks FAILED could win.
    const entries = [
      { label: 'a', evidence: evidence({ checksPassed: true, linesChanged: 100 }) },
      { label: 'b', evidence: evidence({ checksPassed: null, checksFailedCount: null, linesChanged: 10 }) },
      { label: 'c', evidence: evidence({ checksPassed: false, checksFailedCount: 1, linesChanged: 5 }) },
    ]
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]
    for (const order of orders) {
      const result = rankCandidates(order.map((i) => entries[i]!))
      expect(result.ranking, order.join('')).toEqual(['a', 'b', 'c'])
      expect(result.confidence).toBe('decisive')
    }
  })

  it('ranks three candidates consistently and is independent of input order', () => {
    const entries = [
      { label: 'a', evidence: evidence({ checksPassed: false, checksFailedCount: 2 }) },
      { label: 'b', evidence: evidence({ linesChanged: 100 }) },
      { label: 'c', evidence: evidence({ linesChanged: 30 }) },
    ]
    const forward = rankCandidates(entries)
    const backward = rankCandidates([...entries].reverse())
    expect(forward.ranking).toEqual(['c', 'b', 'a'])
    expect(backward.ranking).toEqual(forward.ranking)
    expect(forward.comparisons).toHaveLength(2)
  })

  it('has no rule that reads usage or duration: cost never decides a tournament', () => {
    const cheapButFailing = evidence({ checksPassed: false, checksFailedCount: 1, inputTokens: 1, outputTokens: 1, durationMs: 1 })
    const result = rankCandidates([
      { label: 'a', evidence: cheapButFailing },
      { label: 'b', evidence: evidence({ inputTokens: 10_000_000, durationMs: 9_000_000 }) },
    ])
    expect(result.winner).toBe('b')
    expect(TOURNAMENT_RULES.map((r) => r.name).join(' ')).not.toMatch(/token|duration|time/i)
  })
})

describe('strategy configuration', () => {
  const input = { preset: 'balanced' as const, settings: DEFAULT_SETTINGS }

  it('has one implementation per concrete strategy', () => {
    expect(Object.keys(STRATEGY_REGISTRY).sort()).toEqual(['BUILD', 'CONSENSUS', 'SINGLE', 'SPECULATIVE', 'SWARM'])
    for (const [id, strategy] of Object.entries(STRATEGY_REGISTRY)) expect(strategy.id).toBe(id)
  })

  it('SINGLE has no planner and one agent', () => {
    const plan = configureStrategy('SINGLE', input)
    expect(plan).toMatchObject({ planning: 'none', maxParallelAgents: 1, speculativeCandidates: 0, singleWorkerTier: 'strongest' })
    expect(configureStrategy('SINGLE', { ...input, preset: 'eco' }).singleWorkerTier).toBe('balanced')
  })

  it('BUILD and SWARM plan with one planner and differ in parallelism and mode', () => {
    const build = configureStrategy('BUILD', input)
    const swarm = configureStrategy('SWARM', input)
    expect(build).toMatchObject({ mode: 'build', planning: 'single', maxParallelAgents: 4 })
    expect(swarm).toMatchObject({ mode: 'swarm', planning: 'single', maxParallelAgents: DEFAULT_SETTINGS.execution.maximumPresetAgents })
    expect(configureStrategy('SWARM', { ...input, preset: 'eco' }).maxParallelAgents).toBe(2)
  })

  it('CONSENSUS uses consensus planning and dual review', () => {
    const plan = configureStrategy('CONSENSUS', input)
    expect(plan).toMatchObject({ planning: 'consensus', reviewMode: 'dual' })
    expect(planOverrides(plan)).toMatchObject({ planningMode: 'consensus', reviewMode: 'dual' })
  })

  it('SPECULATIVE defaults to two candidates and never exceeds the hard maximum', () => {
    expect(configureStrategy('SPECULATIVE', input).speculativeCandidates).toBe(2)
    expect(configureStrategy('SPECULATIVE', { ...input, candidates: 99 }).speculativeCandidates).toBe(MAX_SPECULATIVE_CANDIDATES)
    expect(configureStrategy('SPECULATIVE', { ...input, candidates: 1 }).speculativeCandidates).toBe(2)
    expect(configureStrategy('SPECULATIVE', { ...input, candidates: 3 })).toMatchObject({ planning: 'none', maxParallelAgents: 3 })
  })
})
