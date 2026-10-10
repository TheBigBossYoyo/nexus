import { afterEach, describe, expect, it } from 'vitest'
import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { adviceLearning, attachAdviceOutcomes, learningEvidence, recordAdviceOutcome } from '@main/modules/intelligence/outcomes'
import { createIpcHandlers, dispatchIpc } from '@main/modules/ipc/handlers'
import { createHarness, failedVerification, fileWorker, passedVerification, plan, plannedTask, scenarioScript, type Harness } from './harness'

/**
 * 0.7.2: outcome learning. What became of a mission is written down when it ends, with the advice it was admitted
 * with; the record is shown, and given to the next Director request as evidence. Real orchestrator, scripted
 * providers.
 */
describe('scenario: what became of advised work', () => {
  let h: Harness
  let off: (() => void) | null = null
  afterEach(async () => {
    off?.()
    off = null
    await h?.dispose()
  })

  const ADVICE = 'Keep the public API of the parser unchanged.'
  function strategic(): { connection: ChatGPTConnection; sent: { instructions: string; data: unknown }[] } {
    const sent: { instructions: string; data: unknown }[] = []
    const complete = async (instructions: string, data: unknown): Promise<unknown> => {
      sent.push({ instructions, data })
      if (instructions.startsWith('INTENT_DRIFT_CHECK')) return { changesIntent: false, expandsScope: false, conflicts: [], unjustifiedRequirements: [] }
      if (instructions.includes('Produce objective')) return { objective: 'Decide', recommendation: 'Go on.', rationale: [], alternatives: [], risks: [], unknowns: [], requestedExperiments: [], evidenceRefs: [], confidence: 'MEDIUM' }
      return { recommendations: [{ text: ADVICE, kind: 'CONSTRAINT', provenance: 'DIRECTOR_RECOMMENDED', evidenceRefs: [], requiresDecision: false }], scopeChanged: false, ambiguities: [] }
    }
    const connection = {
      status: () => ({ state: 'SIGNED_IN_PLAN_USAGE', activeProfile: 'test', model: 'fake-gpt', capacity: null, includedOnlyConfirmed: true, profiles: [], models: [], error: null }),
      provider: () => ({ complete, usage: () => null }),
      canInfer: () => true,
    } as unknown as ChatGPTConnection
    return { connection, sent }
  }
  async function invoke<C extends IpcChannel>(chatgpt: ChatGPTConnection, channel: C, input: IpcInput<C>): Promise<IpcOutputs[C]> {
    const handlers = createIpcHandlers({
      repos: h.repos, git: h.git, runtime: h.runtime, orchestrator: h.orchestrator, chatgpt,
      appInfo: async () => ({ version: 'test', dataDir: h.dir, dbPath: h.dbPath, worktreesDir: h.worktreesDir, platform: 'win32', gitVersion: 'test', sdkVersion: 'fake', isPackaged: false }),
      pickDirectory: async () => null, openDataDir: async () => undefined, push: () => undefined,
    })
    const result = await dispatchIpc(handlers, channel, input)
    if (!result.ok) throw new Error(`${channel} failed: ${result.error.message}`)
    return result.value as IpcOutputs[C]
  }

  it('writes the outcome of each mission once, by the advice it was admitted with, and gives the record to the next Director request', async () => {
    let verifications = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('alpha')]),
        worker: fileWorker,
        // The first mission's task is rejected once, then passes: one repair attempt. The others pass at once.
        verifier: async (_spec, ctx) => ctx.completeTurn({ text: 'verify', structuredOutput: ++verifications === 1 ? failedVerification() : passedVerification }),
      }),
    })
    off = attachAdviceOutcomes(h.bus, h.repos)
    const { connection, sent } = strategic()
    expect(adviceLearning(h.repos, h.project.id)).toMatchObject({ total: 0, groups: [] })
    expect(learningEvidence(h.repos, h.project.id)).toBeNull()

    const developed = await invoke(connection, 'runs.create', { projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Change the parser to accept trailing commas.', compilationMode: 'STANDARD' })
    expect((await h.waitForState(developed.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const exact = await invoke(connection, 'runs.create', { projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Rename the helper in the parser.', compilationMode: 'EXACT' })
    expect((await h.waitForState(exact.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const cancelled = await invoke(connection, 'runs.create', { projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: 'Rewrite the parser tests.', compilationMode: 'EXACT', requirePlanApproval: true })
    await h.waitFor(() => h.repos.runs.require(cancelled.id).state === 'awaiting_approval' || h.repos.runs.require(cancelled.id).state === 'planning', 'the third mission to start')
    await h.orchestrator.cancelRun(cancelled.id)
    await h.waitFor(() => h.repos.intelligenceArtifacts.adviceOutcomes(h.project.id).length === 3, 'three outcomes on record')

    const learning = await invoke(connection, 'director.learning', { projectId: h.project.id })
    expect(learning.total).toBe(3)
    const byDepth = Object.fromEntries(learning.groups.map((g) => [g.depth, g]))
    expect(byDepth['STANDARD']).toMatchObject({ sourceKind: 'SPECIFICATION', runs: 1, verified: 1, failed: 0, cancelled: 0 })
    expect(byDepth['STANDARD']!.repairs).toBeGreaterThanOrEqual(1)
    expect(byDepth['EXACT']).toMatchObject({ runs: 2, verified: 1, cancelled: 1, repairs: 0 })
    expect(learning.recent.find((o) => o.runId === developed.id)).toMatchObject({ recommendations: 1, verified: true, runState: 'completed' })

    // Written once: recording again changes nothing.
    expect(recordAdviceOutcome(h.repos, developed.id)).toEqual([])
    expect(h.repos.intelligenceArtifacts.adviceOutcomes(h.project.id)).toHaveLength(3)

    // The next Director request of the project is given the record as evidence: counts, no model text.
    const before = sent.length
    const advice = await invoke(connection, 'director.invoke', { projectId: h.project.id, objective: 'Should the next parser change be developed first?', level: 2 })
    expect(advice.state).toBe('COMPLETED')
    const evidence = JSON.stringify(sent[before]!.data)
    expect(evidence).toContain('What became of earlier missions of this project')
    expect(evidence).toContain('Specification, STANDARD depth: 1 mission(s), 1 verified')
    expect(evidence).toContain('Specification, EXACT depth: 2 mission(s), 1 verified, 0 failed, 1 cancelled')
    expect(evidence).not.toContain(ADVICE)
    expect(advice.dependencies.some((d) => d.id === `advice-outcomes:${h.project.id}`)).toBe(true)
  })

  it('records nothing for a read-only run or a mission that has not ended', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker: fileWorker }) })
    off = attachAdviceOutcomes(h.bus, h.repos)
    const ask = await h.startRun({ mode: 'ask', prompt: 'What is here?' })
    expect((await h.waitForState(ask.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(recordAdviceOutcome(h.repos, ask.id)).toEqual([])
    expect(h.repos.intelligenceArtifacts.adviceOutcomes(h.project.id)).toEqual([])
  })
})
