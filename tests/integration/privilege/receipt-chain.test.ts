import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, openDatabase, runMigrations, type Database } from '@main/modules/persistence'
import { GENESIS_HASH, canonicalReceiptJson, chainHash, type ChainFinding, type ReceiptChainVerification } from '@main/modules/privilege/chain'
import { receiptChainVault } from '@main/modules/privilege/chain-key'
import { MemoryPrivilegeStore, SqlitePrivilegeStore } from '@main/modules/privilege/store'
import type { ProtectedStorage } from '@main/modules/intelligence/connection'
import type { PrivilegedOperationReceipt, PrivilegedOutcome } from '@shared/privilege'

// 0.9.2 (review M7): the store chains every receipt once it is final, keeps the chain verifiable across eviction of old
// refusals, and verifyChain() names what was edited, deleted, reordered or inserted by direct SQL.

const MARK = 'FAKE-DPAPI:'
function fakeStorage(state: { failEncrypt?: boolean; available?: boolean } = {}): ProtectedStorage {
  return {
    available: () => state.available ?? true,
    encrypt: (v) => {
      if (state.failEncrypt) throw new Error('encrypt failed')
      return Buffer.from(MARK + Buffer.from(v, 'utf8').reverse().toString('base64'))
    },
    decrypt: (b) => {
      const s = b.toString('utf8')
      if (!s.startsWith(MARK)) throw new Error('not decryptable')
      return Buffer.from(s.slice(MARK.length), 'base64').reverse().toString('utf8')
    },
  }
}

function receipt(id: string, outcome: PrivilegedOutcome, over: Partial<PrivilegedOperationReceipt> = {}): PrivilegedOperationReceipt {
  return {
    id,
    sessionId: 's1',
    requestedAt: `2026-10-14T02:00:00.${id.padStart(3, '0').slice(-3)}Z`,
    finishedAt: `2026-10-14T02:00:30.${id.padStart(3, '0').slice(-3)}Z`,
    projectId: 'p1',
    runId: 'run1',
    taskId: 't1',
    missionTitle: 'Mission',
    taskTitle: 'Task',
    role: 'WORKER',
    agentId: null,
    capability: 'PROJECT_TOOLCHAIN_REPAIR',
    goal: 'Repair the toolchain',
    whyRequired: 'w',
    whyElevation: 'e',
    whyNoUnelevatedAlternative: 'n',
    executable: 'C:\\Windows\\System32\\sc.exe',
    args: ['query'],
    cwd: null,
    envNames: [],
    expected: { files: [], registry: [], services: [], network: 'none' },
    rollback: '',
    provenance: 'test',
    followsOperationId: null,
    precheck: { verdict: 'ALLOWED', reason: 'ok', forbidden: null, councilRequired: false, councilWhy: [] },
    reviews: [],
    finalPolicy: null,
    outcome,
    outcomeReason: 'r',
    exitCode: outcome === 'EXECUTED' ? 0 : null,
    durationMs: null,
    observed: [],
    stdout: '',
    stderr: '',
    stagedSha256: null,
    ...over,
  }
}

