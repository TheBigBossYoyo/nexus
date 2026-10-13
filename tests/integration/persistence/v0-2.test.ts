import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { NexusError } from '@shared/result'
import type {
  ContextPack,
  GraphProposal,
  GraphRevision,
  PlanningCandidate,
  PlanningCritique,
  RepositoryFact,
  RoutingDecision,
  TaskOutcome,
} from '@shared/v2'
import {
  MIGRATIONS,
  createRepositories,
  openDatabase,
  runMigrations,
  type Database,
  type Repositories,
} from '@main/modules/persistence'
import { makeProject, makeRun, makeTask, openMemory, seed } from './fixtures'

const dirs: string[] = []
const open: Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-v02-'))
  dirs.push(dir)
  return join(dir, 'nexus.db')
}

function revision(runId: string, version: number, over: Partial<GraphRevision> = {}): GraphRevision {
  return {
    id: newId(),
    runId,
    version,
    reason: version === 1 ? 'Approved plan' : 'Add a migration task',
    proposalId: null,
    snapshot: {
      tasks: [
        { id: 't-1', key: 'api', title: 'API', role: 'worker', kind: 'implement', state: 'queued', priority: 0, parentTaskId: null },
      ],
      dependencies: [{ taskId: 't-2', dependsOnTaskId: 't-1' }],
    },
    createdAt: nowIso(),
    ...over,
  }
}

function proposal(runId: string, over: Partial<GraphProposal> = {}): GraphProposal {
  return {
    id: newId(),
    runId,
    proposedByAgentId: 'agent-1',
    proposedBy: 'Worker/api',
    taskId: 'task-1',
    type: 'ADD_TASK',
    reason: 'Schema change needs a migration',
    evidence: 'src/db/schema.ts changed',
    changes: {
      tasks: [
        {
          key: 'migration',
          title: 'Write migration',
          description: 'Add the migration',
          role: 'worker',
          dependencies: [],
          suggestedFiles: ['src/db/migrations/003.ts'],
          acceptanceCriteria: ['migration applies cleanly'],
          complexity: 'small',
          risk: 'medium',
        },
      ],
      targetTask: null,
      dependsOn: null,
      blocksProposer: true,
      priority: null,
    },
    status: 'proposed',
    rejectionReason: null,
    revisionId: null,
    createdAt: nowIso(),
    resolvedAt: null,
    ...over,
  }
}

function outcome(projectId: string, runId: string, taskId: string, over: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    id: newId(),
    projectId,
    runId,
    taskId,
    role: 'worker',
    model: 'claude-sonnet-4-5',
    tier: 'balanced',
    category: 'implement',
    complexity: 'medium',
    risk: 'low',
    attempts: 1,
    firstPassVerified: true,
    completed: true,
    reviewRejections: 0,
    repairCount: 0,
    checksFailed: 0,
    humanInterventions: 0,
    elapsedMs: 120_000,
    inputTokens: 12_000,
    outputTokens: 3_400,
    createdAt: nowIso(),
    ...over,
  }
}

function fact(projectId: string, over: Partial<RepositoryFact> = {}): RepositoryFact {
  const now = nowIso()
  return {
    id: newId(),
    projectId,
    kind: 'module',
    subject: 'src/main/modules/persistence',
    statement: 'SQLite persistence with repositories over better-sqlite3',
    source: 'static_analysis',
    confidence: 'high',
    files: ['src/main/modules/persistence/index.ts'],
    fingerprint: 'abc123',
    stale: false,
    createdAt: now,
    verifiedAt: now,
    ...over,
  }
}

describe('graph revisions', () => {
  it('round-trips snapshots, orders by version and computes the next version', () => {
    const { repos } = openMemory()
    const { run } = seed(repos)
    expect(repos.graphRevisions.nextVersion(run.id)).toBe(1)
    expect(repos.graphRevisions.latest(run.id)).toBeNull()
    const v2 = repos.graphRevisions.insert(revision(run.id, 2))
    const v1 = repos.graphRevisions.insert(revision(run.id, 1))
    expect(repos.graphRevisions.get(v1.id)).toEqual(v1)
    expect(repos.graphRevisions.listByRun(run.id).map((r) => r.version)).toEqual([1, 2])
    expect(repos.graphRevisions.latest(run.id)?.id).toBe(v2.id)
    expect(repos.graphRevisions.nextVersion(run.id)).toBe(3)
  })

  it('enforces UNIQUE(run_id, version) per run only', () => {
    const { repos } = openMemory()
    const { project, run } = seed(repos)
    repos.graphRevisions.insert(revision(run.id, 1))
    expect(() => repos.graphRevisions.insert(revision(run.id, 1))).toThrow(NexusError)
    const other = repos.runs.insert(makeRun(project.id))
    expect(() => repos.graphRevisions.insert(revision(other.id, 1))).not.toThrow()
  })
})

