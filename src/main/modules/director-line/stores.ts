import type { CommunicationPolicy, DeliveryAttempt, OperatorChannelKind, OperatorIdentity, ReportEvent } from '@shared/director-line'

/**
 * Persistence the line needs, as interfaces. The runtime backs them with SQLite (see docs/DIRECTOR_LINE.md for the
 * tables); the in-memory versions below are for tests and for running without a database.
 */

export interface IdentityStore {
  list(): Promise<OperatorIdentity[]>
  put(identity: OperatorIdentity): Promise<void>
  remove(channel: OperatorChannelKind, providerUserId: string): Promise<void>
}

export interface AttemptCounter {
  count: number
  lockedUntil: string | null
  /** When the count last changed. Absent on a counter written before 0.9.1. */
  at?: string
}

/** Pairing state. Only hashes are kept: neither the pairing code nor the PIN is stored in the clear. */
export interface PairingState {
  installSalt: string | null
  code: { channel: OperatorChannelKind; hash: string; expiresAt: string; wrongAttempts: number } | null
  pin: { hash: string } | null
  attempts: Record<string, AttemptCounter>
}

export interface PairingStateStore {
  load(): Promise<PairingState>
  save(state: PairingState): Promise<void>
}

export interface SeenStore {
  /** Atomic: true when the key was new and is now recorded, false when it was already there. */
  addIfAbsent(key: string, at: string): Promise<boolean>
  /** Housekeeping: forget keys older than `before`. A key forgotten is one whose provider window is long past. */
  prune(before: string): Promise<void>
}

export interface OutboxItem {
  id: string
  event: ReportEvent
  createdAt: string
  /** PENDING until delivered or dropped. */
  state: 'PENDING'
  callAttempts: number
  messageAttempts: number
  nextAttemptAt: string | null
  quietNoted: boolean
}

export interface OutboxStore {
  put(item: OutboxItem): Promise<void>
  list(): Promise<OutboxItem[]>
  remove(id: string): Promise<void>
}

export interface DeliveryStore {
  add(attempt: DeliveryAttempt): Promise<void>
  last(): Promise<DeliveryAttempt | null>
  list(limit: number): Promise<DeliveryAttempt[]>
}

export interface PolicyStore {
  get(): Promise<CommunicationPolicy | null>
  set(policy: CommunicationPolicy): Promise<void>
}

export class MemoryIdentityStore implements IdentityStore {
  private items: OperatorIdentity[] = []
  async list(): Promise<OperatorIdentity[]> { return this.items.map((i) => ({ ...i })) }
  async put(identity: OperatorIdentity): Promise<void> {
    this.items = this.items.filter((i) => !(i.channel === identity.channel && i.providerUserId === identity.providerUserId))
    this.items.push({ ...identity })
  }
  async remove(channel: OperatorChannelKind, providerUserId: string): Promise<void> {
    this.items = this.items.filter((i) => !(i.channel === channel && i.providerUserId === providerUserId))
  }
}

export class MemoryPairingStateStore implements PairingStateStore {
  private state: PairingState = { installSalt: null, code: null, pin: null, attempts: {} }
  async load(): Promise<PairingState> { return structuredClone(this.state) }
  async save(state: PairingState): Promise<void> { this.state = structuredClone(state) }
}

export class MemorySeenStore implements SeenStore {
  private keys = new Map<string, string>()
  async addIfAbsent(key: string, at: string): Promise<boolean> {
    if (this.keys.has(key)) return false
    this.keys.set(key, at)
    return true
  }
  async prune(before: string): Promise<void> {
    for (const [key, at] of this.keys) if (at < before) this.keys.delete(key)
  }
}

export class MemoryOutboxStore implements OutboxStore {
  private items = new Map<string, OutboxItem>()
  async put(item: OutboxItem): Promise<void> { this.items.set(item.id, structuredClone(item)) }
  async list(): Promise<OutboxItem[]> { return [...this.items.values()].map((i) => structuredClone(i)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }
  async remove(id: string): Promise<void> { this.items.delete(id) }
}

export class MemoryDeliveryStore implements DeliveryStore {
  readonly all: DeliveryAttempt[] = []
  async add(attempt: DeliveryAttempt): Promise<void> { this.all.push({ ...attempt }) }
  async last(): Promise<DeliveryAttempt | null> { return this.all.length ? { ...this.all[this.all.length - 1]! } : null }
  async list(limit: number): Promise<DeliveryAttempt[]> { return this.all.slice(-limit).reverse() }
}

export class MemoryPolicyStore implements PolicyStore {
  private policy: CommunicationPolicy | null = null
  async get(): Promise<CommunicationPolicy | null> { return this.policy ? structuredClone(this.policy) : null }
  async set(policy: CommunicationPolicy): Promise<void> { this.policy = structuredClone(policy) }
}
