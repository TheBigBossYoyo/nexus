import type { ContextNode, ContextSpace, RetrievalQuery, RetrievalSignal } from '@shared/context-graph'
import { newId } from '@shared/ids'
import type { ProgramMemoryEntry } from '@shared/program'
import { composeContext } from '@main/modules/context/context-engine'
import { retrieve } from '@main/modules/context-graph'
import { selectMemory } from '@main/modules/program/memory'
import { scoreRetrieval, type RetrievalScore } from '@main/modules/token'
import { makeRun, makeTask } from '../integration/persistence/fixtures'
import { graphHarness, type GraphHarness } from './context-graph'

/**
 * The retrieval benchmark: a project with realistic knowledge in every store, tasks of the kinds NEXUS runs,
 * and for each task the records it cannot be done well without ("required") and the records it would be
 * wrong to present as current ("forbidden").
 *
 * Variants compared on the same tasks:
 *  - V2: what the 0.7.0 pack selects (facts and project memory), plus what the Program and Workspace engines
 *    put into their prompts by their own selection;
 *  - GRAPH: retrieval over the Context Graph alone;
 *  - V3: V2's selection plus the graph's (what a 0.7.1 pack holds);
 *  - FULL: every current node (the "send the whole project" baseline);
 *  - ablations of the graph's signals.
 *
 * Everything is deterministic and costs no model usage. It measures whether the right knowledge reaches the
 * prompt, which is necessary for engineering quality and not the same thing as it.
 */

export interface BenchCase {
  key: string
  category: string
  title: string
  description: string
  files: string[]
  risk: 'low' | 'medium' | 'high'
  /** Run inside the program (its memory is in scope). */
  program?: boolean
  /** Record references: `fact:<kind>:<subject>`, `memory:<title>`, `pm:<title>`, `wm:<title>`, `contract:<key>`. */
  required: string[]
  forbidden: string[]
}

export interface BenchWorld {
  h: GraphHarness
  programId: string
  workspaceId: string
  spaces: ContextSpace[]
  /** Record reference to the path of the node that projects it. */
  pathOf: Map<string, string>
  cases: BenchCase[]
}

const MODULES: { key: string; about: string; file: string }[] = [
  { key: 'src/telemetry', about: 'Consumes telemetry packets and normalizes race state.', file: 'src/telemetry/parser.ts' },
  { key: 'src/strategy', about: 'Computes pit strategy from race state.', file: 'src/strategy/plan.ts' },
  { key: 'src/history', about: 'Persists finished sessions to SQLite.', file: 'src/history/store.ts' },
  { key: 'src/renderer', about: 'React user interface: timing tower, strategy panel and settings.', file: 'src/renderer/TimingTower.tsx' },
  { key: 'src/persistence', about: 'Database schema, migrations and repositories.', file: 'src/persistence/migrate.ts' },
  { key: 'src/auth', about: 'Account login, token storage and session refresh.', file: 'src/auth/session.ts' },
  { key: 'src/export', about: 'Exports sessions to CSV and JSON files.', file: 'src/export/csv.ts' },
  { key: 'src/settings', about: 'User preferences and their validation.', file: 'src/settings/schema.ts' },
  { key: 'src/updater', about: 'Downloads and applies application updates.', file: 'src/updater/download.ts' },
  { key: 'src/ipc', about: 'Typed channels between the main process and the renderer.', file: 'src/ipc/channels.ts' },
  { key: 'src/replay', about: 'Replays a recorded session through the telemetry pipeline.', file: 'src/replay/player.ts' },
  { key: 'src/weather', about: 'Fetches and caches track weather forecasts.', file: 'src/weather/client.ts' },
]

