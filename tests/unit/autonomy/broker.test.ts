import { actionHashOf } from '@main/modules/autonomy/resource'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AUTONOMY_CAPABILITIES, AUTONOMY_CAPABILITY_NAMES, AUTONOMY_POLICY_VERSION, allowedScopes, profileCapabilities, profileSummary, type AutonomyAuditEvent, type AutonomyCapability, type AutonomyProfile, type BoundaryRequest, type CapabilityGrant, type CapabilityRequest } from '@shared/autonomy'
import { CapabilityBroker, type BoundaryRequestStorePort, type GrantStorePort } from '@main/modules/autonomy/broker'
import { boundaryDedupeKey, normalizeResource, resourceCovers } from '@main/modules/autonomy/resource'
import { canRoleExercise } from '@main/modules/autonomy/role-contract'

function harness(profile: AutonomyProfile | null = 'AUTONOMOUS_PROJECT') {
  const grants: CapabilityGrant[] = []
  const requests: BoundaryRequest[] = []
  const audit: Omit<AutonomyAuditEvent, 'seq'>[] = []
  const changes: { id: string; change: string; state: string }[] = []
  const ended = new Set<string>()
  let clock = Date.parse('2026-10-11T10:00:00Z')
  const grantStore: GrantStorePort = {
    insert: (g) => void grants.push({ ...g }),
    listUsable: (projectId) => grants.filter((g) => g.projectId === projectId && g.revokedAt === null && g.consumedAt === null).map((g) => ({ ...g })),
    consume: (id, at) => {
      const g = grants.find((x) => x.id === id)
      if (!g || g.consumedAt !== null) return false
      g.consumedAt = at
      return true
    },
    revoke: (id, at) => {
      const g = grants.find((x) => x.id === id)
      if (!g || g.revokedAt !== null) return false
      g.revokedAt = at
      return true
    },
    get: (id) => grants.find((x) => x.id === id) ?? null,
  }
  const requestStore: BoundaryRequestStorePort = {
    insert: (r) => void requests.push({ ...r }),
    findByKey: (key) => [...requests].reverse().find((r) => r.dedupeKey === key) ?? null,
    listByKey: (key) => [...requests].reverse().filter((r) => r.dedupeKey === key).sort((a, b) => Number(b.state === 'PENDING') - Number(a.state === 'PENDING')),
    countForCapability: (projectId, runId, capability) => requests.filter((r) => r.projectId === projectId && r.runId === runId && r.capability === capability).length,
    touch: (id, at) => {
      const r = requests.find((x) => x.id === id)
      if (r) {
        r.occurrences += 1
        r.lastSeenAt = at
      }
    },
    decide: (id, state, at, scope, grantId) => {
      const r = requests.find((x) => x.id === id)
      if (!r || r.state !== 'PENDING') return false
      Object.assign(r, { state, decidedAt: at, decidedScope: scope, grantId })
      return true
    },
    get: (id) => requests.find((x) => x.id === id) ?? null,
    listPending: (projectId) => requests.filter((r) => r.state === 'PENDING' && (projectId === undefined || r.projectId === projectId)),
  }
  const broker = new CapabilityBroker({
    enrollment: (projectId) => (profile === null ? null : { projectId, profile, enrolledAt: '2026-10-11T09:00:00Z', policyVersion: AUTONOMY_POLICY_VERSION }),
    grants: grantStore,
    requests: requestStore,
    runActive: (runId) => !ended.has(runId),
    audit: (e) => void audit.push(e),
    onBoundaryChange: (r, change) => void changes.push({ id: r.id, change, state: r.state }),
    transaction: (fn) => fn(),
    now: () => clock,
  })
  return { broker, grants, requests, audit, changes, ended, advance: (ms: number) => void (clock += ms) }
}

