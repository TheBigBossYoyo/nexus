import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { ContextGraphService } from '@main/modules/context-graph'
import type { Repositories } from '@main/modules/persistence'
import { compileTask, compilerIdentity, assertFresh } from '@main/modules/intelligence/compiler'
import type { CompiledTaskSpec } from '@shared/intelligence'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { NexusError } from '@shared/result'
import { DirectorGateway } from '@main/modules/intelligence/gateway'
import type { GitService } from '@main/modules/git'
import { createHash } from 'node:crypto'
import { IntelligenceOperations } from '../intelligence/operations'

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
): V72Handlers {
  const graph = new ContextGraphService({ repos })
  const director = new DirectorGateway(repos.intelligenceArtifacts)
  const compiling = new Map<string, Promise<CompiledTaskSpec>>()
  const retrieve = (projectId: string, raw: string) =>
    graph
      .search(graph.spacesForProject(projectId), raw.slice(0, 500), { limit: 12 })
      .filter(
        (n) => n.programId === null && n.status === 'CURRENT' && n.classification === 'normal',
      )
      .map((n) => ({
        id: n.id,
        version: `${n.version}:${n.contentHash}`,
        text: `${n.title}\n${n.summary}`,
      }))
  const taskContext = async (projectId: string, raw: string, mode: string) => {
    if (mode === 'EXACT') return []
    const project = repos.projects.require(projectId)
    const head = git
      ? await git.headCommit(project.rootPath)
      : (project.profile?.headCommit ?? null)
    const profileVersion = createHash('sha256')
      .update(
        JSON.stringify([
          project.profile?.commands ?? {},
          project.profile?.profiledAt ?? null,
          project.respectProjectClaudeConfig,
        ]),
      )
      .digest('hex')
    return [
      {
        id: `repository:${projectId}`,
        version: `${head ?? 'no-head'}:${profileVersion}`,
        text: `Repository snapshot: ${head ?? 'no commit'}. Project checks: ${JSON.stringify(project.profile?.commands ?? {})}. Only the committed snapshot is used for worktrees.`,
      },
      ...retrieve(projectId, raw),
    ]
  }
  const strategyIdentity = () => {
    const status = connection?.status()
    return status
      ? `${status.activeProfile}:${status.model}:${status.includedOnlyConfirmed}`
      : 'unconfigured'
  }
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
          context: level === 0 ? [] : retrieve(projectId, objective),
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
    'compilation.preview': ({ projectId, raw, mode }) =>
      operations.run(async () => {
        repos.projects.require(projectId)
        // Commit exact input before retrieval or any fallible external call.
        const intentId = repos.intelligenceArtifacts.saveIntent(projectId, raw)
        const context = await taskContext(projectId, raw, mode)
        const strategic = connection?.provider()
        const strategy = strategyIdentity()
        const identity = compilerIdentity(raw, projectId, mode, context, '0.7.2-preview', strategy)
        const cached = repos.intelligenceArtifacts.reusableCompilation(projectId, identity)
        if (cached) return cached
        const pending = compiling.get(identity)
        if (pending) return pending
        const work = compileTask({
          raw,
          projectId,
          mode,
          context,
          policyVersion: '0.7.2-preview',
          strategy,
          ...(strategic ? { strategic } : {}),
        }).then((spec) => repos.intelligenceArtifacts.saveCompilation(spec, intentId))
        compiling.set(identity, work)
        try {
          return await work
        } finally {
          compiling.delete(identity)
        }
      }),
    'compilation.validate': ({ projectId, specId, raw, mode }) =>
      operations.run(async () => {
        repos.projects.require(projectId)
        const spec = repos.intelligenceArtifacts.compilation(projectId, specId)
        if (!spec || spec.rawIntent !== raw || spec.requestedMode !== mode)
          throw new NexusError(
            'invalid_input',
            'Specification does not match this project, original request and mode',
          )
        const context = await taskContext(projectId, raw, mode)
        try {
          assertFresh(spec, context)
        } catch {
          throw new NexusError(
            'invalid_state',
            'Specification is waiting, requires a decision, or has stale context. Preview again before starting.',
            { specId: spec.id, status: spec.status },
          )
        }
        if (
          spec.identity !==
          compilerIdentity(raw, projectId, mode, context, '0.7.2-preview', strategyIdentity())
        )
          throw new NexusError(
            'invalid_state',
            'Context or provider configuration changed. Preview again before starting.',
          )
        return spec
      }),
    'compilation.history': ({ projectId, offset }) => {
      repos.projects.require(projectId)
      return repos.intelligenceArtifacts.listCompilations(projectId, offset)
    },
  }
}