describe('graph proposals', () => {
  it('round-trips, updates status and filters by status', () => {
    const { repos } = openMemory()
    const { run } = seed(repos)
    const a = repos.graphProposals.insert(proposal(run.id))
    const b = repos.graphProposals.insert(proposal(run.id, { type: 'REPLAN', status: 'awaiting_approval', proposedByAgentId: null, taskId: null }))
    expect(repos.graphProposals.get(a.id)).toEqual(a)
    expect(repos.graphProposals.require(b.id).proposedByAgentId).toBeNull()
    const resolvedAt = nowIso()
    const updated = repos.graphProposals.update(a.id, { status: 'applied', revisionId: 'rev-1', resolvedAt })
    expect(updated).toMatchObject({ status: 'applied', revisionId: 'rev-1', resolvedAt })
    expect(repos.graphProposals.listByRun(run.id).map((p) => p.id)).toEqual([a.id, b.id])
    expect(repos.graphProposals.listByStatus(run.id, 'awaiting_approval').map((p) => p.id)).toEqual([b.id])
    expect(repos.graphProposals.listByStatus(run.id, 'rejected')).toEqual([])
    expect(() => repos.graphProposals.require('missing')).toThrow(NexusError)
    expect(repos.graphProposals.get('missing')).toBeNull()
  })

  it('keeps proposals and routing history when the referenced task is deleted', () => {
    const { repos } = openMemory()
    const { run, t1 } = seed(repos)
    const p = repos.graphProposals.insert(proposal(run.id, { taskId: t1.id }))
    const d = repos.routingDecisions.insert(routing(run.id, { taskId: t1.id }))
    repos.tasks.delete(t1.id)
    expect(repos.graphProposals.get(p.id)?.taskId).toBe(t1.id)
    expect(repos.routingDecisions.get(d.id)).not.toBeNull()
  })
})

describe('planning candidates and critiques', () => {
  it('round-trips a valid and an invalid candidate plus a critique', () => {
    const { repos } = openMemory()
    const { run } = seed(repos)
    const valid: PlanningCandidate = {
      id: newId(),
      runId: run.id,
      label: 'Planner A (risk-first)',
      lens: 'risk-first',
      agentId: 'agent-a',
      plan: {
        summary: 'Do it safely',
        assumptions: ['pnpm available'],
        acceptanceCriteria: ['tests pass'],
        tasks: [
          {
            id: 'api',
            title: 'API',
            description: 'Build the API',
            role: 'worker',
            dependencies: [],
            parallelizable: true,
            suggestedFiles: ['src/api.ts'],
            acceptanceCriteria: ['endpoint works'],
            complexity: 'medium',
            risk: 'low',
            requiresApproval: false,
          },
        ],
        risks: [{ description: 'Schema drift', mitigation: 'Add a migration test' }],
      },
      valid: true,
      errors: [],
      durationMs: 41_000,
      model: 'claude-opus-4',
      costUsd: 0.4231,
      createdAt: nowIso(),
    }
    const invalid: PlanningCandidate = {
      ...valid,
      id: newId(),
      label: 'Planner B (parallelism-first)',
      lens: 'parallelism-first',
      agentId: null,
      plan: null,
      valid: false,
      errors: ['cycle between api and ui'],
      durationMs: null,
      model: null,
      costUsd: null,
    }
    repos.planningCandidates.insert(valid)
    repos.planningCandidates.insert(invalid)
    expect(repos.planningCandidates.listByRun(run.id)).toEqual([valid, invalid])
    const updated = repos.planningCandidates.update(invalid.id, { valid: true, errors: [] })
    expect(updated.valid).toBe(true)
    expect(updated.plan).toBeNull()

    const critique: PlanningCritique = {
      id: newId(),
      runId: run.id,
      agentId: 'critic-1',
      output: {
        summary: 'A is safer',
        findings: [{ candidate: 'Planner B (parallelism-first)', severity: 'high', issue: 'Cycle', recommendation: 'Break it' }],
        preferredCandidate: 'Planner A (risk-first)',
      },
      createdAt: nowIso(),
    }
    repos.planningCritiques.insert(critique)
    expect(repos.planningCritiques.listByRun(run.id)).toEqual([critique])
  })
})

