import { describe, expect, it } from 'vitest'
import type { ProjectProfile } from '@shared/domain'
import { countDeliverables, PLANNER_LENSES, recommendPlanningMode } from '@main/modules/planning'

function profile(fileCount: number): ProjectProfile {
  return {
    repoRoot: '/r',
    isGitRepo: true,
    currentBranch: 'main',
    headCommit: null,
    dirty: false,
    packageManagers: [],
    languages: [],
    frameworks: [],
    scripts: {},
    commands: { build: null, test: null, lint: null, typecheck: null },
    docs: [],
    hasClaudeMd: false,
    fileCount,
    sizeBytes: 0,
    generatedPaths: [],
    profiledAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('countDeliverables', () => {
  it('counts numbered and bulleted items', () => {
    expect(countDeliverables('1. a\n2) b\n- c\n* d\nplain line')).toBe(4)
    expect(countDeliverables('fix the typo')).toBe(0)
  })

  it('counts short "a, b and c" lists but not long clauses', () => {
    expect(countDeliverables('Add login, signup and password reset pages')).toBeGreaterThanOrEqual(3)
    expect(
      countDeliverables('Please look at the way the whole configuration loader behaves under many conditions, and then think and decide'),
    ).toBe(0)
  })
})

describe('recommendPlanningMode', () => {
  it('recommends single for a small simple prompt', () => {
    const r = recommendPlanningMode('Fix the typo in the README title', profile(40))
    expect(r.mode).toBe('single')
    expect(r.reasons.length).toBeGreaterThan(0)
    expect(r.reasons.join(' ')).toMatch(/single planner/)
  })

  it('stays single without a profile for a short prompt, and says so', () => {
    const r = recommendPlanningMode('Add a unit test', null)
    expect(r.mode).toBe('single')
    expect(r.reasons.join(' ')).toMatch(/No repository profile/)
  })

  it('recommends consensus for a long multi-area prompt on a large repository', () => {
    const prompt = [
      'Migrate the data layer and refactor the architecture across multiple packages.',
      '1. Move persistence to the new repository interfaces',
      '2. Redesign the event bus',
      '3. Update the renderer stores',
      '4. Harden security checks',
      '5. Add migration tests',
      'x'.repeat(700),
    ].join('\n')
    const r = recommendPlanningMode(prompt, profile(3000))
    expect(r.mode).toBe('consensus')
    const text = r.reasons.join(' ')
    expect(text).toMatch(/Long prompt|Very long prompt/)
    expect(text).toMatch(/deliverables/)
    expect(text).toMatch(/Broad scope keywords/)
    expect(text).toMatch(/Very large repository/)
  })

  it('does not recommend consensus from a single signal', () => {
    expect(recommendPlanningMode('Refactor the logger', profile(10)).mode).toBe('single')
    expect(recommendPlanningMode('word '.repeat(200), profile(10)).mode).toBe('single')
    expect(recommendPlanningMode('Fix the bug', profile(5000)).mode).toBe('single')
  })

  it('combines moderate signals', () => {
    const prompt = `Refactor and migrate the auth module.\n- tokens\n- sessions\n- cookies\n${'detail '.repeat(100)}`
    expect(recommendPlanningMode(prompt, profile(800)).mode).toBe('consensus')
  })

  it('is deterministic', () => {
    expect(recommendPlanningMode('Redesign everything', profile(100))).toEqual(
      recommendPlanningMode('Redesign everything', profile(100)),
    )
  })
})

describe('PLANNER_LENSES', () => {
  it('has the three independent briefs', () => {
    expect(PLANNER_LENSES.map((l) => l.lens)).toEqual(['risk-first', 'parallelism-first', 'minimal-change'])
    for (const l of PLANNER_LENSES) {
      expect(l.label).toMatch(/^Planner [ABC] \(/)
      expect(l.guidance.length).toBeGreaterThan(40)
    }
    expect(new Set(PLANNER_LENSES.map((l) => l.label)).size).toBe(3)
  })
})
