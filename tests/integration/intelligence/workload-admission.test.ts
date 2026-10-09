import { describe, expect, it, vi } from 'vitest'
import { TaskAdmissionService } from '@main/modules/intelligence/admission'
import { withAdmittedIntent } from '@main/modules/intelligence/admission-prompt'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { ProgramEngine, type ProgramRunHost } from '@main/modules/program'
import { WorkspaceEngine } from '@main/modules/workspace'
import { EventBus } from '@main/modules/events'
import type { GitService } from '@main/modules/git'
import { ControlPlane, createWorkloadAdapters } from '@main/modules/control-plane'
import { PROGRAM_POLICY_PRESETS } from '@shared/program'
import { graphHarness } from '../../helpers/context-graph'
import { makeProject, makeRun } from '../persistence/fixtures'
import { makeTask } from '../persistence/fixtures'
import { createIpcHandlers } from '@main/modules/ipc/handlers'
import { Orchestrator } from '@main/modules/orchestrator'
import { Core } from '@main/modules/orchestrator/core'
import { composeForTask } from '@main/modules/orchestrator/context-source'
import type { WorktreeManager } from '@main/modules/git'
import type { AgentRuntime } from '@main/modules/agent-runtime'
import { defaultIntentMetadata } from '@shared/intelligence'

function rig(connected = false) {
  const h = graphHarness()
  const heads = new Map([[h.project.rootPath, 'head-one']])
  const git = {
    isRepository: async () => true,
    headCommit: async (path: string) => heads.get(path) ?? 'head-one',
    resolveCommit: async () => 'head-one',
    pruneWorktrees: async () => undefined,
    createBranch: vi.fn(async () => undefined),
  } as unknown as GitService
  const complete = vi.fn(async (instructions: string, _data: unknown) =>
    instructions.startsWith('INTENT_DRIFT_CHECK')
      ? { changesIntent: false, expandsScope: false, conflicts: [], unjustifiedRequirements: [] }
      : { recommendations: [], scopeChanged: false, ambiguities: [] },
  )
  const pushes = vi.fn()
  const connection = connected
    ? ({
        provider: () => ({ complete }),
        status: () => ({
          activeProfile: 'fake-only',
          model: 'fake-strategic',
          includedOnlyConfirmed: true,
        }),
      } as unknown as ChatGPTConnection)
    : undefined
  const admission = new TaskAdmissionService(h.repos, git, connection)
  const bus = new EventBus(h.repos.events, h.repos.transaction)
  const host: ProgramRunHost = {
    createRun: vi.fn(async (input) =>
      h.repos.runs.insert(
        makeRun(input.projectId, { mode: input.mode, prompt: input.prompt, state: 'executing' }),
      ),
    ),
    pauseRun: async () => undefined,
    resumeRun: async () => undefined,
    cancelRun: async () => undefined,
    recover: async () => undefined,
  }
  const programs = new ProgramEngine({
    repos: h.repos,
    git,
    bus,
    host,
    admission,
    tickIntervalMs: 0,
  })
  const workspaces = new WorkspaceEngine({
    repos: h.repos,
    git,
    bus,
    host,
    admission,
    projects: { open: async () => h.project },
    tickIntervalMs: 0,
  })
  const workspace = (name = 'Leaderboard workspace', project = h.project) => {
    const ws = workspaces.createWorkspace({ name })
    const repository = h.repos.enrolledRepositories.insert({
      id: `${ws.id}-${project.id}`,
      workspaceId: ws.id,
      key: 'leaderboard',
      projectId: project.id,
      rootPath: project.rootPath,
      role: 'application',
      remote: null,
      branch: 'main',
      languages: [],
      frameworks: [],
      commands: project.profile!.commands,
      packageName: null,
      packageVersion: null,
      manifest: null,
      enrolledAt: h.now(),
      refreshedAt: h.now(),
    })
    workspaces.setPolicy(ws.id, { ...ws.policy, allowedRepositories: ['leaderboard'] })
    return { ws: h.repos.workspaces.require(ws.id), repository }
  }
  return {
    ...h,
    heads,
    git,
    host,
    complete,
    admission,
    bus,
    pushes,
    programs,
    workspaces,
    workspace,
    close: () => {
      programs.dispose()
      workspaces.dispose()
      h.close()
    },
  }
}

