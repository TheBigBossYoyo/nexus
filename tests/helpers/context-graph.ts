import type { MemoryEntry, Project } from '@shared/domain'
import type { ContextSpace } from '@shared/context-graph'
import { newId } from '@shared/ids'
import type { FactKind, RepositoryFact } from '@shared/v2'
import { ContextGraphService, type FileStateReader } from '@main/modules/context-graph'
import { createRepositories, openDatabase, type Database, type Repositories } from '@main/modules/persistence'
import { makeProject } from '../integration/persistence/fixtures'

/** A file system that exists only as a map: path to state. A missing path reads as `missing`. */
export class FakeFiles {
  readonly states = new Map<string, string>()
  private tick = 1

  /** Create or change a file: its state becomes a new value. */
  touch(...paths: string[]): void {
    for (const p of paths) this.states.set(p, `${100 + this.tick}:${this.tick++}`)
  }

  remove(path: string): void {
    this.states.delete(path)
  }

  readonly reader: FileStateReader = async (_root, rel) => this.states.get(rel) ?? 'missing'
}

export interface GraphHarness {
  db: Database
  repos: Repositories
  graph: ContextGraphService
  files: FakeFiles
  project: Project
  space: ContextSpace
  /** A clock that advances one second per call, so every record gets a distinct, ordered time. */
  now: () => string
  fact(kind: FactKind, subject: string, statement: string, over?: Partial<RepositoryFact>): RepositoryFact
  memory(title: string, content: string, over?: Partial<MemoryEntry>): MemoryEntry
  close(): void
}

export function graphHarness(over: Partial<Project> = {}): GraphHarness {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const files = new FakeFiles()
  let t = Date.parse('2026-10-07T08:00:00.000Z')
  const now = (): string => new Date((t += 1000)).toISOString()
  const project = repos.projects.insert(makeProject({ name: 'RaceDeck', rootPath: 'C:\\repos\\racedeck', ...over }))
  const graph = new ContextGraphService({ repos, db, now, fileState: files.reader })
  return {
    db,
    repos,
    graph,
    files,
    project,
    space: { kind: 'project', id: project.id },
    now,
    fact(kind, subject, statement, o = {}) {
      const fileList = o.files ?? []
      for (const f of fileList) if (!files.states.has(f)) files.touch(f)
      const at = now()
      return repos.facts.upsert({
        id: newId(),
        projectId: project.id,
        kind,
        subject,
        statement,
        source: 'static_analysis',
        confidence: 'medium',
        files: fileList,
        fingerprint: `fp-${newId().slice(0, 8)}`,
        stale: false,
        createdAt: at,
        verifiedAt: at,
        ...o,
      })
    },
    memory(title, content, o = {}) {
      for (const f of o.filePaths ?? []) if (!files.states.has(f)) files.touch(f)
      return repos.memory.insert({
        id: newId(),
        scope: 'project',
        projectId: project.id,
        runId: null,
        taskId: null,
        agentId: null,
        kind: 'fact',
        title,
        content,
        tags: [],
        filePaths: [],
        source: 'worker',
        evidence: 'src/telemetry/parser.ts:12',
        status: 'approved',
        createdAt: now(),
        ...o,
      })
    },
    close() {
      if (db.open) db.close()
    },
  }
}

/** A small, realistic repository: a telemetry module with a parser, its tests, a strategy module and commands. */
export function seedRaceDeck(h: GraphHarness): void {
  h.fact('language', 'TypeScript', 'TypeScript: 240 files in the analyzed tree', { source: 'manifest', confidence: 'high', files: ['package.json'] })
  h.fact('framework', 'Electron', 'Electron is a dependency', { source: 'manifest', confidence: 'high', files: ['package.json'] })
  h.fact('command', 'test', 'test: pnpm test', { source: 'manifest', confidence: 'high', files: ['package.json'] })
  h.fact('command', 'build', 'build: pnpm build', { source: 'manifest', confidence: 'high', files: ['package.json'] })
  h.fact('module', 'src/telemetry', 'src/telemetry has 14 source files. Consumes telemetry packets and normalizes race state.', { files: ['src/telemetry/index.ts'] })
  h.fact('module', 'src/strategy', 'src/strategy has 9 source files. Computes pit strategy from race state.', { files: ['src/strategy/index.ts'] })
  h.fact('module', 'src/history', 'src/history has 6 source files. Persists finished sessions.', { files: ['src/history/index.ts'] })
  h.fact('import_relation', 'src/strategy -> src/telemetry', 'src/strategy imports from src/telemetry: 7 imports across 4 files', { files: ['src/strategy/plan.ts', 'src/telemetry/index.ts'] })
  h.fact('interface', 'src/telemetry/parser.ts', 'src/telemetry/parser.ts is imported by 6 files; changes here ripple widely', { files: ['src/telemetry/parser.ts'] })
  h.fact('test_mapping', 'src/telemetry/parser.test.ts', 'src/telemetry/parser.test.ts appears to test src/telemetry/parser.ts (matched by naming convention)', { confidence: 'low', files: ['src/telemetry/parser.test.ts', 'src/telemetry/parser.ts'] })
  h.fact('hazard', 'packet ordering', 'Telemetry packets can arrive out of order; the parser must not assume monotonic sequence numbers.', { source: 'verifier', confidence: 'high', files: ['src/telemetry/parser.ts'] })
  h.fact('decision', 'packet versions', 'The parser accepts v2 and v3 packets; v1 is rejected.', { source: 'user', confidence: 'high', files: ['src/telemetry/parser.ts', 'docs/adr/021-packets.md'] })
  h.fact('entry_point', 'src/main.ts', 'src/main.ts is the application entry point', { source: 'manifest', confidence: 'high', files: ['src/main.ts'] })
}