function req(capability: AutonomyCapability, over: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    capability,
    actor: { kind: 'WORKER', agentId: 'agent-1', role: 'worker' },
    projectId: 'p1',
    runId: 'run-1',
    taskId: 'task-1',
    resource: { kind: 'ANY', value: '' },
    trustClass: 'UNTRUSTED_AGENT_AUTHORED',
    provider: 'claude',
    executable: null,
    args: [],
    cwd: null,
    networkTarget: null,
    action: 'Bash: pnpm test',
    reason: 'runs the project tests',
    ...over,
    // The gate computes it from the whole call; here the exact text stands in for the call, unless a test says otherwise.
    actionHash: over.actionHash !== undefined ? over.actionHash : hashOf(over.action ?? 'Bash: pnpm test'),
  }
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('the capability table', () => {
  it('gives every capability a kind and a sentence, and no profile holds a boundary or a forbidden one', () => {
    for (const name of AUTONOMY_CAPABILITY_NAMES) {
      expect(AUTONOMY_CAPABILITIES[name].label.length).toBeGreaterThan(5)
      for (const profile of ['AUTONOMOUS_PROJECT', 'BALANCED', 'LOCKED_DOWN'] as const) {
        if (AUTONOMY_CAPABILITIES[name].kind !== 'PROFILE') expect(profileCapabilities(profile).has(name)).toBe(false)
      }
    }
  })

  it('orders the profiles: what LOCKED_DOWN allows BALANCED allows, and what BALANCED allows AUTONOMOUS_PROJECT allows', () => {
    const auto = profileCapabilities('AUTONOMOUS_PROJECT')
    const balanced = profileCapabilities('BALANCED')
    const locked = profileCapabilities('LOCKED_DOWN')
    for (const c of locked) expect(balanced.has(c)).toBe(true)
    for (const c of balanced) expect(auto.has(c)).toBe(true)
    expect(locked.has('PUBLIC_WEB_RESEARCH')).toBe(false)
    expect(balanced.has('INSTALL_PROJECT_DEPENDENCIES')).toBe(false)
    expect(auto.has('INSTALL_PROJECT_DEPENDENCIES')).toBe(true)
  })

  it('never offers a forbidden capability a scope, and never offers "always" for a payment or an elevation', () => {
    expect(allowedScopes('HOST_POWER')).toEqual([])
    expect(allowedScopes('ACCESS_PROVIDER_SECRETS')).toEqual([])
    expect(allowedScopes('FINANCIAL_TRANSACTION')).toEqual(['ONCE'])
    expect(allowedScopes('ELEVATE')).toEqual(['ONCE'])
    expect(allowedScopes('GIT_PUSH')).toEqual(['ONCE', 'MISSION', 'PROJECT'])
  })

  it('lists in the enrollment summary what is allowed and what is withheld, with nothing forbidden offered as withheld', () => {
    const s = profileSummary('AUTONOMOUS_PROJECT')
    expect(s.allowed).toContain(AUTONOMY_CAPABILITIES.RUN_TESTS.label)
    expect(s.withheld).toContain(AUTONOMY_CAPABILITIES.GIT_PUSH.label)
    expect(s.withheld).not.toContain(AUTONOMY_CAPABILITIES.HOST_POWER.label)
  })
})

