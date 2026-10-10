import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderDetail, renderGraphSection, retrieve, type DetailExpansion } from '@main/modules/context-graph'
import { graphHarness } from '../../helpers/context-graph'
import { navigate, summarizeNavigation, type NavSession, type NavVariant } from '../../helpers/navigation-benchmark'
import { HELDOUT, buildWorld, type BenchWorld } from '../../helpers/retrieval-benchmark'

/**
 * Round trips, not recall: what it costs a session to reach the records its task needs (see the helper).
 * The retriever's selection is not changed by what this measures; the retrieval benchmark guards that.
 * Set NEXUS_WRITE_BENCHMARK=1 to store the figures under docs/acceptance.
 */

let w: BenchWorld
beforeAll(async () => {
  w = await buildWorld()
})
afterAll(() => w?.h.close())

const GRID: [NavSession, NavVariant][] = [['planner', 'before'], ['planner', 'after'], ['task', 'before'], ['task', 'after']]

describe('navigation benchmark', () => {
  it('reports the round trips of a planner and of a task session, before and after', () => {
    const sets = { tuning: w.cases, heldOut: HELDOUT }
    const rows = Object.entries(sets).flatMap(([set, cases]) => GRID.map(([session, variant]) => ({ set, ...summarizeNavigation(w, cases, session, variant) })))
    console.log(`\nnavigation benchmark\n${rows.map((r) => `${r.set.padEnd(8)} ${r.session.padEnd(8)} ${r.variant.padEnd(7)} calls ${String(r.calls).padStart(3)} (mean ${r.meanCalls.toFixed(2)}, max ${r.maxCalls}, none in ${r.noCall}/${r.cases})  held ${(r.heldShare * 100).toFixed(1).padStart(5)}%  file lookups ${String(r.fileLookups).padStart(3)}  section ${String(r.meanSectionTokens).padStart(5)} tok  results ${String(r.meanResultTokens).padStart(5)} tok`).join('\n')}`)
    if (process.env['NEXUS_WRITE_BENCHMARK'] === '1') {
      const dir = resolve(import.meta.dirname, '../../../docs/acceptance')
      mkdirSync(dir, { recursive: true })
      const at = new Date().toISOString()
      const perCase = Object.entries(sets).flatMap(([set, cases]) => cases.flatMap((c) => GRID.map(([session, variant]) => ({ set, session, variant, ...navigate(w, c, session, variant) }))))
      writeFileSync(join(dir, `navigation-benchmark-${at.replace(/[:.]/g, '-')}.json`), `${JSON.stringify({ kind: 'navigation-benchmark', at, note: 'context_open calls an oracle walker needs before it holds the whole text of every required record. Deterministic; no model usage. Tokens are characters / 4.', summary: rows, perCase }, null, 2)}\n`)
    }
    expect(rows).toHaveLength(8)
  })

  it('no case needs more round trips than before, for either session', () => {
    for (const c of [...w.cases, ...HELDOUT]) {
      for (const session of ['planner', 'task'] as const) expect(navigate(w, c, session, 'after').calls, `${c.key} ${session}`).toBeLessThanOrEqual(navigate(w, c, session, 'before').calls)
    }
  })

  it('a planner reaches what its request needs in a fraction of the calls a cold walk took', () => {
    for (const cases of [w.cases, HELDOUT]) {
      const before = summarizeNavigation(w, cases, 'planner', 'before')
      const after = summarizeNavigation(w, cases, 'planner', 'after')
      // Before, every required record was a walk from the root: nothing was in the prompt.
      expect(before.heldShare).toBe(0)
      expect(before.meanCalls).toBeGreaterThan(3)
      expect(after.calls).toBeLessThan(before.calls * 0.35)
      expect(after.heldShare).toBeGreaterThan(0.6)
    }
  })

  it('a task session never has to open a selected record to learn its files', () => {
    for (const cases of [w.cases, HELDOUT]) {
      expect(summarizeNavigation(w, cases, 'task', 'before').fileLookups).toBeGreaterThan(0)
      expect(summarizeNavigation(w, cases, 'task', 'after').fileLookups).toBe(0)
    }
  })

})