function routing(runId: string, over: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    id: newId(),
    runId,
    taskId: 'task-1',
    agentId: 'agent-1',
    role: 'worker',
    purpose: 'implement',
    requestedPolicy: 'BALANCED',
    resolvedPolicy: 'STRONGEST',
    resolvedTier: 'strongest',
    resolvedModel: 'claude-opus-4',
    reasons: ['high risk task: promoted to STRONGEST'],
    createdAt: nowIso(),
    ...over,
  }
}

describe('routing decisions', () => {
  it('lists by run and task and returns the latest decision for an agent', () => {
    const { repos } = openMemory()
    const { run } = seed(repos)
    const first = repos.routingDecisions.insert(routing(run.id, { createdAt: '2026-01-01T00:00:00.000Z' }))
    const second = repos.routingDecisions.insert(
      routing(run.id, { createdAt: '2026-01-01T00:00:01.000Z', resolvedPolicy: 'INHERIT', resolvedTier: null, resolvedModel: null, reasons: [] }),
    )
    const other = repos.routingDecisions.insert(routing(run.id, { taskId: null, agentId: null }))
    expect(repos.routingDecisions.listByRun(run.id).map((d) => d.id)).toEqual([first.id, second.id, other.id])
    expect(repos.routingDecisions.listByTask('task-1').map((d) => d.id)).toEqual([first.id, second.id])
    expect(repos.routingDecisions.latestForAgent('agent-1')).toEqual(second)
    expect(repos.routingDecisions.latestForAgent('nobody')).toBeNull()
  })
})

describe('task outcomes', () => {
  it('round-trips with nullable measurements and lists by project', () => {
    const { repos } = openMemory()
    const { project, run, t1, t2 } = seed(repos)
    const a = repos.taskOutcomes.insert(outcome(project.id, run.id, t1.id))
    const b = repos.taskOutcomes.insert(
      outcome(project.id, run.id, t2.id, { model: null, tier: null, elapsedMs: null, inputTokens: null, outputTokens: null, completed: false, firstPassVerified: false }),
    )
    expect(repos.taskOutcomes.getByTask(t1.id)).toEqual(a)
    expect(repos.taskOutcomes.getByTask(t2.id)).toEqual(b)
    expect(repos.taskOutcomes.listByProject(project.id)).toHaveLength(2)
    expect(repos.taskOutcomes.listAll()).toHaveLength(2)
    expect(repos.taskOutcomes.getByTask('missing')).toBeNull()
  })

  it('is one outcome per task: insert conflicts, upsertForTask replaces measurements', () => {
    const { repos } = openMemory()
    const { project, run, t1 } = seed(repos)
    const first = repos.taskOutcomes.upsertForTask(outcome(project.id, run.id, t1.id))
    expect(() => repos.taskOutcomes.insert(outcome(project.id, run.id, t1.id))).toThrow(NexusError)
    const again = repos.taskOutcomes.upsertForTask(
      outcome(project.id, run.id, t1.id, { attempts: 3, firstPassVerified: false, repairCount: 2, model: 'claude-opus-4' }),
    )
    expect(again).toMatchObject({ id: first.id, createdAt: first.createdAt, attempts: 3, firstPassVerified: false, repairCount: 2, model: 'claude-opus-4' })
    expect(repos.taskOutcomes.listAll()).toHaveLength(1)
  })
})

