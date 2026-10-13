import { vi } from 'vitest'
import type { CommunicationPolicy, RawUserIntent } from '@shared/director-line'
import { DEFAULT_COMMUNICATION_POLICY } from '@shared/director-line'
import type { ProgressSnapshot } from '@shared/progress'
import { DirectorLine, type DirectorLineOptions } from '@main/modules/director-line/line'
import { PairingService } from '@main/modules/director-line/pairing'
import { fakeUpdate, FakeProvider, type RawProviderUpdate } from '@main/modules/director-line/provider'
import { MemoryDeliveryStore, MemoryIdentityStore, MemoryOutboxStore, MemoryPairingStateStore, MemoryPolicyStore, MemorySeenStore } from '@main/modules/director-line/stores'
import { FakeVoiceProvider } from '@main/modules/director-line/voice'

export const OPERATOR = '1001'
export const STRANGER = '9009'

export function snapshot(partial: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    subject: { kind: 'program', id: 'p1' },
    at: '2026-10-13T01:00:00.000Z',
    percent: 62,
    stage: 'Implementing 3 of 5 tasks',
    elapsedSeconds: 7200,
    eta: { lowSeconds: 24 * 60, highSeconds: 35 * 60, text: '24–35 min', confidence: 'MEDIUM', uncertainty: null },
    wait: 'WAITING_FOR_NETWORK',
    summary: '24–35 min of active work remain. Waiting for the Internet; when it ends is not known.',
    tasks: { total: 5, completed: 2, running: 1, waiting: 1, failed: 0, remaining: 3 },
    workers: { active: 1, waiting: 1 },
    blocker: null,
    scopeChange: null,
    lastEvent: null,
    milestones: [],
    nextRefreshAt: null,
    ...partial,
  }
}

export interface Rig {
  line: DirectorLine
  provider: FakeProvider
  voice: FakeVoiceProvider
  pairing: PairingService
  seen: MemorySeenStore
  outbox: MemoryOutboxStore
  deliveries: MemoryDeliveryStore
  policy: MemoryPolicyStore
  identities: MemoryIdentityStore
  pairingState: MemoryPairingStateStore
  clock: { t: number }
  online: { value: boolean }
  spies: {
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    submit: ReturnType<typeof vi.fn<(i: RawUserIntent) => Promise<{ accepted: boolean; reference?: string }>>>
    notify: ReturnType<typeof vi.fn>
    note: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
  }
  inbound(text: string, from?: string, id?: string): Promise<void>
  pairOperator(): Promise<void>
  setPolicy(change: (p: CommunicationPolicy) => void): Promise<void>
}

export function makeRig(extra: Partial<DirectorLineOptions> = {}, shared?: Partial<Pick<Rig, 'seen' | 'outbox' | 'deliveries' | 'policy' | 'identities' | 'pairingState'>>): Rig {
  const clock = { t: Date.parse('2026-10-13T12:00:00.000Z') }
  const online = { value: true }
  const identities = shared?.identities ?? new MemoryIdentityStore()
  const pairingState = shared?.pairingState ?? new MemoryPairingStateStore()
  const seen = shared?.seen ?? new MemorySeenStore()
  const outbox = shared?.outbox ?? new MemoryOutboxStore()
  const deliveries = shared?.deliveries ?? new MemoryDeliveryStore()
  const policy = shared?.policy ?? new MemoryPolicyStore()
  const now = (): Date => new Date(clock.t)
  const pairing = new PairingService({ state: pairingState, identities, now })
  const provider = new FakeProvider('TELEGRAM')
  const voice = new FakeVoiceProvider()
  const spies = {
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    submit: vi.fn(async (_i: RawUserIntent) => ({ accepted: true, reference: 'r-1' })),
    notify: vi.fn(async () => undefined),
    note: vi.fn(),
    status: vi.fn(async () => ({ snapshots: [{ name: 'RaceDeck', snapshot: snapshot() }], facts: { paused: false, online: true, pendingBoundaryRequests: 0 } })),
  }
  const line = new DirectorLine({
    messageProvider: provider,
    voiceProvider: voice,
    pairing,
    seen,
    outbox,
    deliveries,
    policy,
    reads: { getStatus: spies.status, getOvernightReport: async () => 'report', getLatestChecks: async () => ({ lines: ['unit: 4,773 passed'], at: null }) },
    actions: { pauseAfterCurrentTask: spies.pause, resume: spies.resume, submitIntent: spies.submit },
    localNotify: spies.notify,
    recordNote: spies.note,
    isOnline: () => online.value,
    now,
    ...extra,
  })
  let counter = 0
  const rig: Rig = {
    line, provider, voice, pairing, seen, outbox, deliveries, policy, identities, pairingState, clock, online, spies,
    async inbound(text, from = OPERATOR, id) {
      counter += 1
      const u: RawProviderUpdate = fakeUpdate({ text, providerUserId: from, providerMessageId: id ?? `m${counter}`, dedupeKey: `telegram:${id ?? `u${counter}`}` })
      await line.handleUpdate(u)
    },
    async pairOperator() {
      const { code } = await pairing.startPairing('TELEGRAM')
      await rig.inbound(code, OPERATOR)
      provider.sent.length = 0
    },
    async setPolicy(change) {
      const p = structuredClone(DEFAULT_COMMUNICATION_POLICY)
      change(p)
      await policy.set(p)
    },
  }
  return rig
}
