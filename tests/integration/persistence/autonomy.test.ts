import { describe, expect, it } from 'vitest'
import { AUTONOMY_POLICY_VERSION, type CapabilityRequest } from '@shared/autonomy'
import { CapabilityBroker } from '@main/modules/autonomy/broker'
import { MAX_AUDIT_TOTAL } from '@main/modules/persistence/repositories/autonomy'
import { makeProject, openMemory } from './fixtures'

function setup(profile: 'AUTONOMOUS_PROJECT' | 'BALANCED' | 'LOCKED_DOWN' = 'AUTONOMOUS_PROJECT') {
  const { repos, db } = openMemory()
  const project = repos.projects.insert(makeProject())
  repos.enrollments.set({ projectId: project.id, profile, enrolledAt: '2026-10-11T09:00:00.000Z', policyVersion: AUTONOMY_POLICY_VERSION })
  const ended = new Set<string>()
  const broker = new CapabilityBroker({
    enrollment: (id) => repos.enrollments.get(id),
    grants: repos.capabilityGrants,
    requests: repos.boundaryRequests,
    runActive: (runId) => !ended.has(runId),
    audit: (e) => repos.autonomyAudit.record(e),
    transaction: (fn) => repos.transaction(fn),
  })
  const req = (over: Partial<CapabilityRequest> = {}): CapabilityRequest => ({
    capability: 'GIT_PUSH',
    actor: { kind: 'WORKER', agentId: 'agent-1', role: 'worker' },
    projectId: project.id,
    runId: 'run-1',
    taskId: 'task-1',
    resource: { kind: 'GIT_REMOTE', value: 'origin' },
    trustClass: 'UNTRUSTED_AGENT_AUTHORED',
    provider: 'claude',
    executable: 'git',
    args: ['push', 'origin', 'main'],
    cwd: null,
    networkTarget: null,
    action: 'Bash: git push origin main',
    reason: 'publishes the branch',
    ...over,
  })
  return { repos, db, project, broker, req, ended }
}

