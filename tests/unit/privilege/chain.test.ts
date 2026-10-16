import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
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
  type ChainRow,
  type EvictedSpan,
  type ReceiptChainVerification,
} from '@main/modules/privilege/chain'
import type { PrivilegedOperationReceipt, PrivilegedOutcome } from '@shared/privilege'

// 0.9.2 (review M7): the receipts of privileged operations are chained and signed; an edit, a deletion, a reordering
// or an insertion is named, and eviction of old refusals keeps what remains verifiable.

const KEY = randomBytes(32)

function receipt(id: string, outcome: PrivilegedOutcome, over: Partial<PrivilegedOperationReceipt> = {}): PrivilegedOperationReceipt {
  return {
    id,
    sessionId: 's1',
    requestedAt: `2026-10-14T02:${id.padStart(2, '0').slice(-2)}:00.000Z`,
    finishedAt: `2026-10-14T02:${id.padStart(2, '0').slice(-2)}:30.000Z`,
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

const columnsOf = (r: PrivilegedOperationReceipt): ChainRow['columns'] => ({
  id: r.id,
  sessionId: r.sessionId,
  runId: r.runId,
  projectId: r.projectId,
  taskId: r.taskId,
  requestedAt: r.requestedAt,
  finishedAt: r.finishedAt,
  capability: r.capability,
  outcome: r.outcome,
})

interface Chain {
  rows: ChainRow[]
  spans: EvictedSpan[]
  anchor: ChainAnchor | null
  legacyMaxSeq: number | null
  legacyCount: number | null
}

/** What the store does: legacy rows first (unchained), then every receipt chained in order, then the anchor. */
function build(receipts: PrivilegedOperationReceipt[], opts: { legacy?: PrivilegedOperationReceipt[]; key?: Buffer } = {}): Chain {
  const key = opts.key ?? KEY
  const rows: ChainRow[] = []
  let seq = 0
  for (const r of opts.legacy ?? []) rows.push({ seq: ++seq, chainSeq: null, prevHash: null, hash: null, hmac: null, receiptJson: JSON.stringify(r), columns: columnsOf(r) })
  const legacyMaxSeq = seq
  const legacyCount = rows.length
  let prev = GENESIS_HASH
  let chainSeq = 0
  for (const r of receipts) {
    if (r.outcome === 'EXECUTING') {
      rows.push({ seq: ++seq, chainSeq: null, prevHash: null, hash: null, hmac: null, receiptJson: JSON.stringify(r), columns: columnsOf(r) })
      continue
    }
    chainSeq++
    const hash = chainHash(prev, canonicalReceiptJson(r, chainSeq))
    rows.push({ seq: ++seq, chainSeq, prevHash: prev, hash, hmac: linkHmac(key, chainSeq, r.id, hash, isEvictableReceipt(r)), receiptJson: JSON.stringify(r), columns: columnsOf(r) })
    prev = hash
  }
  return { rows, spans: [], anchor: { headChainSeq: chainSeq, headHash: prev, legacyMaxSeq, legacyCount }, legacyMaxSeq, legacyCount }
}

/** What eviction does: removes the receipts at positions from..to and leaves a signed span. */
function evict(chain: Chain, from: number, to: number, key: Buffer = KEY): Chain {
  const first = chain.rows.find((r) => r.chainSeq === from) as ChainRow
  const last = chain.rows.find((r) => r.chainSeq === to) as ChainRow
  const span = { fromChainSeq: from, toChainSeq: to, startPrevHash: first.prevHash as string, endHash: last.hash as string }
  return { ...chain, rows: chain.rows.filter((r) => r.chainSeq === null || r.chainSeq < from || r.chainSeq > to), spans: [...chain.spans, { ...span, hmac: spanHmac(key, from, to, span.startPrevHash, span.endHash) }] }
}

const verify = (chain: Chain, key: Buffer | null = KEY, unavailableReason?: string): ReceiptChainVerification =>
  verifyReceiptChain({ rows: chain.rows, spans: chain.spans, anchor: chain.anchor, key, legacyMaxSeq: chain.legacyMaxSeq, legacyCount: chain.legacyCount, unavailableReason })

const at = (chain: Chain, id: string): ChainRow => chain.rows.find((r) => r.columns.id === id) as ChainRow

/** Five receipts: 1 ran, 2 and 3 refused, 4 ran, 5 refused. */
function intact(): Chain {
  return build([receipt('1', 'EXECUTED'), receipt('2', 'REJECTED_BY_POLICY'), receipt('3', 'DECLINED_BY_OWNER'), receipt('4', 'EXECUTED'), receipt('5', 'REJECTED_BY_DIRECTOR')])
}

describe('receipt chain primitives', () => {
  it('gives the same canonical JSON whatever the key insertion order', () => {
    const r = receipt('1', 'EXECUTED')
    const reversed = Object.fromEntries(Object.entries(r).reverse()) as unknown as PrivilegedOperationReceipt
    reversed.precheck = Object.fromEntries(Object.entries(r.precheck).reverse()) as unknown as PrivilegedOperationReceipt['precheck']
    expect(canonicalReceiptJson(reversed, 3)).toBe(canonicalReceiptJson(r, 3))
    expect(canonicalReceiptJson({ ...r, cwd: undefined } as unknown as PrivilegedOperationReceipt, 3)).not.toContain('"cwd"')
    expect(canonicalReceiptJson(r, 3)).toMatch(/^\{"chainSeq":3,"receipt":\{"agentId":null,"args":\["query"\],/)
    expect(canonicalReceiptJson(r, 3)).not.toMatch(/\s"|":\s/)
    expect(canonicalReceiptJson(r, 3)).not.toBe(canonicalReceiptJson(r, 4))
  })

  it('separates the fields of a hash so that moving bytes between them changes it', () => {
    expect(chainHash('ab', 'c')).not.toBe(chainHash('a', 'bc'))
    expect(chainHash(GENESIS_HASH, 'x')).toMatch(/^[0-9a-f]{64}$/)
    expect(linkHmac(KEY, 1, 'a', GENESIS_HASH, true)).not.toBe(linkHmac(KEY, 1, 'a', GENESIS_HASH, false))
    expect(spanHmac(KEY, 1, 2, GENESIS_HASH, GENESIS_HASH)).not.toBe(spanHmac(KEY, 1, 2, GENESIS_HASH, GENESIS_HASH.replace(/0$/, '1')))
  })

  it('evicts exactly what store.ts evicts: refusals that did not meet the deny list', () => {
    for (const o of ['REJECTED_BY_POLICY', 'REJECTED_BY_DIRECTOR', 'DECLINED_BY_OWNER'] as const) expect(isEvictableReceipt(receipt('1', o))).toBe(true)
    for (const o of ['EXECUTED', 'FAILED', 'ABORTED', 'TIMEOUT', 'EXECUTING'] as const) expect(isEvictableReceipt(receipt('1', o))).toBe(false)
    const forbidden = receipt('1', 'REJECTED_BY_POLICY', { precheck: { verdict: 'DENIED', reason: 'no', forbidden: 'DISABLE_UAC', councilRequired: false, councilWhy: [] } })
    expect(isEvictableReceipt(forbidden)).toBe(false)
    // json_extract(..., '$.precheck.forbidden') IS NULL holds for an absent field as for a null one.
    const { forbidden: _f, ...noForbidden } = receipt('1', 'REJECTED_BY_POLICY').precheck
    expect(isEvictableReceipt({ outcome: 'REJECTED_BY_POLICY', precheck: noForbidden as PrivilegedOperationReceipt['precheck'] })).toBe(true)
  })
})

describe('verifyReceiptChain', () => {
  it('finds an untouched chain INTACT', () => {
    const v = verify(intact())
    expect(v).toMatchObject({ state: 'INTACT', reason: null, verified: 5, legacy: 0, pending: 0, evicted: 0, lastVerifiedChainSeq: 5, findings: [] })
  })

  it('finds an empty record INTACT without an anchor', () => {
    expect(verifyReceiptChain({ rows: [], spans: [], anchor: null, key: KEY, legacyMaxSeq: 0, legacyCount: 0 }).state).toBe('INTACT')
  })

  it('EDITED: names a receipt whose receipt_json was edited', () => {
    const chain = intact()
    const row = at(chain, '3')
    row.receiptJson = JSON.stringify({ ...JSON.parse(row.receiptJson), goal: 'Something else' })
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toContainEqual(expect.objectContaining({ kind: 'EDITED', chainSeq: 3, receiptId: '3' }))
    expect(v.lastVerifiedChainSeq).toBe(2)
  })

  it('EDITED: names the outcome column when it no longer matches the receipt', () => {
    const chain = intact()
    at(chain, '2').columns.outcome = 'EXECUTED'
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toEqual([expect.objectContaining({ kind: 'EDITED', chainSeq: 2, receiptId: '2', detail: expect.stringContaining('outcome') })])
    expect(v.lastVerifiedChainSeq).toBe(1)
  })

  it('EDITED: names the run_id and session_id columns when they no longer match the receipt', () => {
    const chain = intact()
    at(chain, '4').columns.runId = 'run2'
    at(chain, '5').columns.sessionId = 's2'
    const v = verify(chain)
    expect(v.findings).toEqual([
      expect.objectContaining({ kind: 'EDITED', chainSeq: 4, receiptId: '4', detail: expect.stringContaining('run_id') }),
      expect.objectContaining({ kind: 'EDITED', chainSeq: 5, receiptId: '5', detail: expect.stringContaining('session_id') }),
    ])
    expect(v.lastVerifiedChainSeq).toBe(3)
  })

  it('MISSING: names the positions of a deleted interior receipt', () => {
    const chain = intact()
    chain.rows = chain.rows.filter((r) => r.columns.id !== '3')
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toEqual([expect.objectContaining({ kind: 'MISSING', chainSeq: 3, detail: expect.stringContaining('position 3') })])
    expect(v.lastVerifiedChainSeq).toBe(2)
  })

  it('TAIL_MISSING: names the positions of deleted tail receipts against the anchor', () => {
    const chain = intact()
    chain.rows = chain.rows.filter((r) => (r.chainSeq as number) <= 3)
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toEqual([expect.objectContaining({ kind: 'TAIL_MISSING', chainSeq: 4, detail: expect.stringContaining('positions 4 to 5') })])
    expect(v.lastVerifiedChainSeq).toBe(3)
  })

  it('TAIL_MISSING: notices that every chained receipt was deleted', () => {
    const chain = intact()
    chain.rows = []
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toEqual([expect.objectContaining({ kind: 'TAIL_MISSING', chainSeq: 1, detail: expect.stringContaining('positions 1 to 5') })])
    expect(v.lastVerifiedChainSeq).toBeNull()
  })

  it('TAIL_MISSING: notices the anchor itself was deleted', () => {
    const chain = intact()
    chain.anchor = null
    expect(verify(chain).findings).toEqual([expect.objectContaining({ kind: 'TAIL_MISSING', chainSeq: null })])
  })

  it('REORDERED: names receipts whose chain positions were swapped', () => {
    const chain = intact()
    at(chain, '2').chainSeq = 3
    at(chain, '3').chainSeq = 2
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toContainEqual(expect.objectContaining({ kind: 'REORDERED', chainSeq: 2, receiptId: '3' }))
    expect(v.findings).toContainEqual(expect.objectContaining({ kind: 'REORDERED', chainSeq: 3, receiptId: '2' }))
    expect(v.lastVerifiedChainSeq).toBe(1)
  })

  it('INSERTED: names a forged row that claims a position already held', () => {
    const chain = intact()
    const genuine = at(chain, '3')
    const forged = receipt('99', 'EXECUTED')
    const hash = chainHash(genuine.prevHash as string, canonicalReceiptJson(forged, 3))
    chain.rows.push({ seq: 6, chainSeq: 3, prevHash: genuine.prevHash, hash, hmac: linkHmac(randomBytes(32), 3, '99', hash, false), receiptJson: JSON.stringify(forged), columns: columnsOf(forged) })
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toEqual([expect.objectContaining({ kind: 'INSERTED', chainSeq: 3, receiptId: '99' })])
    expect(v.verified).toBe(5)
  })

  it('BAD_HMAC: names a forged row appended with a hash but no valid signature', () => {
    const chain = intact()
    const forged = receipt('99', 'EXECUTED')
    const hash = chainHash(chain.anchor?.headHash as string, canonicalReceiptJson(forged, 6))
    chain.rows.push({ seq: 6, chainSeq: 6, prevHash: chain.anchor?.headHash as string, hash, hmac: linkHmac(randomBytes(32), 6, '99', hash, false), receiptJson: JSON.stringify(forged), columns: columnsOf(forged) })
    const v = verify(chain)
    expect(v.findings).toEqual([expect.objectContaining({ kind: 'BAD_HMAC', chainSeq: 6, receiptId: '99' })])
    expect(v.lastVerifiedChainSeq).toBe(5)
  })

  it('BAD_HMAC: names a receipt whose hmac was stripped, and UNCHAINED one whose hash was stripped', () => {
    const noHmac = intact()
    at(noHmac, '4').hmac = null
    expect(verify(noHmac).findings).toEqual([expect.objectContaining({ kind: 'BAD_HMAC', chainSeq: 4, receiptId: '4' })])

    const noHash = intact()
    at(noHash, '4').hash = null
    at(noHash, '4').hmac = null
    const v = verify(noHash)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toContainEqual(expect.objectContaining({ kind: 'UNCHAINED', chainSeq: 4, receiptId: '4' }))
    expect(v.findings).toContainEqual(expect.objectContaining({ kind: 'MISSING', chainSeq: 4 }))
  })

  it('accepts a receipt beyond the anchor when it is signed (the anchor write failed)', () => {
    const chain = intact()
    chain.anchor = { ...(chain.anchor as ChainAnchor), headChainSeq: 4, headHash: at(chain, '4').hash as string }
    expect(verify(chain).state).toBe('INTACT')
  })

  it('UNCHAINED: names a final receipt after the boundary with no chain values, while EXECUTING ones are pending', () => {
    const chain = build([receipt('1', 'EXECUTED'), receipt('2', 'EXECUTING'), receipt('3', 'FAILED')])
    expect(verify(chain)).toMatchObject({ state: 'INTACT', pending: 1, verified: 2 })
    const inserted = receipt('9', 'EXECUTED')
    chain.rows.push({ seq: 10, chainSeq: null, prevHash: null, hash: null, hmac: null, receiptJson: JSON.stringify(inserted), columns: columnsOf(inserted) })
    // A final receipt that claims to be EXECUTING in its column alone is not pending.
    const disguised = receipt('8', 'EXECUTED')
    chain.rows.push({ seq: 11, chainSeq: null, prevHash: null, hash: null, hmac: null, receiptJson: JSON.stringify(disguised), columns: { ...columnsOf(disguised), outcome: 'EXECUTING' } })
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.pending).toBe(1)
    expect(v.findings).toEqual([expect.objectContaining({ kind: 'UNCHAINED', chainSeq: null, receiptId: '9' }), expect.objectContaining({ kind: 'UNCHAINED', chainSeq: null, receiptId: '8' })])
  })

  it('keeps the chain INTACT after a valid eviction span between retained receipts', () => {
    const chain = evict(intact(), 2, 3)
    const v = verify(chain)
    expect(v).toMatchObject({ state: 'INTACT', verified: 3, evicted: 2, lastVerifiedChainSeq: 5, findings: [] })
    // Two evictions side by side, the second one up to the tail.
    const tail = evict(evict(build([receipt('1', 'EXECUTED'), receipt('2', 'REJECTED_BY_POLICY'), receipt('3', 'REJECTED_BY_POLICY'), receipt('4', 'DECLINED_BY_OWNER')]), 2, 2), 3, 4)
    expect(verify(tail)).toMatchObject({ state: 'INTACT', verified: 1, evicted: 3 })
  })

  it('BAD_SPAN: names a forged eviction span', () => {
    const chain = evict(intact(), 2, 3, randomBytes(32))
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toEqual([expect.objectContaining({ kind: 'BAD_SPAN', chainSeq: 2, detail: expect.stringContaining('positions 2 to 3') })])
    expect(v.lastVerifiedChainSeq).toBe(1)
  })

  it('BAD_SPAN: a span over a receipt that ran cannot be forged without the key', () => {
    // Receipt 4 ran: the store never evicts it, so only someone without the key could have made this span.
    const chain = evict(intact(), 4, 4, randomBytes(32))
    expect(verify(chain).findings).toEqual([expect.objectContaining({ kind: 'BAD_SPAN', chainSeq: 4 })])
    // A span whose fields were altered after it was signed fails as well.
    const altered = evict(intact(), 3, 3)
    altered.spans[0] = { ...(altered.spans[0] as EvictedSpan), toChainSeq: 4, endHash: at(intact(), '4').hash as string }
    altered.rows = altered.rows.filter((r) => r.columns.id !== '4')
    expect(verify(altered).findings).toEqual([expect.objectContaining({ kind: 'BAD_SPAN', chainSeq: 3 })])
  })

  it('counts receipts recorded before the chain existed as legacy, not as broken', () => {
    const legacy = [receipt('a', 'EXECUTED'), receipt('b', 'REJECTED_BY_POLICY'), receipt('c', 'EXECUTING')]
    const chain = build([receipt('1', 'EXECUTED'), receipt('2', 'FAILED')], { legacy })
    expect(verify(chain)).toMatchObject({ state: 'INTACT', legacy: 2, pending: 1, verified: 2, findings: [] })
  })

  it('chains a legacy EXECUTING receipt once it is final', () => {
    const legacy = [receipt('a', 'EXECUTED'), receipt('c', 'EXECUTING')]
    const chain = build([receipt('1', 'EXECUTED')], { legacy })
    const row = at(chain, 'c')
    const final = receipt('c', 'EXECUTED')
    const prev = chain.anchor?.headHash as string
    const hash = chainHash(prev, canonicalReceiptJson(final, 2))
    Object.assign(row, { chainSeq: 2, prevHash: prev, hash, hmac: linkHmac(KEY, 2, 'c', hash, false), receiptJson: JSON.stringify(final), columns: columnsOf(final) })
    chain.anchor = { ...(chain.anchor as ChainAnchor), headChainSeq: 2, headHash: hash }
    expect(verify(chain)).toMatchObject({ state: 'INTACT', legacy: 1, pending: 0, verified: 2 })
  })

  it('BOUNDARY_CHANGED: notices a changed legacy boundary or count', () => {
    const legacy = [receipt('a', 'EXECUTED'), receipt('b', 'EXECUTED')]
    const moved = build([receipt('1', 'EXECUTED'), receipt('2', 'FAILED')], { legacy })
    moved.legacyMaxSeq = 3
    expect(verify(moved).findings).toContainEqual(expect.objectContaining({ kind: 'BOUNDARY_CHANGED', chainSeq: null }))
    expect(verify(moved).state).toBe('BROKEN')

    const counted = build([receipt('1', 'EXECUTED')], { legacy })
    counted.legacyCount = 5
    expect(verify(counted).findings).toEqual([expect.objectContaining({ kind: 'BOUNDARY_CHANGED' })])
  })

  it('INSERTED: notices more receipts before the boundary than existed when the chain began', () => {
    const chain = build([receipt('1', 'EXECUTED')], { legacy: [receipt('a', 'EXECUTED'), receipt('b', 'REJECTED_BY_POLICY')] })
    // An evicted legacy refusal's seq is reused for a forged receipt.
    chain.rows = chain.rows.filter((r) => r.columns.id !== 'b')
    expect(verify(chain).state).toBe('INTACT')
    const forged = receipt('x', 'EXECUTED')
    chain.rows.push({ seq: 2, chainSeq: null, prevHash: null, hash: null, hmac: null, receiptJson: JSON.stringify(forged), columns: columnsOf(forged) })
    chain.rows.push({ seq: 0, chainSeq: null, prevHash: null, hash: null, hmac: null, receiptJson: JSON.stringify(forged), columns: columnsOf(forged) })
    expect(verify(chain).findings).toEqual([expect.objectContaining({ kind: 'INSERTED', chainSeq: null })])
  })

  it('is UNAVAILABLE without the key, never INTACT, and BROKEN when a link is broken', () => {
    const v = verify(intact(), null, 'The key cannot be decrypted.')
    expect(v).toMatchObject({ state: 'UNAVAILABLE', reason: 'The key cannot be decrypted.', findings: [] })
    expect(verify(intact(), null).state).toBe('UNAVAILABLE')
    expect(verify(evict(intact(), 2, 3), null).state).toBe('UNAVAILABLE')

    const edited = intact()
    const row = at(edited, '2')
    row.receiptJson = JSON.stringify({ ...JSON.parse(row.receiptJson), goal: 'x' })
    const broken = verify(edited, null)
    expect(broken.state).toBe('BROKEN')
    expect(broken.findings).toEqual([expect.objectContaining({ kind: 'EDITED', chainSeq: 2, receiptId: '2' })])
  })

  it('collects every finding, capped at 50', () => {
    const chain = build(Array.from({ length: 80 }, (_, i) => receipt(String(i + 1), 'EXECUTED')))
    for (const row of chain.rows) row.columns.runId = 'other'
    const v = verify(chain)
    expect(v.state).toBe('BROKEN')
    expect(v.findings).toHaveLength(50)
    expect(v.reason).toMatch(/^80 problems found\./)
  })

  it('never puts the key in a canonical JSON, a hash, an HMAC or a finding', () => {
    const forms = [KEY.toString('hex'), KEY.toString('base64'), KEY.toString('base64url')]
    const out: string[] = []
    const chain = intact()
    for (const row of chain.rows) out.push(row.receiptJson, row.prevHash ?? '', row.hash ?? '', row.hmac ?? '', canonicalReceiptJson(JSON.parse(row.receiptJson) as PrivilegedOperationReceipt, row.chainSeq ?? 0))
    out.push(anchorHmac(KEY, chain.anchor as ChainAnchor), spanHmac(KEY, 1, 2, GENESIS_HASH, GENESIS_HASH))
    const broken = intact()
    at(broken, '2').columns.outcome = 'EXECUTED'
    at(broken, '4').hmac = null
    broken.rows = broken.rows.filter((r) => r.columns.id !== '3')
    broken.legacyCount = 7
    for (const v of [verify(intact()), verify(broken), verify(evict(intact(), 2, 3, randomBytes(32))), verify(intact(), null)]) out.push(JSON.stringify(v))
    for (const s of out) for (const f of forms) expect(s).not.toContain(f)
    expect(out.join('\n')).toMatch(/BAD_HMAC/)
  })
})