describe('repository facts', () => {
  it('round-trips and upserts by (project, kind, subject) keeping id and createdAt', () => {
    const { repos } = openMemory()
    const { project } = seed(repos)
    const original = repos.facts.upsert(fact(project.id, { createdAt: '2026-01-01T00:00:00.000Z' }))
    const replaced = repos.facts.upsert(
      fact(project.id, { statement: 'Now with FTS5 search', fingerprint: 'def456', files: ['a.ts', 'b.ts'], confidence: 'medium', createdAt: '2026-06-01T00:00:00.000Z' }),
    )
    expect(replaced.id).toBe(original.id)
    expect(replaced.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(replaced).toMatchObject({ statement: 'Now with FTS5 search', fingerprint: 'def456', files: ['a.ts', 'b.ts'], confidence: 'medium' })
    expect(repos.facts.get(original.id)).toEqual(replaced)
    expect(repos.facts.listByProject(project.id)).toHaveLength(1)
    // Same subject under another kind is a different fact.
    repos.facts.upsert(fact(project.id, { kind: 'boundary' }))
    expect(repos.facts.listByProject(project.id)).toHaveLength(2)
  })

  it('enforces uniqueness through plain insert and scopes it per project', () => {
    const { repos } = openMemory()
    const { project } = seed(repos)
    repos.facts.insert(fact(project.id))
    expect(() => repos.facts.insert(fact(project.id))).toThrow(NexusError)
    const other = repos.projects.insert(makeProject({ rootPath: 'C:\\other' }))
    expect(() => repos.facts.insert(fact(other.id))).not.toThrow()
  })

  it('lists with kind and stale filters, and markStale / delete work', () => {
    const { repos } = openMemory()
    const { project } = seed(repos)
    const m = repos.facts.upsert(fact(project.id, { subject: 'src/a' }))
    const c = repos.facts.upsert(fact(project.id, { kind: 'command', subject: 'test', statement: 'pnpm test runs vitest' }))
    expect(repos.facts.markStale([m.id, 'missing'])).toBe(1)
    expect(repos.facts.markStale([m.id])).toBe(0)
    expect(repos.facts.listByProject(project.id).map((f) => f.id)).toEqual([c.id])
    expect(repos.facts.listByProject(project.id, { includeStale: true })).toHaveLength(2)
    expect(repos.facts.listByProject(project.id, { includeStale: true, kind: 'module' }).map((f) => f.id)).toEqual([m.id])
    expect(repos.facts.listByProject(project.id, { kind: 'module' })).toEqual([])
    expect(repos.facts.get(m.id)?.stale).toBe(true)
    expect(repos.facts.delete(c.id)).toBe(true)
    expect(repos.facts.deleteByProject(project.id)).toBe(1)
    expect(repos.facts.listByProject(project.id, { includeStale: true })).toEqual([])
  })

  it('searches with FTS5, hides stale facts by default, scopes by project and survives hostile queries', () => {
    const { repos } = openMemory()
    const { project } = seed(repos)
    const otherProject = repos.projects.insert(makeProject({ rootPath: 'C:\\other' }))
    const sqlite = repos.facts.upsert(fact(project.id, { subject: 'persistence', statement: 'Stores everything in SQLite' }))
    repos.facts.upsert(fact(project.id, { kind: 'command', subject: 'lint', statement: 'eslint runs on src', files: ['eslint.config.js'] }))
    repos.facts.upsert(fact(otherProject.id, { subject: 'persistence', statement: 'SQLite elsewhere' }))

    expect(repos.facts.search(project.id, 'sqlite').map((f) => f.id)).toEqual([sqlite.id])
    expect(repos.facts.search(project.id, 'stores store').map((f) => f.id)).toEqual([sqlite.id])
    expect(repos.facts.search(project.id, 'eslint.config.js')).toHaveLength(1)
    expect(repos.facts.search(project.id, 'nothing-matches-this')).toEqual([])
    expect(repos.facts.search(project.id, '"((* OR NEAR: ^')).toEqual([])
    expect(repos.facts.search(project.id, '   ')).toEqual([])

    repos.facts.markStale([sqlite.id])
    expect(repos.facts.search(project.id, 'sqlite')).toEqual([])
    expect(repos.facts.search(project.id, 'sqlite', { includeStale: true })).toHaveLength(1)

    // The FTS index follows updates and deletes through the triggers.
    repos.facts.upsert(fact(project.id, { subject: 'persistence', statement: 'Now backed by postgres' }))
    expect(repos.facts.search(project.id, 'sqlite', { includeStale: true })).toEqual([])
    expect(repos.facts.search(project.id, 'postgres')).toHaveLength(1)
    repos.facts.deleteByProject(project.id)
    expect(repos.facts.search(project.id, 'postgres', { includeStale: true })).toEqual([])
  })

  it('honours the search limit and ranks subject matches first', () => {
    const { repos } = openMemory()
    const { project } = seed(repos)
    repos.facts.upsert(fact(project.id, { subject: 'a', statement: 'mentions scheduler in passing' }))
    const strong = repos.facts.upsert(fact(project.id, { subject: 'scheduler', statement: 'the scheduler module' }))
    repos.facts.upsert(fact(project.id, { subject: 'b', statement: 'also scheduler text' }))
    expect(repos.facts.search(project.id, 'scheduler')[0]?.id).toBe(strong.id)
    expect(repos.facts.search(project.id, 'scheduler', { limit: 2 })).toHaveLength(2)
  })
})

describe('context packs', () => {
  function pack(runId: string, over: Partial<ContextPack> = {}): ContextPack {
    const id = newId()
    return {
      id,
      runId,
      taskId: 'task-1',
      agentId: 'agent-1',
      purpose: 'implement',
      totalChars: 1800,
      createdAt: nowIso(),
      entries: [
        { id: newId(), packId: id, section: 'Task', sourceKind: 'task', sourceId: 'task-1', title: 'Task spec', reason: 'always included', included: true, chars: 900 },
        { id: newId(), packId: id, section: 'Facts', sourceKind: 'repository_fact', sourceId: null, title: 'Old fact', reason: 'dropped: stale', included: false, chars: 400 },
        { id: newId(), packId: id, section: 'Memory', sourceKind: 'memory', sourceId: 'm-1', title: 'Windows locks', reason: 'matched files', included: true, chars: 900 },
      ],
      ...over,
    }
  }

  it('inserts a pack with its entries and reads it back by id, task, agent and run', () => {
    const { repos } = openMemory()
    const { run } = seed(repos)
    const older = repos.contextPacks.insert(pack(run.id, { createdAt: '2026-01-01T00:00:00.000Z' }))
    const newer = repos.contextPacks.insert(pack(run.id, { createdAt: '2026-01-02T00:00:00.000Z', taskId: null, agentId: 'agent-2', entries: [] }))
    expect(repos.contextPacks.get(older.id)).toEqual(older)
    expect(repos.contextPacks.get(newer.id)).toEqual(newer)
    expect(repos.contextPacks.get('missing')).toBeNull()
    expect(repos.contextPacks.listByTask('task-1')).toEqual([older])
    expect(repos.contextPacks.listByAgent('agent-2')).toEqual([newer])
    expect(repos.contextPacks.listByRun(run.id).map((p) => p.id)).toEqual([newer.id, older.id])
  })

  it('is atomic: a bad entry leaves no pack and no entries behind', () => {
    const { db, repos } = openMemory()
    const { run } = seed(repos)
    const good = pack(run.id)
    const bad = { ...good, entries: [...good.entries, { ...good.entries[0]!, id: good.entries[0]!.id }] }
    expect(() => repos.contextPacks.insert(bad)).toThrow(NexusError)
    expect(repos.contextPacks.get(good.id)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM context_pack_entries').get()).toEqual({ n: 0 })
  })

  it('removes entries with their pack', () => {
    const { db, repos } = openMemory()
    const { run } = seed(repos)
    const p = repos.contextPacks.insert(pack(run.id))
    db.prepare('DELETE FROM context_packs WHERE id = ?').run(p.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM context_pack_entries').get()).toEqual({ n: 0 })
  })
})

function populate(repos: Repositories) {
  const { project, run, t1, agent } = seed(repos)
  repos.graphRevisions.insert(revision(run.id, 1))
  repos.graphProposals.insert(proposal(run.id))
  repos.planningCandidates.insert({
    id: newId(), runId: run.id, label: 'A', lens: 'x', agentId: null, plan: null, valid: false, errors: ['e'],
    durationMs: null, model: null, costUsd: null, createdAt: nowIso(),
  })
  repos.planningCritiques.insert({
    id: newId(), runId: run.id, agentId: null, createdAt: nowIso(),
    output: { summary: 's', findings: [], preferredCandidate: 'A' },
  })
  repos.routingDecisions.insert(routing(run.id, { taskId: t1.id, agentId: agent.id }))
  repos.taskOutcomes.insert(outcome(project.id, run.id, t1.id))
  repos.facts.upsert(fact(project.id))
  const cp: ContextPack = {
    id: newId(), runId: run.id, taskId: t1.id, agentId: agent.id, purpose: 'implement', totalChars: 1, createdAt: nowIso(),
    entries: [],
  }
  cp.entries.push({ id: newId(), packId: cp.id, section: 's', sourceKind: 'task', sourceId: null, title: 't', reason: 'r', included: true, chars: 1 })
  repos.contextPacks.insert(cp)
  return { project, run }
}

const V2_TABLES = [
  'graph_revisions',
  'graph_proposals',
  'planning_candidates',
  'planning_critiques',
  'routing_decisions',
  'task_outcomes',
  'repository_facts',
  'context_packs',
  'context_pack_entries',
]
const count = (db: Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('cascades', () => {
  it('deleting a run removes its v0.2 rows but not project-level facts', () => {
    const { db, repos } = openMemory()
    const { project, run } = populate(repos)
    repos.runs.delete(run.id)
    for (const t of V2_TABLES.filter((n) => n !== 'repository_facts')) expect(count(db, t), t).toBe(0)
    expect(repos.facts.listByProject(project.id)).toHaveLength(1)
    expect(repos.facts.search(project.id, 'sqlite')).toHaveLength(1)
  })

  it('deleting a project removes every v0.2 row and the FTS entries', () => {
    const { db, repos } = openMemory()
    const { project } = populate(repos)
    repos.projects.delete(project.id)
    for (const t of V2_TABLES) expect(count(db, t), t).toBe(0)
    expect(repos.facts.search(project.id, 'sqlite', { includeStale: true })).toEqual([])
    expect(db.prepare("SELECT COUNT(*) AS n FROM repository_facts_fts WHERE repository_facts_fts MATCH 'sqlite'").get()).toEqual({ n: 0 })
  })
})

describe('v0.1 to v0.2 migration', () => {
  const v1Only = MIGRATIONS.filter((m) => m.version === 1)

  function createV1Database(path: string) {
    const raw = new BetterSqlite3(path)
    raw.pragma('journal_mode = WAL')
    raw.pragma('foreign_keys = ON')
    runMigrations(raw, v1Only)
    const repos = createRepositories(raw)
    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(makeRun(project.id, { prompt: 'Legacy v0.1 mission' }))
    const t1 = repos.tasks.insert(makeTask(run.id, 'api', { state: 'completed' }))
    const t2 = repos.tasks.insert(makeTask(run.id, 'ui', { state: 'queued' }))
    repos.dependencies.add(t2.id, t1.id)
    const e1 = repos.events.insert({ runId: run.id, taskId: t1.id, type: 'task.ready', payload: {} })
    const e2 = repos.events.insert({ runId: run.id, type: 'run.started', payload: {} })
    const memory: MemoryEntry = {
      id: newId(), scope: 'project', projectId: project.id, runId: null, taskId: null, agentId: null, kind: 'fact',
      title: 'Windows file locks', content: 'Retry rm on EBUSY', tags: ['windows'], filePaths: ['src/git.ts'],
      source: 'verifier', evidence: null, status: 'approved', createdAt: nowIso(),
    }
    repos.memory.insert(memory)
    raw.close()
    return { project, run, t1, t2, e1, e2, memory }
  }

  it('upgrades a real v0.1 database in place, keeping every row readable', () => {
    const path = tempDb()
    const seeded = createV1Database(path)

    const probe = new BetterSqlite3(path)
    expect(probe.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 })
    expect(probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'graph_revisions'").get()).toEqual({ n: 0 })
    probe.close()

    const db = openDatabase(path)
    open.push(db)
    expect(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'v0-2' },
      { version: 3, name: 'overnight' },
      { version: 4, name: 'v0-3' },
      { version: 5, name: 'overnight-workloads' },
      { version: 6, name: 'programs' },
      { version: 7, name: 'workspaces' },
      { version: 8, name: 'providers' },
      { version: 9, name: 'control-plane' },
      { version: 10, name: 'workers' },
      { version: 11, name: 'security' },
      { version: 12, name: 'context-graph' },
      { version: 13, name: 'intelligence' },
      { version: 14, name: 'canonical-intents' },
      { version: 15, name: 'capacity-director' },
      { version: 16, name: 'advice-outcomes' },
      { version: 17, name: 'autonomy' },
      { version: 18, name: 'research' },
      { version: 19, name: 'boundary-action-hash' },
      { version: 20, name: 'operational-autonomy' },
    ])
    const repos = createRepositories(db)
    expect(repos.projects.require(seeded.project.id)).toEqual(seeded.project)
    expect(repos.runs.require(seeded.run.id)).toEqual(seeded.run)
    expect(repos.runs.require(seeded.run.id).config).toEqual(seeded.run.config)
    expect(repos.tasks.listByRun(seeded.run.id).map((t) => t.key).sort()).toEqual(['api', 'ui'])
    expect(repos.dependencies.listByRun(seeded.run.id)).toEqual([{ taskId: seeded.t2.id, dependsOnTaskId: seeded.t1.id }])
    expect(repos.events.listByRun(seeded.run.id).map((e) => e.id)).toEqual([seeded.e1.id, seeded.e2.id])
    expect(repos.memory.require(seeded.memory.id)).toEqual(seeded.memory)
    expect(repos.memory.search('ebusy', { projectId: seeded.project.id })).toHaveLength(1)

    for (const t of V2_TABLES) expect(count(db, t), t).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'repository_facts_fts'").get()).toEqual({ n: 1 })

    // The upgraded database accepts v0.2 data against the v0.1 rows.
    repos.graphRevisions.insert(revision(seeded.run.id, 1))
    repos.facts.upsert(fact(seeded.project.id))
    expect(repos.facts.search(seeded.project.id, 'sqlite')).toHaveLength(1)
    db.close()

    // Reopening is a no-op.
    const again = openDatabase(path)
    open.push(again)
    expect(again.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toHaveLength(20)
    expect(count(again, 'graph_revisions')).toBe(1)
    expect(createRepositories(again).runs.require(seeded.run.id).prompt).toBe('Legacy v0.1 mission')
  })

  it('does not alter any v0.1 table', () => {
    const v1 = new BetterSqlite3(':memory:')
    runMigrations(v1, v1Only)
    const v2 = openDatabase(':memory:')
    open.push(v2)
    const ddl = (db: Database): Map<string, string> =>
      new Map(
        (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all() as { name: string; sql: string }[]).map(
          (r) => [r.name, r.sql],
        ),
      )
    const before = ddl(v1)
    const after = ddl(v2)
    for (const [name, sql] of before) expect(after.get(name), name).toBe(sql)
    v1.close()
  })

  it('rolls a failing migration back completely and reports NexusError(database) without losing data', () => {
    const path = tempDb()
    const seeded = createV1Database(path)
    const broken = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE half_done (x INTEGER); INSERT INTO half_done VALUES (1); THIS IS NOT SQL;',
    }
    const raw = new BetterSqlite3(path)
    raw.pragma('foreign_keys = ON')
    try {
      runMigrations(raw, [...v1Only, broken])
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(NexusError)
      expect((e as NexusError).code).toBe('database')
    }
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get()).toEqual({ n: 0 })
    expect(raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 })
    const repos = createRepositories(raw)
    expect(repos.runs.require(seeded.run.id).prompt).toBe('Legacy v0.1 mission')
    expect(repos.tasks.listByRun(seeded.run.id)).toHaveLength(2)
    expect(repos.memory.require(seeded.memory.id).title).toBe('Windows file locks')
    raw.close()

    // The real migration still applies afterwards.
    const db = openDatabase(path)
    open.push(db)
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 20 })
  })

  it('rolls back the real v0.2 migration when a later migration fails, leaving the DB at v0.1', () => {
    const path = tempDb()
    createV1Database(path)
    const raw = new BetterSqlite3(path)
    expect(() => runMigrations(raw, [...MIGRATIONS, { version: 8, name: 'broken', sql: 'SELECT * FROM no_such_table_anywhere;' }])).toThrow(
      NexusError,
    )
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'graph_revisions'").get()).toEqual({ n: 0 })
    expect(raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 })
    raw.close()
  })
})
