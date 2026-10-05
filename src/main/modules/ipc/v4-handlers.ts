import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { PROGRAM_POLICY_PRESETS, type ProgramPolicy } from '@shared/program'
import { NexusError } from '@shared/result'
import type { Repositories } from '@main/modules/persistence'
import type { BackgroundEngineering, ProgramEngine } from '@main/modules/program'

type V4Channel = Extract<IpcChannel, `program.${string}` | `backlog.${string}` | `background.${string}` | `expertise.${string}`>
export type V4Handlers = { [C in V4Channel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

export interface V4Context {
  repos: Repositories
  programs?: ProgramEngine
  background?: BackgroundEngineering
}

/** v0.4 channels: programs, backlog, background engineering, expertise. */
export function createV4Handlers(ctx: V4Context): V4Handlers {
  const { repos } = ctx
  const programs = (): ProgramEngine => {
    if (!ctx.programs) throw new NexusError('runtime_unavailable', 'Programs are not available in this process')
    return ctx.programs
  }
  const background = (): BackgroundEngineering => {
    if (!ctx.background) throw new NexusError('runtime_unavailable', 'Background engineering is not available in this process')
    return ctx.background
  }
  return {
    'program.list': ({ projectId, limit, offset }) => programs().list({ ...(projectId ? { projectId } : {}), ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) }),
    'program.get': ({ programId }) => programs().detail(programId),
    'program.presets': () => PROGRAM_POLICY_PRESETS,
    'program.create': ({ projectId, name, goal, successCriteria, constraints, preset, policy, schedule, start }) => {
      // A custom policy is used as given (already validated by the channel schema); otherwise the preset.
      const chosen: ProgramPolicy = policy ?? PROGRAM_POLICY_PRESETS[preset]
      return programs().create({
        projectId,
        name,
        goal,
        policy: chosen,
        ...(successCriteria ? { successCriteria } : {}),
        ...(constraints ? { constraints } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(start !== undefined ? { start } : {}),
      })
    },
    'program.start': ({ programId }) => programs().start(programId),
    'program.pause': ({ programId }) => programs().pause(programId),
    'program.resume': ({ programId }) => programs().resume(programId),
    'program.cancel': ({ programId }) => programs().cancel(programId),
    'program.decidePlan': ({ programId, revisionId, accept }) => programs().decidePlan(programId, revisionId, accept),
    'program.replan': ({ programId, note }) => programs().requestUserReplan(programId, note),
    'backlog.list': ({ projectId, programId, statuses, limit, offset }) =>
      repos.backlog.list({ ...(projectId ? { projectId } : {}), ...(programId ? { programId } : {}), ...(statuses ? { statuses } : {}), ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) }),
    'backlog.setStatus': ({ itemId, status }) => programs().setBacklogStatus(itemId, status),
    'background.settings': () => background().settings(),
    'background.setSettings': ({ settings }) => background().setSettings(settings),
    'background.jobs': ({ projectId }) => background().list(projectId),
    'background.start': ({ projectId, kind }) => background().start(projectId, kind),
    'background.cancel': ({ jobId }) => background().cancel(jobId),
    'expertise.list': ({ projectId }) => repos.expertise.listByProject(projectId),
  }
}

export function unavailableV4Handlers(): V4Handlers {
  return createV4Handlers({ repos: new Proxy({}, { get: () => new Proxy({}, { get: () => () => [] }) }) as unknown as Repositories })
}
