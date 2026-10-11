import { existsSync, readFileSync, statSync } from 'node:fs'
import { AUTONOMY_CAPABILITIES, cleanAgentText, profileSummary, type AutonomyProfile } from '@shared/autonomy'
import type { AppSessionView, IsolationStatusView } from '@shared/isolation'
import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { AutonomyService } from '@main/modules/autonomy/service'
import { describeResource } from '@main/modules/autonomy/resource'

type AutonomyChannel = Extract<IpcChannel, `autonomy.${string}`>
type IsolationChannel = Extract<IpcChannel, `isolation.${string}`>
export type IsolationHandlers = { [C in IsolationChannel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

export interface IsolationHandlerContext {
  status: () => IsolationStatusView
  /** Starts the one-time setup. The caller has already asked the user; Windows asks once more for elevation. */
  setup: () => Promise<{ ok: boolean; detail: string }>
  confirm?: (title: string, message: string, detail: string, accept: string) => Promise<boolean>
  apps: () => { owner: { projectId: string; runId: string | null; taskId: string | null }; status: Omit<AppSessionView, 'projectId' | 'runId' | 'taskId' | 'screenshots'>; artifacts: string[] }[]
}

const SETUP_DETAIL = [
  'This is done once per machine and needs administrator rights: Windows will ask for them next.',
  '',
  'It creates:',
  '  \u2022 a local standard account, NexusSandbox, that is in none of your groups and cannot sign in interactively;',
  '  \u2022 the folder C:\\ProgramData\\NexusSandbox, where the worktrees of enrolled projects are kept;',
  '  \u2022 Windows Firewall rules that block all network traffic of that account.',
  '',
  'Project code then runs as that account: it cannot read your profile, your credentials or your other projects, and its only network is the filter NEXUS gives it.',
  'It changes nothing else, and it can be removed again.',
].join('\n')

/** 0.8 isolation channels. None is reachable from an agent session. */
export function createIsolationHandlers(ctx: IsolationHandlerContext): IsolationHandlers {
  return {
    'isolation.status': () => ctx.status(),
    'isolation.setup': async () => {
      if (!ctx.status().setupAvailable) throw new NexusError('invalid_state', 'This build cannot set up the sandbox account.')
      // The setup changes the machine: it is confirmed natively, and without a way to ask it is not done.
      if (!ctx.confirm || !(await ctx.confirm('Set up the isolated profile', 'Create the NEXUS sandbox account on this machine?', SETUP_DETAIL, 'Continue'))) {
        return { ok: false, detail: 'Nothing was changed: the setup was not confirmed.', status: ctx.status() }
      }
      const outcome = await ctx.setup()
      return { ...outcome, status: ctx.status() }
    },
    'isolation.apps': ({ projectId }) =>
      ctx
        .apps()
        .filter((a) => projectId === undefined || a.owner.projectId === projectId)
        .map((a) => ({ ...a.status, projectId: a.owner.projectId, runId: a.owner.runId, taskId: a.owner.taskId, screenshots: a.artifacts.length })),
    'isolation.appScreenshot': ({ appId, index }) => {
      const app = ctx.apps().find((a) => a.status.id === appId)
      const path = app ? app.artifacts[app.artifacts.length - 1 - (index ?? 0)] : undefined
      // Only a file the manager recorded for that session, read by the runtime: the window names no path.
      if (path === undefined || !existsSync(path)) return null
      const stat = statSync(path)
      if (stat.size > 8 * 1024 * 1024) return null
      return { dataUrl: `data:image/png;base64,${readFileSync(path).toString('base64')}`, takenAt: stat.mtime.toISOString() }
    },
  }
}
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
    'Where project code runs as the NEXUS sandbox account, that account is given read access to the Git data of this project (its .git folder) and may add to it for the branches of its own missions. This is taken back when you stop autonomous work here.',
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
      // No way to ask is a no: a widening that cannot be confirmed is not made.
      if (widening && (!ctx.confirm || !(await ctx.confirm('Enable autonomous work', `Let NEXUS work in "${name}" under the profile "${PROFILE_NAMES[profile]}"?`, enrollmentDetail(profile), 'Enable')))) {
        throw new NexusError('invalid_state', 'The profile was not changed: the confirmation was declined.')
      }
      return autonomy.enroll(projectId, profile)
    },
    'autonomy.unenroll': ({ projectId }) => ({ removed: autonomy.unenroll(projectId) }),
    'autonomy.pending': ({ projectId }) => autonomy.pending(projectId),
    'autonomy.recent': ({ projectId, limit }) => autonomy.recent(limit ?? 50, projectId),
    'autonomy.resolve': async (decision) => {
      if (decision.decision === 'ALLOW_PROJECT') {
        const request = autonomy.pending().find((r) => r.id === decision.requestId)
        if (request === undefined) throw new NexusError('not_found', 'There is no such pending boundary request.')
        const label = AUTONOMY_CAPABILITIES[request.capability].label
        // When the resource is not narrowed to one thing, the grant covers every action of this kind, not only the one shown.
        const covers = request.resource.kind === 'ANY' ? `This covers EVERY such action in the project, not only the one shown here: any "${label}", to any place, now and in every later mission.` : `This covers ${describeResource(request.resource)} in the project.`
        const detail = `${label}\n${describeResource(request.resource)}\n\nThe action shown to you:\n${cleanAgentText(request.action).slice(0, 400)}\n\n${covers}\nIt holds for every later mission in the project until you take it back in Settings, Autonomy.`
        // No way to ask is a no: a project-wide grant that cannot be confirmed is not made.
        if (!ctx.confirm || !(await ctx.confirm('Always allow for this project', `Always allow this in "${request.projectName}"?`, detail, 'Always allow'))) {
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
