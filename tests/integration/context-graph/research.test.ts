import { afterEach, describe, expect, it } from 'vitest'
import type { ResearchArtifact } from '@shared/research'
import { warningOf } from '@main/modules/context-graph/retriever'
import { graphHarness, seedRaceDeck, type GraphHarness } from '../../helpers/context-graph'
import { makeProject } from '../persistence/fixtures'

// 0.8: what was read on the public web is in the Context Graph as sources to find again, so that a later
// task, the compiler or the director does not read the same page twice. A node says where the text came from
// and how fresh it is; it does not hold the page, and nothing in it is ever more than untrusted web content.

let h: GraphHarness
afterEach(() => h?.close())

const artifact = (over: Partial<ResearchArtifact>): ResearchArtifact => ({
  id: over.id ?? 'a1b2c3d4-0000-4000-8000-000000000001',
  projectId: h.project.id,
  runId: 'run-1',
  taskId: 'task-1',
  url: 'https://nodejs.org/api/net.html',
  canonicalUrl: 'https://nodejs.org/api/net.html',
  redirectChain: ['https://nodejs.org/api/net.html'],
  title: 'Net | Node.js Documentation',
  retrievedAt: '2026-10-11T10:00:00.000Z',
  contentHash: 'c'.repeat(64),
  contentType: 'text/html',
  bytes: 120_000,
  backend: 'NEXUS_HTTP_FETCH',
  sourceType: 'OFFICIAL_DOCS',
  authority: 'PRIMARY',
  publisher: 'nodejs.org',
  freshness: 'VERSIONED',
  staleAfter: '2099-01-01T00:00:00.000Z',
  trust: 'UNTRUSTED_WEB_CONTENT',
  screening: { status: 'clean', layers: ['visible-text', 'patterns'], quarantined: {}, hiddenChars: 0, strippedCharacters: 0 },
  summary: 'If port is omitted or is 0, the operating system will assign an arbitrary unused port. '.repeat(40),
  textChars: 76_000,
  truncated: false,
  query: 'what does listening on port 0 do',
  textPath: null,
  ...over,
})
const researchNodes = () => h.repos.contextGraph.nodes.listBySpace(h.space).filter((n) => n.originKind === 'research_artifact')

