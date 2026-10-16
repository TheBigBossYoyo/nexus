import { describe, expect, it } from 'vitest'
import { createPrivilegeHandlers, type PrivilegeRecords } from '@main/modules/ipc/privilege-handlers'
import type { PrivilegeService } from '@main/modules/privilege/service'
import type { ReceiptChainVerification } from '@main/modules/privilege/chain'

const intact: () => ReceiptChainVerification = () => ({ state: 'INTACT', reason: null, verified: 0, legacy: 0, pending: 0, evicted: 0, lastVerifiedChainSeq: null, findings: [] })
const broken: () => ReceiptChainVerification = () => ({ state: 'BROKEN', reason: null, verified: 2, legacy: 0, pending: 0, evicted: 0, lastVerifiedChainSeq: 2, findings: [{ kind: 'MISSING', chainSeq: 3, receiptId: 'op-3', detail: 'the receipt is gone' }] })

// 0.9.1 (review F5): any client holding the runtime's token reaches the privilege channels, and a UAC prompt at a
// moment someone else chose is easy to accept. A session is prepared only after NEXUS's own confirmation.

function fakeService(): { service: PrivilegeService; prepared: number } {
  const state = { prepared: 0 }
  const service = {
    status: () => null,
    history: () => [],
    prepare: async () => {
      state.prepared++
      return { ok: true, status: null }
    },
  } as unknown as PrivilegeService
  return {
    service,
    get prepared() {
      return state.prepared
    },
  }
}

describe('privilege.prepare', () => {
  it('asks the owner first, and prepares nothing when the answer is no or nobody can be asked', async () => {
    const asked: string[] = []
    const yes = fakeService()
    const ok = createPrivilegeHandlers({ service: () => yes.service, unavailableReason: null, integrity: intact, projectOfRun: () => 'p1', confirm: async (_m, detail) => (asked.push(detail), true) })
    expect((await ok['privilege.prepare']({ scope: 'UNTIL_IDLE' })).ok).toBe(true)
    expect(yes.prepared).toBe(1)
    expect(asked[0]).toMatch(/UAC/)

    const no = fakeService()
    const refused = createPrivilegeHandlers({ service: () => no.service, unavailableReason: null, integrity: intact, projectOfRun: () => 'p1', confirm: async () => false })
    expect(await refused['privilege.prepare']({ scope: 'UNTIL_IDLE' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Not confirmed/) })
    expect(no.prepared).toBe(0)

    const none = fakeService()
    const unasked = createPrivilegeHandlers({ service: () => none.service, unavailableReason: null, integrity: intact, projectOfRun: () => 'p1' })
    expect((await unasked['privilege.prepare']({ scope: 'UNTIL_IDLE' })).ok).toBe(false)
    expect(none.prepared).toBe(0)
  })
})

describe('privilege.activity', () => {
  it('puts the verdict of the receipt chain at the top of the report, even with no receipts (M7)', async () => {
    const service = {
      history: () => [],
      receipts: () => [],
      verifyChain: () => ({ state: 'BROKEN', reason: null, verified: 2, legacy: 0, pending: 0, evicted: 0, lastVerifiedChainSeq: 2, findings: [{ kind: 'MISSING', chainSeq: 3, receiptId: 'op-3', detail: 'the receipt is gone' }] }),
    } as unknown as PrivilegeService
    const handlers = createPrivilegeHandlers({ service: () => service, unavailableReason: null, integrity: broken, projectOfRun: () => 'p1' })
    const { report } = await handlers['privilege.activity']({})
    const lines = report.split('\n')
    expect(lines[lines.indexOf('## Privileged activity') + 2]).toMatch(/^Record integrity: BROKEN/)
    expect(report).toContain('op-3')
  })

  it('verifies the records in the database when there is no broker service (M7)', async () => {
    const records: PrivilegeRecords = {
      history: () => [],
      receipts: () => [],
      verifyChain: () => ({ state: 'BROKEN', reason: null, verified: 2, legacy: 0, pending: 0, evicted: 0, lastVerifiedChainSeq: 2, findings: [{ kind: 'MISSING', chainSeq: 3, receiptId: 'op-3', detail: 'the receipt is gone' }] }),
    }
    const handlers = createPrivilegeHandlers({ service: () => null, unavailableReason: 'Privilege sessions are a Windows feature.', records, integrity: broken, projectOfRun: () => 'p1' })
    const { report } = await handlers['privilege.activity']({ runId: 'r1' })
    const lines = report.split('\n')
    expect(lines[lines.indexOf('## Privileged activity') + 2]).toMatch(/^Record integrity: BROKEN/)
    expect(report).toContain('op-3')
  })
})

describe('privilege.activity without a service or records', () => {
  it('still reports a BROKEN record, naming the receipt (M7)', async () => {
    const handlers = createPrivilegeHandlers({ service: () => null, unavailableReason: 'No broker.', integrity: broken, projectOfRun: () => 'p1' })
    const { report, receipts } = await handlers['privilege.activity']({})
    expect(receipts).toEqual([])
    expect(report).toContain('BROKEN')
    expect(report).toContain('op-3')
  })
})