export async function buildWorld(options: { noiseMemory?: number } = {}): Promise<BenchWorld> {
  const h = graphHarness()
  const pathOf = new Map<string, string>()

  h.fact('language', 'TypeScript', 'TypeScript: 480 files in the analyzed tree', { source: 'manifest', confidence: 'high', files: ['package.json'] })
  h.fact('framework', 'Electron', 'Electron is a dependency', { source: 'manifest', confidence: 'high', files: ['package.json'] })
  h.fact('framework', 'React', 'React is a dependency', { source: 'manifest', confidence: 'high', files: ['package.json'] })
  for (const c of ['build', 'test', 'lint', 'typecheck']) h.fact('command', c, `${c}: pnpm ${c}`, { source: 'manifest', confidence: 'high', files: ['package.json'] })
  for (const m of MODULES) {
    const name = m.key.split('/')[1] as string
    h.fact('module', m.key, `${m.key} has ${8 + name.length} source files. ${m.about}`, { files: [`${m.key}/index.ts`] })
    h.fact('interface', m.file, `${m.file} is imported by ${3 + name.length} files; changes here ripple widely`, { files: [m.file] })
    const test = m.file.replace(/\.(tsx?)$/, '.test.$1')
    h.fact('test_mapping', test, `${test} appears to test ${m.file} (matched by naming convention)`, { confidence: 'low', files: [test, m.file] })
    h.fact('hot_file', m.file, `${m.file} changed in ${2 + name.length} commits within the last 200 commits`, { source: 'git', confidence: 'high', files: [m.file] })
  }
  for (const [from, to] of [['src/strategy', 'src/telemetry'], ['src/replay', 'src/telemetry'], ['src/history', 'src/persistence'], ['src/export', 'src/history'], ['src/renderer', 'src/ipc'], ['src/auth', 'src/persistence'], ['src/weather', 'src/settings']] as const) {
    h.fact('import_relation', `${from} -> ${to}`, `${from} imports from ${to}: 5 imports across 3 files`, { files: [`${from}/index.ts`, `${to}/index.ts`] })
  }
  // Two files with the same name in different modules: the adversarial "same symbol" case.
  h.fact('interface', 'src/replay/parser.ts', 'src/replay/parser.ts is imported by 2 files; changes here ripple widely', { files: ['src/replay/parser.ts'] })
  h.fact('hazard', 'replay parser drift', 'src/replay/parser.ts is a copy of an old telemetry parser and does not understand v3 packets.', { source: 'verifier', confidence: 'high', files: ['src/replay/parser.ts'] })

  h.fact('hazard', 'packet ordering', 'Telemetry packets can arrive out of order; the parser must not assume monotonic sequence numbers.', { source: 'verifier', confidence: 'high', files: ['src/telemetry/parser.ts'] })
  h.fact('hazard', 'migration locking', 'Migrations run while the renderer may hold a read transaction; a migration that rewrites a table must take an exclusive lock first.', { source: 'verifier', confidence: 'high', files: ['src/persistence/migrate.ts'] })
  h.fact('hazard', 'token storage', 'Refresh tokens are stored with the operating system keychain; writing them to the settings file is a security defect.', { source: 'user', confidence: 'high', files: ['src/auth/session.ts'] })
  h.fact('hazard', 'update signature', 'Update packages must be verified against the pinned public key before they are applied.', { source: 'user', confidence: 'high', files: ['src/updater/download.ts'] })
  h.fact('decision', 'packet versions', 'The parser accepts v2 and v3 packets; v1 is rejected.', { source: 'user', confidence: 'high', files: ['src/telemetry/parser.ts'] })
  h.fact('decision', 'ipc validation', 'Every IPC payload is validated with a schema in the main process before use.', { source: 'user', confidence: 'high', files: ['src/ipc/channels.ts'] })
  h.fact('decision', 'csv dialect', 'CSV exports use RFC 4180 quoting and a UTF-8 byte order mark so that spreadsheets open them correctly.', { source: 'user', confidence: 'high', files: ['src/export/csv.ts'] })

  // Project memory: approved knowledge, some of it about files, some only findable by its words.
  h.memory('Timing tower virtualization', 'The timing tower renders only visible rows; row height is fixed at 28 pixels and must not depend on content.', { filePaths: ['src/renderer/TimingTower.tsx'] })
  h.memory('Strategy uses fuel-corrected laps', 'Pit strategy compares fuel-corrected lap times; raw lap times make undercuts look better than they are.', { filePaths: ['src/strategy/plan.ts'] })
  h.memory('History schema is append-only', 'Session rows are never updated in place; a correction is a new row that supersedes the old one.', { filePaths: ['src/history/store.ts'] })
  h.memory('Weather cache lifetime', 'Forecasts are cached for ten minutes; the provider bans clients that poll more often.', { filePaths: ['src/weather/client.ts'] })
  h.memory('Previous attempt: streaming CSV export', 'Streaming the CSV export row by row was tried and abandoned: the progress bar needs the row count first, which the stream does not have.', { filePaths: ['src/export/csv.ts'], source: 'debugger' })
  h.memory('User constraint: no telemetry upload', 'The user requires that telemetry never leaves the machine; any feature that uploads it needs an explicit opt-in.', { source: 'user' })
  h.memory('Settings migration rule', 'A renamed preference keeps reading its old key for two releases.', { filePaths: ['src/settings/schema.ts'] })
  // Superseded knowledge: an old persistence decision replaced by a newer one.
  const oldDb = h.memory('Persistence engine', 'Session history is stored in JSON files, one per session.', { source: 'architect' })
  const newDb = h.memory('Persistence engine (current)', 'Session history is stored in SQLite; the JSON files were migrated in 0.4 and are no longer read.', { source: 'architect', filePaths: ['src/history/store.ts'] })
  // Plausible, irrelevant memory.
  for (let i = 0; i < (options.noiseMemory ?? 24); i++) {
    const topic = ['logging', 'build cache', 'icon set', 'release notes', 'keyboard shortcuts', 'locale files', 'crash reports', 'window layout'][i % 8] as string
    h.memory(`Note on ${topic} ${i}`, `The ${topic} convention number ${i}: entries are sorted, lowercase and reviewed before a release. It does not affect runtime behaviour.`, { filePaths: [`docs/notes/${topic.replace(/ /g, '-')}-${i}.md`] })
  }

  // A program with its own memory.
  const now = h.now()
  const program = h.repos.programs.insert({
    id: newId(), projectId: h.project.id, name: 'Reliability', goal: { statement: 'Make live timing reliable under packet loss.', successCriteria: ['No corrupted race state in a 2 hour replay'], constraints: ['No change to the packet format'], risks: [] },
    state: 'ACTIVE', resumeState: null, pauseReason: null, blockedReason: null, policy: {} as never, schedule: null, planVersion: 1, branch: null, baseCommit: null, currentMilestoneId: null, currentRunId: null, currentRunKind: null,
    activeMs: 0, activeSince: null, quotaWaitSince: null, missions: 0, replans: 0, outcome: null, error: null, createdAt: now, startedAt: now, updatedAt: now, finishedAt: null,
  })
  const pm = (kind: ProgramMemoryEntry['kind'], title: string, content: string, status: ProgramMemoryEntry['status'] = 'active'): ProgramMemoryEntry =>
    h.repos.programMemory.insert({ id: newId(), programId: program.id, projectId: h.project.id, milestoneKey: null, kind, title, content, evidence: 'src/telemetry/parser.ts:40 and the replay of session 12', tags: [], source: { kind: 'milestone_verifier', runId: null }, status, createdAt: h.now() })
  pm('architecture_decision', 'Race state is rebuilt from an event log', 'Race state is derived by replaying an ordered event log; handlers never mutate state directly.')
  pm('rejected_approach', 'Reordering packets in the UI layer', 'Sorting packets in the renderer was rejected: it hid the corruption in the display and left the stored state wrong.')
  pm('hazard', 'Sequence numbers wrap', 'Packet sequence numbers wrap at 65535; ordering must use the session clock as a tie breaker.')
  pm('interface', 'Event log format', 'An event is {seq, clock, kind, payload}; kind is one of lap, sector, pit, flag.')
  pm('performance_baseline', 'Replay throughput', 'A two hour session replays in 38 seconds on the reference machine.')
  pm('architecture_decision', 'Buffer size', 'The reorder buffer holds 64 packets.', 'superseded')
  pm('architecture_decision', 'Reorder buffer size (current)', 'The reorder buffer holds 256 packets after the wrap-around fix.')
  for (let i = 0; i < 6; i++) pm('failure', `Flaky replay ${i}`, `Replay run ${i} failed once because the fixture file was locked by an editor; unrelated to the code.`)

  // A workspace: this repository, an API service and a shared schema package.
  const workspace = h.repos.workspaces.insert({ id: newId(), name: 'Racing', description: 'Desktop application, timing API and shared schemas.', policy: {} as never, createdAt: now, updatedAt: now })
  const enrol = (key: string, projectId: string, role: string) =>
    h.repos.enrolledRepositories.insert({ id: newId(), workspaceId: workspace.id, key, projectId, rootPath: `C:\\repos\\${key}`, role: role as never, remote: null, branch: 'main', languages: ['TypeScript'], frameworks: [], commands: { build: 'pnpm build', test: 'pnpm test', lint: null, typecheck: null }, packageName: key, packageVersion: '1.0.0', manifest: null, enrolledAt: h.now(), refreshedAt: h.now() } as never)
  const desktop = enrol('racedeck', h.project.id, 'application')
  const apiProject = h.repos.projects.insert({ ...h.project, id: newId(), name: 'timing-api', rootPath: 'C:\\repos\\timing-api' })
  const schemaProject = h.repos.projects.insert({ ...h.project, id: newId(), name: 'schemas', rootPath: 'C:\\repos\\schemas' })
  const api = enrol('timing-api', apiProject.id, 'service')
  const schemas = enrol('schemas', schemaProject.id, 'library')
  const contract = (key: string, name: string, provider: string, consumers: string[]) => {
    const c = h.repos.workspaceContracts.insert({ id: newId(), workspaceId: workspace.id, key, name, kind: 'json_schema' as never, providerRepositoryId: provider, path: `contracts/${key}.json`, createdAt: h.now() })
    for (const repositoryId of consumers) h.repos.contractConsumers.insert({ id: newId(), contractId: c.id, repositoryId, copyPath: null, provenance: { source: 'contract', file: null, detail: `imports ${key}` }, createdAt: h.now() })
  }
  contract('packet-v3', 'Telemetry packet v3', schemas.id, [desktop.id, api.id])
  contract('session-export', 'Session export format', desktop.id, [api.id])
  contract('billing-events', 'Billing events', api.id, [])
  const wm = (kind: string, title: string, content: string, repositories: string[]) =>
    h.repos.workspaceMemory.insert({ id: newId(), workspaceId: workspace.id, kind: kind as never, title, content, evidence: 'contract file and both consumers', repositories, source: { kind: 'verification', missionId: null }, createdAt: h.now() })
  wm('integration_hazard', 'Export format is consumed by the API', 'The timing API parses session exports; a column added in the desktop app must be optional or the API rejects the upload.', ['racedeck', 'timing-api'])
  wm('shared_decision', 'Schemas are versioned by suffix', 'A breaking schema change gets a new suffix (v3, v4); the old file stays until every consumer has moved.', ['schemas', 'racedeck', 'timing-api'])
  wm('release_convention', 'API deploys before the desktop release', 'The API is deployed a day before a desktop release so that new fields are accepted when clients send them.', ['timing-api', 'racedeck'])
  wm('architecture', 'Billing lives only in the API', 'Billing has no desktop component; the desktop app never sees billing events.', ['timing-api', 'schemas'])

  await h.graph.syncProject(h.project.id)
  await h.graph.syncWorkspace(workspace.id)

  // Supersession and staleness as they would arise in use.
  const nodeOf = (kind: string, id: string): ContextNode => h.repos.contextGraph.nodes.byOrigin(kind, id)[0] as ContextNode
  h.graph.supersede(nodeOf('memory', oldDb.id).id, nodeOf('memory', newDb.id).id, 'The JSON files were migrated to SQLite in 0.4.')
  h.files.touch('src/weather/client.ts')
  await h.graph.refresh({ kind: 'project', id: h.project.id }, h.project.rootPath, { changedFiles: ['src/weather/client.ts'] })

  // Record references.
  for (const f of h.repos.facts.listByProject(h.project.id, { includeStale: true })) {
    const n = nodeOf('repository_fact', f.id)
    if (n) pathOf.set(`fact:${f.kind}:${f.subject}`, `project:${n.path}`)
  }
  for (const m of h.repos.memory.list({ projectId: h.project.id, status: 'any', limit: 5000 })) pathOf.set(`memory:${m.title}`, `project:${nodeOf('memory', m.id).path}`)
  for (const m of h.repos.programMemory.listAll(program.id)) pathOf.set(`pm:${m.title}`, `project:${nodeOf('program_memory', m.id).path}`)
  for (const m of h.repos.workspaceMemory.listByWorkspace(workspace.id)) pathOf.set(`wm:${m.title}`, `workspace:${nodeOf('workspace_memory', m.id).path}`)
  for (const c of h.repos.workspaceContracts.listByWorkspace(workspace.id)) pathOf.set(`contract:${c.key}`, `workspace:${nodeOf('workspace_contract', c.id).path}`)

  return { h, programId: program.id, workspaceId: workspace.id, spaces: h.graph.spacesForProject(h.project.id), pathOf, cases: CASES }
}

