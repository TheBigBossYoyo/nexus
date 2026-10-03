import { describe, expect, it } from 'vitest'
import type {
  AcceptanceCriterion,
  ApprovalRequest,
  Artifact,
  Decision,
  Message,
  Review,
  UsageSnapshot,
  Verification,
  Worktree,
  AgentSession,
} from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { NexusError } from '@shared/result'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { makeAgent, makeProject, makeRun, makeTask, openMemory, seed } from './fixtures'

describe('projects and runs', () => {
  it('round-trips a project with its profile and updates it', () => {
    const { repos } = openMemory()
    const p = repos.projects.insert(makeProject())
    expect(repos.projects.require(p.id)).toEqual(p)
    const updated = repos.projects.update(p.id, { respectProjectClaudeConfig: true, profile: null })
    expect(updated.respectProjectClaudeConfig).toBe(true)
    expect(updated.profile).toBeNull()
  })

  it('throws not_found from require/update and null from get', () => {
    const { repos } = openMemory()
    expect(repos.runs.get('nope')).toBeNull()
    expect(() => repos.runs.require('nope')).toThrow(NexusError)
    try {
      repos.runs.update('nope', { state: 'failed' })
    } catch (e) {
      expect((e as NexusError).code).toBe('not_found')
    }
  })

  it('round-trips a run with plan and config; lists by project and active', () => {
    const { repos } = openMemory()
    const project = repos.projects.insert(makeProject())
    const plan = {
      summary: 's',
      assumptions: ['a'],
      acceptanceCriteria: ['c'],
      tasks: [],
      risks: [{ description: 'r', mitigation: 'm' }],
    }
    const running = repos.runs.insert(makeRun(project.id, { state: 'executing', plan: plan as never }))
    const paused = repos.runs.insert(makeRun(project.id, { state: 'paused', resumeState: 'executing', pauseReason: 'quota' }))
    const done = repos.runs.insert(makeRun(project.id, { state: 'completed', finishedAt: nowIso() }))
    expect(repos.runs.require(running.id)).toEqual(running)
    expect(repos.runs.listByProject(project.id).map((r) => r.id)).toEqual([done.id, paused.id, running.id])
    expect(repos.runs.listActive().map((r) => r.id).sort()).toEqual([paused.id, running.id].sort())
    expect(repos.runs.listByState('paused')).toHaveLength(1)
  })
})

describe('tasks and dependencies', () => {
  it('round-trips tasks including error JSON and booleans', () => {
    const { repos } = openMemory()
    const { run, t1 } = seed(repos)
    expect(repos.tasks.require(t1.id)).toEqual(t1)
    const failed = repos.tasks.update(t1.id, {
      state: 'failed',
      error: { what: 'tsc failed', where: 'src/a.ts', why: null, retryable: true },
      approvalGranted: true,
    })
    expect(failed.error).toEqual({ what: 'tsc failed', where: 'src/a.ts', why: null, retryable: true })
    expect(failed.approvalGranted).toBe(true)
    expect(repos.tasks.getByKey(run.id, 'api')?.id).toBe(t1.id)
    expect(repos.tasks.getByKey(run.id, 'zzz')).toBeNull()
  })

  it('lists by run and by state(s), ordering higher priority first', () => {
    const { repos } = openMemory()
    const { run, t1, t2 } = seed(repos)
    const t3 = repos.tasks.insert(makeTask(run.id, 'db', { state: 'ready', priority: 5 }))
    repos.tasks.update(t1.id, { state: 'ready' })
    expect(repos.tasks.listByRun(run.id)).toHaveLength(3)
    expect(repos.tasks.listByState(run.id, 'ready').map((t) => t.id)).toEqual([t3.id, t1.id])
    expect(repos.tasks.listByState(run.id, ['draft', 'ready']).map((t) => t.id)).toEqual([t3.id, t1.id, t2.id])
    expect(repos.tasks.listByState(run.id, [])).toEqual([])
  })

  it('finds expired leases only for tasks that are held', () => {
    const { repos } = openMemory()
    const { run, t1, t2 } = seed(repos)
    repos.tasks.update(t1.id, { state: 'running', leaseOwner: 'agent-1', leaseExpiresAt: '2026-01-01T00:00:00.000Z' })
    repos.tasks.update(t2.id, { state: 'running', leaseOwner: 'agent-2', leaseExpiresAt: '2026-01-01T02:00:00.000Z' })
    repos.tasks.insert(makeTask(run.id, 'done', { state: 'completed', leaseExpiresAt: '2025-01-01T00:00:00.000Z' }))
    expect(repos.tasks.listExpiredLeases('2026-01-01T01:00:00.000Z').map((t) => t.id)).toEqual([t1.id])
  })

  it('adds dependencies idempotently, lists and removes them', () => {
    const { repos } = openMemory()
    const { run, t1, t2 } = seed(repos)
    repos.dependencies.add(t2.id, t1.id)
    repos.dependencies.add(t2.id, t1.id)
    expect(repos.dependencies.listByRun(run.id)).toEqual([{ taskId: t2.id, dependsOnTaskId: t1.id }])
    expect(repos.dependencies.listForTask(t2.id)).toHaveLength(1)
    expect(repos.dependencies.listDependants(t1.id)).toHaveLength(1)
    expect(repos.dependencies.remove(t2.id, t1.id)).toBe(true)
    expect(repos.dependencies.remove(t2.id, t1.id)).toBe(false)
    expect(repos.dependencies.listByRun(run.id)).toEqual([])
  })
})