describe('autonomy persistence (migration 017)', () => {
  it('keeps one enrollment per project and replaces it on change', () => {
    const { repos, project } = setup('BALANCED')
    expect(repos.enrollments.get(project.id)?.profile).toBe('BALANCED')
    repos.enrollments.set({ projectId: project.id, profile: 'LOCKED_DOWN', enrolledAt: '2026-10-11T10:00:00.000Z', policyVersion: AUTONOMY_POLICY_VERSION })
    expect(repos.enrollments.get(project.id)).toMatchObject({ profile: 'LOCKED_DOWN', enrolledAt: '2026-10-11T10:00:00.000Z' })
    expect(repos.enrollments.remove(project.id)).toBe(true)
    expect(repos.enrollments.get(project.id)).toBeNull()
  })

  it('refuses a profile the schema does not know and a mission grant with no mission', () => {
    const { db, project, repos } = setup()
    expect(() => db.prepare("UPDATE autonomy_enrollments SET profile = 'UNRESTRICTED' WHERE project_id = ?").run(project.id)).toThrow()
    expect(() =>
      repos.capabilityGrants.insert({ id: 'g1', projectId: project.id, capability: 'GIT_PUSH', scope: 'MISSION', runId: null, resource: { kind: 'ANY', value: '' }, createdBy: 'USER', createdAt: 'x', expiresAt: null, reason: '', requestId: null, consumedAt: null, revokedAt: null }),
    ).toThrow()
    expect(() => db.prepare("INSERT INTO capability_grants (id, project_id, capability, scope, resource_kind, resource_value, created_by, created_at, reason) VALUES ('g2', ?, 'GIT_PUSH', 'PROJECT', 'ANY', '', 'AGENT', 'x', '')").run(project.id)).toThrow()
  })

  it('the database itself refuses a second pending request for the same need', () => {
    const { broker, req, repos, db } = setup()
    const first = broker.decide(req(), false)
    if (first.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    const row = repos.boundaryRequests.get(first.requestId)
    if (!row) throw new Error('missing row')
    expect(() => repos.boundaryRequests.insert({ ...row, id: 'duplicate' })).toThrow()
    expect((db.prepare('SELECT COUNT(*) AS n FROM boundary_requests').get() as { n: number }).n).toBe(1)
  })

  it('one need asked 200 times by many agents is one row, counted, and one audit event', () => {
    const { broker, req, repos } = setup()
    for (let i = 0; i < 200; i += 1) broker.decide(req({ actor: { kind: 'WORKER', agentId: `agent-${i % 7}`, role: 'worker' }, taskId: `task-${i % 5}` }), false)
    expect(repos.boundaryRequests.countPending()).toBe(1)
    expect(repos.boundaryRequests.countForRun('run-1')).toBe(1)
    expect(repos.boundaryRequests.listPending()[0]?.occurrences).toBe(200)
    expect(repos.autonomyAudit.counts({ runId: 'run-1' })).toEqual({ BOUNDARY_REQUEST: 1 })
  })

  it('a grant survives a reopen of the stores: once is used once, a project grant keeps holding', () => {
    const { broker, req, repos, project } = setup()
    const asked = broker.decide(req(), false)
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    const { grant } = broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_ONCE' })
    expect(repos.capabilityGrants.get(grant?.id ?? '')).toMatchObject({ scope: 'ONCE', runId: 'run-1', createdBy: 'USER', requestId: asked.requestId })
    // A second broker over the same database: what a restarted runtime sees.
    const again = new CapabilityBroker({ enrollment: (id) => repos.enrollments.get(id), grants: repos.capabilityGrants, requests: repos.boundaryRequests, runActive: () => true, audit: (e) => repos.autonomyAudit.record(e), transaction: (fn) => repos.transaction(fn) })
    expect(again.decide(req(), false).outcome).toBe('AUTHORIZED')
    expect(repos.capabilityGrants.get(grant?.id ?? '')?.consumedAt).not.toBeNull()
    const second = again.decide(req(), false)
    if (second.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a second request')
    again.resolve({ requestId: second.requestId, decision: 'ALLOW_PROJECT' })
    for (let i = 0; i < 5; i += 1) expect(broker.decide(req({ runId: `run-${i}` }), false).outcome).toBe('AUTHORIZED')
    expect(repos.capabilityGrants.list(project.id).map((g) => g.scope)).toEqual(['PROJECT', 'ONCE'])
    expect(repos.boundaryRequests.listRecent().map((r) => r.state)).toEqual(['GRANTED', 'GRANTED'])
  })

  it('a decision that fails half way leaves neither a grant nor a decided request', () => {
    const { req, repos, project } = setup()
    let fail = false
    const broker = new CapabilityBroker({
      enrollment: (id) => repos.enrollments.get(id),
      grants: repos.capabilityGrants,
      requests: {
        insert: (r) => repos.boundaryRequests.insert(r),
        findByKey: (k) => repos.boundaryRequests.findByKey(k),
        touch: (id, at) => repos.boundaryRequests.touch(id, at),
        get: (id) => repos.boundaryRequests.get(id),
        listPending: (p) => repos.boundaryRequests.listPending(p),
        decide: (...args) => {
          if (fail) throw new Error('crash between the grant and the answer')
          return repos.boundaryRequests.decide(...args)
        },
      },
      runActive: () => true,
      audit: (e) => repos.autonomyAudit.record(e),
      transaction: (fn) => repos.transaction(fn),
    })
    const asked = broker.decide(req(), false)
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    fail = true
    expect(() => broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_PROJECT' })).toThrow(/crash/)
    expect(repos.capabilityGrants.listUsable(project.id)).toEqual([])
    expect(repos.boundaryRequests.get(asked.requestId)?.state).toBe('PENDING')
    fail = false
    expect(broker.decide(req(), false)).toMatchObject({ outcome: 'BOUNDARY_GRANT_REQUIRED', deduplicated: true })
  })

  it('removing a project removes its enrollment, grants and requests', () => {
    const { broker, req, repos, project, db } = setup()
    const asked = broker.decide(req(), false)
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_PROJECT' })
    repos.projects.delete(project.id)
    for (const table of ['autonomy_enrollments', 'capability_grants', 'boundary_requests']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0)
    }
  })

  it('pages the audit newest first, filters by severity, and prunes ordinary actions before denials', () => {
    const { broker, req, repos, db } = setup()
    broker.decide(req({ capability: 'HOST_POWER', resource: { kind: 'ANY', value: '' } }), false)
    for (let i = 0; i < 30; i += 1) broker.decide(req({ capability: 'RUN_TESTS', resource: { kind: 'ANY', value: '' } }), true)
    const first = repos.autonomyAudit.list({ limit: 10 })
    expect(first.events).toHaveLength(10)
    expect(first.events[0]?.severity).toBe('NORMAL_AUTONOMOUS_ACTION')
    expect(first.nextBefore).not.toBeNull()
    expect(repos.autonomyAudit.list({ severities: ['POLICY_DENIAL'] }).events).toHaveLength(1)
    // Fill past the bound with ordinary actions, cheaply, then prune.
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_AUDIT_TOTAL})
       INSERT INTO autonomy_audit (id, timestamp, severity, action, resource, reason) SELECT 'bulk-' || i, 't', 'NORMAL_AUTONOMOUS_ACTION', 'a', 'r', 'x' FROM n`,
    ).run()
    repos.autonomyAudit.prune()
    expect((db.prepare('SELECT COUNT(*) AS n FROM autonomy_audit').get() as { n: number }).n).toBe(MAX_AUDIT_TOTAL)
    expect(repos.autonomyAudit.list({ severities: ['POLICY_DENIAL'] }).events).toHaveLength(1)
  })
})