export const CASES: BenchCase[] = [
  { key: 'localized-bug', category: 'localized bug', title: 'Fix the telemetry parser dropping the last sector', description: 'The parser in src/telemetry/parser.ts drops the final sector time of a lap when two packets arrive in the same tick.', files: ['src/telemetry/parser.ts'], risk: 'low', required: ['fact:module:src/telemetry', 'fact:hazard:packet ordering', 'fact:decision:packet versions', 'fact:test_mapping:src/telemetry/parser.test.ts'], forbidden: [] },
  { key: 'cross-module-bug', category: 'cross-module bug', title: 'Strategy panel shows stale gaps after a safety car', description: 'After a safety car the strategy plan keeps the old gaps. The plan is computed in src/strategy/plan.ts from race state produced by the telemetry module.', files: ['src/strategy/plan.ts'], risk: 'medium', required: ['fact:module:src/strategy', 'fact:module:src/telemetry', 'memory:Strategy uses fuel-corrected laps'], forbidden: [] },
  { key: 'architecture', category: 'architecture', title: 'Design how replay and live telemetry share one parser', description: 'Propose how the replay player and the live telemetry pipeline can use a single packet parser instead of two.', files: ['src/replay/player.ts', 'src/telemetry/parser.ts'], risk: 'high', required: ['fact:module:src/replay', 'fact:module:src/telemetry', 'fact:hazard:replay parser drift', 'fact:decision:packet versions', 'fact:hazard:packet ordering'], forbidden: [] },
  { key: 'security', category: 'security', title: 'Review how login tokens are stored', description: 'Review the storage of refresh tokens in the auth module for leaks to disk or logs.', files: ['src/auth/session.ts'], risk: 'high', required: ['fact:module:src/auth', 'fact:hazard:token storage'], forbidden: [] },
  { key: 'ui', category: 'UI', title: 'Timing tower rows jump when a driver name is long', description: 'Rows of the timing tower change height when a long driver name wraps, which breaks scrolling.', files: ['src/renderer/TimingTower.tsx'], risk: 'low', required: ['fact:module:src/renderer', 'memory:Timing tower virtualization'], forbidden: [] },
  { key: 'database', category: 'database', title: 'Add a migration that splits the sessions table', description: 'Write a migration in src/persistence/migrate.ts that moves lap data out of the sessions table into its own table.', files: ['src/persistence/migrate.ts'], risk: 'high', required: ['fact:module:src/persistence', 'fact:hazard:migration locking', 'memory:History schema is append-only'], forbidden: ['memory:Persistence engine'] },
  { key: 'large-refactor', category: 'large refactor', title: 'Move every IPC channel to validated handlers', description: 'Refactor the channels in src/ipc/channels.ts and their callers in the renderer so that every payload goes through one validated handler.', files: ['src/ipc/channels.ts', 'src/renderer/TimingTower.tsx'], risk: 'medium', required: ['fact:module:src/ipc', 'fact:module:src/renderer', 'fact:decision:ipc validation'], forbidden: [] },
  { key: 'program', category: 'Program', title: 'Make the reorder buffer survive sequence wrap-around', description: 'Milestone of the reliability program: the reorder buffer in the telemetry parser must order packets correctly when the sequence number wraps.', files: ['src/telemetry/parser.ts'], risk: 'medium', program: true, required: ['pm:Sequence numbers wrap', 'pm:Reorder buffer size (current)', 'pm:Race state is rebuilt from an event log', 'fact:hazard:packet ordering'], forbidden: ['pm:Buffer size'] },
  { key: 'workspace', category: 'Workspace', title: 'Add a tyre compound column to the session export', description: 'Add the tyre compound to the CSV and JSON session export in src/export/csv.ts.', files: ['src/export/csv.ts'], risk: 'medium', required: ['contract:session-export', 'wm:Export format is consumed by the API', 'fact:decision:csv dialect', 'memory:Previous attempt: streaming CSV export'], forbidden: [] },
  { key: 'recall-old-decision', category: 'memory recall', title: 'Reject telemetry packets the application cannot read', description: 'Decide which packet versions the telemetry parser should refuse and return a typed error for them.', files: [], risk: 'medium', required: ['fact:decision:packet versions'], forbidden: [] },
  { key: 'recall-program-decision', category: 'memory recall', title: 'Add a handler for red flag events', description: 'Add handling of red flag events to the race state of the reliability program.', files: [], risk: 'medium', program: true, required: ['pm:Race state is rebuilt from an event log', 'pm:Event log format'], forbidden: [] },
  { key: 'recall-superseded', category: 'memory recall', title: 'Speed up loading the session history list', description: 'The history list is slow to load; look at how session history is stored and read by the persistence engine.', files: ['src/history/store.ts'], risk: 'low', required: ['memory:Persistence engine (current)', 'memory:History schema is append-only'], forbidden: ['memory:Persistence engine'] },
  { key: 'recall-failed-approach', category: 'memory recall', title: 'Make the CSV export faster for long sessions', description: 'Exporting a long session to CSV blocks the window for seconds; make the export faster.', files: ['src/export/csv.ts'], risk: 'low', required: ['memory:Previous attempt: streaming CSV export', 'fact:decision:csv dialect'], forbidden: [] },
  { key: 'recall-user-constraint', category: 'memory recall', title: 'Add a cloud backup of telemetry sessions', description: 'Add an option that uploads recorded telemetry to cloud storage for backup.', files: [], risk: 'high', required: ['memory:User constraint: no telemetry upload'], forbidden: [] },
  { key: 'recall-hazard', category: 'memory recall', title: 'Apply updates in the background', description: 'Change the updater so that a downloaded update package is applied without asking the user.', files: ['src/updater/download.ts'], risk: 'high', required: ['fact:hazard:update signature'], forbidden: [] },
  { key: 'adversarial-same-name', category: 'adversarial', title: 'Fix the replay parser for v3 packets', description: 'Replaying a v3 session fails in src/replay/parser.ts.', files: ['src/replay/parser.ts'], risk: 'low', required: ['fact:hazard:replay parser drift', 'fact:module:src/replay'], forbidden: [] },
  { key: 'adversarial-stale', category: 'adversarial', title: 'Show the forecast age in the weather widget', description: 'Show how old the cached forecast is, using the weather client in src/weather/client.ts.', files: ['src/weather/client.ts'], risk: 'low', required: ['memory:Weather cache lifetime'], forbidden: ['fact:interface:src/weather/client.ts', 'fact:hot_file:src/weather/client.ts'] },
  { key: 'adversarial-other-program', category: 'adversarial', title: 'Tune the telemetry parser buffer', description: 'Outside any program: review the buffer sizes of the telemetry parser.', files: ['src/telemetry/parser.ts'], risk: 'low', required: ['fact:hazard:packet ordering'], forbidden: ['pm:Buffer size', 'pm:Reorder buffer size (current)', 'pm:Sequence numbers wrap'] },
]

