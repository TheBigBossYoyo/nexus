import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { PrivilegedOperationReceipt, PrivilegedOutcome } from '@shared/privilege'

/**
 * 0.9.2 (review M7): the receipts of privileged operations form a chain. Each receipt, once final, is hashed with
 * the hash of the final receipt before it (SHA-256 over the previous hash and its canonical JSON), and that hash is
 * signed with an HMAC whose key NEXUS keeps in protected storage. Eviction of old refusals leaves a signed span in
 * their place, and a signed anchor records where the chain ends and where the receipts written before it stop.
 *
 * Pure: hashing and verification only. Reading the rows, the spans, the anchor and the key is the store's work.
 *
 * What it protects against: a program running as the owner that edits, deletes, reorders or inserts rows of the
 * database without the key. What it cannot detect: an attacker who can read the protected key, or one who rolls
 * back the database and the anchor together to an earlier state they both had (there is no independent freshness
 * anchor). The key is never part of a hash input stored in clear, and nothing here returns or prints it.
 */

export const CHAIN_VERSION = 1
export const GENESIS_HASH = '0'.repeat(64)

// The same outcomes as EVICTABLE in store.ts: only refusals are ever evicted.
const EVICTABLE_OUTCOMES: readonly PrivilegedOutcome[] = ['REJECTED_BY_POLICY', 'REJECTED_BY_DIRECTOR', 'DECLINED_BY_OWNER']

/** One row of privileged_operations as the verifier needs it. */
export interface ChainRow {
  seq: number
  chainSeq: number | null
  prevHash: string | null
  hash: string | null
  hmac: string | null
  receiptJson: string
  /** The indexed columns, which must agree with the receipt they index. */
  columns: {
    id: string
    sessionId: string | null
    runId: string | null
    projectId: string | null
    taskId: string | null
    requestedAt: string
    finishedAt: string
    capability: string
    outcome: string
  }
}

/** What an eviction leaves in place of the refusals it removed: positions from..to, both included. */
export interface EvictedSpan {
  fromChainSeq: number
  toChainSeq: number
  /** The chain hash before fromChainSeq. */
  startPrevHash: string
  /** The chain hash of toChainSeq. */
  endHash: string
  hmac: string
}

/**
 * Where the chain ended at the last write, and the boundary of the receipts written before the chain existed
 * (legacyMaxSeq: the highest seq then; legacyCount: how many rows there were). The caller passes it only once its
 * anchorHmac has been checked, or null.
 */
export interface ChainAnchor {
  headChainSeq: number
  headHash: string
  legacyMaxSeq: number | null
  legacyCount: number | null
}

export type ChainFindingKind = 'MISSING' | 'EDITED' | 'REORDERED' | 'INSERTED' | 'UNCHAINED' | 'BAD_HMAC' | 'TAIL_MISSING' | 'BOUNDARY_CHANGED' | 'BAD_SPAN'

export interface ChainFinding {
  kind: ChainFindingKind
  chainSeq: number | null
  receiptId: string | null
  detail: string
}

export interface ReceiptChainVerification {
  state: 'INTACT' | 'BROKEN' | 'UNAVAILABLE'
  reason: string | null
  /** Chained receipts that passed every check. */
  verified: number
  /** Receipts recorded before the chain existed. */
  legacy: number
  /** Receipts still EXECUTING: chained once they are final. */
  pending: number
  /** Positions covered by valid eviction spans. */
  evicted: number
  lastVerifiedChainSeq: number | null
  findings: ChainFinding[]
}

/** JSON with object keys sorted at every level, arrays in order, no whitespace, undefined values dropped. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function canonicalReceiptJson(receipt: PrivilegedOperationReceipt, chainSeq: number): string {
  return canonical({ v: CHAIN_VERSION, chainSeq, receipt })
}

/** The domain tag, then each field as a 4-byte big-endian length and its UTF-8 bytes. */
function encode(tag: string, fields: readonly string[]): Buffer {
  const parts = [Buffer.from(tag, 'ascii')]
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    parts.push(length, bytes)
  }
  return Buffer.concat(parts)
}

const mac = (key: Buffer, tag: string, fields: readonly string[]): string => createHmac('sha256', key).update(encode(tag, fields)).digest('hex')

