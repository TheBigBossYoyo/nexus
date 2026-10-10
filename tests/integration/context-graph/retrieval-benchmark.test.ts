import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HELDOUT, buildWorld, byCategory, runVariant, summarize, type BenchWorld, type Variant } from '../../helpers/retrieval-benchmark'

/**
 * The retrieval quality gate of 0.7.1. The Context Graph may be part of context packs by default only if,
 * on these cases, a V3 pack never knows less than a V2 pack, presents nothing stale or superseded as
 * current, and the graph alone finds what tasks need. Set NEXUS_WRITE_BENCHMARK=1 to store the figures
 * under docs/acceptance.
 */

let w: BenchWorld
beforeAll(async () => {
  w = await buildWorld()
})
afterAll(() => w?.h.close())

const VARIANTS: Variant[] = ['V2', 'GRAPH', 'V3', 'FULL', 'hierarchy-only', 'fts-only', 'path-only', 'path+edges', 'graph+fts']

describe('retrieval benchmark', () => {
  it('reports recall, precision and tokens for every variant', () => {
    const rows = VARIANTS.map((v) => summarize(w, v))
    const table = rows.map((r) => `${r.variant.padEnd(15)} recall ${(r.recall * 100).toFixed(1).padStart(5)}%  precision ${(r.precision * 100).toFixed(1).padStart(5)}%  tokens ${String(r.tokens).padStart(6)}  complete ${r.complete}/${r.cases}  wrong ${r.wrong}`)
    console.log(`\nretrieval benchmark (${w.cases.length} cases)\n${table.join('\n')}`)
    for (const r of rows) if (r.missed.length > 0 && (r.variant === 'V2' || r.variant === 'GRAPH' || r.variant === 'V3')) console.log(`${r.variant} missed: ${r.missed.map((m) => `${m.case} [${m.missed.join(', ')}]`).join('; ')}`)
    if (process.env['NEXUS_WRITE_BENCHMARK'] === '1') {
      const dir = resolve(import.meta.dirname, '../../../docs/acceptance')
      mkdirSync(dir, { recursive: true })
      const at = new Date().toISOString()
      writeFileSync(join(dir, `retrieval-benchmark-${at.replace(/[:.]/g, '-')}.json`), `${JSON.stringify({ kind: 'retrieval-benchmark', at, cases: w.cases.length, variants: rows, heldOut: { cases: HELDOUT.length, variants: (['V2', 'GRAPH', 'V3', 'FULL', 'fts-only', 'path+edges'] as Variant[]).map((v) => summarize(w, v, HELDOUT)) }, byCategory: { V2: byCategory(w, 'V2'), GRAPH: byCategory(w, 'GRAPH'), V3: byCategory(w, 'V3'), FULL: byCategory(w, 'FULL') } }, null, 2)}\n`)
    }
    expect(rows).toHaveLength(VARIANTS.length)
  })

  it('a V3 pack never knows less than a V2 pack, on any case', () => {
    for (const c of w.cases) {
      const v2 = runVariant(w, c, 'V2')
      const v3 = runVariant(w, c, 'V3')
      expect(v3.recall, c.key).toBeGreaterThanOrEqual(v2.recall)
    }
  })

  it('the graph presents nothing stale, superseded or out of scope as current', () => {
    expect(summarize(w, 'GRAPH').wrong).toBe(0)
    expect(summarize(w, 'V3').wrong).toBe(0)
  })

  it('the graph alone finds what tasks need at least as well as the 0.7.0 selection', () => {
    const v2 = summarize(w, 'V2')
    const graph = summarize(w, 'GRAPH')
    const v3 = summarize(w, 'V3')
    expect(graph.recall).toBeGreaterThanOrEqual(v2.recall)
    expect(v3.recall).toBeGreaterThanOrEqual(0.95)
    expect(graph.recall).toBeGreaterThanOrEqual(0.9)
  })

  it('costs a small fraction of sending every current node', () => {
    const full = summarize(w, 'FULL')
    const v3 = summarize(w, 'V3')
    expect(full.recall).toBeGreaterThan(0.9)
    expect(v3.tokens).toBeLessThan(full.tokens * 0.4)
    expect(v3.precision).toBeGreaterThan(full.precision * 3)
  })

  it('typed edges earn their place: path and edges find more than paths alone, and text finds what has no file', () => {
    const path = summarize(w, 'path-only')
    const edges = summarize(w, 'path+edges')
    const all = summarize(w, 'GRAPH')
    expect(edges.recall).toBeGreaterThan(path.recall)
    expect(all.recall).toBeGreaterThan(edges.recall)
    expect(all.recall).toBeGreaterThanOrEqual(summarize(w, 'fts-only').recall)
    // The hierarchy alone (every hazard and decision, when retrieval is broad) finds less than half.
    expect(summarize(w, 'hierarchy-only').recall).toBeLessThan(0.5)
    // The simplest combination that reaches the full graph's recall is path + edges + text; it is what retrieval uses.
    expect(summarize(w, 'graph+fts').recall).toBe(all.recall)
  })
})

describe('held-out cases', () => {
  it('hold the two properties that are by construction, whatever their recall turns out to be', () => {
    for (const c of HELDOUT) expect(runVariant(w, c, 'V3').recall, c.key).toBeGreaterThanOrEqual(runVariant(w, c, 'V2').recall)
    expect(summarize(w, 'V3', HELDOUT).wrong).toBe(0)
    expect(summarize(w, 'GRAPH', HELDOUT).wrong).toBe(0)
  })
})

describe('precision under a large memory', () => {
  it('2,000 plausible irrelevant entries do not reach the prompt and do not hide what matters', async () => {
    const big = await buildWorld({ noiseMemory: 2000 })
    try {
      const small = summarize(w, 'GRAPH')
      const large = summarize(big, 'GRAPH')
      console.log(`large memory: nodes ${big.h.graph.health(big.spaces[0]!).nodes}, graph recall ${(large.recall * 100).toFixed(1)}% precision ${(large.precision * 100).toFixed(1)}% tokens ${large.tokens}; full dump ${summarize(big, 'FULL').tokens} tokens`)
      expect(large.recall).toBeGreaterThanOrEqual(small.recall - 0.03)
      expect(large.tokens).toBeLessThan(small.tokens * 1.3)
      expect(summarize(big, 'FULL').tokens).toBeGreaterThan(large.tokens * 20)
      expect(large.wrong).toBe(0)
    } finally {
      big.h.close()
    }
  })
})