/**
 * Held-out cases: written after the retriever was tuned on CASES and never used to change it. Their figures
 * are reported as they come out; they say how far the tuned figures generalize inside this fixture.
 */
export const HELDOUT: BenchCase[] = [
  { key: 'h-settings-rename', category: 'held-out', title: "Rename the 'units' preference to 'measurementSystem'", description: 'Rename the units preference in src/settings/schema.ts and keep existing installations working.', files: ['src/settings/schema.ts'], risk: 'low', required: ['memory:Settings migration rule', 'fact:module:src/settings'], forbidden: [] },
  { key: 'h-weather-polling', category: 'held-out', title: 'Refresh the forecast every minute during a session', description: 'During a running session the weather forecast should be fetched again every minute.', files: [], risk: 'medium', required: ['memory:Weather cache lifetime'], forbidden: [] },
  { key: 'h-upload-field', category: 'held-out', title: 'Include sector times in the session upload', description: 'The exported session that is uploaded to the timing API should also carry the sector times of every lap.', files: [], risk: 'medium', required: ['contract:session-export', 'wm:Export format is consumed by the API'], forbidden: [] },
  { key: 'h-schema-bump', category: 'held-out', title: 'Move the application to telemetry packet v4', description: 'Add support for version 4 telemetry packets to the parser in src/telemetry/parser.ts.', files: ['src/telemetry/parser.ts'], risk: 'high', required: ['contract:packet-v3', 'wm:Schemas are versioned by suffix', 'fact:decision:packet versions'], forbidden: [] },
  { key: 'h-program-throughput', category: 'held-out', title: 'Measure replay throughput after the buffer change', description: 'Milestone of the reliability program: measure how long a two hour replay takes with the larger reorder buffer.', files: [], risk: 'low', program: true, required: ['pm:Replay throughput', 'pm:Reorder buffer size (current)'], forbidden: ['pm:Buffer size'] },
  { key: 'h-ipc-export', category: 'held-out', title: 'Add an IPC channel for exporting a session', description: 'Add a channel in src/ipc/channels.ts that lets the renderer start a CSV export implemented in src/export/csv.ts.', files: ['src/ipc/channels.ts', 'src/export/csv.ts'], risk: 'medium', required: ['fact:decision:ipc validation', 'fact:decision:csv dialect', 'fact:module:src/ipc', 'fact:module:src/export'], forbidden: [] },
  { key: 'h-release-order', category: 'held-out', title: 'Ship the tyre compound field to users', description: 'Plan the release of the new tyre compound field across the desktop application and the API.', files: [], risk: 'medium', required: ['wm:API deploys before the desktop release'], forbidden: [] },
]

