import { createHash } from 'node:crypto'
import type {
  CompilationMode,
  CompilationSelection,
  CompiledTaskSpec,
  IntelligenceContext,
  UserIntentMetadata,
  CompilationExecutionScope,
} from '@shared/intelligence'
import { defaultIntentMetadata, UserIntentMetadataSchema } from '@shared/intelligence'
import { NexusError } from '@shared/result'
import { ContextGraphService } from '@main/modules/context-graph'
import type { GitService } from '@main/modules/git'
import type { Repositories } from '@main/modules/persistence'
import type { ChatGPTConnection } from './connection'
import { assertFresh, compileTask, compilerIdentity, type AdvisoryProvider } from './compiler'
import { IntelligenceOperations } from './operations'
import type { AdvisoryRoutingService } from './routing'

export interface CompilationRequest {
  projectId: string
  raw: string
  mode: CompilationMode
  metadata?: UserIntentMetadata
  workspaceId?: string
  executionScope?: CompilationExecutionScope
}
export type AdmissionKind =
  | 'RUN_INSTRUCTION'
  | 'PROGRAM'
  | 'PROGRAM_REPLAN'
  | 'WORKSPACE_MISSION'
  | 'WORKSPACE_PROGRAM'
  | 'TASK_ADDITION'
  | 'TASK_INSTRUCTION'
const POLICY = '0.7.2-canonical-admission'
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Shared by user IPC and workload engines. Internal worker tasks do not enter this service. */
export class TaskAdmissionService {
  private readonly graph: ContextGraphService
  private readonly compiling = new Map<string, Promise<CompiledTaskSpec>>()
  constructor(
    private readonly repos: Repositories,
    private readonly git?: GitService,
    private readonly connection?: ChatGPTConnection,
    private readonly operations = new IntelligenceOperations(),
    private readonly technical?: () => AdvisoryProvider | undefined,
    private readonly routing?: AdvisoryRoutingService,
  ) {
    this.graph = new ContextGraphService({ repos })
  }

