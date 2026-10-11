import {
  AUTONOMY_CAPABILITIES,
  AUTONOMY_POLICY_VERSION,
  BOUNDARY_RESUME_ACTION,
  allowedScopes,
  boundaryResumeResource,
  profileSummary,
  unattendedPolicy,
  type AutonomyAuditEvent,
  type AutonomyOverview,
  type AutonomyProfile,
  type BoundaryRequestView,
  type BoundaryDecision,
  type BoundaryRequest,
  type CapabilityGrant,
  type ProjectEnrollment,
  type SecurityEventSeverity,
} from '@shared/autonomy'
import type { AgentRole } from '@shared/domain'
import { newId } from '@shared/ids'
import { NexusError } from '@shared/result'
import type { Repositories } from '@main/modules/persistence'
import { CapabilityBroker } from './broker'
import { createAutonomyGate, type AutonomyGate } from './gate'
import { describeResource } from './resource'

export interface AutonomyServiceDeps {
  repos: Repositories
  /** Whether a mission is still under way: a MISSION grant and a pending request end with it. */
  runActive: (runId: string) => boolean
  /**
   * Whether the commands of a session in this project run inside the ISOLATED execution profile. Asked when a
   * session starts. False means the broker treats what the policy cannot inspect as uncontained.
   */
  contained?: (projectId: string) => boolean
  /** Whether they run inside any containment that was verified, RESTRICTED included. */
  confined?: (projectId: string) => boolean
  /** The inbox changed: a request was created or decided, a grant given or taken back, a project enrolled. */
  onChange?: (change: { kind: 'request' | 'grant' | 'enrollment'; request?: BoundaryRequest; created?: boolean }) => void
  now?: () => number
}

/**
 * The autonomy of projects, as the runtime holds it: who is enrolled with which profile, the capability broker
 * over the stored grants and requests, and what the window needs to show and to answer. Nothing here is called
 * by an agent session: a session meets the broker only through the gate its authorizer was given.
 */
export class AutonomyService {
  readonly broker: CapabilityBroker

  constructor(private readonly deps: AutonomyServiceDeps) {
    const { repos } = deps
    this.broker = new CapabilityBroker({
      enrollment: (projectId) => repos.enrollments.get(projectId),
      grants: repos.capabilityGrants,
      requests: repos.boundaryRequests,
      runActive: deps.runActive,
      audit: (event) => repos.autonomyAudit.record(event),
      onBoundaryChange: (request, change) => this.changed({ kind: 'request', request, created: change === 'created' }),
      transaction: (fn) => repos.transaction(fn),
      ...(deps.now ? { now: deps.now } : {}),
    })
  }

  private changed(change: Parameters<NonNullable<AutonomyServiceDeps['onChange']>>[0]): void {
    try {
      this.deps.onChange?.(change)
    } catch {
      // A listener's failure is not the service's.
    }
  }

  private iso(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString()
  }

  enrollment(projectId: string): ProjectEnrollment | null {
    return this.deps.repos.enrollments.get(projectId)
  }

  /** The user's choice of a profile for a project. Called from the window only, after the summary was shown. */
  enroll(projectId: string, profile: AutonomyProfile): ProjectEnrollment {
    if (this.deps.repos.projects.get(projectId) === null) throw new NexusError('not_found', 'There is no such project.')
    const enrollment: ProjectEnrollment = { projectId, profile, enrolledAt: this.iso(), policyVersion: AUTONOMY_POLICY_VERSION }
    this.deps.repos.enrollments.set(enrollment)
    this.changed({ kind: 'enrollment' })
    return enrollment
  }

  /** Back to the approvals of 0.7. Grants are kept (they are the user's) and are not read while not enrolled. */
  unenroll(projectId: string): boolean {
    const removed = this.deps.repos.enrollments.remove(projectId)
    if (removed) this.changed({ kind: 'enrollment' })
    return removed
  }

  /**
   * The gate for one agent session, or undefined for a project that is not enrolled (its authorizer then asks
   * the user as before). Whether the session is contained is fixed here, when it starts.
   */
  gateFor(session: { projectId: string; runId: string | null; taskId: string | null; role: AgentRole; provider: string | null; cwd: string | null }): AutonomyGate | undefined {
    if (this.enrollment(session.projectId) === null) return undefined
    return createAutonomyGate({ broker: this.broker, ...session, contained: this.deps.contained?.(session.projectId) === true, confined: this.deps.confined?.(session.projectId) === true })
  }