describe('agents, sessions, outputs, tool events', () => {
  it('round-trips agents and filters by run, task and active state', () => {
    const { repos } = openMemory()
    const { run, t1, t2, agent } = seed(repos)
    const working = repos.agents.insert(makeAgent(run.id, t2.id, { state: 'working', label: 'Worker/ui' }))
    repos.agents.insert(makeAgent(run.id, null, { state: 'stopped', role: 'planner' }))
    expect(repos.agents.require(agent.id)).toEqual(agent)
    expect(repos.agents.listByRun(run.id)).toHaveLength(3)
    expect(repos.agents.listByTask(t1.id).map((a) => a.id)).toEqual([agent.id])
    expect(repos.agents.listActive().map((a) => a.id)).toEqual([working.id])
    expect(repos.agents.listActive('other-run')).toEqual([])
    const m = { ...agent.metrics, turns: 3, inputTokens: 1200, costUsd: 0.04 }
    expect(repos.agents.update(agent.id, { metrics: m }).metrics).toEqual(m)
  })

  it('tracks sessions with handoffs and returns the latest', () => {
    const { repos } = openMemory()
    const { agent } = seed(repos)
    const base: AgentSession = {
      id: newId(),
      agentId: agent.id,
      sdkSessionId: 'sdk-1',
      model: 'sonnet',
      state: 'rotated',
      endReason: 'turn limit',
      handoff: {
        completedWork: ['a'],
        commits: ['abc'],
        filesChanged: ['x.ts'],
        unresolvedIssues: [],
        importantFindings: [],
        nextSteps: ['b'],
      },
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:10:00.000Z',
    }
    const second: AgentSession = {
      ...base,
      id: newId(),
      sdkSessionId: 'sdk-2',
      state: 'active',
      endReason: null,
      handoff: null,
      startedAt: '2026-01-01T00:11:00.000Z',
      endedAt: null,
    }
    repos.sessions.insert(base)
    repos.sessions.insert(second)
    expect(repos.sessions.require(base.id)).toEqual(base)
    expect(repos.sessions.listByAgent(agent.id).map((s) => s.sdkSessionId)).toEqual(['sdk-1', 'sdk-2'])
    expect(repos.sessions.latestForAgent(agent.id)).toEqual(second)
    expect(repos.sessions.latestForAgent('none')).toBeNull()
  })

  it('appends transcript items with a gapless per-agent seq and pages them', () => {
    const { repos } = openMemory()
    const { run, t2, agent } = seed(repos)
    const other = repos.agents.insert(makeAgent(run.id, t2.id))
    const a1 = repos.outputs.append(agent.id, 'text', 'one')
    const o1 = repos.outputs.append(other.id, 'system', 'other-one')
    repos.outputs.append(agent.id, 'text', 'two')
    repos.outputs.append(agent.id, 'error', 'three')
    expect(a1.seq).toBe(1)
    expect(o1.seq).toBe(1)
    expect(repos.outputs.listByAgent(agent.id).map((o) => [o.seq, o.content])).toEqual([
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ])
    expect(repos.outputs.listByAgent(agent.id, 1, 1).map((o) => o.seq)).toEqual([2])
    expect(repos.outputs.listByAgent(agent.id, 3)).toEqual([])
  })

  it('records and completes tool events by toolUseId', () => {
    const { repos } = openMemory()
    const { run, t1, agent } = seed(repos)
    const started = repos.toolEvents.insert({
      id: newId(),
      runId: run.id,
      taskId: t1.id,
      agentId: agent.id,
      toolUseId: 'toolu_01',
      toolName: 'Bash',
      input: { command: 'pnpm test', nested: { a: [1, 2] } },
      status: 'started',
      outputPreview: null,
      startedAt: nowIso(),
      completedAt: null,
    })
    const done = repos.toolEvents.complete('toolu_01', 'completed', 'ok 12 passed')
    expect(done).toMatchObject({ id: started.id, status: 'completed', outputPreview: 'ok 12 passed' })
    expect(done?.completedAt).not.toBeNull()
    expect(done?.input).toEqual(started.input)
    expect(repos.toolEvents.complete('unknown', 'failed')).toBeNull()
    expect(repos.toolEvents.listByAgent(agent.id)).toHaveLength(1)
    expect(repos.toolEvents.listByRun(run.id)).toHaveLength(1)
  })
})

