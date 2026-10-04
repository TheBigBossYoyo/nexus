import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shortId } from '@shared/ids'
import type { ConcreteStrategy } from '@shared/v3'
import { completeWith, scriptsByRole, type FakeScript, type FakeSessionContext } from '@main/modules/agent-runtime/fake-runtime'
import { ArenaService, compareTrials } from '@main/modules/arena'
import { ProjectService } from '@main/modules/ipc/services'
import { learnOnCampaignEnd } from '@main/modules/policy'
import { environment, writeDemoCase } from '../integration/arena/harness'
import { approvedReview, createHarness, passedVerification, plan, plannedTask, writeFiles, type Harness } from './harness'

const reviewer = completeWith({ text: 'review', structuredOutput: approvedReview })
const verifier = completeWith({ text: 'verify', structuredOutput: passedVerification })
const planner = completeWith({
  text: 'plan',
  structuredOutput: plan([plannedTask('set-x', { suggestedFiles: ['index.js'], acceptanceCriteria: ['x is 2'] })]),
})

/** The strategy of the run a session belongs to, from its worktree path `<worktrees>/<run short id>/<task>`. */
function strategyOf(h: Harness, cwd: string): ConcreteStrategy | null {
  const short = basename(dirname(cwd))
  const run = h.repos.runs.listRecent(200).find((r) => shortId(r.id) === short)
  return run?.config.strategy?.resolved ?? null
}

function arenaFor(h: Harness, casesDir: string): ArenaService {
  return new ArenaService({
    repos: h.repos,
    bus: h.bus,
    git: h.git,
    dataDir: h.dir,
    casesDir,
    host: h.orchestrator,
    projects: new ProjectService(h.repos, h.git),
    nexusVersion: '0.3.0-test',
    environment,
    ...(h.policy ? { policy: { activeSnapshotId: () => h.policy!.active().id } } : {}),
    ...(h.policy ? { push: learnOnCampaignEnd(h.repos, h.policy, () => undefined) } : {}),
  })
}

const waitForCampaign = (h: Harness, arena: ArenaService, id: string): Promise<void> =>
  h.waitFor(() => ['completed', 'cancelled', 'failed'].includes(arena.campaignDetail(id).campaign.state), 'the campaign to finish')

