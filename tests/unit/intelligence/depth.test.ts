import { describe, expect, it } from 'vitest'
import type { StrategyStatistic } from '@shared/v3'
import { LOW_PASS_UPPER_BOUND, compilationDepth } from '@main/modules/intelligence/depth'

const depth = (text: string, options?: Parameters<typeof compilationDepth>[1]) => compilationDepth(text, options).mode

/**
 * AUTO gives a request the least depth that is enough for it. These are kinds of request, not the requests of
 * any benchmark: each line says why the depth is what it is.
 */
describe('the depth AUTO chooses', () => {
  it.each([
    // Localized and exact: nothing to develop, no provider asked.
    ['Fix the typo in the README heading', 'LIGHT'],
    ['In src/utils/date.ts, formatDate returns the wrong month for January: it must return 01, not 00. Add a test.', 'LIGHT'],
    ['Refactor src/handlers/user.js and src/handlers/order.js so that both use the validate() helper from src/validate.js. Behaviour must not change and the existing tests must pass.', 'LIGHT'],
    // An ordinary task that leaves things open: developed with the strategic provider.
    ['Add a dark mode toggle to the settings page', 'STANDARD'],
    ['Add CSV export to the reports page. The export button should download a file named report.csv with one row per report.', 'STANDARD'],
    ['Make the app better', 'STANDARD'],
    ['Investigate why the build is slow and fix it', 'STANDARD'],
    // Risky but bounded: developed, not escalated. Never LIGHT, however exact.
    ['Fix the path traversal in resolvePath in src/files.js: a path that escapes the root must throw an Error with the message "path escapes root". Add tests.', 'STANDARD'],
    ['In src/auth/session.js, a session token must expire after 30 minutes: verify() should return false when it is older. Add a test.', 'STANDARD'],
    // The shape of the work depends on the repository.
    ['Refactor the whole codebase to use async/await everywhere', 'TECHNICAL'],
    ['Redesign the architecture of the plugin system so that plugins are isolated', 'TECHNICAL'],
    // Major and risky: both providers and a synthesis.
    ['Rework authentication and authorization across the entire system to support SSO', 'COUNCIL'],
    ['Rotate the credentials used by the deploy pipeline and update every service that reads them', 'COUNCIL'],
    ['Release version 2.0 to production', 'COUNCIL'],
  ])('%s -> %s', (text, expected) => {
    expect(depth(text)).toBe(expected)
  })

  it('a word is not a depth: "refactor" and "security" alone decide nothing', () => {
    expect(depth('Refactor src/a.js so that parse() must return a list and must not throw.')).toBe('LIGHT')
    expect(depth('Refactor everything across the entire codebase')).toBe('TECHNICAL')
    expect(depth('In src/hash.js the security check must compare in constant time; it should return false on a length mismatch.')).toBe('STANDARD')
  })

  it('work across a workspace is never less than TECHNICAL', () => {
    const text = 'In src/order.js, createOrder must return the currency and should default it to EUR.'
    expect(depth(text)).toBe('LIGHT')
    expect(depth(text, { workspace: true })).toBe('TECHNICAL')
  })

  it('EXACT is the user\'s override and is never chosen', () => {
    for (const text of ['x', 'Fix it', 'Rewrite the world', 'a'.repeat(5000)]) expect(['LIGHT', 'STANDARD', 'TECHNICAL', 'COUNCIL']).toContain(depth(text))
  })

  it('says what it read and under which policy, and gives the same answer every time', () => {
    const a = compilationDepth('In src/utils/date.ts, formatDate must return 01 for January and should not throw.')
    expect(a.reasons[0]).toBe('LOCALIZED_WELL_SPECIFIED_TASK')
    expect(a.reasons[1]).toMatch(/^PROFILE:\w+\|\w+\|\w+:scope=\w+:ambiguity=\w+$/)
    expect(a.reasons[2]).toMatch(/^DEPTH_POLICY:/)
    expect(compilationDepth('In src/utils/date.ts, formatDate must return 01 for January and should not throw.')).toEqual(a)
  })

  describe('recorded evidence raises a depth and never lowers one', () => {
    const text = 'In src/utils/date.ts, formatDate must return 01 for January and should not throw.'
    const key = compilationDepth(text).reasons[1]!.split(':')[1]!
    const stat = (over: Partial<StrategyStatistic>): StrategyStatistic => ({ id: 's', contextKey: key, strategy: 'BUILD', kind: 'arena', n: 20, successes: 6, distinctUnits: 8, effectiveN: 20, effectiveSuccesses: 6, passRate: 0.3, passInterval: { low: 0.15, high: 0.52 }, medianDurationMs: null, meanDurationMs: null, meanSessions: null, meanObservedTokens: null, meanRepairs: null, repairDistribution: [], stabilityFailures: 0, label: 'MODERATE', newestAt: null, oldestAt: null, computedAt: '', ...over }) as StrategyStatistic

    it('work of this kind that often fails here is developed after all', () => {
      const decision = compilationDepth(text, { statistics: [stat({})] })
      expect(decision.mode).toBe('STANDARD')
      expect(decision.reasons).toContain('RECORDED_EVIDENCE_LOW_PASS_RATE')
    })
    it('weak evidence, a good pass rate or another kind of task changes nothing', () => {
      expect(depth(text, { statistics: [stat({ label: 'WEAK' })] })).toBe('LIGHT')
      expect(depth(text, { statistics: [stat({ label: 'INSUFFICIENT' })] })).toBe('LIGHT')
      expect(depth(text, { statistics: [stat({ passInterval: { low: 0.4, high: LOW_PASS_UPPER_BOUND } })] })).toBe('LIGHT')
      expect(depth(text, { statistics: [stat({ contextKey: 'feature|large|high' })] })).toBe('LIGHT')
    })
    it('good evidence lowers nothing', () => {
      const good = stat({ label: 'STRONG', passRate: 1, passInterval: { low: 0.9, high: 1 } })
      expect(depth('Add a dark mode toggle to the settings page', { statistics: [{ ...good, contextKey: compilationDepth('Add a dark mode toggle to the settings page').reasons[1]!.split(':')[1]! }] })).toBe('STANDARD')
      expect(depth('Rework authentication and authorization across the entire system to support SSO', { statistics: [good] })).toBe('COUNCIL')
    })
  })
})