export function chainHash(prevHash: string, canonicalJson: string): string {
  return createHash('sha256').update(encode('nexus-receipt-chain/v1', [prevHash, canonicalJson])).digest('hex')
}

export function linkHmac(key: Buffer, chainSeq: number, receiptId: string, hash: string, evictable: boolean): string {
  return mac(key, 'nexus-receipt-link/v1', [String(chainSeq), receiptId, hash, evictable ? '1' : '0'])
}

export function spanHmac(key: Buffer, fromChainSeq: number, toChainSeq: number, startPrevHash: string, endHash: string): string {
  return mac(key, 'nexus-receipt-span/v1', [String(fromChainSeq), String(toChainSeq), startPrevHash, endHash])
}

export function anchorHmac(key: Buffer, anchor: ChainAnchor): string {
  return mac(key, 'nexus-receipt-anchor/v1', [String(anchor.headChainSeq), anchor.headHash, anchor.legacyMaxSeq === null ? '' : String(anchor.legacyMaxSeq), anchor.legacyCount === null ? '' : String(anchor.legacyCount)])
}

/**
 * Whether the store may evict this receipt: the condition of store.ts (an evictable outcome, and
 * json_extract(receipt_json, '$.precheck.forbidden') IS NULL, which is true when it is absent or null).
 */
export function isEvictableReceipt(r: Pick<PrivilegedOperationReceipt, 'outcome' | 'precheck'>): boolean {
  return EVICTABLE_OUTCOMES.includes(r.outcome) && (r.precheck?.forbidden ?? null) === null
}

/** Compares two hex digests in constant time; anything that is not a SHA-256 hex digest never matches. */
function sameDigest(stored: string | null, expected: string): boolean {
  if (stored === null || !/^[0-9a-f]{64}$/.test(stored)) return false
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(expected, 'hex'))
}

function parseReceipt(json: string): PrivilegedOperationReceipt | null {
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PrivilegedOperationReceipt) : null
  } catch {
    return null
  }
}

const COLUMNS: readonly [keyof ChainRow['columns'], string][] = [
  ['id', 'id'],
  ['sessionId', 'session_id'],
  ['runId', 'run_id'],
  ['projectId', 'project_id'],
  ['taskId', 'task_id'],
  ['requestedAt', 'requested_at'],
  ['finishedAt', 'finished_at'],
  ['capability', 'capability'],
  ['outcome', 'outcome'],
]

const positions = (from: number, to: number): string => (from === to ? `position ${from}` : `positions ${from} to ${to}`)

