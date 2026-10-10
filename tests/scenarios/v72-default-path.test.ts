import { afterEach, describe, expect, it } from 'vitest'
import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { createIpcHandlers, dispatchIpc } from '@main/modules/ipc/handlers'
import { createHarness, fileWorker, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

/**
 * 0.7.2: the path a user takes by default. A mission is created through IPC with no compilation depth chosen
 * (AUTO), the Task Compiler develops the request with the strategic provider, and the real orchestrator runs
 * the admitted specification. Only the two providers are stand-ins: the strategic one answers from a script,
 * the agents are the scripted runtime.
 */
describe('scenario: a mission in the default compilation depth', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  const REQUEST = 'Add a dark mode toggle to the settings page and keep the header layout as it is.'
  const ADVICE = 'Persist the chosen theme so that it survives a restart of the application.'
  const PLANNING_ADVICE = 'Verify the toggle with a test that restarts the application.'

  /** A signed-in ChatGPT connection whose inference answers from here. Records what it was sent. */
  function strategic(): { connection: ChatGPTConnection; sent: { instructions: string; data: unknown }[] } {
    const sent: { instructions: string; data: unknown }[] = []
    const complete = async (instructions: string, data: unknown): Promise<unknown> => {
      sent.push({ instructions, data })
      return instructions.startsWith('INTENT_DRIFT_CHECK')
        ? { changesIntent: false, expandsScope: false, conflicts: [], unjustifiedRequirements: [] }
        : { recommendations: [{ text: ADVICE, kind: 'CONSTRAINT', provenance: 'DIRECTOR_RECOMMENDED', evidenceRefs: [], requiresDecision: false }, { text: PLANNING_ADVICE, kind: 'VERIFICATION', provenance: 'DIRECTOR_RECOMMENDED', evidenceRefs: [], requiresDecision: false }], scopeChanged: false, ambiguities: [] }
    }
    const connection = {
      status: () => ({ state: 'SIGNED_IN_PLAN_USAGE', activeProfile: 'test', model: 'fake-gpt', capacity: null, includedOnlyConfirmed: true, profiles: [], models: [], error: null }),
      provider: () => ({ complete, usage: () => null }),
      canInfer: () => true,
    } as unknown as ChatGPTConnection
    return { connection, sent }
  }

  async function invoke<C extends IpcChannel>(chatgpt: ChatGPTConnection | undefined, channel: C, input: IpcInput<C>): Promise<IpcOutputs[C]> {
    const handlers = createIpcHandlers({
      repos: h.repos, git: h.git, runtime: h.runtime, orchestrator: h.orchestrator, ...(chatgpt ? { chatgpt } : {}),
      appInfo: async () => ({ version: 'test', dataDir: h.dir, dbPath: h.dbPath, worktreesDir: h.worktreesDir, platform: 'win32', gitVersion: 'test', sdkVersion: 'fake', isPackaged: false }),
      pickDirectory: async () => null, openDataDir: async () => undefined, push: () => undefined,
    })
    const result = await dispatchIpc(handlers, channel, input)
    if (!result.ok) throw new Error(`${channel} failed: ${result.error.message}`)
    return result.value as IpcOutputs[C]
  }

  const copies = (text: string, part: string): number => text.split(part).length - 1

  it('with ChatGPT connected: the request is compiled, admitted and carried out, and every prompt shows the request once', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker: fileWorker }) })
    const { connection, sent } = strategic()
    const run = await invoke(connection, 'runs.create', { projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: REQUEST })
    // Compiled before anything ran: the specification is on the run, developed, with the request untouched.
    expect(run.config.compiledTaskSpec).toMatchObject({ rawIntent: REQUEST, status: 'READY' })
    expect(run.config.compiledTaskSpec!.mode).not.toBe('EXACT')
    expect(run.config.compiledTaskSpec!.recommendations.map((r) => r.text)).toEqual([ADVICE, PLANNING_ADVICE])
    expect(run.prompt).toBe(REQUEST)
    // What the strategic provider was sent: the request as written, and nothing an agent wrote.
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(sent[0]!.data)).toContain(REQUEST)

    const done = await h.waitForState(run.id, ['completed', 'paused', 'failed'])
    expect(done.state).toBe('completed')
    expect(h.task(run.id, 'alpha')).toMatchObject({ state: 'completed', attempt: 1 })

    const planner = sessionsOf(h, 'planner')[0]!.prompt
    const worker = sessionsOf(h, 'worker')[0]!.prompt
    for (const [who, prompt] of [['planner', planner], ['worker', worker]] as const) {
      expect(copies(prompt, REQUEST), `copies of the request in the ${who} prompt`).toBe(1)
      expect(prompt, who).toContain(ADVICE)
      // The advice is shown as what it is.
      expect(prompt, who).toContain('generated additions are not user authority')
    }
    // Advice about what to plan and how to verify is the planner's: a worker is given what to keep to.
    expect(planner).toContain(PLANNING_ADVICE)
    expect(worker).not.toContain(PLANNING_ADVICE)
    // No compilation was repeated once the run had started.
    const calls = sent.length
    await h.orchestrator.idle(run.id)
    expect(sent.length).toBe(calls)
  })

  it('a project kept away from OpenAI sends nothing, whatever the connection allows, and still works', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker: fileWorker }) })
    const { connection, sent } = strategic()
    expect(await invoke(connection, 'compilation.projectSending', { projectId: h.project.id })).toEqual({ allowed: true })
    await invoke(connection, 'compilation.setProjectSending', { projectId: h.project.id, allowed: false })
    expect(await invoke(connection, 'compilation.projectSending', { projectId: h.project.id })).toEqual({ allowed: false })

    // A depth that needs the provider waits, says which switch decides, and nothing was sent.
    const waiting = await invoke(connection, 'compilation.preview', { projectId: h.project.id, raw: REQUEST, mode: 'STANDARD' })
    expect(waiting.status).toBe('WAITING_FOR_PROVIDER')
    expect(waiting.reasons).toContain('PROJECT_DOES_NOT_SEND_TO_STRATEGIC_PROVIDER')
    await expect(invoke(connection, 'runs.create', { projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: REQUEST, compilationMode: 'STANDARD' })).rejects.toThrow()
    // The strategic levels of the Director are refused for it; nothing was sent there either.
    await expect(invoke(connection, 'director.invoke', { projectId: h.project.id, objective: 'Should we do this now?', level: 2 })).rejects.toThrow(/not to send to OpenAI/)
    await expect(invoke(connection, 'director.invoke', { projectId: h.project.id, objective: 'Should we do this now?', level: 3 })).rejects.toThrow(/not to send to OpenAI/)
    expect(sent).toEqual([])

    // With no depth chosen the request is admitted as written and carried out.
    const run = await invoke(connection, 'runs.create', { projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: REQUEST })
    expect(run.config.compiledTaskSpec).toMatchObject({ mode: 'EXACT', status: 'READY', rawIntent: REQUEST })
    expect((await h.waitForState(run.id, ['completed', 'paused', 'failed'])).state).toBe('completed')
    expect(sent).toEqual([])

    // Switched back on, the default depth develops the request again.
    await invoke(connection, 'compilation.setProjectSending', { projectId: h.project.id, allowed: true })
    const developed = await invoke(connection, 'compilation.preview', { projectId: h.project.id, raw: `${REQUEST} Also add a test.`, mode: 'AUTO' })
    expect(developed.status).toBe('READY')
    expect(sent.length).toBeGreaterThan(0)
  })

  it('with no ChatGPT connection: nothing is created and nothing runs from an uncompiled request', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker: fileWorker }) })
    await expect(invoke(undefined, 'runs.create', { projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: REQUEST })).rejects.toThrow()
    expect(h.repos.runs.listActive()).toEqual([])
    expect(h.runtime.sessions).toEqual([])
    // The same request in EXACT depth needs no provider and runs.
    const run = await invoke(undefined, 'runs.create', { projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: REQUEST, compilationMode: 'EXACT' })
    expect((await h.waitForState(run.id, ['completed', 'paused', 'failed'])).state).toBe('completed')
  })
})
