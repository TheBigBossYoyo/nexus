import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ContextNode, ContextSpace } from '@shared/context-graph'
import { newId } from '@shared/ids'
import { estimateTokens } from '@shared/token'
import { ContextGraphService, depthOf, parentPath, renderGraphSection, retrieve } from '@main/modules/context-graph'
import { createRepositories, openDatabase } from '@main/modules/persistence'
import { mulberry32 } from '@main/modules/policy'
import { TokenIntelligenceEngine } from '@main/modules/token'
import { makeProject, makeRun } from '../integration/persistence/fixtures'
import { FakeFiles, graphHarness, seedRaceDeck } from '../helpers/context-graph'

/**
 * Context Graph and token-accounting stress. Three parts:
 *  1. scale: a graph of NEXUS_GRAPH_STRESS_NODES nodes and five times as many edges; every query a renderer
 *     or an agent can make stays bounded and answers from indexes;
 *  2. histories: NEXUS_CONTEXT_STRESS_RUNS random sequences of changes to the stores, the files and the graph,
 *     with the invariants checked after every step;
 *  3. accounting: random usage reports through the Token Intelligence Engine.
 * The defaults are small enough for every test run; a release runs 100,000 nodes and 5,000 histories.
 */

const NODES = Number(process.env['NEXUS_GRAPH_STRESS_NODES'] ?? 20_000)
const RUNS = Number(process.env['NEXUS_CONTEXT_STRESS_RUNS'] ?? 40)
const STEPS = 24

