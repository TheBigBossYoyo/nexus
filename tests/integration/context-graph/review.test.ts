import { afterEach, describe, expect, it } from 'vitest'
import type { ContextNode } from '@shared/context-graph'
import { retrieve, warningOf } from '@main/modules/context-graph'
import { graphHarness, seedRaceDeck, type GraphHarness } from '../../helpers/context-graph'

/** Cases found by the 0.7.1 correctness review of the Context Graph. Each one failed before its fix. */

let h: GraphHarness
afterEach(() => h?.close())

const allowed = () => [h.space]
const ofMemory = (id: string): ContextNode => h.repos.contextGraph.nodes.byOrigin('memory', id)[0]!

describe('supersession', () => {
  it('a superseded node stays superseded when its record disappears and comes back', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    const old = h.memory('Persistence', 'SQLite is the authoritative persistence.', { source: 'user' })
    const next = h.memory('Persistence', 'The runtime database moved to PostgreSQL.', { source: 'architect' })
    await h.graph.syncProject(h.project.id)
    h.graph.supersede(ofMemory(old.id).id, ofMemory(next.id).id, 'Migrated.')
    const nodeId = ofMemory(old.id).id

    h.repos.memory.delete(old.id)
    await h.graph.syncProject(h.project.id)
    expect(h.repos.contextGraph.nodes.require(nodeId).status).toBe('ARCHIVED')
    h.repos.memory.insert(old)
    await h.graph.syncProject(h.project.id)
    // The record is back and says "approved"; the graph still knows it was replaced.
    expect(h.repos.contextGraph.nodes.require(nodeId).status).toBe('SUPERSEDED')
    expect(ofMemory(next.id).status).toBe('CURRENT')
    const found = retrieve(h.repos.contextGraph, { spaces: [h.space], text: 'change the persistence layer', files: [] })
    expect(found.nodes.filter((n) => n.node.title === 'Persistence').map((n) => n.node.id)).toEqual([ofMemory(next.id).id])
  })
})

describe('conflicts', () => {
  it('the same statement known in two ways is not a conflict', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    const a = h.memory('Persistence', 'SQLite is the authoritative persistence.', { source: 'user' })
    const b = h.memory('Persistence', 'SQLite is the  authoritative persistence. ', { source: 'worker' })
    const result = await h.graph.syncProject(h.project.id)
    expect(ofMemory(a.id).trust).not.toBe(ofMemory(b.id).trust)
    expect(result.conflicts).toBe(0)
    expect(ofMemory(a.id).status).toBe('CURRENT')
    expect(ofMemory(b.id).status).toBe('CURRENT')
  })

  it('a conflicted node whose file changed goes stale on refresh, and its partner is no longer in conflict', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    const a = h.memory('Persistence', 'SQLite is the authoritative persistence.', { source: 'user', filePaths: ['src/db/sqlite.ts'] })
    const b = h.memory('Persistence', 'The runtime database moved to PostgreSQL.', { source: 'architect' })
    expect((await h.graph.syncProject(h.project.id)).conflicts).toBe(2)
    const hasSource = h.repos.contextGraph.sources.ofNode(ofMemory(a.id).id).some((s) => s.kind === 'file')
    expect(hasSource).toBe(true)
    h.files.touch('src/db/sqlite.ts')
    await h.graph.refresh(h.space, h.project.rootPath, { changedFiles: ['src/db/sqlite.ts'] })
    expect(ofMemory(a.id).status).toBe('STALE')
    expect(ofMemory(b.id).status).toBe('CURRENT')
  })
})

describe('proposals', () => {
  it('a proposed entry reaches no agent: not by navigation, search or relations, and carries a warning where a person sees it', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    const pending = h.memory('Unreviewed claim about the scheduler', 'The scheduler drops every third packet.', { status: 'proposed' })
    await h.graph.syncProject(h.project.id)
    const node = ofMemory(pending.id)
    expect(node.status).toBe('PROPOSED')
    const parent = h.repos.contextGraph.nodes.get(node.parentId!)!

    for (const includeHistory of [false, true]) {
      expect(h.graph.getChildren(parent.id, allowed(), { includeHistory }).children.map((n) => n.id)).not.toContain(node.id)
      expect(h.graph.search(allowed(), 'scheduler drops packet', { includeHistory }).map((n) => n.id)).not.toContain(node.id)
      expect(h.graph.detail(parent.id, allowed(), { includeHistory }).children.map((n) => n.id)).not.toContain(node.id)
    }
    // Every node of the space: none lists the proposal as a relation.
    for (const n of h.repos.contextGraph.nodes.listBySpace(h.space, { limit: 500 })) {
      const rel = h.graph.getNeighbors(n.id, allowed(), { includeHistory: true })
      expect([...rel.outgoing, ...rel.incoming].map((r) => r.node.id)).not.toContain(node.id)
    }
    expect(retrieve(h.repos.contextGraph, { spaces: [h.space], text: 'scheduler drops every third packet', files: [], includeHistory: true }).nodes.map((r) => r.node.id)).not.toContain(node.id)

    // The Context view asks for proposals by name, and they are labelled.
    expect(h.graph.getChildren(parent.id, allowed(), { includeProposed: true }).children.map((n) => n.id)).toContain(node.id)
    expect(warningOf(node)).toContain('NOT APPROVED')
  })
})