export type Variant = 'V2' | 'GRAPH' | 'V3' | 'FULL' | 'hierarchy-only' | 'fts-only' | 'path-only' | 'path+edges' | 'graph+fts'

const SIGNALS: Partial<Record<Variant, Partial<Record<RetrievalSignal, boolean>>>> = {
  'hierarchy-only': { path: false, fts: false, edges: false, hierarchy: true },
  'fts-only': { path: false, fts: true, edges: false, hierarchy: false },
  'path-only': { path: true, fts: false, edges: false, hierarchy: false },
  'path+edges': { path: true, fts: false, edges: true, hierarchy: false },
  'graph+fts': { path: true, fts: true, edges: true, hierarchy: false },
}

interface Retrieved {
  path: string
  warned: boolean
  tokens: number
}

const keyOf = (n: Pick<ContextNode, 'spaceKind' | 'path'>): string => `${n.spaceKind}:${n.path}`

function graphRetrieve(w: BenchWorld, c: BenchCase, signals?: Partial<Record<RetrievalSignal, boolean>>): Retrieved[] {
  const query: RetrievalQuery = { spaces: w.spaces, programId: c.program ? w.programId : null, text: `${c.title}\n${c.description}`, files: c.files, role: 'worker', risk: c.risk, tokenBudget: 2_000, ...(signals ? { signals } : {}) }
  return retrieve(w.h.repos.contextGraph, query).nodes.map((r) => ({ path: keyOf(r.node), warned: r.warning !== null, tokens: r.node.tokenEstimate + 12 }))
}