describe(`context graph at scale (${NODES} nodes, ${NODES * 5} edges)`, () => {
  it('answers navigation, search and retrieval from indexes, in pages', () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const project = repos.projects.insert(makeProject({ name: 'Large' }))
    const space: ContextSpace = { kind: 'project', id: project.id }
    const at = '2026-10-07T00:00:00.000Z'
    const rand = mulberry32(42)
    const words = ['telemetry', 'parser', 'strategy', 'history', 'renderer', 'migration', 'session', 'export', 'weather', 'updater', 'packet', 'cache', 'token', 'schema', 'buffer', 'replay']
    const word = (): string => words[Math.floor(rand() * words.length)] as string

    const insertNode = db.prepare(
      `INSERT INTO context_nodes (id, space_kind, space_id, program_id, type, path, parent_id, depth, title, summary, body, origin_kind, origin_id, trust, status, confidence, subject_key, content_hash, summary_hash, version, token_estimate, classification, provenance, created_at, updated_at, source_updated_at, refreshed_at)
       VALUES (?, 'project', ?, NULL, ?, ?, ?, ?, ?, ?, NULL, 'graph', NULL, ?, ?, 'medium', NULL, ?, NULL, 1, ?, 'normal', '{"source":"graph"}', ?, ?, NULL, ?)`,
    )
    const insertEdge = db.prepare(`INSERT OR IGNORE INTO context_edges (id, from_id, to_id, type, trust, confidence, provenance, created_at, updated_at) VALUES (?, ?, ?, ?, 'VERIFIED', 'high', '{"source":"static_analysis"}', ?, ?)`)
    const insertSource = db.prepare(`INSERT OR IGNORE INTO context_node_sources (node_id, space_id, kind, ref, hash) VALUES (?, ?, 'file', ?, '1:1')`)

    const ids: string[] = []
    const modules: string[] = []
    const started = Date.now()
    db.transaction(() => {
      const rootId = newId()
      insertNode.run(rootId, project.id, 'REPOSITORY', '', null, 0, 'Large', 'Repository Large.', 'GENERATED_SUMMARY', 'CURRENT', 'h', 4, at, at, at)
      const modulesId = newId()
      insertNode.run(modulesId, project.id, 'SECTION', 'modules', rootId, 1, 'Modules', '', 'GENERATED_SUMMARY', 'CURRENT', 'h', 2, at, at, at)
      const moduleCount = Math.max(10, Math.floor(NODES / 200))
      for (let m = 0; m < moduleCount; m++) {
        const id = newId()
        insertNode.run(id, project.id, 'MODULE', `modules/m${m}`, modulesId, 2, `src/m${m}`, `Module ${m}: ${word()} and ${word()}.`, 'VERIFIED', 'CURRENT', `h${m}`, 12, at, at, at)
        modules.push(id)
        ids.push(id)
      }
      const types = ['SYMBOL', 'TEST', 'COMPONENT', 'HAZARD', 'DECISION', 'MEMORY'] as const
      const statuses = ['CURRENT', 'CURRENT', 'CURRENT', 'CURRENT', 'STALE', 'SUPERSEDED', 'ARCHIVED'] as const
      for (let i = ids.length + 2; i < NODES; i++) {
        const m = Math.floor(rand() * modules.length)
        const id = newId()
        const title = `${word()} ${word()} ${i}`
        const summary = `The ${word()} of ${word()} depends on the ${word()} ${word()}; entry ${i}.`
        insertNode.run(id, project.id, types[i % types.length], `modules/m${m}/n${i}`, modules[m], 3, title, summary, i % 9 === 0 ? 'AGENT_NOTE' : 'VERIFIED', statuses[i % statuses.length], `c${i}`, estimateTokens(`${title}\n${summary}`), at, at, at)
        insertSource.run(id, project.id, `src/m${m}/f${i % 50}.ts`)
        ids.push(id)
      }
      const edgeTypes = ['DEPENDS_ON', 'TESTED_BY', 'AFFECTED_BY', 'DECIDED_BY', 'RELATED_TO'] as const
      for (let e = 0; e < NODES * 5; e++) {
        const from = ids[Math.floor(rand() * ids.length)] as string
        const to = ids[Math.floor(rand() * ids.length)] as string
        if (from !== to) insertEdge.run(newId(), from, to, edgeTypes[e % edgeTypes.length], at, at)
      }
    })()
    const built = Date.now() - started
    const counts = { nodes: (db.prepare('SELECT COUNT(*) AS n FROM context_nodes').get() as { n: number }).n, edges: (db.prepare('SELECT COUNT(*) AS n FROM context_edges').get() as { n: number }).n }
    expect(counts.nodes).toBe(NODES)
    expect(counts.edges).toBeGreaterThan(NODES * 4.9)

    const graph = new ContextGraphService({ repos })
    const stores = repos.contextGraph
    const timings: Record<string, number> = {}
    const time = <T>(name: string, fn: () => T): T => {
      const t = performance.now()
      const out = fn()
      timings[name] = Math.round((performance.now() - t) * 10) / 10
      return out
    }
    const root = stores.nodes.root(space) as ContextNode
    const allowed = [space]

    const children = time('children of a module (page of 100)', () => graph.getChildren(modules[0] as string, allowed, { limit: 100 }))
    expect(children.children.length).toBeLessThanOrEqual(100)
    expect(children.total).toBeGreaterThan(children.children.length - 1)
    // A request for more than the page maximum is cut to it: the whole graph cannot be pulled in one call.
    expect(stores.nodes.listBySpace(space, { limit: 1_000_000 }).length).toBeLessThanOrEqual(500)
    expect(time('expand root, depth 3, 60 nodes', () => graph.expand(root.id, allowed, 3, 60))).toHaveLength(60)
    expect(time('expand root, limit above the cap', () => graph.expand(root.id, allowed, 4, 100_000)).length).toBeLessThanOrEqual(200)
    const hits = time('full-text search', () => graph.search(allowed, 'telemetry parser buffer', { limit: 20 }))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(20)
    const neighbors = time('neighbors of a node', () => graph.getNeighbors(ids[500] as string, allowed, { limit: 50 }))
    expect(neighbors.outgoing.length + neighbors.incoming.length).toBeLessThanOrEqual(100)
    const detail = time('detail of a node', () => graph.detail(ids[900] as string, allowed))
    expect(detail.ancestors.length).toBeGreaterThanOrEqual(2)
    const result = time('retrieve for a task', () => retrieve(stores, { spaces: allowed, text: 'fix the telemetry parser buffer and the replay cache', files: ['src/m3/f7.ts', 'src/m9/f11.ts'], risk: 'medium' }))
    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.nodes.length).toBeLessThanOrEqual(60)
    // Nothing that is history is returned as current, and nothing stale that is an analysis fact.
    for (const r of result.nodes) {
      expect(['CURRENT', 'STALE', 'CONFLICTED']).toContain(r.node.status)
      if (r.node.status === 'STALE') expect(r.warning).toContain('POSSIBLY OUTDATED')
    }
    const broad = time('retrieve, high risk (broad)', () => retrieve(stores, { spaces: allowed, text: 'security review of session token storage', files: [], risk: 'high' }))
    expect(broad.breadth).toBe('broad')
    const files = time('nodes for 200 changed files', () => stores.sources.nodesForFiles(project.id, Array.from({ length: 200 }, (_, i) => `src/m${i % 40}/f${i % 50}.ts`)))
    expect(files.length).toBeGreaterThan(0)
    time('health', () => graph.health(space))
    const section = time('render a pack section', () => renderGraphSection(stores, space, result))
    expect(section.text.length).toBeLessThan(40_000)

    console.log(`graph of ${counts.nodes} nodes and ${counts.edges} edges built in ${built} ms; query times (ms): ${JSON.stringify(timings)}`)
    if (process.env['NEXUS_WRITE_BENCHMARK'] === '1') {
      const dir = resolve(import.meta.dirname, '../../docs/acceptance')
      mkdirSync(dir, { recursive: true })
      const at = new Date().toISOString()
      writeFileSync(join(dir, `context-graph-scale-${at.replace(/[:.]/g, '-')}.json`), `${JSON.stringify({ kind: 'context-graph-scale', at, nodes: counts.nodes, edges: counts.edges, buildMs: built, queryMs: timings }, null, 2)}
`)
    }
    // Bounds a hang or a table scan gone quadratic, not a performance promise: every query answers well inside a second.
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(2_000)
    db.close()
  }, 600_000)
})

