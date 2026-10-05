import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { WorkspaceEngine } from '@main/modules/workspace'

type V5Channel = Extract<IpcChannel, `workspace.${string}`>
export type V5Handlers = { [C in V5Channel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

export interface V5Context {
  workspaces?: WorkspaceEngine
  /** The native folder picker; enrolling a repository is always an explicit choice of the user. */
  pickDirectory?: () => Promise<string | null>
}

/** v0.5 channels: workspaces, enrolled repositories, the organization graph, contracts, cross-repository missions, release trains. */
export function createV5Handlers(ctx: V5Context): V5Handlers {
  const engine = (): WorkspaceEngine => {
    if (!ctx.workspaces) throw new NexusError('runtime_unavailable', 'Workspaces are not available in this process')
    return ctx.workspaces
  }
  return {
    'workspace.list': () => (ctx.workspaces ? ctx.workspaces.list() : []),
    'workspace.get': ({ workspaceId }) => engine().detail(workspaceId),
    'workspace.create': ({ name, description }) => engine().createWorkspace({ name, ...(description !== undefined ? { description } : {}) }),
    'workspace.setPolicy': ({ workspaceId, policy }) => engine().setPolicy(workspaceId, policy),
    'workspace.remove': ({ workspaceId }) => {
      engine().removeWorkspace(workspaceId)
      return null
    },
    'workspace.enroll': async ({ workspaceId, path, key, role }) => {
      const target = path ?? (await ctx.pickDirectory?.()) ?? null
      if (!target) return null
      return engine().enroll(workspaceId, { path: target, ...(key !== undefined ? { key } : {}), ...(role !== undefined ? { role } : {}) })
    },
    'workspace.refresh': ({ repositoryId }) => engine().refresh(repositoryId),
    'workspace.unenroll': ({ repositoryId }) => {
      engine().unenroll(repositoryId)
      return null
    },
    'workspace.setRole': ({ repositoryId, role }) => engine().setRole(repositoryId, role),
    'workspace.discover': ({ workspaceId }) => engine().discover(workspaceId),
    'workspace.addDependency': ({ workspaceId, from, to, kind, detail }) => engine().addDependency(workspaceId, { from, to, kind, detail }),
    'workspace.removeDependency': ({ dependencyId }) => {
      engine().removeDependency(dependencyId)
      return null
    },
    'workspace.addService': ({ repositoryId, name, description }) => engine().addService(repositoryId, { name, description }),
    'workspace.registerContract': ({ workspaceId, key, name, kind, provider, path }) => engine().registerContract(workspaceId, { key, name, kind, provider, path }),
    'workspace.addConsumer': ({ contractId, repository, copyPath }) => engine().addConsumer(contractId, { repository, copyPath: copyPath ?? null }),
    'workspace.captureContract': async ({ contractId }) => {
      const captured = await engine().captureContract(contractId, null)
      return { version: captured.version, result: captured.result, created: captured.created }
    },
    'workspace.addMemory': ({ workspaceId, kind, title, content, evidence, repositories }) => engine().addMemory(workspaceId, { kind, title, content, evidence, repositories }),
    'workspace.createMission': ({ workspaceId, goal, start }) => engine().createMission(workspaceId, { goal, ...(start !== undefined ? { start } : {}) }),
    'workspace.mission': ({ missionId }) => engine().missionDetail(missionId),
    'workspace.startMission': ({ missionId }) => engine().startMission(missionId),
    'workspace.decidePlan': ({ missionId, accept }) => engine().decidePlan(missionId, accept),
    'workspace.pauseMission': ({ missionId }) => engine().pauseMission(missionId),
    'workspace.resumeMission': ({ missionId }) => engine().resumeMission(missionId),
    'workspace.cancelMission': ({ missionId }) => engine().cancelMission(missionId),
    'workspace.createProgram': async ({ workspaceId, program, start }) => {
      const created = engine().createProgram(workspaceId, program)
      return start ? engine().startProgram(created.id) : created
    },
    'workspace.startProgram': ({ programId }) => engine().startProgram(programId),
    'workspace.resumeProgram': ({ programId }) => engine().resumeProgram(programId),
    'workspace.cancelProgram': ({ programId }) => engine().cancelProgram(programId),
    'workspace.prepareRelease': ({ missionId }) => engine().prepareReleaseTrain(missionId),
    // Always refused: NEXUS prepares releases and does not publish them. The channel exists so the refusal is explicit and recorded.
    'workspace.publishRelease': ({ trainId }) => engine().publishReleaseTrain(trainId),
    'workspace.cancelRelease': ({ trainId }) => engine().cancelReleaseTrain(trainId),
  }
}

export function unavailableV5Handlers(): V5Handlers {
  return createV5Handlers({})
}