/** What 0.7.0 puts in front of the agent: the V2 pack, plus the Program engine's memory selection inside a program. */
function v2Retrieve(w: BenchWorld, c: BenchCase, v3 = false): Retrieved[] {
  const { h } = w
  const run = makeRun(h.project.id)
  const task = makeTask(run.id, c.key, { title: c.title, description: c.description, suggestedFiles: c.files, risk: c.risk })
  const query = [task.title, task.description.slice(0, 300), ...task.suggestedFiles].join(' ')
  const memorySelected = h.repos.memory.search(query, { projectId: h.project.id, limit: 8 })
  const superseded = (id: string): string | null => (v3 && ['SUPERSEDED', 'ARCHIVED'].includes(h.repos.contextGraph.nodes.byOrigin('memory', id)[0]?.status ?? '') ? 'not current' : null)
  const staleFact = (id: string): string | null => (v3 && h.repos.contextGraph.nodes.byOrigin('repository_fact', id)[0]?.status === 'STALE' ? 'stale' : null)
  const composed = composeContext({ memoryStatus: (m) => superseded(m.id), factStatus: (f) => staleFact(f.id), run, task, purpose: 'implement', missionCriteria: [], dependencies: [], tasks: [task], decisions: [], facts: h.repos.facts.listByProject(h.project.id, { includeStale: true }), memorySelected, memoryExcluded: [], messages: [], repo: { worktreePath: 'C:/wt', branch: 'b', baseCommit: 'c', projectName: h.project.name, checks: { build: null, test: null, lint: null, typecheck: null } }, priorReview: null })
  const out: Retrieved[] = []
  for (const e of composed.pack.entries) {
    if (!e.included || !e.sourceId) continue
    const kind = e.sourceKind === 'repository_fact' ? 'repository_fact' : e.sourceKind === 'memory' ? 'memory' : null
    if (!kind) continue
    const node = h.repos.contextGraph.nodes.byOrigin(kind, e.sourceId)[0]
    if (node) out.push({ path: keyOf(node), warned: false, tokens: Math.ceil(e.chars / 4) + 12 })
  }
  if (c.program) {
    const selected = selectMemory(h.repos.programMemory.listActive(w.programId), { key: c.key, title: c.title, objective: c.description, acceptanceCriteria: [], expertise: 'backend' as never })
    for (const s of selected) {
      const node = h.repos.contextGraph.nodes.byOrigin('program_memory', s.entry.id)[0]
      if (node) out.push({ path: keyOf(node), warned: false, tokens: node.tokenEstimate + 12 })
    }
  }
  return out
}

