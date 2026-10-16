import type { CommunicationPolicy, DeliveryAttempt, OperatorChannelKind, OperatorIdentity, PairingMethod, ReportEvent } from '@shared/director-line'
import type { Database } from '../persistence/database'
import { sanitizeVoiceLineConfig, type VoiceLineConfig } from './voice-config'
import type { CallRecord } from './voice-line'
import type { OffsetStore } from './telegram'
import type { AttemptCounter, DeliveryStore, IdentityStore, OutboxItem, OutboxStore, PairingState, PairingStateStore, PolicyStore, SeenStore } from './stores'

/**
 * SQLite backing for the Director Line stores (tables of migration 020). The methods are async to match the
 * interfaces, but every statement is one synchronous better-sqlite3 call, so each is atomic with respect to the
 * others in this process. Nothing secret is a column: the pairing code and the PIN exist only as salted hashes.
 */

interface IdentityRow { channel: string; provider_user_id: string; label: string; paired_at: string; paired_via: string }

export class SqliteIdentityStore implements IdentityStore {
  constructor(private readonly db: Database) {}

  async list(): Promise<OperatorIdentity[]> {
    const rows = this.db.prepare('SELECT channel, provider_user_id, label, paired_at, paired_via FROM director_line_identities ORDER BY paired_at, provider_user_id').all() as IdentityRow[]
    return rows.map((r) => ({ channel: r.channel as OperatorChannelKind, providerUserId: r.provider_user_id, label: r.label, pairedAt: r.paired_at, pairedVia: r.paired_via as PairingMethod }))
  }

  async put(identity: OperatorIdentity): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO director_line_identities (channel, provider_user_id, label, paired_at, paired_via) VALUES (?, ?, ?, ?, ?)')
      .run(identity.channel, identity.providerUserId, identity.label, identity.pairedAt, identity.pairedVia)
  }

  async remove(channel: OperatorChannelKind, providerUserId: string): Promise<void> {
    this.db.prepare('DELETE FROM director_line_identities WHERE channel = ? AND provider_user_id = ?').run(channel, providerUserId)
  }
}

interface PairingRow {
  install_salt: string | null
  code_channel: string | null
  code_hash: string | null
  code_expires_at: string | null
  code_wrong_attempts: number | null
  pin_hash: string | null
  attempts_json: string
}

function parseAttempts(json: string): Record<string, AttemptCounter> {
  try {
    const value: unknown = JSON.parse(json)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, AttemptCounter> = {}
    for (const [key, raw] of Object.entries(value)) {
      const c = raw as { count?: unknown; lockedUntil?: unknown; at?: unknown }
      if (typeof c?.count === 'number') out[key] = { count: c.count, lockedUntil: typeof c.lockedUntil === 'string' ? c.lockedUntil : null, ...(typeof c.at === 'string' ? { at: c.at } : {}) }
    }
    return out
  } catch {
    return {}
  }
}

export class SqlitePairingStateStore implements PairingStateStore {
  constructor(private readonly db: Database) {}

  async load(): Promise<PairingState> {
    const row = this.db.prepare('SELECT install_salt, code_channel, code_hash, code_expires_at, code_wrong_attempts, pin_hash, attempts_json FROM director_line_pairing_state WHERE id = 1').get() as PairingRow | undefined
    if (!row) return { installSalt: null, code: null, pin: null, attempts: {} }
    return {
      installSalt: row.install_salt,
      code:
        row.code_hash && row.code_channel && row.code_expires_at
          ? { channel: row.code_channel as OperatorChannelKind, hash: row.code_hash, expiresAt: row.code_expires_at, wrongAttempts: row.code_wrong_attempts ?? 0 }
          : null,
      pin: row.pin_hash ? { hash: row.pin_hash } : null,
      attempts: parseAttempts(row.attempts_json),
    }
  }