  private view(request: BoundaryRequest): BoundaryRequestView {
    const { repos } = this.deps
    const run = request.runId !== null ? repos.runs.get(request.runId) : null
    return {
      ...request,
      capabilityLabel: AUTONOMY_CAPABILITIES[request.capability].label,
      resourceLabel: describeResource(request.resource),
      projectName: repos.projects.get(request.projectId)?.name ?? 'project',
      // A mission has no title of its own: the first line of what was asked, shortened.
      missionTitle: run ? (run.prompt.split(/\r?\n/, 1)[0] ?? '').trim().slice(0, 100) || null : null,
      // A request that belongs to no mission can only be answered for the project.
      scopes: allowedScopes(request.capability).filter((scope) => scope === 'PROJECT' || request.runId !== null),
      followUp: request.state === 'GRANTED' || request.state === 'DENIED' ? repos.autonomyAudit.latestReason(BOUNDARY_RESUME_ACTION, boundaryResumeResource(request.id)) : null,
    }
  }

  pending(projectId?: string): BoundaryRequestView[] {
    return this.deps.repos.boundaryRequests.listPending(projectId).map((r) => this.view(r))
  }

  pendingCount(): number {
    return this.deps.repos.boundaryRequests.countPending()
  }

  recent(limit = 50, projectId?: string): BoundaryRequestView[] {
    return this.deps.repos.boundaryRequests.listRecent(limit, projectId).map((r) => this.view(r))
  }

  /** The user's answer to a boundary request. */
  resolve(decision: BoundaryDecision): { request: BoundaryRequest; grant: CapabilityGrant | null; alsoResolved: string[] } {
    const result = this.broker.resolve(decision)
    if (result.grant !== null) this.changed({ kind: 'grant' })
    return result
  }

  revokeGrant(grantId: string): boolean {
    const revoked = this.broker.revoke(grantId)
    if (revoked) this.changed({ kind: 'grant' })
    return revoked
  }

  /** A mission ended: its pending requests have nobody waiting for them. */
  runEnded(runId: string): void {
    this.broker.expireForRun(runId)
  }

  /** Follows the missions: one that completed, failed or was cancelled takes its unanswered questions with it. */
  watch(bus: { subscribe(listener: (event: { type: string; runId: string }) => void): unknown }): void {
    bus.subscribe((event) => {
      if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') this.runEnded(event.runId)
    })
  }

  overview(projectId: string, considering?: AutonomyProfile): AutonomyOverview {
    const { repos } = this.deps
    const enrollment = this.enrollment(projectId)
    const profile = considering ?? enrollment?.profile ?? null
    const now = this.deps.now?.() ?? Date.now()
    const grants = repos.capabilityGrants.list(projectId).map((g) => ({
      ...g,
      capabilityLabel: AUTONOMY_CAPABILITIES[g.capability].label,
      resourceLabel: describeResource(g.resource),
      active: g.revokedAt === null && g.consumedAt === null && (g.expiresAt === null || Date.parse(g.expiresAt) > now) && (g.scope === 'PROJECT' || (g.runId !== null && this.deps.runActive(g.runId))),
    }))
    const denials: SecurityEventSeverity[] = ['POLICY_DENIAL', 'CREDENTIAL_ACCESS_ATTEMPT', 'ESCAPE_ATTEMPT', 'ISOLATION_FAILURE', 'INJECTION_DETECTED']
    return {
      enrollment,
      summary: profile === null ? null : profileSummary(profile),
      unattended: profile === null ? null : unattendedPolicy(profile),
      grants,
      pending: this.pending(projectId),
      recentDenials: repos.autonomyAudit.list({ projectId, severities: denials, limit: 30 }).events,
      counts: repos.autonomyAudit.counts({ projectId }),
      policyVersion: AUTONOMY_POLICY_VERSION,
      policyChanged: enrollment !== null && enrollment.policyVersion !== AUTONOMY_POLICY_VERSION,
    }
  }

  audit(opts: { projectId?: string; runId?: string; severities?: SecurityEventSeverity[]; limit?: number; before?: number }): { events: AutonomyAuditEvent[]; nextBefore: number | null } {
    return this.deps.repos.autonomyAudit.list(opts)
  }

  /** A finding that is not a broker decision: an injection taken out of a page, a containment that failed. Never throws. */
  record(event: { projectId: string | null; runId: string | null; taskId: string | null; agentId: string | null; severity: SecurityEventSeverity; action: string; resource: string; reason: string }): void {
    try {
      this.deps.repos.autonomyAudit.record({ id: newId(), timestamp: this.iso(), capability: null, outcome: null, authorizedBy: null, ...event })
    } catch {
      // The log is evidence, not a gate.
    }
  }

  /** What a mission cost the user in interruptions: the number the approval-spam gate reads. */
  missionMetrics(runId: string): { boundaryRequests: number; counts: Record<string, number> } {
    return { boundaryRequests: this.deps.repos.boundaryRequests.countForRun(runId), counts: this.deps.repos.autonomyAudit.counts({ runId }) }
  }
}