describe('messages', () => {
  const message = (runId: string, over: Partial<Message> = {}): Message => ({
    id: newId(),
    runId,
    type: 'interface_change',
    severity: 'high',
    fromAgentId: null,
    fromTaskId: null,
    fromLabel: 'Worker/api',
    toTaskId: null,
    toRole: 'worker',
    toLabel: 'All workers',
    subject: 'API shape changed',
    body: 'GET /x now returns { items }',
    createdAt: nowIso(),
    ...over,
  })

  it('tracks delivery per recipient task', () => {
    const { repos } = openMemory()
    const { run, t1, t2, agent } = seed(repos)
    const m1 = repos.messages.insert(message(run.id, { fromAgentId: agent.id, fromTaskId: t1.id }), [t1.id, t2.id])
    const m2 = repos.messages.insert(message(run.id, { subject: 'second', createdAt: '2999-01-01T00:00:00.000Z' }), [t2.id])
    expect(repos.messages.require(m1.id)).toEqual(m1)
    expect(repos.messages.listByRun(run.id).map((m) => m.id)).toEqual([m1.id, m2.id])
    expect(repos.messages.listUndeliveredForTask(t1.id).map((m) => m.id)).toEqual([m1.id])
    expect(repos.messages.listUndeliveredForTask(t2.id).map((m) => m.id)).toEqual([m1.id, m2.id])

    repos.messages.markDelivered(t2.id, [m1.id])
    expect(repos.messages.listUndeliveredForTask(t2.id).map((m) => m.id)).toEqual([m2.id])
    expect(repos.messages.listUndeliveredForTask(t1.id).map((m) => m.id)).toEqual([m1.id])
    const recipients = repos.messages.listRecipients(m1.id)
    expect(recipients.find((r) => r.taskId === t2.id)?.deliveredAt).not.toBeNull()
    expect(recipients.find((r) => r.taskId === t1.id)?.deliveredAt).toBeNull()
  })

  it('does not store the message when a recipient task is unknown', () => {
    const { repos } = openMemory()
    const { run } = seed(repos)
    const m = message(run.id)
    expect(() => repos.messages.insert(m, ['missing-task'])).toThrow(NexusError)
    expect(repos.messages.get(m.id)).toBeNull()
  })
})