describe('resources', () => {
  it('covers what lies under a granted path and not a sibling that shares its prefix', () => {
    const root = normalizeResource({ kind: 'PATH', value: 'C:\\work\\out' })
    expect(resourceCovers(root, normalizeResource({ kind: 'PATH', value: 'C:\\work\\out\\a\\b.txt' }))).toBe(true)
    expect(resourceCovers(root, normalizeResource({ kind: 'PATH', value: 'C:\\work\\out' }))).toBe(true)
    expect(resourceCovers(root, normalizeResource({ kind: 'PATH', value: 'C:\\work\\outside\\b.txt' }))).toBe(false)
    expect(resourceCovers(root, normalizeResource({ kind: 'PATH', value: 'C:\\work\\out\\..\\secret.txt' }))).toBe(false)
  })

  it('covers a host and its ports, never a subdomain or a look-alike', () => {
    const host = normalizeResource({ kind: 'HOST', value: 'Example.com.' })
    expect(host.value).toBe('example.com')
    expect(resourceCovers(host, normalizeResource({ kind: 'HOST', value: 'example.com:8443' }))).toBe(true)
    expect(resourceCovers(host, normalizeResource({ kind: 'HOST', value: 'evil.example.com' }))).toBe(false)
    expect(resourceCovers(host, normalizeResource({ kind: 'HOST', value: 'example.com.evil.org' }))).toBe(false)
    const withPort = normalizeResource({ kind: 'HOST', value: 'example.com:443' })
    expect(resourceCovers(withPort, normalizeResource({ kind: 'HOST', value: 'example.com:8443' }))).toBe(false)
  })

  it('lets ANY cover a named resource and never the reverse; a value that cannot be read covers nothing', () => {
    const any = normalizeResource({ kind: 'ANY', value: 'ignored' })
    expect(any.value).toBe('')
    expect(resourceCovers(any, normalizeResource({ kind: 'GIT_REMOTE', value: 'origin' }))).toBe(true)
    expect(resourceCovers(normalizeResource({ kind: 'GIT_REMOTE', value: 'origin' }), any)).toBe(false)
    const bad = normalizeResource({ kind: 'HOST', value: 'http://[' })
    expect(bad.value).toBe('')
    expect(resourceCovers(bad, bad)).toBe(false)
  })

  it('gives the same need the same key within a mission and another key in another mission', () => {
    const a = boundaryDedupeKey({ projectId: 'p1', runId: 'r1', capability: 'GIT_PUSH', resource: { kind: 'GIT_REMOTE', value: 'Origin ' } })
    const b = boundaryDedupeKey({ projectId: 'p1', runId: 'r1', capability: 'GIT_PUSH', resource: { kind: 'GIT_REMOTE', value: 'origin' } })
    const c = boundaryDedupeKey({ projectId: 'p1', runId: 'r2', capability: 'GIT_PUSH', resource: { kind: 'GIT_REMOTE', value: 'origin' } })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('the role contract', () => {
  it('lets no role and no actor hold a forbidden capability', () => {
    for (const name of AUTONOMY_CAPABILITY_NAMES) {
      if (AUTONOMY_CAPABILITIES[name].kind !== 'NEVER') continue
      for (const kind of ['WORKER', 'VERIFIER', 'PLANNER', 'DIRECTOR', 'TASK_COMPILER', 'RESEARCH_AGENT', 'NEXUS'] as const) {
        expect(canRoleExercise({ kind, role: 'worker' }, name)).toBe(false)
      }
    }
  })

  it('keeps a verifier from writing and from pushing, and lets it run, launch and look', () => {
    const verifier = { kind: 'VERIFIER' as const, role: 'verifier' as const }
    expect(canRoleExercise(verifier, 'WRITE_WORKTREE')).toBe(false)
    expect(canRoleExercise(verifier, 'GIT_PUSH')).toBe(false)
    expect(canRoleExercise(verifier, 'RUN_TESTS')).toBe(true)
    expect(canRoleExercise(verifier, 'LAUNCH_PROJECT_APP')).toBe(true)
    expect(canRoleExercise(verifier, 'BROWSER_AUTOMATION')).toBe(true)
  })

  it('gives a Director, the Task Compiler and the research agent research and nothing that runs or writes', () => {
    for (const kind of ['DIRECTOR', 'TASK_COMPILER', 'RESEARCH_AGENT'] as const) {
      expect(canRoleExercise({ kind, role: null }, 'PUBLIC_WEB_RESEARCH')).toBe(true)
      expect(canRoleExercise({ kind, role: null }, 'RUN_PROJECT_COMMAND')).toBe(false)
      expect(canRoleExercise({ kind, role: null }, 'WRITE_WORKTREE')).toBe(false)
      expect(canRoleExercise({ kind, role: null }, 'GIT_PUSH')).toBe(false)
      expect(canRoleExercise({ kind, role: null }, 'READ_PROJECT_SECRETS')).toBe(false)
    }
  })
})

describe('the capability broker', () => {
  it('authorizes what the profile covers without a question, any number of times', () => {
    const h = harness()
    for (let i = 0; i < 50; i += 1) {
      for (const c of ['RUN_TESTS', 'RUN_BUILD', 'INSTALL_PROJECT_DEPENDENCIES', 'LAUNCH_PROJECT_APP', 'BROWSER_AUTOMATION', 'PUBLIC_WEB_RESEARCH', 'GIT_LOCAL', 'WRITE_WORKTREE'] as const) {
        expect(h.broker.decide(req(c), true).outcome).toBe('AUTHORIZED')
      }
    }
    expect(h.requests).toHaveLength(0)
    expect(h.changes).toHaveLength(0)
    expect(h.audit.every((e) => e.severity === 'NORMAL_AUTONOMOUS_ACTION' && e.authorizedBy === 'AUTONOMOUS_PROJECT')).toBe(true)
  })

  it('refuses everything for a project that is not enrolled, and asks nothing', () => {
    const h = harness(null)
    expect(h.broker.decide(req('RUN_TESTS'), true).outcome).toBe('DENIED')
    expect(h.broker.decide(req('GIT_PUSH'), false).outcome).toBe('DENIED')
    expect(h.requests).toHaveLength(0)
  })

  it('refuses a forbidden capability with no request, and records an attempt on credentials as one', () => {
    const h = harness()
    const d = h.broker.decide(req('ACCESS_PROVIDER_SECRETS'), false)
    expect(d.outcome).toBe('DENIED')
    expect(h.broker.decide(req('HOST_POWER'), false).outcome).toBe('DENIED')
    expect(h.broker.decide(req('ALTER_SECURITY_POLICY'), false).outcome).toBe('DENIED')
    expect(h.requests).toHaveLength(0)
    expect(h.audit[0]?.severity).toBe('CREDENTIAL_ACCESS_ATTEMPT')
  })

  it('refuses a profile capability whose resource is outside the boundary, even with a standing grant of it', () => {
    const h = harness()
    h.grants.push({ id: 'g', projectId: 'p1', capability: 'WRITE_WORKTREE', scope: 'PROJECT', runId: null, resource: { kind: 'ANY', value: '' }, createdBy: 'USER', createdAt: '', expiresAt: null, reason: '', requestId: null, consumedAt: null, revokedAt: null })
    const d = h.broker.decide(req('WRITE_WORKTREE', { resource: { kind: 'PATH', value: 'C:\\Users\\someone\\Documents\\x.txt' } }), false)
    expect(d.outcome).toBe('DENIED')
    expect(h.requests).toHaveLength(0)
  })

  it('makes one request for one need, however often and by however many agents it is met', () => {
    const h = harness()
    const push = (agentId: string, taskId: string) => h.broker.decide(req('GIT_PUSH', { resource: { kind: 'GIT_REMOTE', value: 'origin' }, actor: { kind: 'WORKER', agentId, role: 'worker' }, taskId, action: 'Bash: git push origin main' }), false)
    const first = push('a1', 't1')
    expect(first).toMatchObject({ outcome: 'BOUNDARY_GRANT_REQUIRED', deduplicated: false })
    for (let i = 0; i < 20; i += 1) expect(push(`a${i}`, `t${i}`)).toMatchObject({ outcome: 'BOUNDARY_GRANT_REQUIRED', deduplicated: true })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]?.occurrences).toBe(21)
    expect(h.changes.filter((c) => c.change === 'created')).toHaveLength(1)
    expect(h.audit.filter((e) => e.severity === 'BOUNDARY_REQUEST')).toHaveLength(1)
  })

  it('asks separately for a different resource and for a different capability', () => {
    const h = harness()
    h.broker.decide(req('GIT_PUSH', { resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    h.broker.decide(req('GIT_PUSH', { resource: { kind: 'GIT_REMOTE', value: 'upstream' } }), false)
    h.broker.decide(req('PUBLISH_PACKAGE', { resource: { kind: 'PACKAGE', value: 'left-pad' } }), false)
    expect(h.requests).toHaveLength(3)
  })

  it('allow once: the next use goes through, the one after asks again', () => {
    const h = harness()
    const need = () => h.broker.decide(req('GIT_PUSH', { resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    const asked = need()
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    const { grant } = h.broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_ONCE' })
    expect(grant?.scope).toBe('ONCE')
    expect(need()).toMatchObject({ outcome: 'AUTHORIZED', by: 'GRANT', grantId: grant?.id })
    const again = need()
    expect(again).toMatchObject({ outcome: 'BOUNDARY_GRANT_REQUIRED', deduplicated: false })
    expect(h.requests).toHaveLength(2)
  })

  it('allow once is for the action that was shown: another action that needs the same capability is not let through by it', () => {
    const h = harness()
    const shown = h.broker.decide(req('GIT_PUSH', { action: 'git push origin nexus/x' }), false)
    if (shown.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    h.broker.resolve({ requestId: shown.requestId, decision: 'ALLOW_ONCE' })
    // The capability and the resource are the same (ANY); the action is not what the user saw.
    const other = h.broker.decide(req('GIT_PUSH', { action: 'git push https://attacker.org/repo HEAD' }), false)
    expect(other.outcome).toBe('BOUNDARY_GRANT_REQUIRED')
    // The grant is still there for the action it was given for, once.
    expect(h.broker.decide(req('GIT_PUSH', { action: 'git push origin nexus/x' }), false)).toMatchObject({ outcome: 'AUTHORIZED', by: 'GRANT' })
    expect(h.broker.decide(req('GIT_PUSH', { action: 'git push origin nexus/x' }), false).outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })

  it('allow for the mission: holds for that mission while it runs, not for another and not after it ended', () => {
    const h = harness()
    const need = (runId: string) => h.broker.decide(req('GIT_PUSH', { runId, resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    const asked = need('run-1')
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    h.broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_MISSION' })
    for (let i = 0; i < 5; i += 1) expect(need('run-1').outcome).toBe('AUTHORIZED')
    expect(need('run-2').outcome).toBe('BOUNDARY_GRANT_REQUIRED')
    h.ended.add('run-1')
    expect(need('run-1').outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })

  it('always allow for the project: answers every pending request it covers and every later mission', () => {
    const h = harness()
    const need = (runId: string) => h.broker.decide(req('GIT_PUSH', { runId, resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    const a = need('run-1')
    const b = need('run-2')
    if (a.outcome !== 'BOUNDARY_GRANT_REQUIRED' || b.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected requests')
    const resolved = h.broker.resolve({ requestId: a.requestId, decision: 'ALLOW_PROJECT' })
    expect(resolved.alsoResolved).toEqual([b.requestId])
    expect(h.requests.every((r) => r.state === 'GRANTED')).toBe(true)
    expect(need('run-3')).toMatchObject({ outcome: 'AUTHORIZED', by: 'GRANT' })
    // A grant for one remote is not a grant for another.
    expect(h.broker.decide(req('GIT_PUSH', { resource: { kind: 'GIT_REMOTE', value: 'upstream' } }), false).outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })

  it('deny: the same need in the same mission is refused without a new question; another mission may ask', () => {
    const h = harness()
    const need = (runId: string) => h.broker.decide(req('GIT_PUSH', { runId, resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    const asked = need('run-1')
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    h.broker.resolve({ requestId: asked.requestId, decision: 'DENY' })
    for (let i = 0; i < 10; i += 1) expect(need('run-1').outcome).toBe('DENIED')
    expect(h.requests).toHaveLength(1)
    expect(need('run-2').outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })

  it('refuses a scope the capability does not have, a second decision, and an unknown request', () => {
    const h = harness()
    const asked = h.broker.decide(req('ELEVATE', { resource: { kind: 'COMMAND', value: 'choco install x' } }), false)
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    expect(() => h.broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_PROJECT' })).toThrow(/scope/)
    h.broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_ONCE' })
    expect(() => h.broker.resolve({ requestId: asked.requestId, decision: 'DENY' })).toThrow(/already decided/)
    expect(() => h.broker.resolve({ requestId: 'nope', decision: 'DENY' })).toThrow(/no such/)
    expect(h.grants).toHaveLength(1)
  })

  it('stops honouring a revoked grant and an expired one', () => {
    const h = harness()
    const need = () => h.broker.decide(req('GIT_PUSH', { resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    const asked = need()
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    const { grant } = h.broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_PROJECT' })
    expect(need().outcome).toBe('AUTHORIZED')
    expect(h.broker.revoke(grant?.id ?? '')).toBe(true)
    expect(need().outcome).toBe('BOUNDARY_GRANT_REQUIRED')

    const h2 = harness()
    h2.grants.push({ id: 'g', projectId: 'p1', capability: 'GIT_PUSH', scope: 'PROJECT', runId: null, resource: { kind: 'ANY', value: '' }, createdBy: 'USER_POLICY', createdAt: '', expiresAt: '2026-10-11T11:00:00Z', reason: '', requestId: null, consumedAt: null, revokedAt: null })
    expect(h2.broker.decide(req('GIT_PUSH'), false).outcome).toBe('AUTHORIZED')
    h2.advance(2 * 3600_000)
    expect(h2.broker.decide(req('GIT_PUSH'), false).outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })

  it('asks once for a capability the profile withholds, and then never again for the project', () => {
    const h = harness('BALANCED')
    const install = () => h.broker.decide(req('INSTALL_PROJECT_DEPENDENCIES'), true)
    const asked = install()
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    h.broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_PROJECT' })
    for (let i = 0; i < 10; i += 1) expect(install().outcome).toBe('AUTHORIZED')
    expect(h.requests).toHaveLength(1)
  })

  it('refuses a role what its contract does not hold, whatever the profile, without a question', () => {
    const h = harness()
    const asVerifier = { actor: { kind: 'VERIFIER' as const, agentId: 'v', role: 'verifier' as const } }
    expect(h.broker.decide(req('WRITE_WORKTREE', asVerifier), true).outcome).toBe('DENIED')
    expect(h.broker.decide(req('GIT_PUSH', asVerifier), false).outcome).toBe('DENIED')
    expect(h.broker.decide(req('RUN_TESTS', asVerifier), true).outcome).toBe('AUTHORIZED')
    expect(h.broker.decide(req('RUN_PROJECT_COMMAND', { actor: { kind: 'DIRECTOR', agentId: null, role: null } }), true).outcome).toBe('DENIED')
    expect(h.requests).toHaveLength(0)
  })

  it('expires the pending requests of a mission that ended', () => {
    const h = harness()
    h.broker.decide(req('GIT_PUSH', { resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    h.broker.decide(req('GIT_PUSH', { runId: 'run-2', resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    expect(h.broker.expireForRun('run-1')).toBe(1)
    expect(h.requests.map((r) => r.state)).toEqual(['EXPIRED', 'PENDING'])
  })

  // 0.9.1: a worker refused a server it started itself checked the application with the app tools and completed; its
  // request was shown as waiting for the owner until the end of the mission.
  it('expires the pending requests of a task that completed, and only those', () => {
    const h = harness()
    h.broker.decide(req('GIT_PUSH', { resource: { kind: 'GIT_REMOTE', value: 'origin' } }), false)
    h.broker.decide(req('GIT_PUSH', { taskId: 'task-2', resource: { kind: 'GIT_REMOTE', value: 'upstream' } }), false)
    expect(h.broker.expireForRun('run-1', 'task-1')).toBe(1)
    expect(h.requests.map((r) => r.state)).toEqual(['EXPIRED', 'PENDING'])
  })

  it('tells the owner which local port a fetch reaches', () => {
    const h = harness()
    const d = h.broker.decide(req('EXTERNAL_HOST_NETWORK', { reason: 'network operation (curl) to the local port 5051' }), false)
    expect(d.outcome).toBe('BOUNDARY_GRANT_REQUIRED')
    expect(h.requests[0]!.reason).toContain('It reaches this computer at port 5051, which is not an application NEXUS launched for the mission.')
    h.broker.decide(req('EXTERNAL_HOST_NETWORK', { action: 'Bash: curl https://example.com', reason: 'network operation (curl)' }), false)
    expect(h.requests[1]!.reason).not.toContain('port')
  })

  it('still decides when the audit log cannot be written', () => {
    const h = harness()
    const broker = new CapabilityBroker({
      enrollment: (projectId) => ({ projectId, profile: 'AUTONOMOUS_PROJECT', enrolledAt: '', policyVersion: AUTONOMY_POLICY_VERSION }),
      grants: { insert: () => undefined, listUsable: () => [], consume: () => false, revoke: () => false, get: () => null },
      requests: { insert: () => undefined, findByKey: () => null, listByKey: () => [], countForCapability: () => 0, touch: () => undefined, decide: () => false, get: () => null, listPending: () => [] },
      runActive: () => true,
      audit: () => {
        throw new Error('disk full')
      },
      transaction: (fn) => fn(),
    })
    expect(broker.decide(req('RUN_TESTS'), true).outcome).toBe('AUTHORIZED')
    expect(broker.decide(req('HOST_POWER'), false).outcome).toBe('DENIED')
    expect(h.requests).toHaveLength(0)
  })
})

describe('allow once is bound to the exact call', () => {
  const prefix = 'git push origin '.padEnd(299, 'x')

  it('another command with the same first 299 characters is not covered; the identical command is', () => {
    const h = harness()
    const asked = h.broker.decide(req('GIT_PUSH', { action: `${prefix}A`, actionHash: hashOf('full command A') }), false)
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    h.broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_ONCE' })
    // The text shown is equal; the call is not.
    const other = h.broker.decide(req('GIT_PUSH', { action: `${prefix}A`, actionHash: hashOf('full command B, --force') }), false)
    expect(other.outcome).toBe('BOUNDARY_GRANT_REQUIRED')
    expect(h.grants[0]?.consumedAt).toBeNull()
    expect(h.broker.decide(req('GIT_PUSH', { action: `${prefix}A`, actionHash: hashOf('full command A') }), false)).toMatchObject({ outcome: 'AUTHORIZED', by: 'GRANT' })
    expect(h.broker.decide(req('GIT_PUSH', { action: `${prefix}A`, actionHash: hashOf('full command A') }), false).outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })

  it('a once grant whose request is missing is not usable', () => {
    const h = harness()
    h.grants.push({ id: 'g', projectId: 'p1', capability: 'GIT_PUSH', scope: 'ONCE', runId: 'run-1', resource: { kind: 'ANY', value: '' }, createdBy: 'USER', createdAt: '', expiresAt: null, reason: '', requestId: null, consumedAt: null, revokedAt: null })
    h.grants.push({ id: 'g2', projectId: 'p1', capability: 'GIT_PUSH', scope: 'ONCE', runId: 'run-1', resource: { kind: 'ANY', value: '' }, createdBy: 'USER', createdAt: '', expiresAt: null, reason: '', requestId: 'no-such-request', consumedAt: null, revokedAt: null })
    expect(h.broker.decide(req('GIT_PUSH'), false).outcome).toBe('BOUNDARY_GRANT_REQUIRED')
    expect(h.grants.every((g) => g.consumedAt === null)).toBe(true)
  })

  it('a once grant of a request made before the hash existed is not usable, and neither is a call without one', () => {
    const h = harness()
    const asked = h.broker.decide(req('GIT_PUSH', { actionHash: null }), false)
    if (asked.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    expect(h.requests[0]?.actionHash).toBeNull()
    h.broker.resolve({ requestId: asked.requestId, decision: 'ALLOW_ONCE' })
    expect(h.broker.decide(req('GIT_PUSH', { actionHash: null }), false).outcome).toBe('BOUNDARY_GRANT_REQUIRED')
    expect(h.broker.decide(req('GIT_PUSH'), false).outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })

  it('strips the characters that reorder or hide text from what is stored', () => {
    const h = harness()
    h.broker.decide(req('GIT_PUSH', { action: `git push ${String.fromCharCode(0x202e)}orig\u0007in` }), false)
    expect(h.requests[0]?.action).toBe('git push origin')
  })
})

describe('different actions of one need', () => {
  const push = (h: ReturnType<typeof harness>, text: string, runId = 'run-1') => h.broker.decide(req('GIT_PUSH', { runId, action: text, actionHash: hashOf(text) }), false)

  it('the same action is one request, a different action under the same capability and resource is its own', () => {
    const h = harness()
    const a = push(h, 'git push origin main')
    const b = push(h, 'git push --force https://other.example/repo')
    expect(a).toMatchObject({ deduplicated: false })
    expect(b).toMatchObject({ deduplicated: false })
    expect(push(h, 'git push origin main')).toMatchObject({ deduplicated: true })
    expect(push(h, 'git push origin main')).toMatchObject({ deduplicated: true })
    expect(h.requests).toHaveLength(2)
    expect(h.requests.map((r) => r.occurrences)).toEqual([3, 1])
  })

  it('refuses at once after 12 distinct requests for a capability in a mission, creates none, and audits it', () => {
    const h = harness()
    for (let i = 0; i < 12; i += 1) expect(push(h, `git push remote-${i}`).outcome).toBe('BOUNDARY_GRANT_REQUIRED')
    const over = push(h, 'git push remote-13')
    expect(over.outcome).toBe('DENIED')
    if (over.outcome === 'DENIED') expect(over.reason).toContain('limit was reached')
    expect(h.requests).toHaveLength(12)
    expect(h.audit.some((e) => e.outcome === 'DENIED' && e.reason.includes('limit was reached'))).toBe(true)
    // The same action as one that exists is still the same request; another mission has its own count.
    expect(push(h, 'git push remote-3')).toMatchObject({ outcome: 'BOUNDARY_GRANT_REQUIRED', deduplicated: true })
    expect(push(h, 'git push remote-13', 'run-2').outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })

  it('a denial is final for the capability and resource in the mission, for any action', () => {
    const h = harness()
    const first = push(h, 'git push origin main')
    if (first.outcome !== 'BOUNDARY_GRANT_REQUIRED') throw new Error('expected a request')
    h.broker.resolve({ requestId: first.requestId, decision: 'DENY' })
    for (const text of ['git push origin main', 'git push origin other', 'git push --force origin main']) expect(push(h, text).outcome).toBe('DENIED')
    expect(h.requests).toHaveLength(1)
    expect(push(h, 'git push origin main', 'run-2').outcome).toBe('BOUNDARY_GRANT_REQUIRED')
  })
})

describe('what a one-time approval is bound to', () => {
  it('is the command itself: the same command described anew or given another time limit is the same action', () => {
    const first = actionHashOf('Bash', { command: 'git push origin HEAD', description: 'Push the branch', timeout: 60000 }, 'git push origin HEAD')
    expect(actionHashOf('Bash', { command: 'git push origin HEAD', description: 'Retry the push now that it is allowed', timeout: 120000, run_in_background: false }, 'git push origin HEAD')).toBe(first)
    expect(actionHashOf('Bash', { command: 'git push origin HEAD --force', description: 'Push the branch' }, 'git push origin HEAD')).not.toBe(first)
    expect(actionHashOf('Bash', { command: 'git push  origin HEAD' }, 'git push origin HEAD')).not.toBe(first)
    expect(actionHashOf('PowerShell', { command: 'git push origin HEAD' }, 'git push origin HEAD')).not.toBe(first)
  })
  it('for a tool without a command, its input, whatever the order of the keys; and the text of the action when there is no input', () => {
    expect(actionHashOf('WebFetch', { url: 'https://a.example/x', prompt: 'p' }, 'x')).toBe(actionHashOf('WebFetch', { prompt: 'p', url: 'https://a.example/x', description: 'again' }, 'y'))
    expect(actionHashOf('WebFetch', { url: 'https://a.example/y', prompt: 'p' }, 'x')).not.toBe(actionHashOf('WebFetch', { url: 'https://a.example/x', prompt: 'p' }, 'x'))
    expect(actionHashOf('Bash', {}, 'git push origin main')).toBe(actionHashOf('Bash', {}, 'git push origin main'))
    expect(actionHashOf('Bash', {}, 'git push origin main')).not.toBe(actionHashOf('Bash', {}, 'git push origin other'))
  })
})
