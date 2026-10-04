import { describe, expect, it } from 'vitest'
import type { PolicyPreview } from '../../../src/shared/v3-read'
import { buildCreateRunInput, validateMission, type MissionDraft } from '../../../src/renderer/src/views/projects/mission'
import {
  ADAPTIVE_FALLBACK_TEXT,
  STRATEGY_OPTIONS,
  previewText,
  strategyApplies,
  strategyFields,
} from '../../../src/renderer/src/views/projects/strategy'

const draft: MissionDraft = {
  projectId: 'p1',
  prompt: 'do it',
  mode: 'build',
  preset: 'balanced',
  maxAgents: null,
  requirePlanApproval: true,
  maxIterations: 3,
}

describe('strategy model', () => {
  it('lists adaptive first and describes every option', () => {
    expect(STRATEGY_OPTIONS[0]?.value).toBe('ADAPTIVE')
    expect(STRATEGY_OPTIONS).toHaveLength(6)
    for (const o of STRATEGY_OPTIONS) expect(o.description.length).toBeGreaterThan(10)
  })

  it('omits strategy for read-only modes and sends it otherwise', () => {
    expect(strategyApplies('ask')).toBe(false)
    expect(strategyApplies('audit')).toBe(false)
    expect(strategyFields('ask', 'ADAPTIVE', 2)).toEqual({})
    expect(strategyFields('build', 'ADAPTIVE', 3)).toEqual({ strategy: 'ADAPTIVE' })
    expect(strategyFields('build', 'SPECULATIVE', 3)).toEqual({ strategy: 'SPECULATIVE', speculativeCandidates: 3 })
    expect(strategyFields('build', 'SPECULATIVE', 9).speculativeCandidates).toBe(3)
  })

  it('puts strategy and candidates in a valid runs.create input', () => {
    const d = { ...draft, ...strategyFields('build', 'SPECULATIVE', 2) }
    const input = buildCreateRunInput(d)
    expect(input.strategy).toBe('SPECULATIVE')
    expect(input.speculativeCandidates).toBe(2)
    expect(validateMission(d)).toBeNull()
    expect(buildCreateRunInput({ ...draft, strategy: 'BUILD', speculativeCandidates: 2 }).speculativeCandidates).toBeUndefined()
  })

  it('degrades the preview text', () => {
    expect(previewText(null).headline).toBe(ADAPTIVE_FALLBACK_TEXT)
    const p = {
      decision: {
        strategy: 'BUILD',
        reason: 'Default for a feature.',
        evidenceSummary: [{ strategy: 'BUILD', label: 'INSUFFICIENT', suppressed: false }],
      },
    } as unknown as PolicyPreview
    const t = previewText(p)
    expect(t.headline).toBe('Adaptive would choose BUILD')
    expect(t.evidence).toBe('No evidence yet, default policy')
    const strong = { decision: { ...p.decision, evidenceSummary: [{ strategy: 'BUILD', label: 'STRONG', suppressed: false }] } } as unknown as PolicyPreview
    expect(previewText(strong).evidence).toBe('Evidence: strong')
  })
})
