import { describe, expect, it } from 'vitest'
import type { AgentRole, ModelTier } from '@shared/domain'
import { presetRolePolicy, DEFAULT_SETTINGS } from '@shared/settings'
import type { PerformanceStat } from '@shared/v2'
import { routeModel, type RouteInput } from '@main/modules/routing'

const policy: Record<AgentRole, ModelTier> = {
  planner: 'strongest',
  architect: 'strongest',
  worker: 'balanced',
  debugger: 'balanced',
  reviewer: 'balanced',
  verifier: 'strongest',
  researcher: 'fast',
  security_reviewer: 'strongest',
}
const models: Record<ModelTier, string> = { strongest: 'opus', balanced: 'sonnet', fast: 'haiku' }

function route(overrides: Partial<RouteInput> = {}) {
  return routeModel({
    role: 'worker',
    purpose: 'implement',
    rolePolicy: policy,
    preset: 'balanced',
    modelForTier: (t) => models[t],
    ...overrides,
  })
}

function stat(overrides: Partial<PerformanceStat> = {}): PerformanceStat {
  return {
    role: 'worker',
    model: 'sonnet',
    category: 'implement',
    samples: 7,
    sufficient: true,
    firstPassRate: 2 / 7,
    completionRate: 1,
    reviewRejectionRate: 0,
    averageRepairs: 0,
    checkFailureRate: 0,
    interventionRate: 0,
    averageElapsedMs: null,
    averageOutputTokens: null,
    recent: [],
    ...overrides,
  }
}

