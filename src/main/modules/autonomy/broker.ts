import {
  AUTONOMY_CAPABILITIES,
  MAX_BOUNDARY_REQUESTS_PER_CAPABILITY,
  allowedScopes,
  capabilityKind,
  cleanAgentText,
  profileCapabilities,
  type AutonomyAuditEvent,
  type AutonomyCapability,
  type BoundaryDecision,
  type BoundaryRequest,
  type BrokerDecision,
  type CapabilityGrant,
  type CapabilityRequest,
  type CapabilityResource,
  type GrantScope,
  type ProjectEnrollment,
  type SecurityEventSeverity,
} from '@shared/autonomy'
import { newId } from '@shared/ids'
import { NexusError } from '@shared/result'
import { boundaryDedupeKey, describeResource, normalizeResource, resourceCovers } from './resource'
import { canRoleExercise } from './role-contract'

export interface GrantStorePort {
  insert(grant: CapabilityGrant): void
  /** Grants of the project that are neither revoked nor consumed. Expiry and mission are judged by the broker. */
  listUsable(projectId: string): CapabilityGrant[]
  /** Marks a ONCE grant used. False when another use got there first. */
  consume(id: string, at: string): boolean
  revoke(id: string, at: string): boolean
  get(id: string): CapabilityGrant | null
}

export interface BoundaryRequestStorePort {
  insert(request: BoundaryRequest): void
  /** The request with this key in any state, newest first. */
  findByKey(dedupeKey: string): BoundaryRequest | null
  /** Every request with this key, pending ones first and then newest first. */
  listByKey(dedupeKey: string): BoundaryRequest[]
  /** How many requests, in any state, the mission (or the project, when runId is null) put for this capability. */
  countForCapability(projectId: string, runId: string | null, capability: AutonomyCapability): number
  touch(id: string, at: string): void
  decide(id: string, state: 'GRANTED' | 'DENIED' | 'EXPIRED', at: string, scope: GrantScope | null, grantId: string | null): boolean
  get(id: string): BoundaryRequest | null
  listPending(projectId?: string): BoundaryRequest[]
}

export interface CapabilityBrokerDeps {
  enrollment: (projectId: string) => ProjectEnrollment | null
  grants: GrantStorePort
  requests: BoundaryRequestStorePort
  /** Whether a mission is still under way: a MISSION grant ends with it. */
  runActive: (runId: string) => boolean
  audit: (event: Omit<AutonomyAuditEvent, 'seq'>) => void
  /** Told when a request is created or decided (the inbox count, one notification). Never throws into the broker. */
  onBoundaryChange?: (request: BoundaryRequest, change: 'created' | 'decided') => void
  /** Runs a read-then-write as one unit. */
  transaction: <T>(fn: () => T) => T
  now?: () => number
}

/** What a resource must be for a profile capability to be inside the project's boundary without a look at grants. */
export interface BoundaryFacts {
  /** The roots the task may write: its worktree and its temporary roots, canonical. */
  writableRoots: string[]
  /** The roots it may read: the above and the project. */
  readableRoots: string[]
}

const NEVER_REASON: Partial<Record<AutonomyCapability, string>> = {
  ACCESS_PROVIDER_SECRETS: 'Provider credentials stay with NEXUS and its provider adapters. No grant exists for this.',
  ACCESS_NEXUS_CONTROL_PLANE: "NEXUS's runtime, database and keys are not available to anything an agent runs. No grant exists for this.",
  PERSONAL_BROWSER_PROFILE: "NEXUS does not use the user's own browser profile. No grant exists for this.",
  ALTER_SECURITY_POLICY: 'Only the user changes a profile, a grant or the security policy, in the NEXUS window.',
  DISABLE_SECURITY_SOFTWARE: 'Security software is never disabled or reconfigured by an agent. No grant exists for this.',
  HOST_POWER: 'Power is controlled by the Overnight authorization alone. No grant exists for this.',
}