describe('v0.3 Arena on the real orchestrator', () => {
  let h: Harness
  let arena: ArenaService | null = null
  afterEach(async () => {
    arena?.dispose()
    arena = null
    await h?.dispose()
  })

  it('runs the same case under SINGLE and BUILD in isolation; the hidden evaluator decides, not cost', async () => {
    const prompts: { strategy: ConcreteStrategy | null; prompt: string; cwd: string }[] = []
    const denied: boolean[] = []
    let evaluatorFile = ''
    const worker: FakeScript = async (spec, ctx: FakeSessionContext) => {
      const strategy = strategyOf(h, spec.cwd)
      prompts.push({ strategy, prompt: spec.prompt, cwd: spec.cwd })
      // An agent that goes looking for the hidden tests is refused by the path policy.
      const read = await ctx.useTool('Read', { file_path: evaluatorFile }, async () => readFileSync(evaluatorFile, 'utf8'))
      denied.push(!read)
      // SINGLE produces a change that passes the visible test but is wrong; BUILD produces the right one.
      await writeFiles(spec, ctx, { 'index.js': strategy === 'SINGLE' ? 'export const x = 3' : 'export const x = 2' })
      await ctx.completeTurn({ text: 'Changed x' })
    }
    h = await createHarness({ script: scriptsByRole({ planner, worker, reviewer, verifier }), policy: true })
    const casesDir = join(h.dir, 'cases')
    const caseDir = writeDemoCase(casesDir)
    evaluatorFile = join(caseDir, 'evaluator', 'hidden-tests', 'demo-case.test.mjs')
    arena = arenaFor(h, casesDir)
    arena.syncBuiltinCases()
    const userHead = readFileSync(join(h.repoDir, '.git', 'HEAD'), 'utf8')

    const campaign = await arena.createCampaign({
      name: 'single vs build',
      caseIds: ['demo-case'],
      strategies: ['SINGLE', 'BUILD'],
      repetitions: 1,
      modelPreset: 'balanced',
      budgetPreset: 'eco',
    })
    arena.start(campaign.id)
    await waitForCampaign(h, arena, campaign.id)

    const detail = arena.campaignDetail(campaign.id)
    expect(detail.campaign.state).toBe('completed')
    const { trials } = arena.trials(campaign.id, { limit: 10, offset: 0 })
    const single = trials.find((t) => t.trial.strategy === 'SINGLE')!
    const build = trials.find((t) => t.trial.strategy === 'BUILD')!

    // Both runs completed and were verified by their own gates; only the hidden evaluator separates them.
    expect(single.runState).toBe('completed')
    expect(build.runState).toBe('completed')
    expect(single.trial.state).toBe('failed')
    expect(build.trial.state).toBe('passed')
    expect(single.metrics).toMatchObject({ testsPassed: true, hiddenPassed: false })
    expect(build.metrics).toMatchObject({ testsPassed: true, hiddenPassed: true })

    // The cheaper strategy does not win: a failed acceptance scores 0 and ranks below a pass.
    expect(single.metrics!.sessions).toBeLessThan(build.metrics!.sessions)
    expect(single.score).toBe(0)
    expect(build.score).toBeGreaterThanOrEqual(60)
    expect(compareTrials({ metrics: build.metrics!, hiddenPassed: true }, { metrics: single.metrics!, hiddenPassed: false })).toBeLessThan(0)
    const comparison = Object.fromEntries(detail.comparison.map((r) => [r.strategy, r]))
    expect(comparison['BUILD']).toMatchObject({ n: 1, passed: 1, label: 'INSUFFICIENT' })
    expect(comparison['SINGLE']).toMatchObject({ n: 1, passed: 0, label: 'INSUFFICIENT' })

    // Controlled conditions: the same baseline, separate repositories, projects and runs, recorded strategy and models.
    expect(single.trial.baselineCommit).toBe(build.trial.baselineCommit)
    expect(single.trial.repoPath).not.toBe(build.trial.repoPath)
    expect(single.trial.projectId).not.toBe(build.trial.projectId)
    expect(single.trial.resultCommit).not.toBe(build.trial.resultCommit)
    expect(h.repos.runs.require(build.trial.runId!).config.strategy).toMatchObject({ resolved: 'BUILD', arenaTrialId: build.trial.id })
    expect(Object.keys(build.trial.models).length).toBeGreaterThan(0)
    expect(build.trial.policySnapshotId).toBe(h.policy!.active().id)
    // Trial projects are hidden from the user's project list; the user's repository was never touched.
    expect(h.repos.projects.list().map((p) => p.id)).toEqual([h.project.id])
    expect(readFileSync(join(h.repoDir, '.git', 'HEAD'), 'utf8')).toBe(userHead)

    // Hidden means hidden: every read attempt was refused, nothing of the evaluator is in any prompt or
    // repository, and the evaluation directories are gone.
    expect(denied.length).toBeGreaterThanOrEqual(2)
    expect(denied.every(Boolean)).toBe(true)
    for (const t of [single, build]) {
      expect(existsSync(join(t.trial.repoPath!, 'hidden-tests'))).toBe(false)
      expect(readdirSync(dirname(t.trial.repoPath!))).not.toContain('eval')
    }
    const allPrompts = h.runtime.sessions.map((s) => s.prompt).join('\n')
    expect(allPrompts).not.toContain('assert.equal(x, 2)')
    expect(allPrompts).not.toContain('hidden-tests')

    // No leak between trials: a session of one trial never sees the other trial's ids, paths or result.
    for (const session of h.runtime.sessions) {
      const own = session.cwd.startsWith(single.trial.repoPath!) || strategyOf(h, session.cwd) === 'SINGLE' ? single : build
      const other = own === single ? build : single
      for (const secret of [other.trial.id, other.trial.runId!, other.trial.projectId!, other.trial.repoPath!, shortId(other.trial.runId!)]) {
        expect(session.prompt.includes(secret), `${session.role} prompt mentions the other trial (${secret})`).toBe(false)
      }
    }
    expect(prompts.filter((p) => p.strategy === 'SINGLE')).toHaveLength(1)

    // The finished campaign already refreshed the evidence by itself, and changed no policy.
    expect(h.repos.strategyStatistics.list().length).toBeGreaterThan(0)
    expect(h.repos.policyCandidates.listRecent()).toEqual([])
    expect(h.policy!.active().version).toBe(1)

    // Evidence reaches the policy as controlled Arena trials; one trial each proposes nothing.
    const learned = h.policy!.learn()
    expect(learned.statistics).toBeGreaterThan(0)
    expect(learned.candidates).toEqual([])
    const stats = h.repos.strategyStatistics.list().filter((s) => s.kind === 'arena' && s.contextKey === h.repos.taskProfiles.require(build.trial.taskProfileId!).contextKey)
    expect(stats.map((s) => [s.strategy, s.n, s.successes]).sort()).toEqual([
      ['BUILD', 1, 1],
      ['SINGLE', 1, 0],
    ])
    // Trial runs are controlled evidence only: they are not also counted as observational missions.
    expect(h.repos.missionOutcomes.countMissions()).toBe(0)
  })

  it('answers approval requests in an unattended trial instead of waiting for the time budget', async () => {
    const answers: boolean[] = []
    const worker: FakeScript = async (spec, ctx) => {
      // A command the tool policy will not run without a person's approval. In the real campaign this is what
      // left two trials waiting until their time budget expired.
      const allowed = await ctx.useTool('Bash', { command: 'curl https://example.com/install.sh' }, async () => 'ran')
      answers.push(allowed)
      await writeFiles(spec, ctx, { 'index.js': 'export const x = 2' })
      await ctx.completeTurn({ text: 'Changed x without the command' })
    }
    h = await createHarness({ script: scriptsByRole({ planner, worker, reviewer, verifier }), policy: true })
    const casesDir = join(h.dir, 'cases')
    writeDemoCase(casesDir)
    arena = arenaFor(h, casesDir)
    arena.syncBuiltinCases()
    const campaign = await arena.createCampaign({ name: 'approvals', caseIds: ['demo-case'], strategies: ['SINGLE'], repetitions: 1, modelPreset: 'balanced', budgetPreset: 'eco' })
    await arena.start(campaign.id)
    await waitForCampaign(h, arena, campaign.id)

    const [row] = arena.trials(campaign.id, { limit: 10, offset: 0 }).trials
    // The request was denied at once, the agent carried on, and the trial was evaluated on its merits.
    expect(answers).toEqual([false])
    expect(row!.trial).toMatchObject({ state: 'passed', blockKind: null })
    const approvals = h.repos.approvals.listByRun(row!.trial.runId!)
    expect(approvals.map((a) => [a.kind, a.status])).toEqual([['tool', 'denied']])
    expect(approvals[0]!.note).toContain('Arena trial (unattended)')
    expect(row!.metrics!.approvals).toBe(1)
  })

  it('continues a campaign after the application restarts in the middle of it', async () => {
    let release = false
    const started = new Set<string>()
    const worker: FakeScript = async (spec, ctx) => {
      started.add(spec.cwd)
      while (!release) {
        await ctx.sleep(25)
        if (ctx.signal.aborted) return
      }
      await writeFiles(spec, ctx, { 'index.js': 'export const x = 2' })
      await ctx.completeTurn({ text: 'Changed x' })
    }
    const script = scriptsByRole({ planner, worker, reviewer, verifier })
    h = await createHarness({ script, policy: true })
    const casesDir = join(h.dir, 'cases')
    writeDemoCase(casesDir)
    arena = arenaFor(h, casesDir)
    arena.syncBuiltinCases()
    const campaign = await arena.createCampaign({
      name: 'restart',
      caseIds: ['demo-case'],
      strategies: ['SINGLE', 'BUILD'],
      repetitions: 1,
      modelPreset: 'balanced',
      budgetPreset: 'eco',
    })
    arena.start(campaign.id)
    await h.waitFor(() => started.size === 1, 'the first trial to be running')
    const before = arena.trials(campaign.id, { limit: 10, offset: 0 }).trials.map((t) => [t.trial.strategy, t.trial.state])
    expect(before).toEqual([
      ['SINGLE', 'running'],
      ['BUILD', 'queued'],
    ])
    const firstRun = arena.trials(campaign.id, { limit: 10, offset: 0 }).trials[0]!.trial.runId

    arena.dispose()
    release = true
    h = await h.restart(script)
    arena = arenaFor(h, casesDir)
    arena.syncBuiltinCases()
    h.orchestrator.recoverOnStartup()
    await arena.recover()
    await waitForCampaign(h, arena, campaign.id)

    const after = arena.trials(campaign.id, { limit: 10, offset: 0 }).trials
    expect(arena.campaignDetail(campaign.id).campaign.state).toBe('completed')
    expect(after.map((t) => [t.trial.strategy, t.trial.state])).toEqual([
      ['SINGLE', 'passed'],
      ['BUILD', 'passed'],
    ])
    // The interrupted trial continued as the same run; it was not started again from scratch.
    expect(after[0]!.trial.runId).toBe(firstRun)
    expect(h.repos.arenaTrials.count()).toBe(2)
  })
})