describe('the walk of the 0.7.1 real pair', () => {
  // The repository of `pnpm accept:graph`: three modules, a test command, and one note written by the user.
  // The real session opened "/", hazards, decisions, notes, notes/general and the note: six calls, six turns.
  const NOTE = 'The sender uses a 16-bit sequence counter, so seq wraps from 65535 to 0 about every 18 hours at one packet per second. Ordering by seq alone is wrong across a wrap; the session clock is monotonic and is the reliable order.'
  const REQUEST = 'In long sessions the race state gets corrupted: after roughly eighteen hours of running, laps of a car appear out of driving order. Find the cause in the telemetry pipeline and fix it, with a test that fails before the fix.'

  async function world() {
    const h = graphHarness({ name: 'racedeck-lite' })
    h.fact('language', 'JavaScript', 'JavaScript: 8 files in the analyzed tree', { source: 'manifest', confidence: 'high', files: ['package.json'] })
    h.fact('command', 'test', 'test: node --test', { source: 'manifest', confidence: 'high', files: ['package.json'] })
    for (const m of ['src', 'src/strategy', 'src/telemetry']) h.fact('module', m, `${m} has 2 source files.`, { files: [`${m}/index.js`] })
    await h.graph.syncProject(h.project.id)
    h.files.touch('src/telemetry/order.js')
    const note = h.graph.writeNote({ space: h.space, title: 'Packet sequence numbers wrap at 65535', body: NOTE, evidence: 'src/telemetry/packet.js: seq & 0xffff', about: 'src/telemetry/order.js', author: { source: 'user' } })
    return { h, note }
  }
  const expansionOf = (h: Awaited<ReturnType<typeof world>>['h']): DetailExpansion => ({
    childrenOf: (n) => h.graph.getChildren(n.id, [h.space], { limit: 16 }),
    textOf: (n) => h.graph.originText(n),
  })

  it('took four opens at best with one level per call, and the root listed its empty branches like the others', async () => {
    const { h, note } = await world()
    try {
      const root = h.graph.root(h.space)!
      const level = renderDetail(h.graph.detail(root.id, [h.space]), h.space)
      expect(level).toContain('- hazards [section] "Known hazards"')
      expect(level).toContain('- decisions [section] "Decisions"')
      expect(level).not.toContain('seq wraps')
      // "/" , notes, notes/general, the note.
      expect(h.graph.getPath(note.id, [h.space]).length + 1).toBe(4)
    } finally {
      h.close()
    }
  })

  it('is one open now: the root shows the note under its branch and names the branches that hold nothing', async () => {
    const { h, note } = await world()
    try {
      const root = h.graph.root(h.space)!
      const batched = renderDetail(h.graph.detail(root.id, [h.space]), h.space, { expansion: expansionOf(h) })
      expect(batched).toMatch(/Nothing recorded under: .*\bhazards\b/)
      expect(batched).toMatch(/Nothing recorded under: .*\bdecisions\b/)
      expect(batched).not.toContain('- hazards [section]')
      expect(batched).toContain(`- ${note.path} [note, user-provided] "Packet sequence numbers wrap at 65535": "The sender uses a 16-bit sequence counter`)
      // Opening the folder of the note gives its whole text: no call for the note itself.
      const folder = h.graph.getPath(note.id, [h.space]).at(-1)!
      const opened = renderDetail(h.graph.detail(folder.id, [h.space]), h.space, { expansion: expansionOf(h) })
      expect(opened.replace(/\n\s*> /g, ' ')).toContain(NOTE)
    } finally {
      h.close()
    }
  })

  it('is no open for the planner: the request retrieves the note, whole, with its evidence and the file it is about', async () => {
    const { h, note } = await world()
    try {
      const result = retrieve(h.repos.contextGraph, { spaces: [h.space], programId: null, text: REQUEST, files: [], role: 'planner', risk: 'medium', tokenBudget: 2_000 })
      expect(result.nodes.map((r) => r.node.id)).toContain(note.id)
      const section = renderGraphSection(h.repos.contextGraph, h.space, result, { tools: true }).text
      expect(section).toContain(`- ${note.path} [note, user-provided] "Packet sequence numbers wrap at 65535" (shown in full)`)
      expect(section.replace(/\n\s*> /g, ' ')).toContain(NOTE)
      expect(section).toContain('evidence given: "src/telemetry/packet.js: seq & 0xffff"')
      expect(section).toContain('An entry marked "shown in full" is the whole record')
    } finally {
      h.close()
    }
  })
})