  async save(state: PairingState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO director_line_pairing_state (id, install_salt, code_channel, code_hash, code_expires_at, code_wrong_attempts, pin_hash, attempts_json)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET install_salt = excluded.install_salt, code_channel = excluded.code_channel, code_hash = excluded.code_hash,
           code_expires_at = excluded.code_expires_at, code_wrong_attempts = excluded.code_wrong_attempts, pin_hash = excluded.pin_hash, attempts_json = excluded.attempts_json`,
      )
      .run(state.installSalt, state.code?.channel ?? null, state.code?.hash ?? null, state.code?.expiresAt ?? null, state.code?.wrongAttempts ?? null, state.pin?.hash ?? null, JSON.stringify(state.attempts))
  }
}

export class SqliteSeenStore implements SeenStore {
  constructor(private readonly db: Database) {}

  /** One statement: a key that is already there changes nothing, and `changes` says which happened. */
  async addIfAbsent(key: string, at: string): Promise<boolean> {
    return this.db.prepare('INSERT OR IGNORE INTO director_line_seen (key, seen_at) VALUES (?, ?)').run(key, at).changes === 1
  }

  async prune(before: string): Promise<void> {
    this.db.prepare('DELETE FROM director_line_seen WHERE seen_at < ?').run(before)
  }
}

interface OutboxRow { id: string; created_at: string; event_json: string; call_attempts: number; message_attempts: number; next_attempt_at: string | null; quiet_noted: number }

export class SqliteOutboxStore implements OutboxStore {
  constructor(private readonly db: Database) {}

  async put(item: OutboxItem): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO director_line_outbox (id, created_at, event_json, call_attempts, message_attempts, next_attempt_at, quiet_noted)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, event_json = excluded.event_json, call_attempts = excluded.call_attempts,
           message_attempts = excluded.message_attempts, next_attempt_at = excluded.next_attempt_at, quiet_noted = excluded.quiet_noted`,
      )
      .run(item.id, item.createdAt, JSON.stringify(item.event), item.callAttempts, item.messageAttempts, item.nextAttemptAt, item.quietNoted ? 1 : 0)
  }

  async list(): Promise<OutboxItem[]> {
    const rows = this.db.prepare('SELECT id, created_at, event_json, call_attempts, message_attempts, next_attempt_at, quiet_noted FROM director_line_outbox ORDER BY created_at, id').all() as OutboxRow[]
    const items: OutboxItem[] = []
    for (const r of rows) {
      let event: ReportEvent
      try {
        event = JSON.parse(r.event_json) as ReportEvent
      } catch {
        // A row that cannot be read can never be sent; it is not kept to be retried for ever.
        this.db.prepare('DELETE FROM director_line_outbox WHERE id = ?').run(r.id)
        continue
      }
      items.push({ id: r.id, event, createdAt: r.created_at, state: 'PENDING', callAttempts: r.call_attempts, messageAttempts: r.message_attempts, nextAttemptAt: r.next_attempt_at, quietNoted: r.quiet_noted === 1 })
    }
    return items
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM director_line_outbox WHERE id = ?').run(id)
  }
}

interface DeliveryRow { report_id: string; channel: string; at: string; outcome: string; provider_reference: string | null; error_class: string | null }

function toAttempt(r: DeliveryRow): DeliveryAttempt {
  return { reportId: r.report_id, channel: r.channel as DeliveryAttempt['channel'], at: r.at, outcome: r.outcome as DeliveryAttempt['outcome'], providerReference: r.provider_reference, errorClass: r.error_class }
}

export class SqliteDeliveryStore implements DeliveryStore {
  constructor(private readonly db: Database) {}

  async add(attempt: DeliveryAttempt): Promise<void> {
    this.db
      .prepare('INSERT INTO director_line_deliveries (report_id, channel, at, outcome, provider_reference, error_class) VALUES (?, ?, ?, ?, ?, ?)')
      .run(attempt.reportId, attempt.channel, attempt.at, attempt.outcome, attempt.providerReference, attempt.errorClass)
  }

  async last(): Promise<DeliveryAttempt | null> {
    const row = this.db.prepare('SELECT report_id, channel, at, outcome, provider_reference, error_class FROM director_line_deliveries ORDER BY id DESC LIMIT 1').get() as DeliveryRow | undefined
    return row ? toAttempt(row) : null
  }

  /** Newest first, like the in-memory store. */
  async list(limit: number): Promise<DeliveryAttempt[]> {
    const rows = this.db.prepare('SELECT report_id, channel, at, outcome, provider_reference, error_class FROM director_line_deliveries ORDER BY id DESC LIMIT ?').all(Math.max(0, Math.floor(limit))) as DeliveryRow[]
    return rows.map(toAttempt)
  }
}

export class SqlitePolicyStore implements PolicyStore {
  constructor(private readonly db: Database) {}

  async get(): Promise<CommunicationPolicy | null> {
    const row = this.db.prepare('SELECT policy_json FROM director_line_policy WHERE id = 1').get() as { policy_json: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.policy_json) as CommunicationPolicy
    } catch {
      return null
    }
  }

  async set(policy: CommunicationPolicy): Promise<void> {
    this.db
      .prepare('INSERT INTO director_line_policy (id, policy_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET policy_json = excluded.policy_json')
      .run(JSON.stringify(policy))
  }
}

export interface DirectorLineSettingsRow {
  enabled: boolean
  messageProvider: OperatorChannelKind | null
  telegramOffset: number | null
}

/**
 * The single settings row: enabled, the message provider and the Telegram offset. Holds no secret. The columns
 * `voice_provider` and `relay_base_url` of migration 020 are no longer read: since 0.9.1 voice is SIP (its own table),
 * and a 0.9.0 row that says TWILIO_VOICE means nothing.
 */
export class SqliteDirectorLineSettings {
  constructor(private readonly db: Database) {}

  read(): DirectorLineSettingsRow {
    const row = this.db.prepare('SELECT enabled, message_provider, telegram_offset FROM director_line_settings WHERE id = 1').get() as
      | { enabled: number; message_provider: string | null; telegram_offset: number | null }
      | undefined
    return {
      enabled: row?.enabled === 1,
      messageProvider: (row?.message_provider ?? null) as OperatorChannelKind | null,
      telegramOffset: row?.telegram_offset ?? null,
    }
  }

  private ensure(): void {
    this.db.prepare('INSERT OR IGNORE INTO director_line_settings (id) VALUES (1)').run()
  }

