import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compilationDepth } from '@main/modules/intelligence/depth'
import { countDeliverables, recommendPlanningMode } from '@main/modules/planning/heuristics'

// 0.9.1: the first mission NEXUS ran on itself was a small panel described precisely (the files named, what to
// show, the constraints as bullets). Its length and its bullets made it look broad: Consensus planning (three
// planners, a critic, a synthesizer) and the technical compilation depth, for a change its worker made in 88 s.
const prompt = readFileSync(join(__dirname, 'precise-mission-prompt.txt'), 'utf8')

describe('a precise prompt is not a broad one', () => {
  it('does not count constraints and instructions as deliverables', () => {
    expect(countDeliverables('Build:\n- a panel\n- a push handler\n\nConstraints:\n- Do not push\n- Do not tag\n- Run the tests')).toBe(2)
    expect(countDeliverables('- Do not change native/\n- Run pnpm lint\n- add a button')).toBe(1)
  })

  it('plans the real mission with one planner and compiles it at the standard depth', () => {
    expect(recommendPlanningMode(prompt, { fileCount: 524 } as never).mode).toBe('single')
    expect(compilationDepth(prompt).mode).toBe('STANDARD')
  })

  it('still asks for consensus planning for a broad, unspecified request', () => {
    const broad = `Refactor the architecture across the repository and migrate every module to the new event system.\n${'- migrate another area\n'.repeat(6)}${'Context about why this matters. '.repeat(60)}`
    expect(recommendPlanningMode(broad, { fileCount: 2500 } as never).mode).toBe('consensus')
  })
})

// 0.9.1: a one-task request about agent roles got consensus planning (2 min 40 s for a plan of one task): the role
// identifier `security_reviewer` counted as the scope keyword "security", and one item's sub-bullets as more items.
describe('identifiers and sub-bullets do not make a request broad', () => {
  it('matches scope keywords as whole words only', () => {
    const named = recommendPlanningMode('Give the security_reviewer role only two tools.', null)
    expect(named.reasons.join(' ')).not.toContain('security')
    const real = recommendPlanningMode('Review the security of the login flow.', null)
    expect(real.reasons.join(' ')).toContain('Broad scope keyword: security')
  })

  it('counts the outer bullets of a list, not the details of one of them', () => {
    const prompt = ['What to do:', '- Split the text so that:', '  - workers get every tool;', '  - reviewers get two;', '- The wording stays the same.', '- Add unit tests.'].join('\n')
    expect(countDeliverables(prompt)).toBe(3)
  })
})