describe('hygiene across programs', () => {
  const programNote = (programId: string | null, runId: string, title = 'Same finding', body = 'The reorder buffer loses the last packet.') =>
    h.graph.writeNote({ space: h.space, programId, folder: 'shared', title, body, author: { source: 'worker', runId } })

  it('garbage collection never archives a note because another program wrote the same text', async () => {
    h = graphHarness()
    await h.graph.syncProject(h.project.id)
    const one = programNote('program-1', 'run-1')
    const two = programNote('program-2', 'run-2')
    const none = programNote(null, 'run-3')
    expect(new Set([one.id, two.id, none.id]).size).toBe(3)
    expect(h.graph.collectGarbage(h.space, () => true)).toEqual({ duplicates: 0, obsoleteProgress: 0 })
    for (const n of [one, two, none]) expect(h.repos.contextGraph.nodes.require(n.id).status).toBe('CURRENT')
  })

  it('of two identical notes the one written first is kept', async () => {
    h = graphHarness()
    await h.graph.syncProject(h.project.id)
    const first = h.graph.writeNote({ space: h.space, folder: 'zzz', title: 'Same', body: 'One observation.', author: { source: 'worker', runId: 'run-1' } })
    const second = h.graph.writeNote({ space: h.space, folder: 'aaa', title: 'Same', body: 'One observation.', author: { source: 'worker', runId: 'run-1' } })
    // The later note sorts first by path; the earlier one must still be the one that stays.
    expect(second.path < first.path).toBe(true)
    expect(h.graph.collectGarbage(h.space, () => true).duplicates).toBe(1)
    expect(h.repos.contextGraph.nodes.require(first.id).status).toBe('CURRENT')
    expect(h.repos.contextGraph.nodes.require(second.id).status).toBe('ARCHIVED')
  })

  it('compaction folds only notes that every reader of the branch may read', async () => {
    h = graphHarness()
    await h.graph.syncProject(h.project.id)
    for (let i = 0; i < 14; i++) programNote(null, 'run-1', `Open note ${i}`, `Observation ${i} about ordering.`)
    const secret = programNote('program-1', 'run-2', 'Plan of program one', 'The buffer will be replaced in milestone three.')
    const folder = h.repos.contextGraph.nodes.get(secret.parentId!)!
    const summary = h.graph.compactNotes(folder.id)!
    expect(summary.title).toBe('Summary of 14 notes')
    expect(summary.programId).toBeNull()
    expect(summary.body).not.toContain('Plan of program one')
    expect(summary.body).not.toContain('milestone three')
    expect(h.repos.contextGraph.nodes.require(secret.id).status).toBe('CURRENT')
  })
})

describe('retrieval bounds and confidence', () => {
  it('evidence that was dropped gives no confidence: the retrieval widens', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    await h.graph.syncProject(h.project.id)
    const stores = h.repos.contextGraph
    // A file that only a stale analysis fact names: the path hit exists and is not admissible.
    const withFile = stores.sources.fileSources(h.space.id, 1000, 0)
    const target = withFile.map((s) => ({ s, node: stores.nodes.get(s.nodeId)! })).find((x) => x.node.type !== 'MEMORY' && x.node.type !== 'DECISION' && x.node.type !== 'HAZARD' && x.node.type !== 'NOTE' && x.node.type !== 'MODULE')
    if (!target) throw new Error('the seed has no analysis fact with a file')
    stores.nodes.update(target.node.id, { status: 'STALE' })
    const others = withFile.filter((s) => s.ref === target.s.ref && s.nodeId !== target.node.id)
    for (const o of others) stores.nodes.update(o.nodeId, { status: 'ARCHIVED' })
    const found = retrieve(stores, { spaces: [h.space], text: 'qqqq zzzz', files: [target.s.ref], signals: { edges: false, hierarchy: false } })
    expect(found.nodes.map((n) => n.node.id)).not.toContain(target.node.id)
    // Only the containing module (when there is a module fact) may still count as path evidence.
    const moduleHit = found.nodes.some((n) => n.via === 'path' && n.node.trust !== 'GENERATED_SUMMARY')
    if (!moduleHit) {
      expect(found.confidence).toBeLessThan(0.5)
      expect(found.widened).toBe(true)
    }
  })

  it('required nodes are bounded, however many files a task names', async () => {
    h = graphHarness()
    const files = Array.from({ length: 400 }, (_, i) => `src/gen/file-${i}.ts`)
    files.forEach((f, i) => h.fact('hazard', `generated hazard ${i}`, `File ${i} must not be edited by hand.`, { files: [f] }))
    await h.graph.syncProject(h.project.id)
    const found = retrieve(h.repos.contextGraph, { spaces: [h.space], text: 'regenerate everything', files, breadth: 'tight' })
    // Broad at most (30 nodes), three times that for required nodes.
    expect(found.nodes.length).toBeLessThanOrEqual(90)
    expect(found.excluded.some((e) => e.reason.startsWith('Required'))).toBe(true)
  })
})

describe('sync details', () => {
  it('the root lead follows the record when it becomes shorter', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    await h.graph.syncProject(h.project.id)
    const lead = (): string => h.graph.root(h.space)!.summary.split('\nContains: ')[0]!
    const before = lead()
    h.repos.projects.update(h.project.id, { name: 'RD' })
    await h.graph.syncProject(h.project.id)
    expect(lead()).not.toBe(before)
    expect(lead()).toContain('Repository RD')
    expect(lead()).not.toContain('RaceDeck')
  })

  it('an unchanged sync rewrites no source row', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    await h.graph.syncProject(h.project.id)
    const rowids = (): unknown[] => h.db.prepare('SELECT rowid FROM context_node_sources ORDER BY rowid').all()
    const before = rowids()
    expect(before.length).toBeGreaterThan(0)
    await h.graph.syncProject(h.project.id)
    expect(rowids()).toEqual(before)
  })
})