/**
 * The capability broker. Every consequential operation asks it, and it answers from data the user set: the
 * project's profile, the grants, and rules that hold whatever those say. It never asks a model, and nothing
 * it reads was written by one. AUTHORIZED means go; DENIED means no, with no question to follow;
 * BOUNDARY_GRANT_REQUIRED means one question for the user exists, new or already there.
 */
export class CapabilityBroker {
  constructor(private readonly deps: CapabilityBrokerDeps) {}

  private iso(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString()
  }

  private record(request: CapabilityRequest, severity: SecurityEventSeverity, decision: BrokerDecision, authorizedBy: string | null, reason: string): void {
    try {
      this.deps.audit({
        id: newId(),
        timestamp: this.iso(),
        projectId: request.projectId,
        runId: request.runId,
        taskId: request.taskId,
        agentId: request.actor.agentId,
        severity,
        capability: request.capability,
        outcome: decision.outcome,
        authorizedBy,
        action: request.action,
        resource: describeResource(normalizeResource(request.resource)),
        reason,
      })
    } catch {
      // The log is evidence, not a gate: a failure to write it must not change the decision.
    }
  }

  private usableGrant(request: CapabilityRequest, resource: CapabilityResource): CapabilityGrant | null {
    const now = this.deps.now?.() ?? Date.now()
    // The narrowest scope first: a ONCE grant given for this need is used before a standing one is leaned on.
    const order: GrantScope[] = ['ONCE', 'MISSION', 'PROJECT']
    const candidates = this.deps.grants
      .listUsable(request.projectId)
      .filter((g) => g.capability === request.capability && g.revokedAt === null && g.consumedAt === null)
      .filter((g) => g.expiresAt === null || Date.parse(g.expiresAt) > now)
      .filter((g) => g.scope === 'PROJECT' || (g.runId !== null && g.runId === request.runId && this.deps.runActive(g.runId)))
      .filter((g) => resourceCovers(g.resource, resource))
      .sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope))
    for (const grant of candidates) {
      if (grant.scope !== 'ONCE') return grant
      // "Once" is for the action the user was shown, and for no other that happens to need the same capability:
      // a push to another remote, a request to another host. A different action is a new question. The action is
      // compared by the hash of the whole call, not by the text shown (redacted, shortened, whitespace collapsed),
      // and a grant whose request is gone, or was made before the hash existed, covers nothing: it fails closed.
      const shown = grant.requestId !== null ? this.deps.requests.get(grant.requestId) : null
      if (shown === null || !shown.actionHash || !request.actionHash || shown.actionHash !== request.actionHash) continue
      if (this.deps.grants.consume(grant.id, this.iso())) return grant
    }
    return null
  }

  /**
   * Decides one request. `inBoundary` says whether the resource lies inside what the profile covers (a path in
   * the task roots, a public host for research, a registered local endpoint): the caller establishes it from
   * facts it owns, never from the actor's description of itself.
   */
  decide(raw: CapabilityRequest, inBoundary: boolean): BrokerDecision {
    // What an agent wrote is stored and shown without the characters that reorder or hide text.
    const request: CapabilityRequest = { ...raw, resource: normalizeResource(raw.resource), action: cleanAgentText(raw.action) }
    const capability = request.capability
    const kind = capabilityKind(capability)
    const deny = (reason: string, severity: SecurityEventSeverity = 'POLICY_DENIAL'): BrokerDecision => {
      const decision: BrokerDecision = { outcome: 'DENIED', capability, reason }
      this.record(request, severity, decision, null, reason)
      return decision
    }

    if (kind === 'NEVER') {
      const severity: SecurityEventSeverity = capability === 'ACCESS_PROVIDER_SECRETS' || capability === 'ACCESS_NEXUS_CONTROL_PLANE' ? 'CREDENTIAL_ACCESS_ATTEMPT' : 'POLICY_DENIAL'
      return deny(NEVER_REASON[capability] ?? 'No grant exists for this.', severity)
    }
    if (!canRoleExercise({ kind: request.actor.kind, role: request.actor.role }, capability)) {
      return deny(`The ${request.actor.role ?? request.actor.kind.toLowerCase()} role is not one that can ${AUTONOMY_CAPABILITIES[capability].label.toLowerCase()}.`)
    }
    const enrollment = this.deps.enrollment(request.projectId)
    if (enrollment === null) return deny('This project is not enrolled for autonomous work.')

    if (kind === 'PROFILE') {
      // A profile capability is about resources inside the project's boundary. Outside it the need is another
      // capability (a write outside the roots, a host that is not public), which the caller asks for by its
      // own name; no grant of this one stretches that far.
      if (!inBoundary) return deny(`${AUTONOMY_CAPABILITIES[capability].label}: ${describeResource(request.resource)} is outside what this capability covers.`)
      if (profileCapabilities(enrollment.profile).has(capability)) {
        const decision: BrokerDecision = { outcome: 'AUTHORIZED', by: 'PROFILE', grantId: null, capability }
        this.record(request, 'NORMAL_AUTONOMOUS_ACTION', decision, enrollment.profile, request.reason)
        return decision
      }
    }

    return this.deps.transaction(() => {
      const grant = this.usableGrant(request, request.resource)
      if (grant !== null) {
        const decision: BrokerDecision = { outcome: 'AUTHORIZED', by: 'GRANT', grantId: grant.id, capability }
        this.record(request, 'NORMAL_AUTONOMOUS_ACTION', decision, grant.id, request.reason)
        return decision
      }
      if (allowedScopes(capability).length === 0) return deny('No grant exists for this.')

      const key = boundaryDedupeKey({ projectId: request.projectId, runId: request.runId, capability, resource: request.resource })
      const known = this.deps.requests.listByKey(key)
      const at = this.iso()
      // A denial is final for the mission, for any action of this capability and resource: the agent does not get to ask again in other words.
      const denied = known.find((r) => r.state === 'DENIED')
      if (denied !== undefined) {
        return deny(`The user denied this for the mission (boundary request ${denied.id}). It is not asked again.`)
      }
      // The same action tried again is one question. A different action of the same need is another question: the user sees each of them.
      // A capability the profile merely withholds (installing dependencies) is one question for the project whatever the command: its answer covers them all.
      const existing = known.find((r) => r.state === 'PENDING' && (kind === 'PROFILE' || (r.actionHash ?? null) === (request.actionHash ?? null)))
      if (existing !== undefined) {
        this.deps.requests.touch(existing.id, at)
        const decision: BrokerDecision = { outcome: 'BOUNDARY_GRANT_REQUIRED', capability, requestId: existing.id, deduplicated: true, reason: existing.reason }
        // The same need met again is not a second event for the user; it is counted on the request.
        return decision
      }
      if (this.deps.requests.countForCapability(request.projectId, request.runId, capability) >= MAX_BOUNDARY_REQUESTS_PER_CAPABILITY) {
        return deny(`${MAX_BOUNDARY_REQUESTS_PER_CAPABILITY} different boundary requests for "${AUTONOMY_CAPABILITIES[capability].label}" have been put to the user in this mission; the limit was reached and no further question is asked. Finish what does not depend on it.`)
      }
      // GRANTED with nothing usable left (a ONCE grant that was used, a revoked one) or EXPIRED: a new question.
      const reason = `${AUTONOMY_CAPABILITIES[capability].label} is outside what the ${enrollment.profile} profile of this project allows.`
      const created: BoundaryRequest = {
        id: newId(),
        projectId: request.projectId,
        runId: request.runId,
        taskId: request.taskId,
        agentId: request.actor.agentId,
        capability,
        resource: request.resource,
        action: request.action,
        actionHash: request.actionHash ?? null,
        reason,
        dedupeKey: key,
        state: 'PENDING',
        occurrences: 1,
        createdAt: at,
        lastSeenAt: at,
        decidedAt: null,
        decidedScope: null,
        grantId: null,
      }
      this.deps.requests.insert(created)
      const decision: BrokerDecision = { outcome: 'BOUNDARY_GRANT_REQUIRED', capability, requestId: created.id, deduplicated: false, reason }
      this.record(request, 'BOUNDARY_REQUEST', decision, null, reason)
      this.notify(created, 'created')
      return decision
    })
  }

  private notify(request: BoundaryRequest, change: 'created' | 'decided'): void {
    try {
      this.deps.onBoundaryChange?.(request, change)
    } catch {
      // A listener's failure is not the broker's.
    }
  }

  /**
   * The user's answer. Only the NEXUS window calls this, through a channel no agent session can reach. A
   * PROJECT grant also answers every other pending request of the project that it covers.
   */
  resolve(decision: BoundaryDecision): { request: BoundaryRequest; grant: CapabilityGrant | null; alsoResolved: string[] } {
    return this.deps.transaction(() => {
      const request = this.deps.requests.get(decision.requestId)
      if (request === null) throw new NexusError('not_found', 'There is no such boundary request.')
      if (request.state !== 'PENDING') throw new NexusError('invalid_state','This boundary request was already decided.')
      const at = this.iso()
      if (decision.decision === 'DENY') {
        this.deps.requests.decide(request.id, 'DENIED', at, null, null)
        const denied = { ...request, state: 'DENIED' as const, decidedAt: at }
        this.notify(denied, 'decided')
        return { request: denied, grant: null, alsoResolved: [] }
      }
      const scope: GrantScope = decision.decision === 'ALLOW_ONCE' ? 'ONCE' : decision.decision === 'ALLOW_MISSION' ? 'MISSION' : 'PROJECT'
      if (!allowedScopes(request.capability).includes(scope)) throw new NexusError('invalid_input', `This cannot be allowed with the scope ${scope}.`)
      if (scope !== 'PROJECT' && request.runId === null) throw new NexusError('invalid_input', 'This request belongs to no mission; it can only be allowed for the project.')
      const grant: CapabilityGrant = {
        id: newId(),
        projectId: request.projectId,
        capability: request.capability,
        scope,
        runId: scope === 'PROJECT' ? null : request.runId,
        resource: request.resource,
        createdBy: 'USER',
        createdAt: at,
        expiresAt: null,
        reason: request.reason,
        requestId: request.id,
        consumedAt: null,
        revokedAt: null,
      }
      this.deps.grants.insert(grant)
      this.deps.requests.decide(request.id, 'GRANTED', at, scope, grant.id)
      const granted = { ...request, state: 'GRANTED' as const, decidedAt: at, decidedScope: scope, grantId: grant.id }
      const alsoResolved: string[] = []
      if (scope === 'PROJECT') {
        for (const other of this.deps.requests.listPending(request.projectId)) {
          if (other.id === request.id || other.capability !== request.capability || !resourceCovers(grant.resource, other.resource)) continue
          if (this.deps.requests.decide(other.id, 'GRANTED', at, scope, grant.id)) {
            alsoResolved.push(other.id)
            this.notify({ ...other, state: 'GRANTED', decidedAt: at, decidedScope: scope, grantId: grant.id }, 'decided')
          }
        }
      }
      this.notify(granted, 'decided')
      return { request: granted, grant, alsoResolved }
    })
  }

  /** The user takes a grant back. What it authorized already is not undone. */
  revoke(grantId: string): boolean {
    return this.deps.grants.revoke(grantId, this.iso())
  }

  /** Pending requests of a mission that ended: nobody is waiting for them any more. */
  expireForRun(runId: string): number {
    let n = 0
    const at = this.iso()
    for (const request of this.deps.requests.listPending()) {
      if (request.runId !== runId) continue
      if (this.deps.requests.decide(request.id, 'EXPIRED', at, null, null)) {
        n += 1
        this.notify({ ...request, state: 'EXPIRED', decidedAt: at }, 'decided')
      }
    }
    return n
  }
}
