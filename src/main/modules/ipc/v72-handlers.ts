import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { Repositories } from '@main/modules/persistence'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { NexusError } from '@shared/result'
import { DirectorGateway } from '@main/modules/intelligence/gateway'
import type { GitService } from '@main/modules/git'
import { IntelligenceOperations } from '../intelligence/operations'
import { TaskAdmissionService } from '../intelligence/admission'

type Channel = Extract<
  IpcChannel,
  `compilation.${string}` | `chatgpt.${string}` | `director.${string}`
>
export type V72Handlers = {
  [C in Channel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]>
}

/** User-entry preview only. Internal orchestrator tasks never recursively invoke this service. */
export function createV72Handlers(
  repos: Repositories,
  connection?: ChatGPTConnection,
  git?: GitService,
  operations = new IntelligenceOperations(),
  admission = new TaskAdmissionService(repos, git, connection, operations),
): V72Handlers {
  const director = new DirectorGateway(repos.intelligenceArtifacts)
  const chatgpt = () => {
    if (!connection)
      throw new NexusError(
        'runtime_unavailable',
        'ChatGPT connection is unavailable in this runtime',
      )
    return connection
  }
  return {
    'director.invoke': ({ projectId, objective, level }) =>
      operations.run(() => {
        repos.projects.require(projectId)
        const strategic = connection?.provider()
        const status = connection?.status()
        return director.invoke({
          projectId,
          objective,
          level,
          reasons: ['USER_SELECTED_LEVEL'],
          context: level === 0 ? [] : admission.retrieve(projectId, objective),
          provider: strategic ? 'openai' : null,
          model: status?.model ?? null,
          ...(strategic ? { strategic } : {}),
        })
      }),
    'director.history': ({ projectId, offset }) => {
      repos.projects.require(projectId)
      return repos.intelligenceArtifacts.listDirectors(projectId, offset)
    },
    'chatgpt.status': () =>
      connection?.status() ?? {
        state: 'STORAGE_UNAVAILABLE',
        profiles: [],
        activeProfile: null,
        model: null,
        models: [],
        error: 'Protected sign-in is unavailable in this runtime',
        includedOnlyConfirmed: false,
      },
    'chatgpt.connect': ({ profileId }) => chatgpt().connect(profileId),
    'chatgpt.select': ({ profileId }) => chatgpt().select(profileId),
    'chatgpt.models': () => operations.run(() => chatgpt().models()),
    'chatgpt.configure': ({ model, includedOnlyConfirmed }) =>
      chatgpt().configure(model, includedOnlyConfirmed),
    'chatgpt.disconnect': () => operations.run(() => chatgpt().disconnect()),
    'chatgpt.manageUsage': async () => {
      await chatgpt().manageUsage()
      return null
    },
    'compilation.preview': (input) => admission.preview(input),
    'compilation.admission': ({ kind, entityId }) => {
      if (kind === 'PROGRAM') repos.programs.require(entityId)
      else if (kind === 'WORKSPACE_MISSION') repos.workspaceMissions.require(entityId)
      else repos.workspacePrograms.require(entityId)
      return repos.intelligenceArtifacts.admission(kind, entityId)
    },
    'compilation.validate': ({ specId, ...input }) => admission.validate(input, specId),
    'compilation.history': ({ projectId, offset }) => {
      repos.projects.require(projectId)
      return repos.intelligenceArtifacts.listCompilations(projectId, offset)
    },
  }
}
