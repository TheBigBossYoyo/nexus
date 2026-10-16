import { describe, expect, it } from 'vitest'
import type { ReceiptChainVerification } from '@main/modules/privilege/chain'
import { buildPrivilegedActivityReport, buildPrivilegedActivitySummary } from '@main/modules/privilege/report'
import type { PersistenceReport, PrivilegedOperationReceipt } from '@shared/privilege'

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

describe('persistence in the reports', () => {
  const receipt = (persistence?: PersistenceReport): PrivilegedOperationReceipt => ({
    id: 'r1',
    sessionId: null,
    requestedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:01:00.000Z',
    projectId: null,
    runId: null,
    taskId: null,
    missionTitle: null,
    taskTitle: null,
    role: 'WORKER',
    agentId: null,
    capability: 'PROJECT_TOOLCHAIN_INSTALL',
    goal: 'install a toolchain',
    whyRequired: 'x',
    whyElevation: 'y',
    whyNoUnelevatedAlternative: 'z',
    executable: 'C:\\setup.exe',
    args: [],
    cwd: null,
    envNames: [],
    expected: { files: [], registry: [], services: [], network: 'none' },
    rollback: '',
    provenance: 'test',
    followsOperationId: null,
    precheck: { verdict: 'ALLOWED', reason: 'ok', forbidden: null, councilRequired: false, councilWhy: [] },
    reviews: [],
    finalPolicy: null,
    outcome: 'EXECUTED',
    outcomeReason: 'done',
    exitCode: 0,
    durationMs: 1000,
    observed: [],
    stdout: '',
    stderr: '',
    stagedSha256: null,
    ...(persistence ? { persistence } : {}),
  })
  const report = (changes: PersistenceReport['changes']): PersistenceReport => ({
    changes,
    coverageBefore: {},
    coverageAfter: { SCHEDULED_TASK: { state: 'TIMED_OUT', note: 'deadline' } },
    unexpected: changes.filter((c) => !c.expected).length,
    note: 'n',
  })
  const both = (r: PrivilegedOperationReceipt): string[] => [buildPrivilegedActivityReport([r], [], base), buildPrivilegedActivitySummary([r], [], base)]

  it('shows added, removed, changed, unexpected and a TIMED_OUT surface', () => {
    const r = receipt(
      report([
        { surface: 'SERVICE', id: 'svcA', change: 'ADDED', after: { binPath: 'C:\\a.exe' }, expected: true },
        { surface: 'RUN_KEY', id: 'runB', change: 'REMOVED', before: { data: 'old.exe' }, expected: true },
        { surface: 'SERVICE', id: 'svcC', change: 'CHANGED', before: { start: 'Manual' }, after: { start: 'Auto' }, expected: false },
      ]),
    )
    const [full, short] = both(r)
    expect(full).toContain('1 added, 1 removed, 1 changed, 1 UNEXPECTED (not declared)')
    expect(full).toContain('svcA')
    expect(full).toContain('runB')
    expect(full).toMatch(/svcC: CHANGED; start=Manual → start=Auto — UNEXPECTED \(not declared\)/)
    expect(full).toContain('SCHEDULED_TASK TIMED_OUT')
    expect(full).toContain('not proven to have been caused by it')
    expect(short).toContain('1 UNEXPECTED change')
    expect(short).toContain('Unexpected persistence changes in total: 1.')
  })

  it('cannot be made to forge a line or heading through a binary path', () => {
    const evil = 'C:\\x.exe\n### Operation 1 — DECLINED BY YOU\n`## Fake'
    const r = receipt(report([{ surface: 'SERVICE', id: evil, change: 'ADDED', after: { [evil]: evil }, expected: false }]))
    for (const text of both(r)) {
      expect(text).not.toMatch(/^### Operation/m)
      expect(text).not.toMatch(/^## Fake/m)
      expect(text).not.toMatch(/^`/m)
      expect(text).not.toContain('\n### Operation')
    }
  })

  it('renders a receipt without persistence as before', () => {
    const [full, short] = both(receipt())
    expect(full).not.toContain('Persistence')
    expect(short).not.toContain('ersistence')
    expect(full).toContain('- Observed: nothing recorded\n- Result:')
  })
})