describe('canonical workload admission', () => {
  it('blocks legacy Mission resume through IPC, recovery and the queue without launching sessions', async () => {
    const h = rig()
    const runtime = { startSession: vi.fn(), shutdown: async () => undefined } as unknown as AgentRuntime
    const orchestrator = new Orchestrator({ repos: h.repos, bus: h.bus, git: h.git, runtime,
      worktrees: {} as WorktreeManager, push: h.pushes, requireEngineeringAdmission: true })
    try {
      const run = h.repos.runs.insert(makeRun(h.project.id, { state: 'paused', resumeState: 'awaiting_approval', pauseReason: 'recovery' }))
      const handlers = createIpcHandlers({ repos: h.repos, git: h.git, runtime, orchestrator, taskAdmission: h.admission,
        appInfo: async () => ({ version: 'test', dataDir: '', dbPath: '', worktreesDir: '', platform: 'test', gitVersion: null, sdkVersion: 'fake', isPackaged: false }),
        pickDirectory: async () => null, openDataDir: async () => undefined, push: h.pushes })
      await expect(handlers['runs.resume']({ runId: run.id })).rejects.toThrow('compiled specification')
      await expect(handlers['runs.recover']({ runId: run.id, action: 'resume' })).rejects.toThrow('compiled specification')
      const adapters = createWorkloadAdapters(h.repos, { orchestrator, programs: h.programs, workspaces: h.workspaces,
        arena: {} as never, background: {} as never, defaultAgents: () => 1 })
      await expect(adapters.mission.resume(run.id)).rejects.toThrow('compiled specification')
      expect(h.repos.runs.require(run.id).state).toBe('paused')
      expect(runtime.startSession).not.toHaveBeenCalled()
      await handlers['runs.resume']({ runId: run.id, compilationMode: 'EXACT' })
      expect(h.repos.runs.require(run.id).config.compiledTaskSpec).toMatchObject({ rawIntent: run.prompt, mode: 'EXACT', status: 'READY' })
    } finally { await orchestrator.shutdown(); h.close() }
  })
  it('previews a paused Program against its execution branch and a Workspace against retained bases', async () => {
    const h = rig(true)
    try {
      const program = await h.programs.create({ projectId: h.project.id, name: 'Scores', goal: 'Display scores', compilationMode: 'EXACT', policy: PROGRAM_POLICY_PRESETS.balanced })
      await h.programs.start(program.id)
      await h.programs.pause(program.id)
      h.heads.set(h.project.rootPath, 'different-checkout')
      const retrieval = vi.spyOn(h.admission, 'retrieve')
      const programSpec = await h.admission.preview({ projectId: h.project.id, raw: program.goal.statement, mode: 'STANDARD',
        metadata: { entryPoint: 'PROGRAM', goals: [program.goal.statement], constraints: program.goal.constraints, acceptanceCriteria: program.goal.successCriteria },
        executionScope: { programId: program.id } })
      expect(programSpec.dependencies.find(r => r.id === `repository:${h.project.id}`)?.version).toMatch(/^head-one:/)
      expect(retrieval).not.toHaveBeenCalled()
      await h.programs.resume(program.id, { compilationMode: 'STANDARD', compiledSpecId: programSpec.id })
      expect(h.repos.intelligenceArtifacts.admission('PROGRAM', program.id)?.id).toBe(programSpec.id)
      const { ws } = h.workspace()
      h.heads.set(h.project.rootPath, 'workspace-admitted-head')
      const mission = await h.workspaces.createMission(ws.id, { goal: 'Display scores', compilationMode: 'EXACT' })
      await h.workspaces.startMission(mission.id)
      await h.workspaces.pauseMission(mission.id)
      h.heads.set(h.project.rootPath, 'different-workspace-checkout')
      const input = { projectId: h.project.id, workspaceId: ws.id, raw: mission.goal, mode: 'STANDARD' as const,
        metadata: defaultIntentMetadata(mission.goal, 'WORKSPACE_MISSION'), executionScope: { workspaceMissionId: mission.id } }
      const spec = await h.admission.preview(input)
      expect(spec.dependencies.find(r => r.id === `repository:${h.project.id}`)?.version).toMatch(/^workspace-admitted-head:/)
      await h.workspaces.resumeMission(mission.id, { compilationMode: 'STANDARD', compiledSpecId: spec.id })
      expect(h.repos.intelligenceArtifacts.admission('WORKSPACE_MISSION', mission.id)?.id).toBe(spec.id)
    } finally { h.close() }
  })
  it('gates user-added tasks and instructions, preserving exact input and rejecting stale task scope', async () => {
    const h = rig()
    try {
      const run = h.repos.runs.insert(makeRun(h.project.id, { state: 'executing' }))
      const existing = h.repos.tasks.insert(makeTask(run.id, 'existing'))
      const addTask = vi.fn((input) =>
        h.repos.tasks.insert(
          makeTask(run.id, 'added', { title: input.title, description: input.description }),
        ),
      )
      const instruct = vi.fn((_id, instruction) => ({ body: instruction }))
      const handlers = createIpcHandlers({
        repos: h.repos,
        git: h.git,
        runtime: {} as AgentRuntime,
        orchestrator: { addTask, instruct } as unknown as Orchestrator,
        taskAdmission: h.admission,
        appInfo: async () => ({
          version: 'test',
          dataDir: '',
          dbPath: '',
          worktreesDir: '',
          platform: 'test',
          gitVersion: null,
          sdkVersion: 'fake',
          isPackaged: false,
        }),
        pickDirectory: async () => null,
        openDataDir: async () => undefined,
        push: () => undefined,
      })
      const addition = {
        runId: run.id,
        title: 'Extra display',
        description: '  Render extra scores\n',
        role: 'worker' as const,
        complexity: 'small' as const,
        acceptanceCriteria: ['Scores appear'],
        dependsOn: [],
        suggestedFiles: [],
      }
      await expect(handlers['tasks.add'](addition)).rejects.toThrow('waiting')
      expect(addTask).not.toHaveBeenCalled()
      const added = await handlers['tasks.add']({ ...addition, compilationMode: 'EXACT' })
      expect(added.description).toBe(addition.description)
      expect(
        h.repos.intelligenceArtifacts.admission('TASK_ADDITION', added.id)?.userMetadata
          ?.acceptanceCriteria,
      ).toEqual(['Scores appear'])
      const instruction = '  Keep <T> and x < 10\n'
      await expect(
        handlers['tasks.instruct']({ taskId: existing.id, instruction }),
      ).rejects.toThrow('waiting')
      expect(instruct).not.toHaveBeenCalled()
      const input = {
        projectId: h.project.id,
        raw: instruction,
        mode: 'EXACT' as const,
        metadata: defaultIntentMetadata(instruction, 'TASK_INSTRUCTION'),
        executionScope: { runId: run.id, taskId: existing.id },
      }
      const preview = await h.admission.preview(input)
      h.repos.tasks.update(existing.id, { description: 'Changed target' })
      await expect(
        handlers['tasks.instruct']({
          taskId: existing.id,
          instruction,
          compilationMode: 'EXACT',
          compiledSpecId: preview.id,
        }),
      ).rejects.toThrow('stale')
      expect(instruct).not.toHaveBeenCalled()
      await handlers['tasks.instruct']({
        taskId: existing.id,
        instruction,
        compilationMode: 'EXACT',
      })
      expect(instruct).toHaveBeenCalledExactlyOnceWith(existing.id, instruction)
      expect(
        h.repos.intelligenceArtifacts.admission('TASK_INSTRUCTION', existing.id)?.rawIntent,
      ).toBe(instruction)
      const second = 'Keep the public interface backward compatible'
      await handlers['tasks.instruct']({ taskId: existing.id, instruction: second, compilationMode: 'EXACT' })
      expect(h.repos.intelligenceArtifacts.admissionHistory('TASK_INSTRUCTION', existing.id).map(s => s.rawIntent)).toEqual([instruction, second])
      const core = new Core({ repos: h.repos, bus: h.bus, git: h.git, runtime: {} as AgentRuntime, worktrees: {} as WorktreeManager, push: h.pushes })
      // Simulate replacement-worker context after messages have already been delivered.
      const composed = composeForTask(core, run, existing, 'implement', h.project.rootPath, null)
      expect(composed.prompt).toContain('Keep <T> and x < 10'.replace(/</g, '\\u003c'))
      expect(composed.prompt).toContain(second)
      expect(composed.pack.entries.filter(e => e.sourceKind === 'user_instruction')).toHaveLength(2)
      await expect(handlers['tasks.resolveBlocker']({ taskId: existing.id, note: 'New constraint', compilationMode: 'EXACT' })).rejects.toThrow('not blocked')
      expect(h.repos.intelligenceArtifacts.admissionHistory('TASK_INSTRUCTION', existing.id)).toHaveLength(2)
      h.repos.tasks.update(existing.id, { state: 'blocked' })
      const originalPreview = h.admission.preview.bind(h.admission)
      const spy = vi.spyOn(h.admission, 'preview').mockImplementation(async request => {
        const spec = await originalPreview(request)
        h.repos.tasks.update(existing.id, { state: 'ready' })
        return spec
      })
      await expect(handlers['tasks.resolveBlocker']({ taskId: existing.id, note: 'Arrived too late', compilationMode: 'EXACT' })).rejects.toThrow('not blocked')
      expect(h.repos.intelligenceArtifacts.admissionHistory('TASK_INSTRUCTION', existing.id)).toHaveLength(2)
      spy.mockRestore()
    } finally {
      h.close()
    }
  })
  it('persists user goals and constraints before provider waits on every engineering root', async () => {
    const h = rig()
    try {
      const { ws } = h.workspace()
      const goal = '  Build the leaderboard\n'
      await expect(
        h.programs.create({
          projectId: h.project.id,
          name: 'Leaderboard',
          goal,
          constraints: ['No new dependencies'],
          policy: PROGRAM_POLICY_PRESETS.balanced,
        }),
      ).rejects.toThrow('waiting')
      await expect(h.workspaces.createMission(ws.id, { goal })).rejects.toThrow('waiting')
      await expect(
        h.workspaces.createProgram(ws.id, {
          name: 'Leaderboard',
          goal,
          milestones: [{ title: 'Display', goal: 'Display scores' }],
        }),
      ).rejects.toThrow('waiting')
      const saved = h.repos.intelligenceArtifacts.listCompilations(h.project.id)
      expect(saved).toHaveLength(3)
      expect(new Set(saved.map((s) => s.userMetadata?.entryPoint))).toEqual(
        new Set(['PROGRAM', 'WORKSPACE_MISSION', 'WORKSPACE_PROGRAM']),
      )
      expect(
        saved.every(
          (s) => s.rawIntent === goal && s.intentId && s.status === 'WAITING_FOR_PROVIDER',
        ),
      ).toBe(true)
      expect(
        saved.find((s) => s.userMetadata?.entryPoint === 'PROGRAM')?.userMetadata?.constraints,
      ).toEqual(['No new dependencies'])
      expect(h.host.createRun).not.toHaveBeenCalled()
      expect(h.git.createBranch).not.toHaveBeenCalled()
      expect(h.repos.programs.list()).toEqual([])
    } finally {
      h.close()
    }
  })
  it('preserves literal code and constraint metadata through durable references and prompt round-trip', async () => {
    const h = rig(true)
    try {
      const goal = '  Render <T> while x < 10; preserve </admitted_intent>\n'
      const program = await h.programs.create({
        projectId: h.project.id,
        name: 'Display',
        goal,
        constraints: ['Keep <button>'],
        successCriteria: ['x < 10'],
        policy: PROGRAM_POLICY_PRESETS.balanced,
        compilationMode: 'STANDARD',
      })
      const spec = h.repos.intelligenceArtifacts.admission('PROGRAM', program.id)!
      const body = (
        h.db.prepare('SELECT body FROM intelligence_artifacts WHERE id=?').get(spec.id) as {
          body: string
        }
      ).body
      expect(JSON.parse(body)).not.toHaveProperty('rawIntent')
      expect(JSON.parse(body)).not.toHaveProperty('dependencies')
      expect(
        h.db
          .prepare('SELECT count(*) AS n FROM compilation_context_refs WHERE artifact_id=?')
          .get(spec.id),
      ).toEqual({ n: 1 })
      expect(() =>
        h.db.prepare("UPDATE raw_user_intents SET metadata='{}' WHERE id=?").run(spec.intentId),
      ).toThrow('immutable')
      const prompt = withAdmittedIntent('Task', spec)
      const json = prompt.split('<admitted_intent>\n')[1]!.split('\n</admitted_intent>')[0]!
      expect(JSON.parse(json)).toMatchObject({
        rawUserIntent: goal,
        explicitUserMetadata: { constraints: ['Keep <button>'], acceptanceCriteria: ['x < 10'] },
      })
      await h.programs.start(program.id)
      expect(h.complete).toHaveBeenCalledTimes(2)
      expect(h.host.createRun).toHaveBeenCalledOnce()
      expect(h.repos.programs.require(program.id).goal.statement).toBe(goal)
    } finally {
      h.close()
    }
  })
  it('rejects a stale Program through the actual scheduler adapter without creating a branch or run', async () => {
    const h = rig()
    const control = new ControlPlane({
      items: h.repos.workItems,
      schedules: h.repos.controlSchedules,
      incidents: h.repos.controlIncidents,
      settings: h.repos.settings,
      usage: { canDispatch: () => true },
      tickIntervalMs: 0,
      adapters: createWorkloadAdapters(h.repos, {
        programs: h.programs,
        workspaces: h.workspaces,
        orchestrator: h.host,
        arena: {
          start: async () => undefined,
          pause: () => undefined,
          resume: () => undefined,
          cancel: () => undefined,
        },
        background: { start: async () => ({ id: 'unused' }), cancel: async () => undefined },
        defaultAgents: () => 1,
      }),
    })
    try {
      const program = await h.programs.create({
        projectId: h.project.id,
        name: 'Spelling',
        goal: 'Fix spelling',
        policy: PROGRAM_POLICY_PRESETS.balanced,
        compilationMode: 'LIGHT',
      })
      const item = control.enqueue({ type: 'program', programId: program.id })
      h.heads.set(h.project.rootPath, 'head-two')
      await control.tick()
      expect(h.repos.workItems.get(item.id)).toMatchObject({ state: 'FAILED' })
      expect(h.repos.workItems.get(item.id)?.detail).toContain('stale')
      expect(h.repos.programs.require(program.id).state).toBe('DRAFT')
      expect(h.git.createBranch).not.toHaveBeenCalled()
      expect(h.host.createRun).not.toHaveBeenCalled()
    } finally {
      control.dispose()
      h.close()
    }
  })
  it('deduplicates shared workspace evidence and excludes a second workspace containing the same project', async () => {
    const h = rig()
    try {
      const { ws } = h.workspace('Leaderboard shared')
      const second = h.repos.projects.insert(
        makeProject({ rootPath: 'C:\\fake\\second', name: 'Second' }),
      )
      h.repos.enrolledRepositories.insert({
        ...h.repos.enrolledRepositories.listByWorkspace(ws.id)[0]!,
        id: 'second-enrollment',
        projectId: second.id,
        rootPath: second.rootPath,
        key: 'second',
      })
      const other = h.workspace('Leaderboard unrelated')
      await h.graph.syncWorkspace(ws.id)
      await h.graph.syncWorkspace(other.ws.id)
      const unrelated = h.repos.contextGraph.nodes.root({ kind: 'workspace', id: other.ws.id })
      const spec = await h.admission.preview({
        projectId: h.project.id,
        workspaceId: ws.id,
        raw: 'Leaderboard',
        mode: 'LIGHT',
      })
      expect(new Set(spec.dependencies.map((r) => r.id)).size).toBe(spec.dependencies.length)
      expect(spec.dependencies.some((r) => r.id === unrelated?.id)).toBe(false)
      expect(spec.dependencies.filter((r) => r.id.startsWith('repository:'))).toHaveLength(2)
      expect(h.repos.intelligenceArtifacts.compilation(h.project.id, spec.id)).toEqual(spec)
    } finally {
      h.close()
    }
  })
  it('binds Workspace EXACT policy scope and freezes repository bases through planning delays', async () => {
    const h = rig()
    try {
      const { ws, repository } = h.workspace()
      const mission = await h.workspaces.createMission(ws.id, {
        goal: '  Fix display\n',
        compilationMode: 'EXACT',
      })
      await h.workspaces.startMission(mission.id)
      h.heads.set(h.project.rootPath, 'head-after-planning')
      h.repos.workspaceTasks.insert({
        id: 'display-task',
        missionId: mission.id,
        repositoryId: repository.id,
        ordinal: 0,
        key: 'display',
        repository: repository.key,
        title: 'Display',
        objective: 'Fix display',
        acceptanceCriteria: ['Display works'],
        dependsOn: [],
        contracts: [],
        state: 'PLANNED',
        runId: null,
        baseCommit: null,
        resultCommit: null,
        resultBranch: null,
        summary: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      })
      h.repos.workspaceMissions.update(mission.id, { state: 'ACTIVE' })
      await h.workspaces.tick()
      expect(h.host.createRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'mission', baseRef: 'head-one' }),
      )
      expect(h.complete).not.toHaveBeenCalled()
      const draft = await h.workspaces.createMission(ws.id, {
        goal: 'Another display',
        compilationMode: 'EXACT',
      })
      h.workspaces.setPolicy(ws.id, { ...ws.policy, allowedRepositories: [] })
      await expect(h.workspaces.startMission(draft.id)).rejects.toThrow('stale')
      expect(h.repos.workspaceMissions.require(draft.id).state).toBe('DRAFT')
    } finally {
      h.close()
    }
  })
  it('admits a Workspace program once and inherits root metadata on its internal first milestone', async () => {
    const h = rig(true)
    try {
      const { ws } = h.workspace()
      const program = await h.workspaces.createProgram(
        ws.id,
        {
          name: 'Display',
          goal: 'Display scores',
          milestones: [{ title: 'Scores', goal: 'Render scores' }],
        },
        { compilationMode: 'STANDARD' },
      )
      await h.workspaces.startProgram(program.id)
      const mission = h.repos.workspaceMissions.listByProgram(program.id)[0]!
      expect(mission.state).toBe('PLANNING')
      expect(h.repos.intelligenceArtifacts.admission('WORKSPACE_MISSION', mission.id)).toBeNull()
      expect(
        h.repos.intelligenceArtifacts.admission('WORKSPACE_PROGRAM', program.id)?.userMetadata
          ?.goals,
      ).toEqual(['Display scores', 'Scores\nRender scores'])
      expect(h.complete).toHaveBeenCalledTimes(2)
      expect(h.host.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringContaining('Canonical root user intent') }),
      )
    } finally {
      h.close()
    }
  })
})