describe('review, verification, criteria, decisions, approvals, artifacts, usage, worktrees', () => {
  it('round-trips each entity and runs its list queries', () => {
    const { repos } = openMemory()
    const { run, t1, t2, agent } = seed(repos)
    const createdAt = nowIso()

    const review: Review = {
      id: newId(),
      runId: run.id,
      taskId: t1.id,
      agentId: agent.id,
      attempt: 1,
      verdict: 'changes_requested',
      summary: 'Needs work',
      findings: [
        {
          title: 'Race',
          description: 'd',
          evidence: 'e',
          severity: 'high',
          category: 'concurrency',
          file: 'src/a.ts',
          lineStart: 10,
          lineEnd: null,
          confidence: 'medium',
          suggestedCorrection: null,
        },
      ],
      createdAt,
    }
    repos.reviews.insert(review)
    expect(repos.reviews.require(review.id)).toEqual(review)
    expect(repos.reviews.listByTask(t1.id)).toHaveLength(1)
    expect(repos.reviews.listByTask(t2.id)).toHaveLength(0)
    expect(repos.reviews.listByRun(run.id)).toHaveLength(1)

    const verification: Verification = {
      id: newId(),
      runId: run.id,
      taskId: null,
      agentId: null,
      attempt: 1,
      kind: 'checks',
      passed: false,
      summary: 'tests failed',
      criteria: [{ criterion: 'c', passed: false, evidence: 'e' }],
      commands: [
        { name: 'test', command: 'pnpm test', cwd: 'C:\\w', exitCode: 1, timedOut: false, durationMs: 1200, output: 'FAIL' },
      ],
      failures: [{ criterion: 'c', evidence: 'e', likelyCause: 'x', relevantFiles: ['a.ts'] }],
      createdAt,
    }
    repos.verifications.insert(verification)
    expect(repos.verifications.require(verification.id)).toEqual(verification)
    expect(repos.verifications.listByRun(run.id)).toHaveLength(1)
    expect(repos.verifications.listByTask(t1.id)).toHaveLength(0)
    const taskVerification = repos.verifications.insert({ ...verification, id: newId(), taskId: t1.id, passed: true })
    expect(repos.verifications.listByTask(t1.id).map((v) => v.id)).toEqual([taskVerification.id])

    const criterion: AcceptanceCriterion = {
      id: newId(),
      runId: run.id,
      taskId: null,
      text: 'Settings page renders',
      status: 'pending',
      evidence: null,
      updatedAt: createdAt,
    }
    repos.criteria.insert(criterion)
    repos.criteria.insert({ ...criterion, id: newId(), taskId: t1.id, text: 'task level' })
    expect(repos.criteria.listByRun(run.id)).toHaveLength(2)
    expect(repos.criteria.listByTask(t1.id)).toHaveLength(1)
    expect(repos.criteria.update(criterion.id, { status: 'passed', evidence: 'screenshot' })).toMatchObject({
      status: 'passed',
      evidence: 'screenshot',
    })

    const decision: Decision = {
      id: newId(),
      runId: run.id,
      taskId: t1.id,
      agentId: agent.id,
      title: 'Use zod',
      decision: 'zod everywhere',
      rationale: 'already a dep',
      createdAt,
    }
    repos.decisions.insert(decision)
    expect(repos.decisions.listByRun(run.id)).toEqual([decision])

    const pending: ApprovalRequest = {
      id: newId(),
      runId: run.id,
      taskId: t1.id,
      agentId: agent.id,
      kind: 'tool',
      action: 'Run shell command',
      reason: 'install deps',
      command: 'pnpm add left-pad',
      requestedBy: 'Worker/api',
      risk: 'medium',
      status: 'pending',
      note: null,
      createdAt,
      resolvedAt: null,
    }
    repos.approvals.insert(pending)
    const resolved = repos.approvals.insert({ ...pending, id: newId(), status: 'approved', resolvedAt: createdAt })
    expect(repos.approvals.listPending().map((a) => a.id)).toEqual([pending.id])
    expect(repos.approvals.listPending(run.id)).toHaveLength(1)
    expect(repos.approvals.listByRun(run.id).map((a) => a.id)).toEqual([pending.id, resolved.id])
    repos.approvals.update(pending.id, { status: 'denied', note: 'no', resolvedAt: nowIso() })
    expect(repos.approvals.listPending()).toEqual([])

    const artifact: Artifact = {
      id: newId(),
      runId: run.id,
      taskId: t1.id,
      agentId: null,
      kind: 'diff',
      title: 'patch',
      content: 'diff --git ...',
      createdAt,
    }
    repos.artifacts.insert(artifact)
    expect(repos.artifacts.listByRun(run.id)).toEqual([artifact])
    expect(repos.artifacts.listByTask(t1.id)).toEqual([artifact])

    const usage: UsageSnapshot = {
      id: newId(),
      runId: run.id,
      agentId: agent.id,
      model: 'claude-sonnet',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheCreationTokens: 300,
      costUsd: 0.0123,
      contextWindow: null,
      turns: 4,
      createdAt,
    }
    repos.usage.insert(usage)
    expect(repos.usage.listByRun(run.id)).toEqual([usage])
    expect(repos.usage.listByAgent(agent.id)).toEqual([usage])

    const wt: Worktree = {
      id: newId(),
      runId: run.id,
      taskId: t1.id,
      path: 'C:\\Users\\user\\AppData\\Local\\nexus\\wt\\api',
      branch: 'nexus/api',
      baseCommit: 'ae35e3f',
      state: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    repos.worktrees.insert(wt)
    const newer = repos.worktrees.insert({ ...wt, id: newId(), state: 'removed', createdAt: '2026-01-02T00:00:00.000Z' })
    expect(repos.worktrees.listByRun(run.id)).toHaveLength(2)
    expect(repos.worktrees.getByTask(t1.id)?.id).toBe(newer.id)
    expect(repos.worktrees.getByTask(t2.id)).toBeNull()
    expect(repos.worktrees.listActive().map((w) => w.id)).toEqual([wt.id])
    expect(repos.worktrees.listActive('other')).toEqual([])
  })
})

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    const { repos } = openMemory()
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists a change and merges partial stored data over defaults', () => {
    const { repos } = openMemory()
    repos.settings.set({ ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'light' } })
    expect(repos.settings.get().appearance.theme).toBe('light')
    // Simulates data written by an older version that lacked newer keys.
    repos.settings.setValue('app', { appearance: { theme: 'light' }, execution: { maxParallelAgents: 2 } })
    const merged = repos.settings.get()
    expect(merged.appearance).toEqual({ ...DEFAULT_SETTINGS.appearance, theme: 'light' })
    expect(merged.execution.maxParallelAgents).toBe(2)
    expect(merged.execution.leaseMinutes).toBe(DEFAULT_SETTINGS.execution.leaseMinutes)
  })

  it('falls back to defaults on invalid or corrupt stored data', () => {
    const { db, repos } = openMemory()
    repos.settings.setValue('app', { execution: { maxParallelAgents: 9999 } })
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS)
    db.prepare("UPDATE settings SET value = '{not json' WHERE key = 'app'").run()
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects invalid settings on set', () => {
    const { repos } = openMemory()
    const bad = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, fontSize: 99 } }
    expect(() => repos.settings.set(bad)).toThrow()
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('stores arbitrary key/value flags', () => {
    const { repos } = openMemory()
    expect(repos.settings.getValue('x')).toBeNull()
    repos.settings.setValue('x', { a: 1 })
    repos.settings.setValue('x', { a: 2 })
    expect(repos.settings.getValue('x')).toEqual({ a: 2 })
    repos.settings.deleteValue('x')
    expect(repos.settings.getValue('x')).toBeNull()
  })
})