export function verifyReceiptChain(input: {
  rows: ChainRow[]
  spans: EvictedSpan[]
  anchor: ChainAnchor | null
  key: Buffer | null
  legacyMaxSeq: number | null
  legacyCount: number | null
  unavailableReason?: string
}): ReceiptChainVerification {
  const { key, anchor } = input
  const walkFindings: ChainFinding[] = []
  const otherFindings: ChainFinding[] = []
  let legacy = 0
  let pending = 0
  let verified = 0
  let evicted = 0
  let lastVerifiedChainSeq: number | null = null
  let clean = true
  const walkFinding = (f: ChainFinding): void => {
    clean = false
    walkFindings.push(f)
  }
  const verifiedUpTo = (pos: number): void => {
    if (clean) lastVerifiedChainSeq = pos
  }

  // Sort the rows: chained, legacy, pending or unchained.
  const chained: ChainRow[] = []
  let postBoundaryFinal = 0
  let belowBoundary = 0
  for (const row of input.rows) {
    if (input.legacyMaxSeq !== null && row.seq <= input.legacyMaxSeq) belowBoundary++
    const set = [row.chainSeq, row.prevHash, row.hash].filter((v) => v !== null).length
    if (set === 3) {
      chained.push(row)
      continue
    }
    // EXECUTING only when the column and the receipt both say so: a final receipt cannot pass itself off as pending.
    const executing = row.columns.outcome === 'EXECUTING' && parseReceipt(row.receiptJson)?.outcome === 'EXECUTING'
    if (set === 0 && executing) {
      pending++
      continue
    }
    if (set === 0 && input.legacyMaxSeq !== null && row.seq <= input.legacyMaxSeq) {
      legacy++
      continue
    }
    postBoundaryFinal++
    otherFindings.push({
      kind: 'UNCHAINED',
      chainSeq: row.chainSeq,
      receiptId: row.columns.id,
      detail: set === 0 ? `Receipt ${row.columns.id} is final but has no place in the chain.` : `Receipt ${row.columns.id} has only part of its chain values.`,
    })
  }
  if (input.legacyCount !== null && belowBoundary > input.legacyCount) {
    otherFindings.push({ kind: 'INSERTED', chainSeq: null, receiptId: null, detail: `${belowBoundary} receipts are recorded before the chain existed, but only ${input.legacyCount} existed when it began.` })
  }

  // Walk the chain in position order.
  const ordered = [...chained].sort((a, b) => (a.chainSeq as number) - (b.chainSeq as number) || a.seq - b.seq)
  const groups = new Map<number, ChainRow[]>()
  const positionOfHash = new Map<string, number>()
  for (const row of ordered) {
    const pos = row.chainSeq as number
    groups.set(pos, [...(groups.get(pos) ?? []), row])
    positionOfHash.set(row.hash as string, pos)
  }
  const spans = [...input.spans].sort((a, b) => a.fromChainSeq - b.fromChainSeq)
  const used = new Set<EvictedSpan>()
  const hashAt = new Map<number, string>([[0, GENESIS_HASH]])
  let running = GENESIS_HASH
  let expected = 1
  let lastSeq = Number.NEGATIVE_INFINITY

  /** Covers positions expected..upTo-1 with spans; what no span covers is reported as gapKind. */
  const fill = (upTo: number, gapKind: 'MISSING' | 'TAIL_MISSING', resync: string | null): void => {
    while (expected < upTo) {
      const span = spans.find((s) => !used.has(s) && s.fromChainSeq === expected && s.toChainSeq >= s.fromChainSeq && s.toChainSeq < upTo)
      if (!span) break
      used.add(span)
      if (key !== null && !sameDigest(span.hmac, spanHmac(key, span.fromChainSeq, span.toChainSeq, span.startPrevHash, span.endHash))) {
        walkFinding({ kind: 'BAD_SPAN', chainSeq: span.fromChainSeq, receiptId: null, detail: `The eviction record for ${positions(span.fromChainSeq, span.toChainSeq)} is not signed by NEXUS.` })
      } else if (span.startPrevHash !== running) {
        walkFinding({ kind: 'BAD_SPAN', chainSeq: span.fromChainSeq, receiptId: null, detail: `The eviction record for ${positions(span.fromChainSeq, span.toChainSeq)} does not continue the chain.` })
      } else {
        evicted += span.toChainSeq - span.fromChainSeq + 1
        verifiedUpTo(span.toChainSeq)
      }
      running = span.endHash
      hashAt.set(span.toChainSeq, span.endHash)
      expected = span.toChainSeq + 1
    }
    if (expected < upTo) {
      walkFinding({
        kind: gapKind,
        chainSeq: expected,
        receiptId: null,
        detail: gapKind === 'MISSING' ? `The receipts at ${positions(expected, upTo - 1)} are missing.` : `The last receipts of the chain, at ${positions(expected, upTo - 1)}, are missing.`,
      })
      if (resync !== null) running = resync
      expected = upTo
    }
  }

  const linkHolds = (row: ChainRow, pos: number): boolean => {
    const parsed = parseReceipt(row.receiptJson)
    if (row.prevHash !== running || parsed === null || chainHash(row.prevHash, canonicalReceiptJson(parsed, pos)) !== row.hash) return false
    return key === null || sameDigest(row.hmac, linkHmac(key, pos, String(parsed.id), row.hash, isEvictableReceipt(parsed)))
  }

  for (const [pos, group] of groups) {
    if (!Number.isInteger(pos) || pos < 1) {
      for (const row of group) walkFinding({ kind: 'INSERTED', chainSeq: pos, receiptId: row.columns.id, detail: `Receipt ${row.columns.id} claims ${pos}, which is no position in the chain.` })
      continue
    }
    const first = group[0] as ChainRow
    fill(pos, 'MISSING', first.prevHash)
    const row = group.find((r) => linkHolds(r, pos)) ?? first
    const id = row.columns.id
    const parsed = parseReceipt(row.receiptJson)
    const prevHash = row.prevHash as string
    const hash = row.hash as string
    let ok = true
    const fail = (f: Omit<ChainFinding, 'chainSeq' | 'receiptId'>): void => {
      ok = false
      walkFinding({ ...f, chainSeq: pos, receiptId: id })
    }

    if (prevHash !== running) {
      // A link that points elsewhere: to another receipt's position, or out of the order the receipts were written in.
      const other = positionOfHash.get(prevHash)
      if ((other !== undefined && other !== pos - 1) || row.seq < lastSeq) fail({ kind: 'REORDERED', detail: `Receipt ${id} at position ${pos} follows ${other !== undefined ? `position ${other}` : 'another receipt'} instead of position ${pos - 1}.` })
      else fail({ kind: 'EDITED', detail: `Receipt ${id} at position ${pos} does not follow position ${pos - 1}.` })
    } else if (parsed === null) {
      fail({ kind: 'EDITED', detail: `Receipt ${id} at position ${pos} can no longer be read.` })
    } else {
      if (chainHash(prevHash, canonicalReceiptJson(parsed, pos)) !== hash) fail({ kind: 'EDITED', detail: `Receipt ${id} at position ${pos} no longer matches its hash.` })
      if (key !== null && !sameDigest(row.hmac, linkHmac(key, pos, String(parsed.id), hash, isEvictableReceipt(parsed)))) fail({ kind: 'BAD_HMAC', detail: `Receipt ${id} at position ${pos} is not signed by NEXUS.` })
    }
    if (parsed !== null) {
      const fields = parsed as unknown as Record<string, unknown>
      const edited = COLUMNS.filter(([field]) => (fields[field] ?? null) !== row.columns[field]).map(([, column]) => column)
      if (edited.length > 0) fail({ kind: 'EDITED', detail: `Receipt ${id} at position ${pos}: the column${edited.length === 1 ? '' : 's'} ${edited.join(', ')} no longer match${edited.length === 1 ? 'es' : ''} the receipt.` })
    }
    if (ok) {
      verified++
      verifiedUpTo(pos)
    }
    for (const extra of group) {
      if (extra !== row) walkFinding({ kind: 'INSERTED', chainSeq: pos, receiptId: extra.columns.id, detail: `Receipt ${extra.columns.id} claims position ${pos}, which receipt ${id} holds.` })
    }
    running = hash
    hashAt.set(pos, hash)
    expected = pos + 1
    lastSeq = row.seq
  }

  // The tail, against the anchor.
  if (anchor !== null) {
    fill(anchor.headChainSeq + 1, 'TAIL_MISSING', null)
    const atHead = hashAt.get(anchor.headChainSeq)
    if (atHead !== undefined && atHead !== anchor.headHash) {
      walkFinding({ kind: 'EDITED', chainSeq: anchor.headChainSeq, receiptId: null, detail: `The chain at position ${anchor.headChainSeq} is not the one NEXUS recorded.` })
    }
    if (anchor.legacyMaxSeq !== input.legacyMaxSeq || anchor.legacyCount !== input.legacyCount) {
      otherFindings.push({ kind: 'BOUNDARY_CHANGED', chainSeq: null, receiptId: null, detail: 'The boundary of the receipts recorded before the chain existed has changed.' })
    }
  } else if (chained.length > 0 || spans.length > 0 || postBoundaryFinal > 0) {
    walkFinding({ kind: 'TAIL_MISSING', chainSeq: null, receiptId: null, detail: 'The record of where the chain ends is missing.' })
  }
  for (const span of spans) {
    if (!used.has(span)) walkFinding({ kind: 'BAD_SPAN', chainSeq: span.fromChainSeq, receiptId: null, detail: `The eviction record for ${positions(span.fromChainSeq, span.toChainSeq)} does not fit the chain.` })
  }

  // Every finding is kept: the report must never hide part of a broken record.
  const findings = [...walkFindings, ...otherFindings]
  const total = findings.length
  const base = { verified, legacy, pending, evicted, lastVerifiedChainSeq, findings }
  const firstFinding = findings[0]
  if (firstFinding) return { ...base, state: 'BROKEN', reason: `${total} problem${total === 1 ? '' : 's'} found. ${firstFinding.detail}` }
  if (key === null) return { ...base, state: 'UNAVAILABLE', reason: input.unavailableReason ?? 'The key of the receipt chain is not available.' }
  return { ...base, state: 'INTACT', reason: null }
}