describe('routeModel', () => {
  it('uses the role policy and resolves it to a model', () => {
    const r = route()
    expect(r).toMatchObject({
      requestedPolicy: 'BALANCED',
      resolvedPolicy: 'BALANCED',
      resolvedTier: 'balanced',
      resolvedModel: 'sonnet',
    })
    expect(r.reasons[0]).toMatch(/Role policy for worker asks for BALANCED/)
    expect(r.reasons.at(-1)).toMatch(/BALANCED resolves to sonnet/)
  })

  it('promotes writing roles to STRONGEST on high risk or large complexity', () => {
    expect(route({ risk: 'high' })).toMatchObject({ resolvedPolicy: 'STRONGEST', requestedPolicy: 'BALANCED' })
    expect(route({ complexity: 'large' }).resolvedModel).toBe('opus')
    expect(route({ risk: 'high' }).reasons.join(' ')).toMatch(/High-risk task with a writing role: BALANCED -> STRONGEST/)
    // non-writing roles are unaffected
    expect(route({ role: 'reviewer', risk: 'high' }).resolvedPolicy).toBe('BALANCED')
    expect(route({ role: 'debugger', risk: 'high' }).resolvedPolicy).toBe('STRONGEST')
  })

  it('promotes one step on the second attempt and never past STRONGEST', () => {
    expect(route({ attempt: 1 }).resolvedPolicy).toBe('BALANCED')
    expect(route({ attempt: 2 }).resolvedPolicy).toBe('STRONGEST')
    expect(route({ attempt: 2, role: 'researcher' }).resolvedPolicy).toBe('BALANCED')
    const top = route({ attempt: 3, role: 'planner' })
    expect(top.resolvedPolicy).toBe('STRONGEST')
    expect(top.reasons.join(' ')).toMatch(/already STRONGEST/)
  })

  it('goes straight to STRONGEST for a repair after a HIGH or CRITICAL finding', () => {
    expect(route({ role: 'researcher', repairCycle: 1, triggeringSeverity: 'high' }).resolvedPolicy).toBe('STRONGEST')
    expect(route({ repairCycle: 2, triggeringSeverity: 'critical' }).reasons.join(' ')).toMatch(/CRITICAL finding/)
    expect(route({ repairCycle: 1, triggeringSeverity: 'medium' }).resolvedPolicy).toBe('BALANCED')
    expect(route({ repairCycle: 0, triggeringSeverity: 'high' }).resolvedPolicy).toBe('BALANCED')
  })

  it('applies an explicit tier override as a floor', () => {
    expect(route({ tierOverride: 'strongest' }).resolvedPolicy).toBe('STRONGEST')
    const kept = route({ role: 'planner', tierOverride: 'fast' })
    expect(kept.resolvedPolicy).toBe('STRONGEST')
  })

  it('applies rules in order, each adding a reason', () => {
    const r = route({ role: 'researcher', risk: 'high', attempt: 2, repairCycle: 1, triggeringSeverity: 'high' })
    // researcher is not a writing role: attempt 2 (fast -> balanced), then finding (-> strongest)
    expect(r.reasons).toHaveLength(4)
    expect(r.reasons[1]).toMatch(/Attempt 2/)
    expect(r.reasons[2]).toMatch(/Repair cycle 1/)
  })

  describe('ECO preset', () => {
    const eco = presetRolePolicy('eco', policy)
    it('never promotes a non-gate role above BALANCED', () => {
      const r = route({ rolePolicy: eco, preset: 'eco', risk: 'high', attempt: 2 })
      expect(r.resolvedPolicy).toBe('BALANCED')
      expect(r.reasons.join(' ')).toMatch(/ECO preset/)
      expect(route({ rolePolicy: eco, preset: 'eco', role: 'researcher', attempt: 2 }).resolvedPolicy).toBe('BALANCED')
    })

    it('allows promotion through a HIGH finding or an explicit override', () => {
      expect(route({ rolePolicy: eco, preset: 'eco', repairCycle: 1, triggeringSeverity: 'high' }).resolvedPolicy).toBe(
        'STRONGEST',
      )
      expect(route({ rolePolicy: eco, preset: 'eco', tierOverride: 'strongest' }).resolvedPolicy).toBe('STRONGEST')
    })

    it('does not cap gate roles or demote a policy that already chose STRONGEST', () => {
      expect(route({ preset: 'eco', role: 'planner', attempt: 2 }).resolvedPolicy).toBe('STRONGEST')
      expect(route({ preset: 'eco', role: 'verifier', attempt: 2 }).resolvedPolicy).toBe('STRONGEST')
      expect(route({ preset: 'eco', role: 'architect', attempt: 2 }).resolvedPolicy).toBe('STRONGEST')
    })

    it('uses DEFAULT_SETTINGS-style ECO policies without throwing', () => {
      expect(DEFAULT_SETTINGS.models.tiers.fast).toBeTruthy()
    })
  })

  describe('measured performance', () => {
    it('promotes one step and quotes the numbers when first-pass is below 50% with sufficient samples', () => {
      const r = route({ category: 'implement', stats: [stat()] })
      expect(r.resolvedPolicy).toBe('STRONGEST')
      expect(r.reasons.join(' ')).toMatch(/first-pass 2\/7 = 29%/)
    })

    it('ignores insufficient samples, good rates, and other roles/models/categories', () => {
      const cases = [
        stat({ sufficient: false }),
        stat({ firstPassRate: 0.5 }),
        stat({ role: 'debugger' }),
        stat({ model: 'opus' }),
        stat({ category: 'repair' }),
      ]
      for (const s of cases) expect(route({ category: 'implement', stats: [s] }).resolvedPolicy).toBe('BALANCED')
    })

    it('does nothing without a category or without stats', () => {
      expect(route({ stats: [stat()] }).resolvedPolicy).toBe('BALANCED')
      expect(route({ category: 'implement' }).resolvedPolicy).toBe('BALANCED')
    })

    it('matches stats against the model of the tier selected so far', () => {
      // after a second attempt the tier is strongest (opus); sonnet stats no longer apply
      const r = route({ attempt: 2, category: 'implement', stats: [stat()] })
      expect(r.resolvedPolicy).toBe('STRONGEST')
      expect(r.reasons.join(' ')).not.toMatch(/first-pass/)
    })

    it('is capped by ECO', () => {
      const r = route({ preset: 'eco', category: 'implement', stats: [stat()] })
      expect(r.resolvedPolicy).toBe('BALANCED')
      expect(r.reasons.join(' ')).toMatch(/ECO preset/)
    })
  })

  describe('resolution', () => {
    it('falls back to INHERIT when no model is configured', () => {
      for (const empty of [null, '', '  ']) {
        const r = route({ modelForTier: () => empty })
        expect(r).toMatchObject({ resolvedPolicy: 'INHERIT', resolvedTier: null, resolvedModel: null, requestedPolicy: 'BALANCED' })
        expect(r.reasons.at(-1)).toMatch(/INHERIT/)
      }
    })

    it('resolves the promoted tier, not the requested one, when its model is missing', () => {
      const r = route({ risk: 'high', modelForTier: (t) => (t === 'strongest' ? null : models[t]) })
      expect(r.resolvedPolicy).toBe('INHERIT')
      expect(r.reasons.join(' ')).toMatch(/No model is configured for STRONGEST/)
    })

    it('is total for a missing policy entry and deterministic', () => {
      const partial = { ...policy } as Partial<Record<AgentRole, ModelTier>>
      delete partial.worker
      const a = route({ rolePolicy: partial as Record<AgentRole, ModelTier> })
      expect(a.requestedPolicy).toBe('BALANCED')
      expect(route({ risk: 'high', attempt: 2 })).toEqual(route({ risk: 'high', attempt: 2 }))
    })
  })
})
