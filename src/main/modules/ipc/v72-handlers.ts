import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { Repositories } from '@main/modules/persistence'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { NexusError } from '@shared/result'
import { DirectorGateway, RETRIABLE_ESCALATION } from '@main/modules/intelligence/gateway'
import type { GitService } from '@main/modules/git'
import { IntelligenceOperations } from '../intelligence/operations'
import { adviceLearning, learningEvidence } from '../intelligence/outcomes'
import { TaskAdmissionService } from '../intelligence/admission'
import type { AdvisoryRoutingService } from '../intelligence/routing'

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
  routing?: AdvisoryRoutingService,
): V72Handlers {
  const director = new DirectorGateway(repos.intelligenceArtifacts, routing)
  const chatgpt = () => {
    if (!connection)
      throw new NexusError(
        'runtime_unavailable',
        'ChatGPT connection is unavailable in this runtime',
      )
    return connection
  }
  return {
    'director.invoke': ({ projectId, objective, level, escalationId }) =>
      operations.run(() => {
        repos.projects.require(projectId)
        // The Technical Director is Claude, which the project already works with. The strategic levels send the
        // objective and project knowledge to the strategic provider, which this project may be kept away from.
        if (level >= 2 && !admission.sendsToStrategicProvider(projectId))
          throw new NexusError('invalid_state', 'This project is set not to send to OpenAI. Ask the Technical Director, or change the setting of the project in its mission composer.')
        const strategic = connection?.provider()
        const status = connection?.status()
        return director.invoke({
          projectId,
          objective,
          level,
          reasons: ['USER_SELECTED_LEVEL'],
          // With the project's knowledge: what became of the missions earlier advice was given to.
          context: level === 0 ? [] : [...admission.retrieve(projectId, objective), ...[learningEvidence(repos, projectId)].filter((item) => item !== null)],
          // Level 1 is the Technical Director alone: nothing is asked of the strategic provider, and the record
          // of a request must not name a provider it never called.
          provider: strategic && level >= 2 ? 'openai' : null,
          model: strategic && level >= 2 ? (status?.model ?? null) : null,
          ...(strategic ? { strategic } : {}),
          ...(escalationId ? { escalationId } : {}),
        })
      }),
    'director.escalate': (input) => {
      repos.projects.require(input.projectId)
      if (input.runId) {
        const run = repos.runs.require(input.runId)
        if (run.projectId !== input.projectId)
          throw new NexusError('invalid_input', 'Escalation workload belongs to another project')
      }
      if (input.taskId && (!input.runId || repos.tasks.require(input.taskId).runId !== input.runId))
        throw new NexusError('invalid_input', 'Escalation task belongs to another workload')
      return director.escalate({
        ...input,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
      })
    },
    'director.learning': ({ projectId }) => {
      repos.projects.require(projectId)
      return adviceLearning(repos, projectId)
    },
    'director.records': ({ projectId, offset }) => {
      repos.projects.require(projectId)
      return repos.intelligenceArtifacts.directorRecords(projectId, offset)
    },
    'director.dismissEscalation': ({ projectId, escalationId }) => {
      repos.projects.require(projectId)
      const record = repos.intelligenceArtifacts.directorRecord(projectId, escalationId)
      if (record?.kind !== 'ESCALATION' || !RETRIABLE_ESCALATION.includes(record.state))
        throw new NexusError('invalid_state', 'Only an escalation that is not running and not finished can be dismissed')
      const dismissed = {
        ...record,
        state: 'DISMISSED' as const,
        updatedAt: new Date().toISOString(),
      }
      repos.intelligenceArtifacts.saveDirectorRecord(dismissed)
      return dismissed
    },
    'director.routing': ({ projectId, operationId }) => {
      repos.projects.require(projectId)
      return repos.intelligenceArtifacts.routingHistory(projectId, operationId)
    },
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
    'compilation.decide': ({ projectId, specId, accept }) => {
      repos.projects.require(projectId)
      return admission.decide(projectId, specId, accept)
    },
    'compilation.projectSending': ({ projectId }) => {
      repos.projects.require(projectId)
      return { allowed: admission.sendsToStrategicProvider(projectId) }
    },
    'compilation.setProjectSending': ({ projectId, allowed }) => ({ allowed: admission.setSendsToStrategicProvider(projectId, allowed) }),
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
