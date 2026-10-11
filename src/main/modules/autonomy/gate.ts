import { AUTONOMY_CAPABILITIES, type ActorKind, type BrokerDecision, type CapabilityRequest } from '@shared/autonomy'
import type { AgentRole } from '@shared/domain'
import type { TrustClass } from '@shared/security'
import type { ToolDecision, ToolRequest } from '@main/modules/agent-runtime/types'
import type { CapabilityBroker } from './broker'
import type { CapabilityNeed } from './tool-capabilities'

/**
 * What the tool authorizer of an enrolled project asks instead of asking the user. It is given the needs of one
 * tool call and answers allow or deny; it never answers "ask". A need that is outside the project's boundary
 * becomes a boundary request (one per need), and the call is refused with that request's id, so the agent goes
 * on with other work and the user finds one question in the inbox.
 */
export interface AutonomyGate {
  /** Whether this session's shell commands run inside the ISOLATED execution profile. */
  readonly contained: boolean
  /** Whether they run inside any containment (RESTRICTED included): writes held to the task's directories, environment an allowlist. */
  readonly confined: boolean
  resolve(request: ToolRequest, action: string, needs: CapabilityNeed[], trust?: TrustClass): ToolDecision
}

export interface AutonomyGateContext {
  broker: CapabilityBroker
  projectId: string
  runId: string | null
  taskId: string | null
  role: AgentRole
  provider: string | null
  cwd: string | null
  contained: boolean
  confined?: boolean
}

const ACTOR_OF_ROLE: Record<AgentRole, ActorKind> = {
  worker: 'WORKER',
  debugger: 'WORKER',
  reviewer: 'VERIFIER',
  verifier: 'VERIFIER',
  planner: 'PLANNER',
  architect: 'PLANNER',
  researcher: 'PLANNER',
  security_reviewer: 'VERIFIER',
}

/** What an agent is told when its call met a boundary. It names the request and says what to do meanwhile. */
export function boundaryMessage(decisions: Extract<BrokerDecision, { outcome: 'BOUNDARY_GRANT_REQUIRED' }>[]): string {
  const list = decisions.map((d) => `${AUTONOMY_CAPABILITIES[d.capability].label} (boundary request ${d.requestId})`).join('; ')
  return (
    `Not done: this is outside what the project allows without the user's decision. NEXUS has put the question to the user: ${list}. ` +
    'Do not retry it and do not look for another way to the same effect. Go on with the work that does not depend on it. ' +
    'If nothing else is left, report a blocker that names the boundary request; the task is resumed when the user has decided.'
  )
}

export function createAutonomyGate(ctx: AutonomyGateContext): AutonomyGate {
  return {
    contained: ctx.contained,
    confined: ctx.confined === true || ctx.contained,
    resolve(request, action, needs, trust = 'UNTRUSTED_AGENT_AUTHORED') {
      const decisions: BrokerDecision[] = []
      for (const need of needs) {
        const capabilityRequest: CapabilityRequest = {
          capability: need.capability,
          actor: { kind: ACTOR_OF_ROLE[ctx.role], agentId: request.agentId, role: ctx.role },
          projectId: ctx.projectId,
          runId: ctx.runId,
          taskId: ctx.taskId,
          resource: need.resource,
          trustClass: trust,
          provider: ctx.provider,
          executable: null,
          args: [],
          cwd: ctx.cwd,
          networkTarget: need.resource.kind === 'HOST' ? need.resource.value : null,
          action: action.slice(0, 400),
          reason: need.why.slice(0, 400),
        }
        const decision = ctx.broker.decide(capabilityRequest, need.inBoundary)
        decisions.push(decision)
        // A refusal ends it: no question is put for the other needs of a call that will not run anyway.
        if (decision.outcome === 'DENIED') return { behavior: 'deny', reason: `Denied: ${decision.reason} This cannot be approved; choose a different approach.` }
      }
      const waiting = decisions.filter((d): d is Extract<BrokerDecision, { outcome: 'BOUNDARY_GRANT_REQUIRED' }> => d.outcome === 'BOUNDARY_GRANT_REQUIRED')
      if (waiting.length > 0) return { behavior: 'deny', reason: boundaryMessage(waiting), boundaryRequests: waiting.map((d) => d.requestId) }
      return { behavior: 'allow' }
    },
  }
}
