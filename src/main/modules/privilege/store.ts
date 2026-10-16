import type { PrivilegeSessionScope, PrivilegeSessionState, PrivilegeSessionStatus, PrivilegedCapability, PrivilegedOperationReceipt, PrivilegedOutcome } from '@shared/privilege'
import { timingSafeEqual } from 'node:crypto'
import { PRIVILEGED_OUTCOMES } from '@shared/privilege'
import { errorMessage } from '@shared/result'
import type { Database } from '../persistence/database'
import { guard, prepare, type Row } from '../persistence/table'
import {
  GENESIS_HASH,
  anchorHmac,
  canonicalReceiptJson,
  chainHash,
  isEvictableReceipt,
  linkHmac,
  spanHmac,
  verifyReceiptChain,
  type ChainAnchor,
  type ChainFinding,
  type ChainRow,
  type EvictedSpan,
  type ReceiptChainVerification,
} from './chain'
import type { ChainAnchor as StoredAnchor, receiptChainVault } from './chain-key'

/**
 * 0.9.1: the sessions and the receipts of every privileged attempt (migration 023). 0.9.2 (review M7, migration 025):
 * each receipt that reaches a final outcome is chained once, and eviction of old refusals leaves a signed span.
 */

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
/**
 * Receipts kept in all; the oldest refusals go first. 0.9.1 (review F7): only refusals: what ran (or may have run)
 * is never evicted, so a task asking again and again cannot push the record of an operation out.
 */
const MAX_RECEIPTS = 20_000
// 0.9.1 (second review, L10): a request that met the deny list is never evicted either.
const EVICTABLE ="('REJECTED_BY_POLICY', 'REJECTED_BY_DIRECTOR', 'DECLINED_BY_OWNER')"

export interface PrivilegeSessionRow {
  id: string
  scope: PrivilegeSessionScope
  runId: string | null
  projectId: string | null
  state: PrivilegeSessionState
  capabilities: PrivilegedCapability[]
  createdAt: string
  activeAt: string | null
  expiresAt: string
  endedAt: string | null
  endReason: string | null
  uacPrompts: number
  elevated: boolean
}

export interface PrivilegeStore {
  saveSession(s: PrivilegeSessionRow): void
  session(id: string): PrivilegeSessionRow | null
  sessions(opts?: { runId?: string; limit?: number }): PrivilegeSessionRow[]
  /** Sessions a previous run of NEXUS left marked as preparing or active: their broker ended with that runtime. */
  unfinished(): PrivilegeSessionRow[]
  /** Writes a receipt, or replaces the one with its id (an operation recorded as EXECUTING before it ran). */
  record(r: PrivilegedOperationReceipt): void
  /** Operations recorded as EXECUTING: after a restart, the ones a stopped NEXUS left running. */
  executing(): PrivilegedOperationReceipt[]
  receipts(opts: { runId?: string; sessionId?: string; since?: string; limit?: number }): PrivilegedOperationReceipt[]
  counts(sessionId: string): Record<PrivilegedOutcome, number>
  /** Walks the receipt chain over every receipt kept: INTACT, BROKEN with what is wrong, or UNAVAILABLE and why. */
  verifyChain(): ReceiptChainVerification
}

export type ReceiptChainVault = ReturnType<typeof receiptChainVault>

/**
 * Adds what the store found (a bad anchor, a missing boundary, a missing key) to the verifier's findings. Without the
 * key the anchor cannot be read at all, so "the record of where the chain ends is missing" is dropped then: it is
 * not verified, not missing.
 */