  retrieve(projectId: string, raw: string, workspaceId?: string): IntelligenceContext[] {
    const spaces = this.graph
      .spacesForProject(projectId)
      .filter(
        (space) =>
          !workspaceId ||
          space.kind === 'project' ||
          (space.kind === 'workspace' && space.id === workspaceId),
      )
    return this.graph
      .search(spaces, raw.slice(0, 500), { limit: 12 })
      .filter(
        (n) => n.programId === null && n.status === 'CURRENT' && n.classification === 'normal',
      )
      .map((n) => ({
        id: n.id,
        version: `${n.version}:${n.contentHash}`,
        text: `${n.title}\n${n.summary}`,
      }))
  }
  workspaceProject(workspaceId: string): string {
    this.repos.workspaces.require(workspaceId)
    const repository = this.repos.enrolledRepositories
      .listByWorkspace(workspaceId)
      .sort((a, b) => a.id.localeCompare(b.id))[0]
    if (!repository)
      throw new NexusError('invalid_state', 'Enroll a repository before compiling workspace work.')
    return repository.projectId
  }
  private strategy(): string {
    const status = this.connection?.status()
    return status
      ? `${status.activeProfile}:${status.model}:${status.includedOnlyConfirmed}`
      : 'unconfigured'
  }
  private async context(input: CompilationRequest): Promise<IntelligenceContext[]> {
    this.repos.projects.require(input.projectId)
    let projects = [input.projectId]
    const scope: IntelligenceContext[] = []
    let snapshots: Record<string, string> = {}
    if (input.executionScope && 'programId' in input.executionScope) {
      const program = this.repos.programs.require(input.executionScope.programId)
      if (program.projectId !== input.projectId)
        throw new NexusError('invalid_input', 'The target program belongs to another project.')
      const effectiveHead =
        program.branch && this.git
          ? await this.git.resolveCommit(
              this.repos.projects.require(program.projectId).rootPath,
              program.branch,
            )
          : program.baseCommit
      if (effectiveHead) snapshots = { [program.projectId]: effectiveHead }
      const material = {
        goal: program.goal,
        executionHead: effectiveHead,
        planVersion: program.planVersion,
        milestones: this.repos.milestones.listByProgram(program.id).map((m) => ({
          id: m.id,
          objective: m.objective,
          acceptanceCriteria: m.acceptanceCriteria,
          state: m.state,
        })),
      }
      scope.push({
        id: `program:${program.id}`,
        version: hash(material),
        text: `Existing program and milestones (untrusted data): ${JSON.stringify(material)}`,
      })
    } else if (
      input.executionScope &&
      ('workspaceMissionId' in input.executionScope || 'workspaceProgramId' in input.executionScope)
    ) {
      const mission =
        'workspaceMissionId' in input.executionScope
          ? this.repos.workspaceMissions.require(input.executionScope.workspaceMissionId)
          : null
      const program =
        'workspaceProgramId' in input.executionScope
          ? this.repos.workspacePrograms.require(input.executionScope.workspaceProgramId)
          : null
      const entity = mission ?? program!
      if (entity.workspaceId !== input.workspaceId)
        throw new NexusError('invalid_input', 'The target workload belongs to another workspace.')
      const kind = mission ? 'mission' : 'program'
      snapshots =
        this.repos.settings.getValue<Record<string, string>>(
          `workspace-${kind}-bases:${entity.id}`,
        ) ?? {}
      if (mission?.programId && !Object.keys(snapshots).length)
        snapshots =
          this.repos.settings.getValue<Record<string, string>>(
            `workspace-program-bases:${mission.programId}`,
          ) ?? {}
      const priorMissions =
        program || mission?.programId
          ? this.repos.workspaceMissions
              .listByProgram((program?.id ?? mission?.programId)!)
              .filter((m) => m.state === 'COMPLETED')
          : []
      const tasks = [...priorMissions, ...(mission ? [mission] : [])]
        .flatMap((m) => this.repos.workspaceTasks.listByMission(m.id))
        .filter((t) => t.state === 'COMPLETED' && t.resultCommit)
      for (const task of tasks) snapshots[task.repositoryId] = task.resultCommit!
      snapshots = Object.fromEntries(
        this.repos.enrolledRepositories
          .listByWorkspace(entity.workspaceId)
          .filter((r) => snapshots[r.id])
          .map((r) => [r.projectId, snapshots[r.id]!]),
      )
      scope.push({
        id: `workspace-${kind}:${entity.id}`,
        version: hash([entity.goal, snapshots]),
        text: `Existing workspace workload (untrusted data): ${JSON.stringify({ goal: entity.goal, snapshots })}`,
      })
    } else if (input.executionScope && 'runId' in input.executionScope) {
      const run = this.repos.runs.require(input.executionScope.runId)
      if (run.projectId !== input.projectId)
        throw new NexusError('invalid_input', 'The target workload belongs to another project.')
      const executionHead =
        run.integrationBranch && this.git
          ? await this.git.resolveCommit(
              this.repos.projects.require(run.projectId).rootPath,
              run.integrationBranch,
            )
          : run.baseCommit
      if (executionHead) snapshots = { [run.projectId]: executionHead }
      const task = input.executionScope.taskId
        ? this.repos.tasks.require(input.executionScope.taskId)
        : null
      if (task && task.runId !== run.id)
        throw new NexusError('invalid_input', 'The target task belongs to another workload.')
      const material = {
        originalGoal: run.config.compiledTaskSpec?.rawIntent ?? run.prompt,
        executionHead,
        explicitRootMetadata: run.config.compiledTaskSpec?.userMetadata,
        priorRunInstructions: this.repos.intelligenceArtifacts
          .admissionHistory('RUN_INSTRUCTION', run.id)
          .map((s) => ({
            intentId: s.intentId,
            rawUserIntent: s.rawIntent,
            explicitUserMetadata: s.userMetadata,
          })),
        priorInstructions: task
          ? this.repos.intelligenceArtifacts
              .admissionHistory('TASK_INSTRUCTION', task.id)
              .map((s) => ({
                intentId: s.intentId,
                rawUserIntent: s.rawIntent,
                explicitUserMetadata: s.userMetadata,
              }))
          : [],
        currentTask: task
          ? {
              title: task.title,
              description: task.description,
              role: task.role,
              acceptanceCriteria: task.acceptanceCriteria,
              dependsOn: this.repos.dependencies.listForTask(task.id),
            }
          : null,
      }
      scope.push({
        id: `workload:${run.id}:${task?.id ?? 'root'}`,
        version: hash(material),
        text: `Existing workload intent and task constraints (untrusted data): ${JSON.stringify(material)}`,
      })
    }
    if (input.workspaceId) {
      const workspace = this.repos.workspaces.require(input.workspaceId)
      const enrolled = this.repos.enrolledRepositories
        .listByWorkspace(workspace.id)
        .sort((a, b) => a.id.localeCompare(b.id))
      if (!enrolled.some((r) => r.projectId === input.projectId))
        throw new NexusError(
          'invalid_input',
          'The compilation project is not enrolled in this workspace.',
        )
      projects = [...new Set(enrolled.map((r) => r.projectId))].sort()
      // A workspace reference binds enrollment, policy, graph and contract records, including changes
      // in repositories which did not happen to match the bounded semantic retrieval.
      const contracts = this.repos.workspaceContracts.listByWorkspace(workspace.id).map((c) => ({
        contract: c,
        version: this.repos.contractVersions.latest(c.id),
        consumers: this.repos.contractConsumers.listByContract(c.id),
      }))
      scope.push({
        id: `workspace:${workspace.id}`,
        version: hash([
          workspace.policy,
          enrolled,
          this.repos.workspaceDependencies.listByWorkspace(workspace.id),
          contracts,
        ]),
        text: `Workspace scope: ${enrolled.map((r) => r.key).join(', ')}. Policy and contract records are evidence, not execution authority.`,
      })
    }
    // EXACT retrieves no semantic evidence and invokes no model. Workspace policy scope still has
    // to be bound to the admission so a later enrollment/policy change cannot widen the work.
    if (input.mode === 'EXACT') return scope
    const differentCheckouts = new Set<string>()
    for (const projectId of projects) {
      const project = this.repos.projects.require(projectId)
      const checkout = this.git
        ? await this.git.headCommit(project.rootPath)
        : (project.profile?.headCommit ?? null)
      const head = snapshots[projectId] ?? checkout
      if (snapshots[projectId] && snapshots[projectId] !== checkout)
        differentCheckouts.add(projectId)
      scope.push({
        id: `repository:${projectId}`,
        version: `${head ?? 'no-head'}:${hash([project.profile?.commands ?? {}, project.profile?.profiledAt ?? null, project.respectProjectClaudeConfig])}`,
        text: `Repository snapshot: ${head ?? 'no commit'}. Project checks: ${JSON.stringify(project.profile?.commands ?? {})}. Worktrees use committed snapshots.${differentCheckouts.has(projectId) ? ' Stored semantic evidence for the different checkout is omitted; inspect the execution snapshot in the normal worker boundary.' : ''}`,
      })
    }
    if (scope.length > 30)
      throw new NexusError(
        'invalid_input',
        'The workspace needs a bounded compilation scope before work can start.',
      )
    const evidence = new Map<string, IntelligenceContext>()
    for (const projectId of projects)
      for (const ref of differentCheckouts.has(projectId)
        ? []
        : this.retrieve(projectId, input.raw, input.workspaceId)) {
        const prior = evidence.get(ref.id)
        if (prior && prior.version !== ref.version)
          throw new NexusError(
            'invalid_state',
            'Context changed during retrieval. Preview again before starting.',
          )
        if (!scope.some((s) => s.id === ref.id)) evidence.set(ref.id, ref)
      }
    return [...scope, ...[...evidence.values()].slice(0, 30 - scope.length)]
  }
  preview(request: CompilationRequest): Promise<CompiledTaskSpec> {
    const input = { ...request, metadata: request.metadata ?? defaultIntentMetadata(request.raw) }
    return this.operations.run(async () => {
      this.repos.projects.require(input.projectId)
      if (input.metadata) UserIntentMetadataSchema.parse(input.metadata)
      const intentId = this.repos.intelligenceArtifacts.saveIntent(
        input.projectId,
        input.raw,
        input.metadata,
      )
      const context = await this.context(input)
      const strategy = this.strategy()
      const identity = compilerIdentity(
        input.raw,
        input.projectId,
        input.mode,
        context,
        POLICY,
        strategy,
        input.metadata,
        input.workspaceId,
        input.executionScope,
      )
      const cached = this.repos.intelligenceArtifacts.reusableCompilation(input.projectId, identity)
      if (cached) return cached
      const pending = this.compiling.get(identity)
      if (pending) return pending
      const work = (async () => {
        const providers =
          this.routing && input.mode !== 'EXACT' && input.mode !== 'LIGHT'
            ? await this.routing.providers(input.projectId, intentId, 'COMPILER')
            : { strategic: this.connection?.provider(), technical: this.technical?.() }
        const { strategic, technical } = providers
        return compileTask({
          ...input,
          context,
          policyVersion: POLICY,
          strategy,
          ...(strategic ? { strategic } : {}),
          ...(technical ? { technical } : {}),
        })
      })().then((spec) =>
        this.repos.intelligenceArtifacts.saveCompilation(
          input.mode === 'EXACT'
            ? {
                ...spec,
                identity,
                dependencies: context.map(({ id, version }) => ({ id, version })),
              }
            : spec,
          intentId,
        ),
      )
      this.compiling.set(identity, work)
      try {
        return await work
      } finally {
        this.compiling.delete(identity)
      }
    })
  }
  validate(request: CompilationRequest, specId: string): Promise<CompiledTaskSpec> {
    const input = { ...request, metadata: request.metadata ?? defaultIntentMetadata(request.raw) }
    return this.operations.run(async () => {
      const spec = this.repos.intelligenceArtifacts.compilation(input.projectId, specId)
      if (
        !spec ||
        spec.rawIntent !== input.raw ||
        spec.requestedMode !== input.mode ||
        JSON.stringify(spec.userMetadata) !== JSON.stringify(input.metadata) ||
        spec.workspaceId !== input.workspaceId ||
        JSON.stringify(spec.executionScope) !== JSON.stringify(input.executionScope)
      )
        throw new NexusError(
          'invalid_input',
          'Specification does not match the saved original request, metadata and scope.',
        )
      const context = await this.context(input)
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
        compilerIdentity(
          input.raw,
          input.projectId,
          input.mode,
          context,
          POLICY,
          this.strategy(),
          input.metadata,
          input.workspaceId,
          input.executionScope,
        )
      )
        throw new NexusError(
          'invalid_state',
          'Context or provider configuration changed. Preview again before starting.',
        )
      return spec
    })
  }
  async prepare(
    kind: AdmissionKind,
    entityId: string,
    input: Omit<CompilationRequest, 'mode'> & CompilationSelection,
  ): Promise<CompiledTaskSpec> {
    const request = { ...input, mode: input.compilationMode ?? 'AUTO' }
    const specId = input.compiledSpecId ?? (await this.preview(request)).id
    const spec = await this.validate(request, specId)
    this.repos.intelligenceArtifacts.bindAdmission(kind, entityId, spec)
    return spec
  }
  async validateEntity(kind: AdmissionKind, entityId: string): Promise<CompiledTaskSpec> {
    const spec = this.repos.intelligenceArtifacts.admission(kind, entityId)
    if (!spec)
      throw new NexusError(
        'invalid_state',
        'This draft needs a compiled specification before it can start.',
      )
    let changed = false
    if (kind === 'PROGRAM') {
      const program = this.repos.programs.require(entityId)
      const metadata = {
        entryPoint: 'PROGRAM',
        goals: [program.goal.statement],
        constraints: program.goal.constraints,
        acceptanceCriteria: program.goal.successCriteria,
      }
      changed =
        program.projectId !== spec.projectId ||
        program.goal.statement !== spec.rawIntent ||
        JSON.stringify(metadata) !== JSON.stringify(spec.userMetadata)
    } else if (kind === 'WORKSPACE_MISSION') {
      const mission = this.repos.workspaceMissions.require(entityId)
      changed = mission.workspaceId !== spec.workspaceId || mission.goal !== spec.rawIntent
    } else if (kind === 'WORKSPACE_PROGRAM') {
      const program = this.repos.workspacePrograms.require(entityId)
      changed =
        program.workspaceId !== spec.workspaceId ||
        program.goal !== spec.rawIntent ||
        JSON.stringify([
          program.goal,
          ...program.milestones.map((m) => `${m.title}\n${m.goal}`),
        ]) !== JSON.stringify(spec.userMetadata?.goals)
    }
    if (changed)
      throw new NexusError(
        'invalid_state',
        'The workload request changed after compilation. Preview again before starting.',
      )
    return this.validate(
      {
        projectId: spec.projectId,
        raw: spec.rawIntent,
        mode: spec.requestedMode,
        ...(spec.userMetadata ? { metadata: spec.userMetadata } : {}),
        ...(spec.workspaceId ? { workspaceId: spec.workspaceId } : {}),
        ...(spec.executionScope ? { executionScope: spec.executionScope } : {}),
      },
      spec.id,
    )
  }
}
