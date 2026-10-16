import { describe, expect, it } from 'vitest'
import type { ReceiptChainVerification } from '@main/modules/privilege/chain'
import { buildPrivilegedActivityReport, buildPrivilegedActivitySummary } from '@main/modules/privilege/report'

const base: ReceiptChainVerification = { state: 'INTACT', reason: null, verified: 3, legacy: 0, pending: 0, evicted: 0, lastVerifiedChainSeq: 3, findings: [] }
const broken = (n = 1): ReceiptChainVerification => ({
  ...base,
  state: 'BROKEN',
  lastVerifiedChainSeq: 4,
  findings: Array.from({ length: n }, (_, i) => ({ kind: 'EDITED' as const, chainSeq: 5 + i, receiptId: `rec-${i}`, detail: 'the stored receipt no longer matches its hash' })),
})

const builders: Array<[string, (i: ReceiptChainVerification) => string]> = [
  ['full report', (i) => buildPrivilegedActivityReport([], [], i)],
  ['summary', (i) => buildPrivilegedActivitySummary([], [], i)],
]

describe.each(builders)('integrity verdict in the %s', (_name, build) => {
  it('puts an INTACT verdict directly after the heading', () => {
    const lines = build(base).split('\n')
    expect(lines[0]).toBe('## Privileged activity')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('Record integrity: intact — 3 receipts verified.')
  })

  it('names the receipt id and chain position of a BROKEN record, with no receipts and no sessions', () => {
    const text = build(broken())
    const lines = text.split('\n')
    expect(lines[2]).toContain('Record integrity: BROKEN')
    expect(lines[2]).toContain('Last verified position 4')
    expect(text).toContain('rec-0')
    expect(text).toContain('chain position 5')
  })

  it('shows why the record could not be verified', () => {
    const text = build({ ...base, state: 'UNAVAILABLE', reason: 'the protected key is not available' })
    expect(text.split('\n')[2]).toBe('Record integrity: not verified — the protected key is not available')
  })

  it('labels receipts recorded before the chain existed, pending and evicted ones', () => {
    const text = build({ ...base, legacy: 2, pending: 1, evicted: 4 })
    expect(text).toContain('2 recorded before the chain existed')
    expect(text).toContain('1 pending')
    expect(text).toContain('4 evicted refusals')
  })
})

describe.each(builders)('how many findings the %s lists', (_name, build) => {
  it('lists every one of them, past 50, and says how many there are', () => {
    const text = build(broken(80))
    expect(text.split('\n')[2]).toContain('80 findings')
    for (let i = 0; i < 80; i++) expect(text).toContain(`receipt \` rec-${i} \`, chain position ${5 + i}:`)
    expect(text).not.toContain('more finding')
  })
})

describe('findings', () => {

  it('cannot be made to inject markdown through a receipt id', () => {
    const v = broken()
    v.findings[0]!.receiptId = 'x`\n## Fake'
    expect(buildPrivilegedActivityReport([], [], v)).not.toMatch(/^## Fake/m)
  })
})
