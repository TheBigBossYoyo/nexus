import { AUTONOMY_CAPABILITIES, profileSummary, type AutonomyProfile } from '@shared/autonomy'
import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { AutonomyService } from '@main/modules/autonomy/service'
import { describeResource } from '@main/modules/autonomy/resource'

type AutonomyChannel = Extract<IpcChannel, `autonomy.${string}`>
export type AutonomyHandlers = { [C in AutonomyChannel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

export interface AutonomyHandlerContext {
  autonomy: AutonomyService
  projectName: (projectId: string) => string | null
  /**
   * A native confirmation shown by the runtime itself before authority is given that lasts: enrolling a
   * project, and allowing something for a project for good. A client of the pipe cannot answer it. Absent
   * (tests of the handlers), the change is made without a question.
   */
  confirm?: (title: string, message: string, detail: string, accept: string) => Promise<boolean>
}

const PROFILE_NAMES: Record<AutonomyProfile, string> = { AUTONOMOUS_PROJECT: 'Autonomous project', BALANCED: 'Balanced', LOCKED_DOWN: 'Locked down' }

/** The text of the one-time enrollment confirmation: what NEXUS will do without asking, and what it will not. */
export function enrollmentDetail(profile: AutonomyProfile): string {
  const { allowed, withheld } = profileSummary(profile)
  return [
    'In this project NEXUS will, without asking again:',
    ...allowed.map((line) => `  • ${line}`),
    '',
    'It will not, without a separate decision of yours:',
    ...withheld.slice(0, 14).map((line) => `  • ${line}`),
    '',
    'It never reads provider credentials, reaches its own runtime from project code, uses your browser profile, or controls power.',
  ].join('\n')
}

/**
 * 0.8 autonomy channels. The two that give authority (`enroll`, and `resolve` with a grant for the whole
 * project) are confirmed natively by the runtime; the others read. None is reachable from an agent session:
 * a session has no channel to the runtime but the calls of its own tools.
 */
export function createAutonomyHandlers(ctx: AutonomyHandlerContext): AutonomyHandlers {
  const { autonomy } = ctx
  return {
    'autonomy.status': () => ({ pendingBoundaryRequests: autonomy.pendingCount() }),
    'autonomy.overview': ({ projectId, considering }) => autonomy.overview(projectId, considering),
    'autonomy.enroll': async ({ projectId, profile }) => {
      const name = ctx.projectName(projectId)
      if (name === null) throw new NexusError('not_found', 'There is no such project.')
      const current = autonomy.enrollment(projectId)
      // Narrowing needs no confirmation; the same profile again is not a change.
      const widening = current === null || (current.profile !== profile && (profile === 'AUTONOMOUS_PROJECT' || current.profile === 'LOCKED_DOWN'))
      if (widening && ctx.confirm && !(await ctx.confirm('Enable autonomous work', `Let NEXUS work in "${name}" under the profile "${PROFILE_NAMES[profile]}"?`, enrollmentDetail(profile), 'Enable'))) {
        throw new NexusError('invalid_state', 'The profile was not changed: the confirmation was declined.')
      }
      return autonomy.enroll(projectId, profile)
    },
    'autonomy.unenroll': ({ projectId }) => ({ removed: autonomy.unenroll(projectId) }),
    'autonomy.pending': ({ projectId }) => autonomy.pending(projectId),
    'autonomy.recent': ({ projectId, limit }) => autonomy.recent(limit ?? 50, projectId),
    'autonomy.resolve': async (decision) => {
      if (decision.decision === 'ALLOW_PROJECT' && ctx.confirm) {
        const request = autonomy.pending().find((r) => r.id === decision.requestId)
        if (request === undefined) throw new NexusError('not_found', 'There is no such pending boundary request.')
        const detail = `${AUTONOMY_CAPABILITIES[request.capability].label}\n${describeResource(request.resource)}\n\nThis holds for every later mission in the project until you take it back in Settings, Autonomy.`
        if (!(await ctx.confirm('Always allow for this project', `Always allow this in "${request.projectName}"?`, detail, 'Always allow'))) {
          throw new NexusError('invalid_state', 'Nothing was allowed: the confirmation was declined. The request is still pending.')
        }
      }
      const result = autonomy.resolve(decision)
      return { requestId: result.request.id, state: result.request.state, grantId: result.grant?.id ?? null, alsoResolved: result.alsoResolved }
    },
    'autonomy.revokeGrant': ({ grantId }) => ({ revoked: autonomy.revokeGrant(grantId) }),
    'autonomy.audit': (input) => autonomy.audit(input),
  }
}