function withFindings(result: ReceiptChainVerification, extra: ChainFinding[], anchorUnreadable: boolean, unavailableReason: string): ReceiptChainVerification {
  const kept = anchorUnreadable ? result.findings.filter((f) => !(f.kind === 'TAIL_MISSING' && f.chainSeq === null && f.receiptId === null)) : result.findings
  if (extra.length === 0 && kept.length === result.findings.length) return result
  const findings = [...extra, ...kept].slice(0, 50)
  const first = findings[0]
  if (first === undefined) return { ...result, state: 'UNAVAILABLE', reason: unavailableReason, findings: [] }
  const total = extra.length + kept.length
  return { ...result, state: 'BROKEN', findings, reason: `${total} problem${total === 1 ? '' : 's'} found. ${first.detail}` }
}

const sameHex = (a: string, b: string): boolean => a.length === b.length && /^[0-9a-f]*$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

/** The anchor the vault keeps, if its HMAC holds; an anchor that fails it is never trusted. */
function trustedAnchor(key: Buffer, stored: StoredAnchor | null): ChainAnchor | null {
  if (stored === null) return null
  const anchor: ChainAnchor = { headChainSeq: stored.headChainSeq, headHash: stored.headHash, legacyMaxSeq: stored.legacyMaxSeq, legacyCount: stored.legacyCount }
  return sameHex(stored.hmac, anchorHmac(key, anchor)) ? anchor : null
}

function parseReceipt(json: unknown): PrivilegedOperationReceipt | null {
  try {
    const parsed = JSON.parse(String(json)) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PrivilegedOperationReceipt) : null
  } catch {
    return null
  }
}

/** A run of consecutive chain positions: one evicted link, an existing span, or several merged. */
interface Segment {
  from: number
  to: number
  startPrev: string
  endHash: string
  /** The existing span (by from_chain_seq) this segment is, or null for a link evicted now. */
  span: number | null
}

function sessionOf(row: Row): PrivilegeSessionRow {
  let capabilities: PrivilegedCapability[]
  try {
    capabilities = JSON.parse(String(row['capabilities_json'])) as PrivilegedCapability[]
  } catch {
    capabilities = []
  }
  return {
    id: String(row['id']),
    scope: String(row['scope']) as PrivilegeSessionScope,
    runId: text(row['run_id']),
    projectId: text(row['project_id']),
    state: String(row['state']) as PrivilegeSessionState,
    capabilities,
    createdAt: String(row['created_at']),
    activeAt: text(row['active_at']),
    expiresAt: String(row['expires_at']),
    endedAt: text(row['ended_at']),
    endReason: text(row['end_reason']),
    uacPrompts: Number(row['uac_prompts']),
    elevated: Number(row['elevated']) === 1,
  }
}

export class SqlitePrivilegeStore implements PrivilegeStore {
  private inserts = 0
  private readonly vault: ReceiptChainVault | undefined
  private readonly maxReceipts: number
  private readonly log: (line: string) => void

  constructor(
    private readonly db: Database,
    opts: { vault?: ReceiptChainVault; maxReceipts?: number; log?: (line: string) => void } = {},
  ) {
    this.vault = opts.vault
    this.maxReceipts = opts.maxReceipts ?? MAX_RECEIPTS
    this.log = opts.log ?? ((line) => console.error(`[nexus] ${line}`))
  }