  setEnabled(enabled: boolean): void {
    this.ensure()
    this.db.prepare('UPDATE director_line_settings SET enabled = ? WHERE id = 1').run(enabled ? 1 : 0)
  }

  setMessageProvider(kind: OperatorChannelKind | null): void {
    this.ensure()
    this.db.prepare('UPDATE director_line_settings SET message_provider = ? WHERE id = 1').run(kind)
  }

  setOffset(offset: number | null): void {
    this.ensure()
    this.db.prepare('UPDATE director_line_settings SET telegram_offset = ? WHERE id = 1').run(offset)
  }
}

/** The Telegram offset, kept in the settings row so a restart does not fetch (and answer) old updates again. */
export class SqliteOffsetStore implements OffsetStore {
  constructor(private readonly settings: SqliteDirectorLineSettings) {}
  async get(): Promise<number | null> { return this.settings.read().telegramOffset }
  async set(offset: number): Promise<void> { this.settings.setOffset(offset) }
}

/** The non-secret configuration of the voice line: one JSON row (migration 021). The SIP password is never in it. */
export class SqliteVoiceConfigStore {
  constructor(private readonly db: Database) {}

  get(): VoiceLineConfig {
    const row = this.db.prepare('SELECT config_json FROM director_line_voice WHERE id = 1').get() as { config_json: string } | undefined
    if (!row) return sanitizeVoiceLineConfig(null)
    try {
      return sanitizeVoiceLineConfig(JSON.parse(row.config_json))
    } catch {
      return sanitizeVoiceLineConfig(null)
    }
  }

  set(config: VoiceLineConfig): void {
    this.db
      .prepare('INSERT INTO director_line_voice (id, config_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json')
      .run(JSON.stringify(config))
  }
}

export const MAX_CALL_RECORDS = 200

interface CallRow {
  call_id: string; direction: string; started_at: string; ended_at: string; outcome: string; end_reason: string | null
  authenticated: number; signalling: string | null; media: string | null; end_to_end: number | null; peer_verified: number | null; median_answer_ms: number | null
}

/** What is kept of each call: when, which way, how it ended, what was negotiated. Never what was said, and never the verification code. The newest 200 stay. */
export class SqliteCallStore {
  constructor(private readonly db: Database) {}

  add(call: CallRecord): void {
    this.db
      .prepare(
        `INSERT INTO director_line_calls (call_id, direction, started_at, ended_at, outcome, end_reason, authenticated, signalling, media, end_to_end, peer_verified, median_answer_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(call.callId, call.direction, call.startedAt, call.endedAt, call.outcome, call.endReason, call.authenticated ? 1 : 0, call.security?.signalling ?? null, call.security?.media ?? null, call.security ? (call.security.endToEnd ? 1 : 0) : null, call.security ? (call.security.peerVerified ? 1 : 0) : null, call.medianAnswerMs === null ? null : Math.round(call.medianAnswerMs))
    this.db.prepare('DELETE FROM director_line_calls WHERE seq <= (SELECT MAX(seq) FROM director_line_calls) - ?').run(MAX_CALL_RECORDS)
  }

  /** Newest first. */
  recent(limit: number): CallRecord[] {
    const rows = this.db
      .prepare('SELECT call_id, direction, started_at, ended_at, outcome, end_reason, authenticated, signalling, media, end_to_end, peer_verified, median_answer_ms FROM director_line_calls ORDER BY seq DESC LIMIT ?')
      .all(Math.max(0, Math.floor(limit))) as CallRow[]
    return rows.map((r) => ({
      callId: r.call_id,
      direction: r.direction as CallRecord['direction'],
      startedAt: r.started_at,
      endedAt: r.ended_at,
      outcome: r.outcome as CallRecord['outcome'],
      endReason: r.end_reason as CallRecord['endReason'],
      authenticated: r.authenticated === 1,
      security: r.signalling !== null && r.media !== null ? { signalling: r.signalling as 'TLS' | 'NONE' | 'UNKNOWN', media: r.media as 'SRTP' | 'ZRTP' | 'DTLS_SRTP' | 'NONE' | 'UNKNOWN', endToEnd: r.end_to_end === 1, peerVerified: r.peer_verified === 1, sas: null } : null,
      medianAnswerMs: r.median_answer_ms,
    }))
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM director_line_calls').get() as { n: number }).n
  }
}

/** The times of the calls NEXUS placed in the last day (migration 022), so that the daily limit survives a restart. */
export class SqlitePlacedCallStore {
  constructor(private readonly db: Database) {}

  add(at: Date): void {
    this.db.prepare('INSERT INTO director_line_placed_calls (placed_at) VALUES (?)').run(at.toISOString())
  }

  /** The times since `since`, oldest first. Older rows are dropped. */
  since(since: Date): Date[] {
    this.db.prepare('DELETE FROM director_line_placed_calls WHERE placed_at < ?').run(since.toISOString())
    const rows = this.db.prepare('SELECT placed_at FROM director_line_placed_calls ORDER BY seq').all() as { placed_at: string }[]
    return rows.map((r) => new Date(r.placed_at))
  }
}