const dirs: string[] = []
const dbs: Database[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

function setup(opts: { db?: Database; maxReceipts?: number; storage?: ProtectedStorage } = {}) {
  const db = opts.db ?? openDatabase(':memory:')
  dbs.push(db)
  const dir = mkdtempSync(join(tmpdir(), 'receipt-chain-'))
  dirs.push(dir)
  const vault = receiptChainVault(dir, opts.storage ?? fakeStorage())
  const logs: string[] = []
  const store = new SqlitePrivilegeStore(db, { vault, log: (l) => logs.push(l), ...(opts.maxReceipts !== undefined ? { maxReceipts: opts.maxReceipts } : {}) })
  return { db, dir, vault, logs, store }
}

/** Four final receipts at positions 1..4, ids '1'..'4'. */
function chainOfFour() {
  const s = setup()
  s.store.record(receipt('1', 'EXECUTED'))
  s.store.record(receipt('2', 'REJECTED_BY_POLICY'))
  s.store.record(receipt('3', 'EXECUTED'))
  s.store.record(receipt('4', 'FAILED'))
  expect(s.store.verifyChain().state).toBe('INTACT')
  return s
}

const chainOf = (db: Database, id: string) => db.prepare('SELECT chain_seq, chain_prev, chain_hash, chain_hmac, receipt_json FROM privileged_operations WHERE id = ?').get(id) as { chain_seq: number | null; chain_prev: string | null; chain_hash: string | null; chain_hmac: string | null; receipt_json: string }

function broken(v: ReceiptChainVerification, match: Partial<ChainFinding>): ChainFinding {
  expect(v.state).toBe('BROKEN')
  const f = v.findings.find((x) => Object.entries(match).every(([k, val]) => x[k as keyof ChainFinding] === val))
  expect(f, JSON.stringify(v.findings)).toBeDefined()
  return f as ChainFinding
}

describe('SqlitePrivilegeStore receipt chain', () => {
  it('an untouched chain is INTACT', () => {
    const { store } = chainOfFour()
    const v = store.verifyChain()
    expect(v).toMatchObject({ state: 'INTACT', reason: null, verified: 4, legacy: 0, pending: 0, evicted: 0, lastVerifiedChainSeq: 4, findings: [] })
  })

  it('chains an EXECUTING receipt exactly once, when it is final, and re-recording never changes it', () => {
    const { db, store, logs } = setup()
    store.record(receipt('1', 'EXECUTING'))
    expect(chainOf(db, '1')).toMatchObject({ chain_seq: null, chain_prev: null, chain_hash: null, chain_hmac: null })
    expect(store.verifyChain()).toMatchObject({ pending: 1 })
    store.record(receipt('1', 'EXECUTED'))
    const first = chainOf(db, '1')
    expect(first.chain_seq).toBe(1)
    expect(first.chain_prev).toBe(GENESIS_HASH)
    expect(first.chain_hmac).toMatch(/^[0-9a-f]{64}$/)
    store.record(receipt('1', 'EXECUTED'))
    store.record(receipt('1', 'EXECUTING'))
    store.record(receipt('1', 'FAILED', { outcomeReason: 'changed' }))
    expect(chainOf(db, '1')).toEqual(first)
    expect(logs.some((l) => l.includes('receipt 1 is already chained'))).toBe(true)
    store.record(receipt('2', 'EXECUTED'))
    expect(chainOf(db, '2').chain_seq).toBe(2)
    expect(chainOf(db, '2').chain_prev).toBe(first.chain_hash)
    expect(store.verifyChain()).toMatchObject({ state: 'INTACT', verified: 2, pending: 0 })
  })

  it('BROKEN: an edited receipt_json', () => {
    const { db, store } = chainOfFour()
    const json = JSON.parse(chainOf(db, '2').receipt_json) as PrivilegedOperationReceipt
    db.prepare('UPDATE privileged_operations SET receipt_json = ? WHERE id = ?').run(JSON.stringify({ ...json, goal: 'something else' }), '2')
    const v = store.verifyChain()
    broken(v, { kind: 'EDITED', receiptId: '2', chainSeq: 2 })
    expect(v.lastVerifiedChainSeq).toBe(1)
  })

  it('BROKEN: an edited outcome column', () => {
    const { db, store } = chainOfFour()
    db.prepare("UPDATE privileged_operations SET outcome = 'EXECUTED' WHERE id = '2'").run()
    const v = store.verifyChain()
    expect(broken(v, { kind: 'EDITED', receiptId: '2' }).detail).toContain('outcome')
    expect(v.lastVerifiedChainSeq).toBe(1)
  })

  it('BROKEN: an edited run_id column (and session_id)', () => {
    const { db, store } = chainOfFour()
    db.prepare("UPDATE privileged_operations SET run_id = 'other', session_id = 'other' WHERE id = '3'").run()
    const v = store.verifyChain()
    const f = broken(v, { kind: 'EDITED', receiptId: '3', chainSeq: 3 })
    expect(f.detail).toContain('run_id')
    expect(f.detail).toContain('session_id')
    expect(v.lastVerifiedChainSeq).toBe(2)
  })

  it('BROKEN: a deleted interior receipt', () => {
    const { db, store } = chainOfFour()
    db.prepare("DELETE FROM privileged_operations WHERE id = '2'").run()
    const v = store.verifyChain()
    broken(v, { kind: 'MISSING', chainSeq: 2 })
    expect(v.lastVerifiedChainSeq).toBe(1)
  })

  it('BROKEN: a deleted tail receipt, and a receipt written after it does not cover the gap', () => {
    const { db, store } = chainOfFour()
    db.prepare("DELETE FROM privileged_operations WHERE id = '4'").run()
    const v = store.verifyChain()
    broken(v, { kind: 'TAIL_MISSING', chainSeq: 4 })
    expect(v.lastVerifiedChainSeq).toBe(3)
    store.record(receipt('5', 'EXECUTED'))
    expect(chainOf(db, '5').chain_seq).toBe(5)
    broken(store.verifyChain(), { kind: 'MISSING', chainSeq: 4 })
  })

  it('BROKEN: every receipt deleted', () => {
    const { db, store } = chainOfFour()
    db.prepare('DELETE FROM privileged_operations').run()
    const v = store.verifyChain()
    broken(v, { kind: 'TAIL_MISSING', chainSeq: 1 })
    expect(v.lastVerifiedChainSeq).toBeNull()
  })

  it('BROKEN: two receipts with their chain positions swapped', () => {
    const { db, store } = chainOfFour()
    db.prepare("UPDATE privileged_operations SET chain_seq = -1 WHERE id = '2'").run()
    db.prepare("UPDATE privileged_operations SET chain_seq = 2 WHERE id = '3'").run()
    db.prepare("UPDATE privileged_operations SET chain_seq = 3 WHERE id = '2'").run()
    const v = store.verifyChain()
    expect(v.state).toBe('BROKEN')
    expect(v.findings.some((f) => (f.receiptId === '3' && f.chainSeq === 2) || (f.receiptId === '2' && f.chainSeq === 3))).toBe(true)
    expect(v.lastVerifiedChainSeq).toBe(1)
  })

  it('BROKEN: an inserted row with forged chain values', () => {
    const { db, store } = chainOfFour()
    const forged = receipt('99', 'EXECUTED')
    const prev = chainOf(db, '4').chain_hash as string
    const hash = chainHash(prev, canonicalReceiptJson(forged, 5))
    db.prepare(
      `INSERT INTO privileged_operations (id, session_id, run_id, project_id, task_id, requested_at, finished_at, capability, outcome, receipt_json, chain_seq, chain_prev, chain_hash, chain_hmac)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5, ?, ?, ?)`,
    ).run(forged.id, forged.sessionId, forged.runId, forged.projectId, forged.taskId, forged.requestedAt, forged.finishedAt, forged.capability, forged.outcome, JSON.stringify(forged), prev, hash, randomBytes(32).toString('hex'))
    const v = store.verifyChain()
    broken(v, { kind: 'BAD_HMAC', receiptId: '99', chainSeq: 5 })
    expect(v.lastVerifiedChainSeq).toBe(4)
  })

  it('BROKEN: an inserted row without chain values', () => {
    const { db, store } = chainOfFour()
    const forged = receipt('98', 'EXECUTED')
    db.prepare(
      `INSERT INTO privileged_operations (id, session_id, run_id, project_id, task_id, requested_at, finished_at, capability, outcome, receipt_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(forged.id, forged.sessionId, forged.runId, forged.projectId, forged.taskId, forged.requestedAt, forged.finishedAt, forged.capability, forged.outcome, JSON.stringify(forged))
    broken(store.verifyChain(), { kind: 'UNCHAINED', receiptId: '98' })
  })

  it('BROKEN: a stripped chain_hmac', () => {
    const { db, store } = chainOfFour()
    db.prepare("UPDATE privileged_operations SET chain_hmac = NULL WHERE id = '3'").run()
    const v = store.verifyChain()
    broken(v, { kind: 'BAD_HMAC', receiptId: '3', chainSeq: 3 })
    expect(v.lastVerifiedChainSeq).toBe(2)
  })

  it('BROKEN: a changed or missing legacy boundary', () => {
    const { db, store } = chainOfFour()
    db.prepare('UPDATE privilege_chain_meta SET legacy_count = legacy_count + 1').run()
    broken(store.verifyChain(), { kind: 'BOUNDARY_CHANGED' })
    db.prepare('DELETE FROM privilege_chain_meta').run()
    broken(store.verifyChain(), { kind: 'BOUNDARY_CHANGED' })
  })

  it('BROKEN: an anchor whose HMAC fails is not trusted', () => {
    const { store, vault } = chainOfFour()
    const loaded = vault.load()
    if (loaded.state !== 'READY' || loaded.anchor === null) throw new Error('no anchor')
    vault.saveAnchor({ ...loaded.anchor, headChainSeq: 2, hmac: 'ab'.repeat(32) })
    const v = store.verifyChain()
    broken(v, { kind: 'BAD_HMAC', receiptId: null, chainSeq: null })
  })

  it('reports receipts written before the chain existed as legacy, and chains a legacy EXECUTING one once it is final', () => {
    const db = new BetterSqlite3(':memory:')
    runMigrations(db, MIGRATIONS.slice(0, 24))
    const insert = db.prepare(
      `INSERT INTO privileged_operations (id, session_id, run_id, project_id, task_id, requested_at, finished_at, capability, outcome, receipt_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of [receipt('1', 'EXECUTED'), receipt('2', 'REJECTED_BY_POLICY'), receipt('3', 'EXECUTING')]) {
      insert.run(r.id, r.sessionId, r.runId, r.projectId, r.taskId, r.requestedAt, r.finishedAt, r.capability, r.outcome, JSON.stringify(r))
    }
    runMigrations(db)
    expect(db.prepare('SELECT legacy_max_seq, legacy_count FROM privilege_chain_meta').get()).toEqual({ legacy_max_seq: 3, legacy_count: 3 })
    const { store } = setup({ db })
    store.record(receipt('4', 'EXECUTED'))
    expect(store.verifyChain()).toMatchObject({ state: 'INTACT', verified: 1, legacy: 2, pending: 1, findings: [] })
    store.record(receipt('3', 'EXECUTED'))
    expect(chainOf(db, '3').chain_seq).toBe(2)
    expect(store.verifyChain()).toMatchObject({ state: 'INTACT', verified: 2, legacy: 2, pending: 0, findings: [] })
  })

  it('stays INTACT after evicting refusals interleaved with EXECUTED receipts', () => {
    const { db, store } = setup({ maxReceipts: 20 })
    const forbidden = { verdict: 'DENIED' as const, reason: 'no', forbidden: 'DISABLE_UAC' as const, councilRequired: false, councilWhy: [] }
    for (let i = 1; i <= 100; i++) {
      const id = String(i)
      if (i % 3 === 0) store.record(receipt(id, 'EXECUTED'))
      else if (i === 10) store.record(receipt(id, 'REJECTED_BY_POLICY', { precheck: forbidden }))
      else store.record(receipt(id, i % 2 === 0 ? 'REJECTED_BY_POLICY' : 'DECLINED_BY_OWNER'))
    }
    const kept = db.prepare('SELECT id, outcome FROM privileged_operations ORDER BY seq').all() as { id: string; outcome: string }[]
    // Everything that ran stays, and so does the refusal that met the deny list.
    expect(kept.filter((r) => r.outcome === 'EXECUTED')).toHaveLength(33)
    expect(kept.some((r) => r.id === '10')).toBe(true)
    expect(kept.filter((r) => r.outcome !== 'EXECUTED').length).toBeLessThan(67)
    const v = store.verifyChain()
    expect(v).toMatchObject({ state: 'INTACT', findings: [], lastVerifiedChainSeq: 100 })
    expect(v.evicted).toBe(100 - kept.length)
    expect(v.verified).toBe(kept.length)
    store.record(receipt('101', 'EXECUTED'))
    expect(store.verifyChain()).toMatchObject({ state: 'INTACT', lastVerifiedChainSeq: 101 })
  })

  it('merges a later eviction with the span next to it', () => {
    const { db, store } = setup({ maxReceipts: 60 })
    for (let i = 1; i <= 200; i++) store.record(receipt(String(i), i === 50 ? 'EXECUTED' : 'REJECTED_BY_DIRECTOR'))
    expect(db.prepare('SELECT from_chain_seq AS f, to_chain_seq AS t FROM privilege_chain_spans ORDER BY f').all()).toEqual([
      { f: 1, t: 49 },
      { f: 51, t: 141 },
    ])
    expect(store.verifyChain()).toMatchObject({ state: 'INTACT', evicted: 140, verified: 60, lastVerifiedChainSeq: 200 })
  })

  it('BROKEN: a deleted non-refusal covered by a hand-written span', () => {
    const { db, store } = chainOfFour()
    const row = chainOf(db, '3')
    db.prepare("DELETE FROM privileged_operations WHERE id = '3'").run()
    db.prepare('INSERT INTO privilege_chain_spans (from_chain_seq, to_chain_seq, start_prev, end_hash, hmac) VALUES (3, 3, ?, ?, ?)').run(row.chain_prev, row.chain_hash, randomBytes(32).toString('hex'))
    const v = store.verifyChain()
    broken(v, { kind: 'BAD_SPAN', chainSeq: 3 })
    expect(v.lastVerifiedChainSeq).toBe(2)
  })

  it('stores the receipt when the anchor cannot be written', () => {
    const state = { failEncrypt: false }
    const { db, store, vault, logs } = setup({ storage: fakeStorage(state) })
    vault.create()
    state.failEncrypt = true
    expect(() => store.record(receipt('1', 'EXECUTED'))).not.toThrow()
    expect(chainOf(db, '1')).toMatchObject({ chain_seq: 1 })
    expect(chainOf(db, '1').chain_hmac).toMatch(/^[0-9a-f]{64}$/)
    expect(logs.some((l) => l.includes('anchor of the receipt chain was not saved'))).toBe(true)
  })

  it('is UNAVAILABLE with the reason of the vault when the protected storage is not available', () => {
    const { db, store } = setup({ storage: fakeStorage({ available: false }) })
    expect(() => store.record(receipt('1', 'EXECUTED'))).not.toThrow()
    expect(chainOf(db, '1')).toMatchObject({ chain_seq: 1, chain_hmac: null })
    const v = store.verifyChain()
    expect(v.state).toBe('UNAVAILABLE')
    expect(v.reason).toContain('protected storage')
  })

  it('keeps the key out of every column', () => {
    const { db, store, vault } = setup({ maxReceipts: 10 })
    for (let i = 1; i <= 100; i++) store.record(receipt(String(i), i % 4 === 0 ? 'EXECUTED' : 'REJECTED_BY_POLICY'))
    expect((db.prepare('SELECT COUNT(*) AS n FROM privilege_chain_spans').get() as { n: number }).n).toBeGreaterThan(0)
    const loaded = vault.load()
    if (loaded.state !== 'READY') throw new Error('no key')
    const forms = [loaded.key.toString('hex'), loaded.key.toString('base64'), loaded.key.toString('base64url')]
    for (const table of ['privileged_operations', 'privilege_chain_spans', 'privilege_chain_meta']) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
        for (const value of Object.values(row)) for (const form of forms) expect(String(value)).not.toContain(form)
      }
    }
    expect(store.verifyChain().state).toBe('INTACT')
  })
})

describe('MemoryPrivilegeStore', () => {
  it('never reports its record as INTACT', () => {
    const store = new MemoryPrivilegeStore()
    store.record(receipt('1', 'EXECUTED'))
    expect(store.verifyChain()).toMatchObject({ state: 'UNAVAILABLE', reason: 'in-memory record, not chained' })
  })
})