describe(`context graph histories (${RUNS} runs of ${STEPS} steps)`, () => {
  it('keeps its invariants under random changes to the stores, the files and the graph', async () => {
    for (let run = 0; run < RUNS; run++) {
      const rand = mulberry32(1000 + run)
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
      const h = graphHarness()
      // A second project in the same database: nothing of it may ever be reached from the first.
      const other = h.repos.projects.insert(makeProject({ name: 'Other', rootPath: 'C:\\repos\\other' }))
      const otherGraph = new ContextGraphService({ repos: h.repos, fileState: new FakeFiles().reader })
      h.repos.facts.upsert({ id: newId(), projectId: other.id, kind: 'hazard', subject: 'packet ordering', statement: 'OTHER PROJECT SECRET', source: 'user', confidence: 'high', files: [], fingerprint: 'x', stale: false, createdAt: h.now(), verifiedAt: h.now() })
      await otherGraph.syncProject(other.id)
      seedRaceDeck(h)
      await h.graph.syncProject(h.project.id)
      const allowed = [h.space]
      let maxNodes = 0
      const superseded = new Set<string>()
      let noteCount = 0

      for (let step = 0; step < STEPS; step++) {
        const facts = h.repos.facts.listByProject(h.project.id, { includeStale: true })
        const op = Math.floor(rand() * 11)
        try {
          if (op === 0) h.fact('hazard', `hazard ${run}-${step}`, `Hazard number ${step} about the ${pick(['parser', 'strategy', 'history'])}.`, { files: [pick(['src/telemetry/parser.ts', 'src/strategy/plan.ts', 'src/history/store.ts'])] })
          else if (op === 1) h.memory(pick(['Persistence', 'Units', `Topic ${step}`]), `Statement ${Math.floor(rand() * 3)} of step ${step % 4}.`, { filePaths: rand() < 0.5 ? ['src/telemetry/parser.ts'] : [] })
          else if (op === 2 && facts.length > 4) h.repos.facts.delete(pick(facts).id)
          else if (op === 3 && facts.length > 0) {
            const f = pick(facts)
            h.repos.facts.upsert({ ...f, statement: `${f.statement.slice(0, 60)} (rev ${step})`, fingerprint: `fp-${run}-${step}`, stale: false })
          } else if (op === 4) h.files.touch(pick(['src/telemetry/parser.ts', 'src/strategy/plan.ts', 'src/main.ts', 'package.json']))
          else if (op === 5) await h.graph.refresh(h.space, h.project.rootPath, rand() < 0.5 ? { changedFiles: ['src/telemetry/parser.ts', 'src/strategy/plan.ts'] } : {})
          else if (op === 6) {
            h.graph.writeNote({ space: h.space, folder: pick(['a', 'b']), title: `Note ${noteCount % 5}`, body: `Observation ${noteCount % 3} of run ${run}.`, kind: rand() < 0.4 ? 'progress' : 'note', author: { source: 'worker', runId: 'run-1', taskId: pick(['open', 'done']) } })
            noteCount++
          } else if (op === 7) h.graph.collectGarbage(h.space, (taskId) => taskId === 'open')
          else if (op === 8) {
            const current = h.repos.contextGraph.nodes.listBySpace(h.space, { types: ['MEMORY', 'HAZARD', 'DECISION'], statuses: ['CURRENT', 'CONFLICTED'] })
            if (current.length >= 2) {
              const older = pick(current)
              const newer = pick(current.filter((n) => n.id !== older.id))
              // Supersession in both directions between two nodes would be a cycle; one direction only.
              if (!superseded.has(newer.id)) {
                h.graph.supersede(older.id, newer.id, 'replaced')
                superseded.add(older.id)
              }
            }
          } else if (op === 9 && facts.length > 0) h.repos.facts.markStale([pick(facts).id])
          else if (op === 10) {
            const stale = h.repos.contextGraph.nodes.listByStatus(h.space, 'STALE', 5)
            if (stale[0]) await h.graph.reverify(stale[0].id, h.project.rootPath, 'the user')
          }
        } catch (e) {
          throw new Error(`run ${run} step ${step} op ${op}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
        }
        if (rand() < 0.6) await h.graph.syncProject(h.project.id)

        const label = `run ${run} step ${step} op ${op}`
        const rows = h.db.prepare("SELECT * FROM context_nodes WHERE space_id = ?").all(h.project.id) as Record<string, unknown>[]
        const byId = new Map(rows.map((r) => [r['id'] as string, r]))
        // Nothing is ever deleted: history only grows.
        expect(rows.length, label).toBeGreaterThanOrEqual(maxNodes)
        maxNodes = rows.length
        // The tree is a tree: unique paths, the parent is the node at the parent path, the depth is the path's.
        expect(new Set(rows.map((r) => r['path'])).size, label).toBe(rows.length)
        for (const r of rows) {
          const path = r['path'] as string
          expect(r['depth'], label).toBe(depthOf(path))
          const up = parentPath(path)
          if (up === null) expect(r['parent_id'], label).toBeNull()
          else expect(byId.get(r['parent_id'] as string)?.['path'], `${label} parent of ${path}`).toBe(up)
        }
        // Every edge joins two existing nodes.
        const dangling = h.db.prepare('SELECT COUNT(*) AS n FROM context_edges e WHERE NOT EXISTS (SELECT 1 FROM context_nodes n WHERE n.id = e.from_id) OR NOT EXISTS (SELECT 1 FROM context_nodes n WHERE n.id = e.to_id)').get() as { n: number }
        expect(dangling.n, label).toBe(0)
        // A superseded node is never current again, whatever its record says.
        for (const id of superseded) expect(['SUPERSEDED', 'ARCHIVED'], label).toContain(byId.get(id)?.['status'])

        // Retrieval: only this project's nodes, nothing historical, nothing stale without a warning.
        const result = retrieve(h.repos.contextGraph, { spaces: allowed, text: 'telemetry parser packet ordering persistence hazard', files: ['src/telemetry/parser.ts'] })
        for (const r of result.nodes) {
          expect(r.node.spaceId, label).toBe(h.project.id)
          expect(['CURRENT', 'STALE', 'CONFLICTED'], label).toContain(r.node.status)
          if (r.node.status !== 'CURRENT') expect(r.warning, label).not.toBeNull()
          expect(r.node.summary, label).not.toContain('OTHER PROJECT SECRET')
        }
        // The same graph renders to the same bytes.
        expect(renderGraphSection(h.repos.contextGraph, h.space, result).text, label).toBe(renderGraphSection(h.repos.contextGraph, h.space, result).text)
        // The other project's nodes cannot be reached by id, path, search or a relation.
        const foreign = h.repos.contextGraph.nodes.byPath({ kind: 'project', id: other.id }, 'hazards/packet-ordering') as ContextNode
        expect(() => h.graph.getNode(foreign.id, allowed), label).toThrow(/not found/)
        for (const n of h.graph.search(allowed, 'OTHER PROJECT SECRET')) {
          expect(n.spaceId, label).toBe(h.project.id)
          expect(n.summary, label).not.toContain('OTHER PROJECT SECRET')
        }
      }

      // After a full check and a sync, no node is current while a file it rests on differs from what was verified.
      await h.graph.refresh(h.space, h.project.rootPath)
      await h.graph.syncProject(h.project.id)
      const current = h.db.prepare("SELECT s.node_id, s.ref, s.hash FROM context_node_sources s JOIN context_nodes n ON n.id = s.node_id WHERE n.space_id = ? AND n.status = 'CURRENT' AND s.kind = 'file' AND s.hash IS NOT NULL").all(h.project.id) as { node_id: string; ref: string; hash: string }[]
      for (const s of current) expect(h.files.states.get(s.ref) ?? 'missing', `run ${run}: ${s.ref}`).toBe(s.hash)
      // Token estimates are what the text gives.
      for (const n of h.repos.contextGraph.nodes.listBySpace(h.space, { limit: 500 })) if (n.body === null) expect(n.tokenEstimate, `run ${run}: ${n.path}`).toBe(estimateTokens(`${n.title}\n${n.summary}`))
      h.close()
    }
  }, 3_600_000)
})

describe(`token accounting histories (${RUNS * 25} sessions)`, () => {
  it('records every request once, in order, and its totals equal what the runtime reported', () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(makeRun(project.id))
    let clock = Date.parse('2026-10-07T00:00:00.000Z')
    const engine = new TokenIntelligenceEngine({ repos, now: () => new Date((clock += 1000)).toISOString() })
    const rand = mulberry32(7)
    const roles = ['worker', 'reviewer', 'verifier', 'planner']
    const expected = { input: 0, read: 0, write: 0, requests: 0 }
    const hashes = new Map<string, string>()
    for (let s = 0; s < RUNS * 25; s++) {
      const agentId = `agent-${s}`
      const role = roles[s % roles.length] as string
      engine.planSession({ runId: run.id, taskId: null, agentId, role, model: 'opus', effort: null, cwd: `C:/wt/${s}`, systemText: `Role: ${role}.`, tools: role === 'worker' ? ['Read', 'Edit', 'Bash'] : ['Read'], nexusToolNames: ['send_message'], externalServers: [], loadProjectSettings: false, structuredOutput: false, settings: undefined })
      engine.sessionStarted(agentId, { provider: s % 17 === 0 ? 'codex' : 'claude', model: 'claude-opus-5-5' })
      const requests = 1 + Math.floor(rand() * 6)
      for (let r = 0; r < requests; r++) {
        const usage = { requestId: `req-${s}-${r}`, model: 'claude-opus-5-5', inputTokens: Math.floor(rand() * 500), cacheReadTokens: Math.floor(rand() * 20_000), cacheCreationTokens: Math.floor(rand() * 9_000), outputTokens: Math.floor(rand() * 900) }
        const event = engine.requestUsage(agentId, `sdk-${s}`, usage)
        expect(event?.requestIndex).toBe(r)
        // The same response delivered again (several assistant messages share one id) is not counted again.
        expect(engine.requestUsage(agentId, `sdk-${s}`, usage)).toBeNull()
        expected.input += usage.inputTokens
        expected.read += usage.cacheReadTokens
        expected.write += usage.cacheCreationTokens
        expected.requests++
        if (r === 0) {
          const key = `${event?.provider}:${role}`
          // One role on one provider has one prefix hash, whatever the worktree, the session and the time.
          if (hashes.has(key)) expect(event?.prefixHash).toBe(hashes.get(key))
          else hashes.set(key, event?.prefixHash as string)
        }
      }
      expect(engine.turnEnded(agentId, `sdk-${s}`, { turns: requests, rotationTurns: 60, hitTurnLimit: false, canHandoff: true, settings: undefined }).action).toBe('KEEP')
      engine.sessionClosed(agentId)
    }
    const totals = repos.cacheEvents.totals('2000-01-01T00:00:00.000Z')
    expect(totals).toMatchObject({ requests: expected.requests, inputTokens: expected.input, cacheReadTokens: expected.read, cacheWriteTokens: expected.write, sessions: RUNS * 25 })
    const byRole = repos.cacheEvents.totalsBy('role', '2000-01-01T00:00:00.000Z')
    expect(byRole.reduce((n, r) => n + r.requests, 0)).toBe(expected.requests)
    expect(byRole.reduce((n, r) => n + r.cacheReadTokens, 0)).toBe(expected.read)
    // A session on a provider without the Claude options carries none of them in its prefix.
    const codex = repos.promptPrefixes.list(100).filter((p) => p.provider === 'codex')
    expect(codex.length).toBeGreaterThan(0)
    for (const p of codex) expect(p.components.find((c) => c.startsWith('flags='))).toContain('"stablePrefix":false')
    db.close()
  }, 600_000)
})
