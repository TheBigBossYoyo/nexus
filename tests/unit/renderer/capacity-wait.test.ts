import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@shared/events'
import { capacityWaitLines } from '../../../src/renderer/src/views/run/eventText'

const at = (ms: number): string => `T${ms}`
const waiting = (seq: number, waitingOn?: unknown): RunEvent =>
  ({ seq, runId: 'r1', taskId: null, agentId: 'a1', type: 'capacity.waiting', createdAt: '', payload: { routingId: 'x', provider: null, reasons: ['claude:opus: PROVIDER_UNAVAILABLE', 'NO_QUALITY_SAFE_PROVIDER'], ...(waitingOn ? { waitingOn } : {}) } }) as unknown as RunEvent

describe('what a run that waits for capacity is waiting on', () => {
  it('names the provider, the reason and the reset time the provider gave', () => {
    const lines = capacityWaitLines([waiting(1, { providers: [{ provider: 'claude', state: 'QUOTA_PAUSED', resetAt: 1234, usable: false }, { provider: 'codex', state: 'AUTH_REQUIRED', resetAt: null, usable: false }], slotsFull: false })], at)
    expect(lines).toEqual(['Claude has reached its usage limit. Its limit resets at T1234.', 'Codex needs you to sign in again (Providers page).'])
  })

  it('gives no time the provider did not give', () => {
    const [line] = capacityWaitLines([waiting(1, { providers: [{ provider: 'claude', state: 'WAITING_FOR_RESET', resetAt: null, usable: false }], slotsFull: false })], at)
    expect(line).toBe('Claude has reached its usage limit. It gave no reset time; it is tried again later.')
  })

  it('says so when the providers are fine and every slot is taken', () => {
    const lines = capacityWaitLines([waiting(1, { providers: [{ provider: 'claude', state: 'AVAILABLE', resetAt: null, usable: true }], slotsFull: true })], at)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Every agent slot')
  })

  it('reads the latest wait, and shows no raw routing reason', () => {
    const lines = capacityWaitLines([
      waiting(1, { providers: [{ provider: 'claude', state: 'QUOTA_PAUSED', resetAt: null, usable: false }], slotsFull: false }),
      waiting(2, { providers: [{ provider: 'claude', state: 'THROTTLED', resetAt: null, usable: false }], slotsFull: false }),
    ], at)
    expect(lines).toEqual(['Claude is slowing requests down.'])
    expect(lines.join(' ')).not.toMatch(/[A-Z]{4,}_[A-Z]/)
  })

  it('has nothing to say for a wait recorded without detail (an older run)', () => {
    expect(capacityWaitLines([waiting(1)], at)).toEqual([])
    expect(capacityWaitLines([], at)).toEqual([])
  })
})