function fullRetrieve(w: BenchWorld, c: BenchCase): Retrieved[] {
  const out: Retrieved[] = []
  for (const space of w.spaces) {
    for (let offset = 0; ; offset += 500) {
      const batch = w.h.repos.contextGraph.nodes.listBySpace(space, { statuses: ['CURRENT'], limit: 500, offset })
      for (const n of batch) if (n.type !== 'SECTION' && n.path !== '' && (!n.programId || (c.program && n.programId === w.programId))) out.push({ path: keyOf(n), warned: false, tokens: n.tokenEstimate + 12 })
      if (batch.length < 500) break
    }
  }
  return out
}

export function runVariant(w: BenchWorld, c: BenchCase, variant: Variant): RetrievalScore {
  let retrieved: Retrieved[]
  if (variant === 'V2') retrieved = v2Retrieve(w, c)
  else if (variant === 'FULL') retrieved = fullRetrieve(w, c)
  else if (variant === 'V3') {
    const seen = new Set<string>()
    retrieved = [...v2Retrieve(w, c, true), ...graphRetrieve(w, c)].filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)))
  } else retrieved = graphRetrieve(w, c, SIGNALS[variant])
  const resolve = (refs: string[]): string[] => refs.map((r) => {
    const p = w.pathOf.get(r)
    if (!p) throw new Error(`benchmark reference does not resolve: ${r}`)
    return p
  })
  return scoreRetrieval({ key: c.key, required: resolve(c.required), forbidden: resolve(c.forbidden) }, retrieved, retrieved.reduce((n, r) => n + r.tokens, 0))
}

