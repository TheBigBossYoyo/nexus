import { describe, expect, it } from 'vitest'
import type { ReviewFinding } from '@shared/domain'
import { applyArbitration, dedupeFindings } from '@main/modules/review'

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: 'Missing null check',
    description: 'd',
    evidence: 'e',
    severity: 'medium',
    category: 'correctness',
    file: 'src/a.ts',
    lineStart: 10,
    lineEnd: 12,
    confidence: 'medium',
    suggestedCorrection: null,
    ...overrides,
  }
}

describe('dedupeFindings', () => {
  it('returns nothing for no findings', () => {
    expect(dedupeFindings([])).toEqual([])
    expect(dedupeFindings([{ reviewer: 'A', findings: [] }])).toEqual([])
  })

  it('merges overlapping ranges in the same file, keeping highest severity, confidence and longer evidence', () => {
    const out = dedupeFindings([
      { reviewer: 'A', findings: [finding({ severity: 'low', confidence: 'high', evidence: 'short', title: 'Low one' })] },
      {
        reviewer: 'B',
        findings: [finding({ severity: 'high', confidence: 'low', evidence: 'much longer evidence', title: 'High one', lineStart: 11, lineEnd: 20 })],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.reportedBy).toEqual(['A', 'B'])
    expect(out[0]?.finding).toMatchObject({
      title: 'High one',
      severity: 'high',
      confidence: 'high',
      evidence: 'much longer evidence',
      lineStart: 10,
      lineEnd: 20,
    })
  })

  it('treats ranges within 3 lines as duplicates and 4 lines as distinct', () => {
    const near = dedupeFindings([
      { reviewer: 'A', findings: [finding({ lineStart: 10, lineEnd: 10 })] },
      { reviewer: 'B', findings: [finding({ lineStart: 13, lineEnd: null, title: 'Other' })] },
    ])
    expect(near).toHaveLength(1)
    const far = dedupeFindings([
      { reviewer: 'A', findings: [finding({ lineStart: 10, lineEnd: 10 })] },
      { reviewer: 'B', findings: [finding({ lineStart: 14, lineEnd: 14 })] },
    ])
    expect(far).toHaveLength(2)
  })

  it('never merges across different files', () => {
    expect(
      dedupeFindings([
        { reviewer: 'A', findings: [finding()] },
        { reviewer: 'B', findings: [finding({ file: 'src/b.ts' })] },
      ]),
    ).toHaveLength(2)
  })

  it('normalizes path separators', () => {
    expect(
      dedupeFindings([
        { reviewer: 'A', findings: [finding({ file: 'src\\a.ts' })] },
        { reviewer: 'B', findings: [finding({ file: './src/a.ts' })] },
      ]),
    ).toHaveLength(1)
  })

  it('merges line-less findings with near-identical titles in the same file and category', () => {
    const base = { lineStart: null, lineEnd: null }
    const out = dedupeFindings([
      { reviewer: 'A', findings: [finding({ ...base, title: 'SQL injection in user lookup!' })] },
      { reviewer: 'B', findings: [finding({ ...base, title: 'sql injection in the user lookup' })] },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.reportedBy).toEqual(['A', 'B'])
  })

  it('keeps line-less findings apart when titles differ, categories differ, or files differ', () => {
    const base = { lineStart: null, lineEnd: null }
    const mk = (o: Partial<ReviewFinding>) => finding({ ...base, ...o })
    expect(
      dedupeFindings([
        { reviewer: 'A', findings: [mk({ title: 'Race condition in cache' })] },
        { reviewer: 'B', findings: [mk({ title: 'Unused import in header' })] },
      ]),
    ).toHaveLength(2)
    expect(
      dedupeFindings([
        { reviewer: 'A', findings: [mk({ title: 'Same title here' })] },
        { reviewer: 'B', findings: [mk({ title: 'Same title here', category: 'security' })] },
      ]),
    ).toHaveLength(2)
    expect(
      dedupeFindings([
        { reviewer: 'A', findings: [mk({ title: 'Same title here' })] },
        { reviewer: 'B', findings: [mk({ title: 'Same title here', file: 'src/other.ts' })] },
      ]),
    ).toHaveLength(2)
  })

  it('merges file-less findings with similar titles but not file-less with filed', () => {
    const mk = (title: string, file: string | null) => finding({ title, file, lineStart: null, lineEnd: null })
    expect(
      dedupeFindings([
        { reviewer: 'A', findings: [mk('Missing tests for module', null)] },
        { reviewer: 'B', findings: [mk('missing tests for module', null)] },
      ]),
    ).toHaveLength(1)
    expect(
      dedupeFindings([
        { reviewer: 'A', findings: [mk('Missing tests for module', null)] },
        { reviewer: 'B', findings: [mk('Missing tests for module', 'src/a.ts')] },
      ]),
    ).toHaveLength(2)
  })

  it('does not mix a line-based finding with a line-less one', () => {
    expect(
      dedupeFindings([
        { reviewer: 'A', findings: [finding()] },
        { reviewer: 'B', findings: [finding({ lineStart: null, lineEnd: null })] },
      ]),
    ).toHaveLength(2)
  })

  it('does not report the same reviewer twice and merges within one reviewer', () => {
    const out = dedupeFindings([{ reviewer: 'A', findings: [finding(), finding({ lineStart: 11 })] }])
    expect(out).toHaveLength(1)
    expect(out[0]?.reportedBy).toEqual(['A'])
  })

  it('orders by severity, then first appearance', () => {
    const out = dedupeFindings([
      { reviewer: 'A', findings: [finding({ title: 'm1', file: 'a', severity: 'medium' }), finding({ title: 'c1', file: 'b', severity: 'critical' })] },
      { reviewer: 'B', findings: [finding({ title: 'm2', file: 'c', severity: 'medium' }), finding({ title: 'n1', file: 'd', severity: 'nit' }), finding({ title: 'h1', file: 'e', severity: 'high' })] },
    ])
    expect(out.map((o) => o.finding.title)).toEqual(['c1', 'h1', 'm1', 'm2', 'n1'])
  })
})

describe('applyArbitration', () => {
  const deduped = (findings: ReviewFinding[]) => findings.map((f) => ({ finding: f, reportedBy: ['A'] }))

  it('accepts and rejects per decision, with the arbiter reason', () => {
    const list = deduped([finding({ title: 'one' }), finding({ title: 'two' })])
    const out = applyArbitration(list, [
      { findingIndex: 0, accepted: false, reason: 'not reproducible' },
      { findingIndex: 1, accepted: true, reason: 'confirmed' },
    ])
    expect(out.accepted.map((f) => f.title)).toEqual(['two'])
    expect(out.rejected).toEqual([{ finding: list[0]?.finding, reason: 'not reproducible' }])
  })

  it('fail-safe: undecided findings are accepted only when critical/high AND high confidence', () => {
    const list = deduped([
      finding({ title: 'crit-high', severity: 'critical', confidence: 'high' }),
      finding({ title: 'high-high', severity: 'high', confidence: 'high' }),
      finding({ title: 'high-med', severity: 'high', confidence: 'medium' }),
      finding({ title: 'med-high', severity: 'medium', confidence: 'high' }),
      finding({ title: 'low', severity: 'low', confidence: 'low' }),
    ])
    const out = applyArbitration(list, [])
    expect(out.accepted.map((f) => f.title)).toEqual(['crit-high', 'high-high'])
    expect(out.rejected.map((r) => r.reason)).toEqual(['no arbiter decision', 'no arbiter decision', 'no arbiter decision'])
  })

  it('an explicit decision overrides the fail-safe in both directions', () => {
    const list = deduped([finding({ severity: 'critical', confidence: 'high' }), finding({ severity: 'low', confidence: 'low', title: 'x' })])
    const out = applyArbitration(list, [
      { findingIndex: 0, accepted: false, reason: 'false positive' },
      { findingIndex: 1, accepted: true, reason: 'real' },
    ])
    expect(out.accepted.map((f) => f.title)).toEqual(['x'])
    expect(out.rejected[0]?.reason).toBe('false positive')
  })

  it('first decision wins and out-of-range indexes are ignored', () => {
    const list = deduped([finding({ severity: 'low' })])
    const out = applyArbitration(list, [
      { findingIndex: 0, accepted: true, reason: 'first' },
      { findingIndex: 0, accepted: false, reason: 'second' },
      { findingIndex: 9, accepted: true, reason: 'nowhere' },
    ])
    expect(out.accepted).toHaveLength(1)
    expect(out.rejected).toHaveLength(0)
  })
})