  saveSession(s: PrivilegeSessionRow): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO privilege_sessions (id, scope, run_id, project_id, state, capabilities_json, created_at, active_at, expires_at, ended_at, end_reason, uac_prompts, elevated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, active_at = excluded.active_at, expires_at = excluded.expires_at, ended_at = excluded.ended_at,
           end_reason = excluded.end_reason, uac_prompts = excluded.uac_prompts, elevated = excluded.elevated`,
      ).run(s.id, s.scope, s.runId, s.projectId, s.state, JSON.stringify(s.capabilities), s.createdAt, s.activeAt, s.expiresAt, s.endedAt, s.endReason?.slice(0, 400) ?? null, s.uacPrompts, s.elevated ? 1 : 0),
    )
  }

  session(id: string): PrivilegeSessionRow | null {
    const row = prepare(this.db, 'SELECT * FROM privilege_sessions WHERE id = ?').get(id) as Row | undefined
    return row ? sessionOf(row) : null
  }

  sessions(opts: { runId?: string; limit?: number } = {}): PrivilegeSessionRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 200)
    const rows = (opts.runId !== undefined
      ? prepare(this.db, 'SELECT * FROM privilege_sessions WHERE run_id = ? ORDER BY created_at DESC LIMIT ?').all(opts.runId, limit)
      : prepare(this.db, 'SELECT * FROM privilege_sessions ORDER BY created_at DESC LIMIT ?').all(limit)) as Row[]
    return rows.map(sessionOf)
  }

  unfinished(): PrivilegeSessionRow[] {
    return (prepare(this.db, "SELECT * FROM privilege_sessions WHERE state IN ('PREPARING', 'ACTIVE')").all() as Row[]).map(sessionOf)
  }

  /**
   * 0.9.2: a receipt is chained once, when it first reaches a final outcome; an EXECUTING one is written as before
   * and chained when it is final; a chained row is never cleared, changed or chained again. The anchor is saved after
   * the commit, best effort: the operation already ran, so a failing vault never makes this throw.
   */
  record(r: PrivilegedOperationReceipt): void {
    const json = JSON.stringify(r)
    const chained = guard(() =>
      this.db.transaction((): boolean => {
        const existing = prepare(this.db, 'SELECT chain_seq, receipt_json FROM privileged_operations WHERE id = ?').get(r.id) as Row | undefined
        if (existing !== undefined && existing['chain_seq'] !== null) {
          if (String(existing['receipt_json']) !== json) this.log(`privilege: receipt ${r.id} is already chained and was kept as it was recorded.`)
          return false
        }
        if (r.outcome === 'EXECUTING') {
          prepare(
            this.db,
            `INSERT INTO privileged_operations (id, session_id, run_id, project_id, task_id, requested_at, finished_at, capability, outcome, receipt_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, outcome = excluded.outcome, receipt_json = excluded.receipt_json`,
          ).run(r.id, r.sessionId, r.runId, r.projectId, r.taskId, r.requestedAt, r.finishedAt, r.capability, r.outcome, json)
          return false
        }
        const { key, anchor } = this.chainKey(true)
        // Never behind the anchor: a tail deleted before this write stays a gap instead of being written over.
        let head = this.head()
        if (anchor !== null && anchor.headChainSeq > head.seq) head = { seq: anchor.headChainSeq, hash: anchor.headHash }
        const pos = head.seq + 1
        const hash = chainHash(head.hash, canonicalReceiptJson(r, pos))
        const hmac = key === null ? null : linkHmac(key, pos, r.id, hash, isEvictableReceipt(r))
        // The indexed columns follow the final receipt, so that they match what is chained.
        prepare(
          this.db,
          `INSERT INTO privileged_operations (id, session_id, run_id, project_id, task_id, requested_at, finished_at, capability, outcome, receipt_json, chain_seq, chain_prev, chain_hash, chain_hmac)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, run_id = excluded.run_id, project_id = excluded.project_id, task_id = excluded.task_id,
             requested_at = excluded.requested_at, finished_at = excluded.finished_at, capability = excluded.capability, outcome = excluded.outcome,
             receipt_json = excluded.receipt_json, chain_seq = excluded.chain_seq, chain_prev = excluded.chain_prev, chain_hash = excluded.chain_hash, chain_hmac = excluded.chain_hmac`,
        ).run(r.id, r.sessionId, r.runId, r.projectId, r.taskId, r.requestedAt, r.finishedAt, r.capability, r.outcome, json, pos, head.hash, hash, hmac)
        return true
      })(),
    )
    if (chained) this.saveAnchor()
    if (++this.inserts % 100 === 0) {
      const total = (prepare(this.db, 'SELECT COUNT(*) AS n FROM privileged_operations').get() as { n: number }).n
      if (total > this.maxReceipts) this.evict(total - this.maxReceipts)
    }
  }

  /**
   * Evicts the oldest refusals, as many as are over the limit. Unchained ones (recorded before the chain existed) are
   * deleted; chained ones only with the key, and only when their signature shows them evictable: a run of them is
   * folded, with the spans next to it, into one signed span that keeps the chain verifiable.
   */
  private evict(count: number): void {
    const { key } = this.chainKey(false)
    const folded = guard(() =>
      this.db.transaction((): boolean => {
        const rows = prepare(this.db, `SELECT seq, chain_seq, chain_prev, chain_hash, chain_hmac, receipt_json FROM privileged_operations WHERE seq IN (SELECT seq FROM privileged_operations WHERE outcome IN ${EVICTABLE} AND json_extract(receipt_json, '$.precheck.forbidden') IS NULL ORDER BY seq LIMIT ?)`).all(count) as Row[]
        const remove = prepare(this.db, 'DELETE FROM privileged_operations WHERE seq = ?')
        const links: Segment[] = []
        for (const row of rows) {
          if (row['chain_seq'] === null) remove.run(row['seq'])
          else if (key !== null && this.evictableLink(key, row)) links.push({ from: Number(row['chain_seq']), to: Number(row['chain_seq']), startPrev: String(row['chain_prev']), endHash: String(row['chain_hash']), span: null })
        }
        if (links.length === 0 || key === null) return false
        const positions = this.fold(key, links)
        const removeLink = prepare(this.db, 'DELETE FROM privileged_operations WHERE chain_seq = ?')
        for (const pos of positions) removeLink.run(pos)
        return positions.length > 0
      })(),
    )
    if (folded) this.saveAnchor()
  }

  /** Whether a chained row may be evicted: its receipt is a refusal, its hash holds, and NEXUS signed it as evictable. */
  private evictableLink(key: Buffer, row: Row): boolean {
    const parsed = parseReceipt(row['receipt_json'])
    if (parsed === null || !isEvictableReceipt(parsed) || row['chain_hmac'] === null) return false
    const pos = Number(row['chain_seq'])
    const hash = String(row['chain_hash'])
    if (chainHash(String(row['chain_prev']), canonicalReceiptJson(parsed, pos)) !== hash) return false
    return sameHex(String(row['chain_hmac']), linkHmac(key, pos, String(parsed.id), hash, true))
  }

  /**
   * Merges the evicted links with each other and with the signed spans next to them, writes one span per merged run,
   * and returns the positions of the links it covered. A span that is not signed, or a run that would overlap a span
   * it cannot merge with, is left as it is, and its links are kept.
   */
  private fold(key: Buffer, links: Segment[]): number[] {
    const existing = (prepare(this.db, 'SELECT from_chain_seq, to_chain_seq, start_prev, end_hash, hmac FROM privilege_chain_spans').all() as Row[]).map((s) => ({
      from: Number(s['from_chain_seq']),
      to: Number(s['to_chain_seq']),
      startPrev: String(s['start_prev']),
      endHash: String(s['end_hash']),
      hmac: String(s['hmac']),
    }))
    const signed: Segment[] = existing
      .filter((s) => sameHex(s.hmac, spanHmac(key, s.from, s.to, s.startPrev, s.endHash)))
      .map((s) => ({ from: s.from, to: s.to, startPrev: s.startPrev, endHash: s.endHash, span: s.from }))
    const segments = [...links, ...signed].sort((a, b) => a.from - b.from)
    const runs: Segment[][] = []
    for (const seg of segments) {
      const run = runs[runs.length - 1]
      const last = run?.[run.length - 1]
      if (run !== undefined && last !== undefined && last.to + 1 === seg.from && last.endHash === seg.startPrev) run.push(seg)
      else runs.push([seg])
    }
    const covered: number[] = []
    const removeSpan = prepare(this.db, 'DELETE FROM privilege_chain_spans WHERE from_chain_seq = ?')
    const insertSpan = prepare(this.db, 'INSERT INTO privilege_chain_spans (from_chain_seq, to_chain_seq, start_prev, end_hash, hmac) VALUES (?, ?, ?, ?, ?)')
    for (const run of runs) {
      const fresh = run.filter((s) => s.span === null)
      if (fresh.length === 0) continue
      const first = run[0] as Segment
      const last = run[run.length - 1] as Segment
      const merged = new Set(run.flatMap((s) => (s.span === null ? [] : [s.span])))
      if (existing.some((s) => !merged.has(s.from) && s.from <= last.to && s.to >= first.from)) continue
      for (const from of merged) removeSpan.run(from)
      insertSpan.run(first.from, last.to, first.startPrev, last.endHash, spanHmac(key, first.from, last.to, first.startPrev, last.endHash))
      covered.push(...fresh.map((s) => s.from))
    }
    return covered
  }

  /** The last position of the chain (a receipt or the end of a span) and its hash; position 0 is the genesis. */
  private head(): { seq: number; hash: string } {
    const row = prepare(this.db, 'SELECT chain_seq AS s, chain_hash AS h FROM privileged_operations WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1').get() as { s: number; h: string } | undefined
    const span = prepare(this.db, 'SELECT to_chain_seq AS s, end_hash AS h FROM privilege_chain_spans ORDER BY to_chain_seq DESC LIMIT 1').get() as { s: number; h: string } | undefined
    const top = span !== undefined && (row === undefined || span.s > row.s) ? span : row
    return top === undefined ? { seq: 0, hash: GENESIS_HASH } : { seq: Number(top.s), hash: String(top.h) }
  }

  /**
   * The key and the trusted anchor, or null for each. With create, a key is made when there is none and nothing has
   * been chained yet; once receipts are chained, a missing key is never replaced by a new one. Never throws.
   */
  private chainKey(create: boolean): { key: Buffer | null; anchor: ChainAnchor | null } {
    if (this.vault === undefined) return { key: null, anchor: null }
    try {
      const v = this.vault.load()
      if (v.state === 'READY') return { key: v.key, anchor: trustedAnchor(v.key, v.anchor) }
      if (v.state === 'ABSENT' && create) {
        const started = prepare(this.db, 'SELECT EXISTS (SELECT 1 FROM privileged_operations WHERE chain_seq IS NOT NULL) OR EXISTS (SELECT 1 FROM privilege_chain_spans) AS n').get() as { n: number }
        if (Number(started.n) === 0) return { key: this.vault.create(), anchor: null }
      }
    } catch (e) {
      this.log(`privilege: the receipt-chain key is not available: ${errorMessage(e)}`)
    }
    return { key: null, anchor: null }
  }

  /**
   * Records the head of the chain and the legacy boundary in the vault, signed. Never moves a trusted anchor back, and
   * keeps the boundary it recorded first. Best effort: a failure is logged, never thrown.
   */
  private saveAnchor(): void {
    if (this.vault === undefined) return
    try {
      const v = this.vault.load()
      if (v.state !== 'READY') return
      const previous = trustedAnchor(v.key, v.anchor)
      let legacyMaxSeq: number
      let legacyCount: number
      if (previous !== null && previous.legacyMaxSeq !== null && previous.legacyCount !== null) {
        legacyMaxSeq = previous.legacyMaxSeq
        legacyCount = previous.legacyCount
      } else {
        const meta = prepare(this.db, 'SELECT legacy_max_seq, legacy_count FROM privilege_chain_meta WHERE id = 1').get() as Row | undefined
        if (meta === undefined) throw new Error('the boundary of the receipts recorded before the chain existed is missing')
        legacyMaxSeq = Number(meta['legacy_max_seq'])
        legacyCount = Number(meta['legacy_count'])
      }
      let head = this.head()
      if (previous !== null && previous.headChainSeq > head.seq) head = { seq: previous.headChainSeq, hash: previous.headHash }
      const anchor: ChainAnchor = { headChainSeq: head.seq, headHash: head.hash, legacyMaxSeq, legacyCount }
      this.vault.saveAnchor({ headChainSeq: head.seq, headHash: head.hash, legacyMaxSeq, legacyCount, hmac: anchorHmac(v.key, anchor) })
    } catch (e) {
      this.log(`privilege: the anchor of the receipt chain was not saved: ${errorMessage(e)}`)
    }
  }

  verifyChain(): ReceiptChainVerification {
    const rows: ChainRow[] = (prepare(this.db, 'SELECT * FROM privileged_operations ORDER BY seq').all() as Row[]).map((row) => ({
      seq: Number(row['seq']),
      chainSeq: num(row['chain_seq']),
      prevHash: text(row['chain_prev']),
      hash: text(row['chain_hash']),
      hmac: text(row['chain_hmac']),
      receiptJson: String(row['receipt_json']),
      columns: {
        id: String(row['id']),
        sessionId: text(row['session_id']),
        runId: text(row['run_id']),
        projectId: text(row['project_id']),
        taskId: text(row['task_id']),
        requestedAt: String(row['requested_at']),
        finishedAt: String(row['finished_at']),
        capability: String(row['capability']),
        outcome: String(row['outcome']),
      },
    }))
    const spans: EvictedSpan[] = (prepare(this.db, 'SELECT * FROM privilege_chain_spans').all() as Row[]).map((s) => ({
      fromChainSeq: Number(s['from_chain_seq']),
      toChainSeq: Number(s['to_chain_seq']),
      startPrevHash: String(s['start_prev']),
      endHash: String(s['end_hash']),
      hmac: String(s['hmac']),
    }))
    const meta = prepare(this.db, 'SELECT legacy_max_seq, legacy_count FROM privilege_chain_meta WHERE id = 1').get() as Row | undefined
    const extra: ChainFinding[] = []
    let key: Buffer | null = null
    let anchor: ChainAnchor | null = null
    let unavailableReason = 'This store does not keep the receipt-chain key.'
    if (this.vault !== undefined) {
      let v: ReturnType<ReceiptChainVault['load']>
      try {
        v = this.vault.load()
      } catch (e) {
        v = { state: 'UNAVAILABLE', reason: `the receipt-chain key could not be read: ${errorMessage(e)}` }
      }
      if (v.state === 'READY') {
        key = v.key
        anchor = trustedAnchor(v.key, v.anchor)
        if (v.anchor !== null && anchor === null) extra.push({ kind: 'BAD_HMAC', chainSeq: null, receiptId: null, detail: 'The record of where the chain ends is not signed by NEXUS.' })
      } else if (v.state === 'ABSENT') {
        unavailableReason = 'No receipt-chain key has been created yet.'
        // A key was used once receipts are signed: its disappearance must not turn a check into "not verified".
        if (spans.length > 0 || rows.some((r) => r.hmac !== null)) extra.push({ kind: 'BAD_HMAC', chainSeq: null, receiptId: null, detail: 'The receipt-chain key is missing, though receipts were signed with it.' })
      } else {
        unavailableReason = v.reason
      }
    }
    const result = verifyReceiptChain({
      rows,
      spans,
      anchor,
      key,
      legacyMaxSeq: meta === undefined ? null : Number(meta['legacy_max_seq']),
      legacyCount: meta === undefined ? null : Number(meta['legacy_count']),
      unavailableReason,
    })
    if (meta === undefined && !result.findings.some((f) => f.kind === 'BOUNDARY_CHANGED')) {
      extra.push({ kind: 'BOUNDARY_CHANGED', chainSeq: null, receiptId: null, detail: 'The boundary of the receipts recorded before the chain existed is missing.' })
    }
    return withFindings(result, extra, key === null, unavailableReason)
  }

  executing(): PrivilegedOperationReceipt[] {
    return (prepare(this.db, "SELECT receipt_json FROM privileged_operations WHERE outcome = 'EXECUTING' ORDER BY seq").all() as Row[]).flatMap((row) => {
      try {
        return [JSON.parse(String(row['receipt_json'])) as PrivilegedOperationReceipt]
      } catch {
        return []
      }
    })
  }

  receipts(opts: { runId?: string; sessionId?: string; since?: string; limit?: number }): PrivilegedOperationReceipt[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.runId !== undefined) {
      where.push('run_id = ?')
      params.push(opts.runId)
    }
    if (opts.sessionId !== undefined) {
      where.push('session_id = ?')
      params.push(opts.sessionId)
    }
    if (opts.since !== undefined) {
      where.push('requested_at >= ?')
      params.push(opts.since)
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000)
    const rows = prepare(this.db, `SELECT receipt_json FROM privileged_operations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`).all(...params, limit) as Row[]
    return rows
      .map((row) => {
        try {
          return JSON.parse(String(row['receipt_json'])) as PrivilegedOperationReceipt
        } catch {
          return null
        }
      })
      .filter((r): r is PrivilegedOperationReceipt => r !== null)
      .reverse()
  }

  counts(sessionId: string): Record<PrivilegedOutcome, number> {
    const out = Object.fromEntries(PRIVILEGED_OUTCOMES.map((o) => [o, 0])) as Record<PrivilegedOutcome, number>
    for (const row of prepare(this.db, 'SELECT outcome, COUNT(*) AS n FROM privileged_operations WHERE session_id = ? GROUP BY outcome').all(sessionId) as { outcome: PrivilegedOutcome; n: number }[]) out[row.outcome] = row.n
    return out
  }
}

/** The same, in memory: for tests and for a runtime without a database. */
export class MemoryPrivilegeStore implements PrivilegeStore {
  readonly sessionRows = new Map<string, PrivilegeSessionRow>()
  readonly receiptRows: PrivilegedOperationReceipt[] = []

  saveSession(s: PrivilegeSessionRow): void {
    this.sessionRows.set(s.id, { ...s })
  }
  session(id: string): PrivilegeSessionRow | null {
    return this.sessionRows.get(id) ?? null
  }
  sessions(opts: { runId?: string } = {}): PrivilegeSessionRow[] {
    return [...this.sessionRows.values()].filter((s) => opts.runId === undefined || s.runId === opts.runId).reverse()
  }
  unfinished(): PrivilegeSessionRow[] {
    return [...this.sessionRows.values()].filter((s) => s.state === 'PREPARING' || s.state === 'ACTIVE')
  }
  record(r: PrivilegedOperationReceipt): void {
    const at = this.receiptRows.findIndex((x) => x.id === r.id)
    if (at >= 0) this.receiptRows[at] = structuredClone(r)
    else this.receiptRows.push(structuredClone(r))
  }
  executing(): PrivilegedOperationReceipt[] {
    return this.receiptRows.filter((r) => r.outcome === 'EXECUTING').map((r) => structuredClone(r))
  }
  receipts(opts: { runId?: string; sessionId?: string; since?: string }): PrivilegedOperationReceipt[] {
    return this.receiptRows.filter((r) => (opts.runId === undefined || r.runId === opts.runId) && (opts.sessionId === undefined || r.sessionId === opts.sessionId) && (opts.since === undefined || r.requestedAt >= opts.since))
  }
  counts(sessionId: string): Record<PrivilegedOutcome, number> {
    const out = Object.fromEntries(PRIVILEGED_OUTCOMES.map((o) => [o, 0])) as Record<PrivilegedOutcome, number>
    for (const r of this.receiptRows) if (r.sessionId === sessionId) out[r.outcome]++
    return out
  }
  verifyChain(): ReceiptChainVerification {
    return { state: 'UNAVAILABLE', reason: 'in-memory record, not chained', verified: 0, legacy: 0, pending: 0, evicted: 0, lastVerifiedChainSeq: null, findings: [] }
  }
}

export type { PrivilegeSessionStatus }