describe('run events', () => {
  it('assigns increasing seq across runs and pages with afterSeq', () => {
    const { repos } = openMemory()
    const { project, run, t1, agent } = seed(repos)
    const other = repos.runs.insert(makeRun(project.id))
    const e1 = repos.events.insert({ runId: run.id, type: 'run.created', payload: { mode: 'build', preset: 'balanced' } })
    const eo = repos.events.insert({ runId: other.id, type: 'run.started', payload: {} })
    const e2 = repos.events.insert({
      runId: run.id,
      taskId: t1.id,
      agentId: agent.id,
      type: 'task.state_changed',
      payload: { from: 'draft', to: 'ready', reason: 'deps met' },
    })
    const e3 = repos.events.insert({ runId: run.id, type: 'run.completed', payload: { summary: 'done' } })
    expect([e1.seq, eo.seq, e2.seq, e3.seq]).toEqual([e1.seq, e1.seq + 1, e1.seq + 2, e1.seq + 3])

    const all = repos.events.listByRun(run.id)
    expect(all.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id])
    expect(all[1]).toEqual(e2)
    expect(all[0]?.taskId).toBeNull()
    expect(repos.events.listByRun(run.id, e1.seq).map((e) => e.id)).toEqual([e2.id, e3.id])
    expect(repos.events.listByRun(run.id, e1.seq, 1).map((e) => e.id)).toEqual([e2.id])
    expect(repos.events.listByRun(run.id, e3.seq)).toEqual([])
    expect(repos.events.get(e3.id)).toEqual(e3)
    expect(repos.events.get('nope')).toBeNull()
  })

  it('never reuses a seq after deletion (AUTOINCREMENT)', () => {
    const { db, repos } = openMemory()
    const { run } = seed(repos)
    const a = repos.events.insert({ runId: run.id, type: 'run.resumed', payload: {} })
    db.prepare('DELETE FROM run_events WHERE seq = ?').run(a.seq)
    const b = repos.events.insert({ runId: run.id, type: 'run.resumed', payload: {} })
    expect(b.seq).toBeGreaterThan(a.seq)
  })
})