export interface VariantSummary {
  variant: Variant
  cases: number
  recall: number
  precision: number
  tokens: number
  /** Cases with every required record retrieved. */
  complete: number
  /** Records presented as current that should not be. */
  wrong: number
  missed: { case: string; missed: string[] }[]
  wrongDetail: { case: string; wrong: string[] }[]
}

export function summarize(w: BenchWorld, variant: Variant, cases: readonly BenchCase[] = w.cases): VariantSummary {
  const scores = cases.map((c) => ({ c, s: runVariant(w, c, variant) }))
  const mean = (f: (s: RetrievalScore) => number): number => scores.reduce((n, x) => n + f(x.s), 0) / Math.max(1, scores.length)
  return {
    variant,
    cases: scores.length,
    recall: mean((s) => s.recall),
    precision: mean((s) => s.precision),
    tokens: Math.round(mean((s) => s.tokens)),
    complete: scores.filter((x) => x.s.missed.length === 0).length,
    wrong: scores.reduce((n, x) => n + x.s.wrong.length, 0),
    missed: scores.filter((x) => x.s.missed.length > 0).map((x) => ({ case: x.c.key, missed: x.s.missed })),
    wrongDetail: scores.filter((x) => x.s.wrong.length > 0).map((x) => ({ case: x.c.key, wrong: x.s.wrong })),
  }
}

export function byCategory(w: BenchWorld, variant: Variant): { category: string; recall: number; precision: number; tokens: number; cases: number }[] {
  const groups = new Map<string, BenchCase[]>()
  for (const c of w.cases) groups.set(c.category, [...(groups.get(c.category) ?? []), c])
  return [...groups.entries()].map(([category, cases]) => {
    const s = summarize(w, variant, cases)
    return { category, recall: s.recall, precision: s.precision, tokens: s.tokens, cases: s.cases }
  })
}
