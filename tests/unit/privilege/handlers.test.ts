import { describe, expect, it } from 'vitest'
import { createPrivilegeHandlers } from '@main/modules/ipc/privilege-handlers'
import type { PrivilegeService } from '@main/modules/privilege/service'

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
    const ok = createPrivilegeHandlers({ service: () => yes.service, unavailableReason: null, projectOfRun: () => 'p1', confirm: async (_m, detail) => (asked.push(detail), true) })
    expect((await ok['privilege.prepare']({ scope: 'UNTIL_IDLE' })).ok).toBe(true)
    expect(yes.prepared).toBe(1)
    expect(asked[0]).toMatch(/UAC/)

    const no = fakeService()
    const refused = createPrivilegeHandlers({ service: () => no.service, unavailableReason: null, projectOfRun: () => 'p1', confirm: async () => false })
    expect(await refused['privilege.prepare']({ scope: 'UNTIL_IDLE' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Not confirmed/) })
    expect(no.prepared).toBe(0)

    const none = fakeService()
    const unasked = createPrivilegeHandlers({ service: () => none.service, unavailableReason: null, projectOfRun: () => 'p1' })
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
    const handlers = createPrivilegeHandlers({ service: () => service, unavailableReason: null, projectOfRun: () => 'p1' })
    const { report } = await handlers['privilege.activity']({})
    const lines = report.split('\n')
    expect(lines[lines.indexOf('## Privileged activity') + 2]).toMatch(/^Record integrity: BROKEN/)
    expect(report).toContain('op-3')
  })
})
