import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROGRAM_POLICY_PRESETS } from '@shared/program'
import { completeWith, scriptsByRole, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { ProgramEngine, REASONING_MARKERS } from '@main/modules/program'
import { judgmentJson, milestone, planJson, replanJson } from '../integration/program/harness'
import { approvedReview, createHarness, git, passedVerification, plan, plannedTask, writeFiles, type Harness } from './harness'

/**
 * A program on the real orchestrator with the scripted runtime: the planner, the missions, the milestone
 * verifier and the reassessment are all real runs; only Claude's words are scripted.
 */
describe('v0.4 program on the real orchestrator', () => {
  let h: Harness
  let engine: ProgramEngine | null = null
  afterEach(async () => {
    engine?.dispose()
    await engine?.idle()
    engine = null
    await h?.dispose()
  })

  const untilState = async (programId: string, states: string[], timeoutMs = 200_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await engine!.idle()
      const program = h.repos.programs.require(programId)
      if (states.includes(program.state)) return
      if (Date.now() > deadline) throw new Error(`The program is ${program.state} (${program.blockedReason ?? program.pauseReason ?? ''}); decisions: ${h.repos.programDecisions.listByProgram(programId).map((d) => `${d.kind}: ${d.summary}`).join(' | ')}`)
      await engine!.tick()
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('two milestones, two missions that build on each other, one rejection, a revision, memory and backlog; the user checkout is untouched', async () => {
    const verdicts = [
      // The first mission of the first milestone is rejected by the milestone verifier, with a backlog item and a memory entry.
      judgmentJson('rejected', {
        gaps: ['The module has no exported version'],
        backlog: [{ title: 'No lint command configured', description: 'The project has no lint script.', category: 'debt', severity: 'low', evidence: 'package.json has no lint script', complexity: 'small', dependencies: [], recommendedMilestone: null }],
        memory: [{ kind: 'interface', title: 'Core module exports', content: 'The core module is consumed through its named exports; the api milestone imports from it.', evidence: 'core.txt is the only file of the core module', tags: ['core', 'api'] }],
      }),
      judgmentJson('accepted'),
      judgmentJson('accepted'),
    ]
    const replans = [
      replanJson(),
      // After the first milestone is accepted the reassessment renames the remaining milestone's objective and adds one.
      replanJson({ action: 'revise', reason: 'The api needs a smoke check afterwards.', milestones: [milestone('api', { objective: 'Expose the core through an api file.', acceptanceCriteria: ['api.txt exists'], dependsOn: ['core'] })], defer: [], strategyNote: 'Keep each mission to one file.' }),
      replanJson(),
    ]
    const seenByWorker: { cwd: string; coreExisted: boolean; prompt: string }[] = []
    const researcher: FakeScript = async (spec, ctx) => {
      const p = spec.prompt
      const text = p.includes(REASONING_MARKERS.plan)
        ? planJson([milestone('core', { objective: 'Create the core module.', acceptanceCriteria: ['core.txt exists'] }), milestone('api', { objective: 'Expose the core.', acceptanceCriteria: ['api.txt exists'], dependsOn: ['core'] })])
        : p.includes(REASONING_MARKERS.verify)
          ? (verdicts.shift() ?? judgmentJson('accepted'))
          : p.includes(REASONING_MARKERS.replan)
            ? (replans.shift() ?? replanJson())
            : 'no answer'
      await ctx.completeTurn({ text })
    }
    // The mission planner plans one task named after the milestone it was given.
    const planner: FakeScript = async (spec, ctx) => {
      const key = spec.prompt.includes('Milestone api') ? 'api' : 'core'
      const attempt = spec.prompt.includes('verified and rejected') ? 'fix' : 'first'
      await ctx.completeTurn({ text: 'plan', structuredOutput: plan([plannedTask(`${key}-${attempt}`, { suggestedFiles: [`${key}.txt`], acceptanceCriteria: [`${key}.txt exists`] })]) })
    }
    const worker: FakeScript = async (spec, ctx) => {
      const key = spec.prompt.includes('api-') ? 'api' : 'core'
      seenByWorker.push({ cwd: spec.cwd, coreExisted: existsSync(join(spec.cwd, 'core.txt')), prompt: spec.prompt })
      const name = spec.prompt.includes('-fix') ? `${key}-version.txt` : `${key}.txt`
      await writeFiles(spec, ctx, { [name]: `${key}\n` })
      await ctx.completeTurn({ text: `Wrote ${name}` })
    }
    h = await createHarness({
      script: scriptsByRole({ researcher, planner, worker, reviewer: completeWith({ text: 'review', structuredOutput: approvedReview }), verifier: completeWith({ text: 'verify', structuredOutput: passedVerification }) }),
    })
    const userHead = await git(h.repoDir, 'rev-parse', 'HEAD')
    const userStatus = await git(h.repoDir, 'status', '--porcelain')
    engine = new ProgramEngine({ repos: h.repos, bus: h.bus, git: h.git, host: h.orchestrator, tickIntervalMs: 0, push: (m) => void h.pushes.push(m) })

    const program = await engine.create({ projectId: h.project.id, name: 'Scenario program', goal: 'Build a core module and expose it through an api.', policy: { ...PROGRAM_POLICY_PRESETS.autonomous, missionStrategy: 'BUILD', maxAgents: 2 }, start: true })
    await untilState(program.id, ['COMPLETED', 'BLOCKED', 'FAILED'])
    const done = h.repos.programs.require(program.id)
    expect(done.state, done.blockedReason ?? '').toBe('COMPLETED')

    // Three real missions: core (rejected), core again (accepted), api (accepted).
    const missions = h.repos.programMissions.listByProgram(program.id)
    expect(missions.map((m) => m.outcome)).toEqual(['completed', 'completed', 'completed'])
    expect(missions.map((m) => m.strategy)).toEqual(['BUILD', 'BUILD', 'BUILD'])
    expect(h.repos.milestones.listByProgram(program.id).map((m) => [m.key, m.state, m.attempts])).toEqual([
      ['core', 'COMPLETED', 2],
      ['api', 'COMPLETED', 1],
    ])
    expect(done.outcome).toMatchObject({ result: 'completed', milestonesCompleted: 2, missions: 3 })

    // Missions build on each other: the retry started from the first attempt, the api mission from the accepted core.
    expect(missions[0]!.baseCommit).toBe(userHead)
    expect(missions[1]!.baseCommit).toBe(missions[0]!.resultCommit)
    expect(missions[2]!.baseCommit).toBe(missions[1]!.resultCommit)
    expect(seenByWorker.map((w) => w.coreExisted)).toEqual([false, true, true])
    // The gaps of the rejection reached the second mission's planner; the revision's note reached the third.
    const prompts = missions.map((m) => h.repos.runs.require(m.runId).prompt)
    expect(prompts[1]).toContain('The module has no exported version')
    expect(prompts[2]).toContain('Keep each mission to one file.')
    // Selective memory: the entry about the core's exports is relevant to the api milestone and was given to it.
    expect(prompts[2]).toContain('Core module exports')

    // The accepted work is on the program branch and nowhere in the user's checkout.
    const files = (await git(h.repoDir, 'ls-tree', '--name-only', '-r', done.branch!)).split('\n')
    expect(files).toEqual(expect.arrayContaining(['core.txt', 'core-version.txt', 'api.txt']))
    expect(await git(h.repoDir, 'rev-parse', done.branch!)).toBe(missions[2]!.resultCommit)
    expect(await git(h.repoDir, 'rev-parse', 'HEAD')).toBe(userHead)
    expect(await git(h.repoDir, 'status', '--porcelain')).toBe(userStatus)
    expect(existsSync(join(h.repoDir, 'core.txt'))).toBe(false)

    // The plan was revised once, with a stored diff; backlog and memory were kept.
    const revisions = h.repos.planRevisions.listByProgram(program.id)
    expect(revisions.map((r) => [r.version, r.trigger, r.status])).toEqual([
      [1, 'initial', 'accepted'],
      [2, 'milestone_completed', 'accepted'],
    ])
    expect(revisions[1]!.diff.changed).toEqual([{ key: 'api', fields: ['objective'] }])
    expect(h.repos.backlog.list({ programId: program.id }).map((b) => [b.title, b.status, b.provenance.source])).toEqual([['No lint command configured', 'proposed', 'milestone_verifier']])
    expect(h.repos.programMemory.listActive(program.id).map((m) => m.title)).toEqual(['Core module exports'])
    // Reasoning sessions were read-only runs and changed nothing.
    for (const run of h.repos.runs.listByProject(h.project.id).filter((r) => r.mode === 'ask')) expect(run.integrationBranch).toBeNull()
  })
})