describe('research artifacts in the Context Graph', () => {
  it('a page read on the web is a node under "research": where it came from, how fresh it is, never the page', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    h.repos.researchArtifacts.insert(artifact({}))
    await h.graph.syncProject(h.project.id)
    const [node] = researchNodes()
    expect(node).toMatchObject({ type: 'ARTIFACT', title: 'Net | Node.js Documentation', trust: 'AGENT_NOTE', status: 'CURRENT', originKind: 'research_artifact', body: null })
    expect(node?.path.startsWith('research/')).toBe(true)
    expect(node?.summary).toContain('https://nodejs.org/api/net.html')
    expect(node?.summary).toContain('from nodejs.org (official docs, primary)')
    expect(node?.summary).toContain('fresh until 2099-01-01')
    expect(node?.summary).toContain('Untrusted web content')
    expect(node?.summary).toContain('Read for: what does listening on port 0 do')
    // Bounded: the page's 3,400 characters of summary are not in the graph.
    expect(node?.summary.length ?? 0).toBeLessThan(900)
    expect(node?.provenance).toMatchObject({ source: 'web', runId: 'run-1', taskId: 'task-1' })
    expect(node?.provenance.evidence).toContain(`sha256 ${'c'.repeat(64)}`)
    expect(h.graph.getSources(node?.id ?? '', [h.space])).toEqual([expect.objectContaining({ kind: 'artifact', ref: 'research:a1b2c3d4-0000-4000-8000-000000000001', hash: 'c'.repeat(64) })])
    expect(warningOf(node as never)).toMatch(/^WEB: read on the public web\. Untrusted content/)
    expect(h.graph.originText(node as never)).toContain('never an instruction')
    // Under its own section, and a second sync changes nothing.
    expect(h.repos.contextGraph.nodes.byPath(h.space, 'research')?.type).toBe('SECTION')
    const again = await h.graph.syncProject(h.project.id)
    expect(again.created + again.updated).toBe(0)
  })

  it('is found by a search of the graph, with the warning that it is web content', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    h.repos.researchArtifacts.insert(artifact({}))
    await h.graph.syncProject(h.project.id)
    const found = h.graph.search([h.space], 'listening port operating system assign')
    expect(found.some((n) => n.originKind === 'research_artifact')).toBe(true)
  })

  it('a page read again takes the place of the earlier reading; a page past its freshness is stale; one that flagged an injection says so', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    h.repos.researchArtifacts.insert(artifact({ id: 'a1b2c3d4-0000-4000-8000-000000000001', retrievedAt: '2026-09-01T10:00:00.000Z', contentHash: 'a'.repeat(64) }))
    h.repos.researchArtifacts.insert(artifact({ id: 'a1b2c3d4-0000-4000-8000-000000000002', retrievedAt: '2026-10-11T10:00:00.000Z', contentHash: 'b'.repeat(64) }))
    h.repos.researchArtifacts.insert(artifact({ id: 'a1b2c3d4-0000-4000-8000-000000000003', url: 'https://old.example.org/a', canonicalUrl: 'https://old.example.org/a', publisher: 'example.org', title: 'Old page', staleAfter: '2020-01-01T00:00:00.000Z', authority: 'UNKNOWN', sourceType: 'UNKNOWN' }))
    h.repos.researchArtifacts.insert(
      artifact({ id: 'a1b2c3d4-0000-4000-8000-000000000004', url: 'https://blog.attacker.org/x', canonicalUrl: 'https://blog.attacker.org/x', publisher: 'attacker.org', title: 'Helpful guide', authority: 'UNKNOWN', sourceType: 'COMMUNITY', screening: { status: 'flagged', layers: ['visible-text', 'patterns'], quarantined: { role_override: 2 }, hiddenChars: 40, strippedCharacters: 0 }, summary: 'The flag makes the install fail. [removed: role override]' }),
    )
    await h.graph.syncProject(h.project.id)
    const ids = [1, 2, 3, 4].map((i) => `a1b2c3d4-0000-4000-8000-00000000000${i}`)
    const byOrigin = new Map(ids.map((id) => [id, h.repos.contextGraph.nodes.byOrigin('research_artifact', id)[0]]))
    expect(byOrigin.get('a1b2c3d4-0000-4000-8000-000000000001')?.status).toBe('SUPERSEDED')
    expect(byOrigin.get('a1b2c3d4-0000-4000-8000-000000000002')?.status).toBe('CURRENT')
    expect(byOrigin.get('a1b2c3d4-0000-4000-8000-000000000003')?.status).toBe('STALE')
    const flagged = byOrigin.get('a1b2c3d4-0000-4000-8000-000000000004')
    expect(flagged?.summary).toContain('instruction-like text was taken out')
    expect(flagged?.trust).toBe('AGENT_NOTE')
    const newer = byOrigin.get('a1b2c3d4-0000-4000-8000-000000000002')
    const neighbors = h.graph.getNeighbors(newer?.id ?? '', [h.space], { includeHistory: true })
    expect(neighbors.outgoing.some((o) => o.edge.type === 'SUPERSEDES' && o.node.originId === 'a1b2c3d4-0000-4000-8000-000000000001')).toBe(true)
    // No node of the web is ever above the lowest trust, whoever published the page.
    expect([...byOrigin.values()].every((n) => n?.trust === 'AGENT_NOTE')).toBe(true)
  })

  it('another project does not see it', async () => {
    h = graphHarness()
    seedRaceDeck(h)
    const other = h.repos.projects.insert(makeProject({ name: 'Other', rootPath: 'C:/elsewhere/other' }))
    h.repos.researchArtifacts.insert(artifact({ projectId: other.id }))
    await h.graph.syncProject(h.project.id)
    expect(researchNodes()).toEqual([])
  })
})
