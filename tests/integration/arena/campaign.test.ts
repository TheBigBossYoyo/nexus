import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NexusError } from '@shared/result'
import { newId } from '@shared/ids'
import type { ArenaCampaign, TrialState } from '@shared/v3'
import { importCase } from '@main/modules/arena'
import { makeRig, sleep, waitFor, writeDemoCase, type ArenaRig, type Behavior } from './harness'

let rig: ArenaRig | null = null
afterEach(async () => {
  await rig?.cleanup()
  rig = null
})

const states = (r: ArenaRig, campaignId: string): TrialState[] => r.repos.arenaTrials.listByCampaign(campaignId).map((t) => t.state)
const campaignState = (r: ArenaRig, id: string): string => r.repos.arenaCampaigns.require(id).state

async function create(r: ArenaRig, over: Partial<Parameters<ArenaRig['service']['createCampaign']>[0]> = {}): Promise<ArenaCampaign> {
  r.service.syncBuiltinCases()
  return r.service.createCampaign({
    name: 'test',
    caseIds: ['demo-case'],
    strategies: ['SINGLE', 'BUILD'],
    repetitions: 1,
    modelPreset: 'balanced',
    budgetPreset: 'eco',
    ...over,
  })
}

describe('campaign creation and persistence', () => {
  it('expands cases x strategies x repetitions deterministically, repetition outermost', async () => {
    rig = makeRig({
      cases: (dir) => {
        writeDemoCase(dir, 'case-a')
        writeDemoCase(dir, 'case-b', { allowedStrategies: ['BUILD'] })
      },
    })
    rig.service.syncBuiltinCases()
    const c = await rig.service.createCampaign({
      name: 'x',
      caseIds: ['case-a', 'case-b'],
      strategies: ['SINGLE', 'BUILD'],
      repetitions: 2,
      modelPreset: 'balanced',
      budgetPreset: 'balanced',
    })
    const trials = rig.repos.arenaTrials.listByCampaign(c.id)
    // case-b only allows BUILD
    expect(trials.map((t) => `${t.repetition}:${t.caseId}:${t.strategy}`)).toEqual([
      '1:case-a:SINGLE',
      '1:case-a:BUILD',
      '1:case-b:BUILD',
      // counterbalanced: the strategy order of a case rotates with (case index + repetition)
      '2:case-a:BUILD',
      '2:case-a:SINGLE',
      '2:case-b:BUILD',
    ])
    expect(trials.map((t) => t.ordinal)).toEqual([0, 1, 2, 3, 4, 5])
    expect(trials.every((t) => t.state === 'queued')).toBe(true)
    expect(c.state).toBe('draft')
    expect(c.nexusVersion).toBe('0.3.0-test')
    expect(c.environment.platform).toBe('test')
    const list = rig.service.listCampaigns()
    expect(list.total).toBe(1)
    expect(list.campaigns[0]!.counts.queued).toBe(6)
    expect(rig.service.trials(c.id, { limit: 2 }).trials).toHaveLength(2)
  })

  it('enforces maxTrials and refuses untrusted cases', async () => {
    rig = makeRig()
    rig.service.syncBuiltinCases()
    await expect(
      rig.service.createCampaign({ name: 'x', caseIds: ['demo-case'], strategies: ['SINGLE', 'BUILD'], repetitions: 3, modelPreset: 'balanced', budgetPreset: 'eco', maxTrials: 5 }),
    ).rejects.toThrow(/above the limit of 5/)

    const outside = join(rig.root, 'imports')
    const dir = writeDemoCase(outside, 'imported-case')
    const imported = importCase(rig.repos, dir)
    expect(imported.commands.at(-1)).toContain('hidden evaluation')
    await expect(
      rig.service.createCampaign({ name: 'x', caseIds: ['imported-case'], strategies: ['SINGLE'], repetitions: 1, modelPreset: 'balanced', budgetPreset: 'eco' }),
    ).rejects.toThrow(/not trusted/)
    rig.service.trustCase(imported.summary.version.id)
    const c = await rig.service.createCampaign({ name: 'x', caseIds: ['imported-case'], strategies: ['SINGLE'], repetitions: 1, modelPreset: 'balanced', budgetPreset: 'eco' })
    expect(c.state).toBe('draft')
  })
})

describe('running a campaign', () => {
  it('runs every trial through provision, run, evaluation and scoring, and persists the raw metrics', async () => {
    rig = makeRig()
    rig.host.behavior = (_i, input) => (input.strategy === 'BUILD' ? 'solve' : 'wrong')
    const c = await create(rig)
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'campaign completion')
    await rig.service.idle()

    const trials = rig.repos.arenaTrials.listByCampaign(c.id)
    const single = trials.find((t) => t.strategy === 'SINGLE')!
    const build = trials.find((t) => t.strategy === 'BUILD')!
    expect(single.state).toBe('failed')
    expect(build.state).toBe('passed')
    for (const t of trials) {
      expect(t.baselineCommit).toMatch(/^[0-9a-f]{40}$/)
      expect(t.resultCommit).toMatch(/^[0-9a-f]{40}$/)
      expect(t.resultCommit).not.toBe(t.baselineCommit)
      expect(t.projectId).not.toBeNull()
      expect(t.finishedAt).not.toBeNull()
      expect(rig!.repos.projects.isArena(t.projectId!)).toBe(true)
    }
    const detailBuild = rig.service.trial(build.id)
    expect(detailBuild.evaluation!.passed).toBe(true)
    expect(detailBuild.evaluation!.score).toBeGreaterThanOrEqual(60)
    expect(detailBuild.evaluation!.scoreVersion).toBe('score-v1')
    expect(detailBuild.metrics!.hiddenPassed).toBe(true)
    expect(detailBuild.metrics!.sessions).toBe(1)
    expect(detailBuild.metrics!.inputTokens).toBe(1000)
    const detailSingle = rig.service.trial(single.id)
    expect(detailSingle.evaluation!.passed).toBe(false)
    expect(detailSingle.evaluation!.score).toBe(0)
    expect(detailSingle.metrics!.hiddenPassed).toBe(false)
    expect(detailSingle.metrics!.sessions).toBe(1) // raw metrics are kept for a failed trial

    const detail = rig.service.campaignDetail(c.id)
    expect(detail.counts.passed).toBe(1)
    expect(detail.counts.failed).toBe(1)
    expect(detail.matrix).toHaveLength(2)
    expect(detail.comparison.map((r) => [r.strategy, r.passed, r.n])).toEqual([['SINGLE', 0, 1], ['BUILD', 1, 1]])
    const results = rig.service.results({ campaignId: c.id })
    expect(results.totalTrials).toBe(2)
    expect(results.notes.join(' ')).toContain('n is below 5')

    // the host was told how to run it
    const input = rig.host.created[0]!
    expect(input.prompt).toContain('Make x equal 2.')
    expect(input.prompt).toContain('- x is 2')
    expect(input.overrides).toMatchObject({ requirePlanApproval: false, maxParallelAgents: 2, maxTurnsPerAgent: 60 })
    expect(input.overrides!['checks']).toMatchObject({ test: 'node --test' })
    // the eval directories are gone
    for (const t of trials) expect(existsSync(join(t.repoPath!, '..', 'eval'))).toBe(false)
  })

  it('blocks a failed provisioning without stopping the campaign', async () => {
    rig = makeRig()
    let calls = 0
    const realProvision = (await import('@main/modules/arena')).provisionTrial
    rig = makeRig({
      overrides: {
        provision: async (input) => {
          if (calls++ === 0) throw new Error('disk full')
          return realProvision(input)
        },
      },
    })
    const c = await create(rig)
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    const trials = rig.repos.arenaTrials.listByCampaign(c.id)
    expect(trials[0]!.state).toBe('blocked')
    expect(trials[0]!.detail).toContain('disk full')
    expect(trials[0]!.blockKind).toBe('infrastructure')
    expect(rig.repos.arenaEvaluations.latestForTrial(trials[0]!.id)).toBeNull()
    expect(trials[1]!.state).toBe('passed')
    // an unrun trial does not count against its strategy
    const rows = rig.service.campaignDetail(c.id).comparison
    expect(rows.map((r) => [r.strategy, r.n, r.excludedInfrastructure])).toEqual([['SINGLE', 0, 1], ['BUILD', 1, 0]])
    expect(rig.service.results({ campaignId: c.id }).notes.join(' ')).toContain('left out because the harness blocked it')
  })

  it('a failed run is a failed trial with the evaluator not run; the evaluator never sees an unfinished run', async () => {
    rig = makeRig()
    const behaviors: Behavior[] = ['fail', 'nocommit']
    rig.host.behavior = (i) => behaviors[i]!
    const c = await create(rig)
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    const [failed, nocommit] = rig.repos.arenaTrials.listByCampaign(c.id)
    expect(failed!.state).toBe('failed')
    const ev = rig.repos.arenaEvaluations.latestForTrial(failed!.id)!
    expect(ev.skippedReason).toContain('planner gave up')
    expect(ev.passed).toBe(false)
    expect(ev.score).toBe(0)
    expect(nocommit!.state).toBe('failed')
    expect(rig.repos.arenaEvaluations.latestForTrial(nocommit!.id)!.skippedReason).toContain('without an integration commit')
  })

  it('isolates trials: nothing of trial A reaches trial B', async () => {
    rig = makeRig()
    const marker = `MARKER-${newId()}`
    rig.host.onCreated = (run, input) => {
      if (input.strategy !== 'SINGLE') return
      // Trial A leaves facts, memory and reviewer output behind.
      const projectId = run.projectId
      rig!.repos.facts.insert({
        id: newId(),
        projectId,
        kind: 'convention',
        subject: 'a',
        statement: marker,
        source: 'agent',
        confidence: 'high',
        files: [],
        fingerprint: 'x',
        stale: false,
        createdAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      } as never)
    }
    const c = await create(rig, { maxConcurrentTrials: 2 })
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    const [a, b] = rig.repos.arenaTrials.listByCampaign(c.id)
    expect(a!.projectId).not.toBe(b!.projectId)
    expect(a!.runId).not.toBe(b!.runId)
    expect(a!.repoPath).not.toBe(b!.repoPath)
    const runB = rig.repos.runs.require(b!.runId!)
    const inputB = rig.host.created.find((i) => i.arenaTrialId === b!.id)
    const blob = JSON.stringify([runB, rig.repos.projects.require(b!.projectId!), inputB])
    for (const secret of [a!.id, a!.runId!, a!.projectId!, a!.repoPath!, a!.resultCommit!, marker]) {
      expect(blob).not.toContain(secret)
    }
    expect(rig.repos.facts.listByProject(b!.projectId!).some((f) => JSON.stringify(f).includes(marker))).toBe(false)
    expect(rig.repos.facts.listByProject(a!.projectId!).some((f) => JSON.stringify(f).includes(marker))).toBe(true)
    // the prompt contains neither the evaluator's content nor its location
    for (const input of rig.host.created) {
      expect(input.prompt).not.toContain('hidden-tests')
      expect(input.prompt).not.toContain('assert.equal(x, 2)')
    }
    // and the case's evaluator directory is not under any trial repository
    for (const t of [a!, b!]) expect(readdirSync(t.repoPath!)).not.toContain('hidden-tests')
  })

  it('never exceeds maxConcurrentTrials and starts trials in ordinal order', async () => {
    rig = makeRig()
    rig.host.delayMs = 40
    let live = 0
    let peak = 0
    rig.bus.subscribe((e) => {
      if (e.type === 'run.completed') live--
    })
    const orig = rig.host.createRun.bind(rig.host)
    rig.host.createRun = async (input) => {
      live++
      peak = Math.max(peak, live)
      return orig(input)
    }
    const c = await create(rig, { strategies: ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS'], maxConcurrentTrials: 2 })
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBe(2)
    const started = rig.repos.arenaTrials.listByCampaign(c.id).map((t) => t.startedAt!)
    expect([...started].sort()).toEqual(started)
  })
})

describe('budgets', () => {
  it('stops at maxAgentSessions: the rest is cancelled and the campaign completes with a note', async () => {
    rig = makeRig()
    rig.host.sessionsPerRun = 2
    const c = await create(rig, { strategies: ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS'], maxAgentSessions: 3 })
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    const s = states(rig, c.id)
    expect(s.filter((x) => x === 'passed')).toHaveLength(2)
    expect(s.filter((x) => x === 'cancelled')).toHaveLength(2)
    const final = rig.repos.arenaCampaigns.require(c.id)
    expect(final.error).toContain('maxAgentSessions')
    expect(rig.repos.arenaTrials.listByCampaign(c.id).filter((t) => t.state === 'cancelled').every((t) => t.detail?.includes('maxAgentSessions'))).toBe(true)
  })

  it('cancels a run that exceeds the case wall-clock budget and blocks the trial with the reason', async () => {
    rig = makeRig({ overrides: { minuteMs: 25 }, cases: (dir) => writeDemoCase(dir, 'demo-case', { budgets: { maxWallClockMinutes: 4, maxAgentSessions: 20, maxAgentsPerTrial: 2, maxTurnsPerAgent: 60 } }) })
    rig.host.behavior = () => 'hang'
    const c = await create(rig, { strategies: ['SINGLE'] })
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    const t = rig.repos.arenaTrials.listByCampaign(c.id)[0]!
    expect(t.state).toBe('blocked')
    expect(t.detail).toContain('wall-clock budget')
    expect(t.blockKind).toBe('timeout')
    // a timeout is a failure of the strategy: it is IN n (not passed), not dropped
    expect(rig.service.campaignDetail(c.id).comparison[0]).toMatchObject({ strategy: 'SINGLE', n: 1, passed: 0, excludedInfrastructure: 0 })
    expect(rig.host.cancelled).toContain(t.runId)
    expect(rig.repos.arenaMetrics.getByTrial(t.id)).not.toBeNull()
    expect(rig.repos.arenaEvaluations.latestForTrial(t.id)!.passed).toBe(false)
  })

  it('stops the campaign at maxWallClockMinutes', async () => {
    rig = makeRig({ overrides: { minuteMs: 30 } })
    rig.host.behavior = () => 'hang'
    const c = await create(rig, { strategies: ['SINGLE', 'BUILD'], maxWallClockMinutes: 3 })
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    expect(rig.repos.arenaCampaigns.require(c.id).error).toContain('maxWallClockMinutes')
    expect(states(rig, c.id).every((s) => s === 'cancelled')).toBe(true)
  })

  it('caps agents per trial with the lower of the campaign and the case limit', async () => {
    rig = makeRig()
    const c = await create(rig, { strategies: ['SINGLE'], maxAgentsPerTrial: 1 })
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    expect(rig.host.created[0]!.overrides).toMatchObject({ maxParallelAgents: 1 })
  })
})

describe('control', () => {
  it('cancels a running campaign: queued trials, the running trial and its run', async () => {
    rig = makeRig()
    rig.host.behavior = () => 'hang'
    const c = await create(rig, { strategies: ['SINGLE', 'BUILD', 'SWARM'] })
    await rig.service.start(c.id)
    await waitFor(() => rig!.host.created.length === 1, 'first run')
    rig.service.cancel(c.id)
    expect(campaignState(rig, c.id)).toBe('cancelled')
    await rig.service.idle()
    expect(states(rig, c.id)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(rig.host.cancelled).toHaveLength(1)
    expect(rig.host.created).toHaveLength(1)
    // cancelling again is harmless
    expect(rig.service.cancel(c.id).state).toBe('cancelled')
  })

  it('pausing starts nothing new and resuming continues', async () => {
    rig = makeRig()
    rig.host.delayMs = 60
    const c = await create(rig, { strategies: ['SINGLE', 'BUILD', 'SWARM'] })
    await rig.service.start(c.id)
    await waitFor(() => rig!.host.created.length === 1, 'first run')
    rig.service.pause(c.id)
    await rig.service.idle()
    await sleep(100)
    expect(rig.host.created).toHaveLength(1)
    expect(states(rig, c.id)).toEqual(['passed', 'queued', 'queued'])
    expect(rig.repos.arenaCampaigns.require(c.id)).toMatchObject({ state: 'paused', pauseReason: 'user' })
    rig.service.resume(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    expect(states(rig, c.id)).toEqual(['passed', 'passed', 'passed'])
  })

  it('refuses invalid transitions', async () => {
    rig = makeRig()
    const c = await create(rig, { strategies: ['SINGLE'] })
    expect(() => rig!.service.pause(c.id)).toThrow(NexusError)
    expect(() => rig!.service.resume(c.id)).toThrow(NexusError)
    await rig.service.start(c.id)
    await expect(rig!.service.start(c.id)).rejects.toThrow(NexusError)
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
  })
})

describe('quota', () => {
  it('pauses the campaign while a run waits for a usage reset and continues after the resume', async () => {
    rig = makeRig()
    rig.host.behavior = (i) => (i === 0 ? 'quota' : 'solve')
    const c = await create(rig, { strategies: ['SINGLE', 'BUILD'] })
    await rig.service.start(c.id)
    await waitFor(() => campaignState(rig!, c.id) === 'paused', 'quota pause')
    expect(rig.repos.arenaCampaigns.require(c.id).pauseReason).toBe('quota')
    await sleep(150)
    expect(rig.host.created).toHaveLength(1) // a paused campaign starts nothing
    expect(states(rig, c.id)).toEqual(['running', 'queued'])

    // the usage service resumes the run; the campaign follows
    const runId = rig.host.created.length ? rig.repos.arenaTrials.listByCampaign(c.id)[0]!.runId! : ''
    await rig.host.resumeRun(runId)
    await rig.host.apply(runId, 'solve')
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    expect(states(rig, c.id)).toEqual(['passed', 'passed'])
    const m = rig.repos.arenaMetrics.getByTrial(rig.repos.arenaTrials.listByCampaign(c.id)[0]!.id)!
    expect(m.sessions).toBeGreaterThanOrEqual(1)
  })

  it('does not start trials while the usage gate is closed and continues when it opens', async () => {
    let open = false
    const listeners = new Set<() => void>()
    rig = makeRig({
      overrides: {
        usage: {
          canDispatch: () => open,
          onChange: (l) => {
            listeners.add(l)
            return () => listeners.delete(l)
          },
        },
      },
    })
    const c = await create(rig, { strategies: ['SINGLE'] })
    await rig.service.start(c.id)
    expect(rig.repos.arenaCampaigns.require(c.id)).toMatchObject({ state: 'paused', pauseReason: 'quota' })
    await sleep(100)
    expect(rig.host.created).toHaveLength(0)
    open = true
    for (const l of listeners) l()
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    expect(states(rig, c.id)).toEqual(['passed'])
  })

  it('a user pause is not undone by the gate opening', async () => {
    let open = false
    const listeners = new Set<() => void>()
    rig = makeRig({ overrides: { usage: { canDispatch: () => open, onChange: (l) => (listeners.add(l), () => listeners.delete(l)) } } })
    const c = await create(rig, { strategies: ['SINGLE'] })
    await rig.service.start(c.id)
    rig.service.pause(c.id)
    open = true
    for (const l of listeners) l()
    await sleep(100)
    expect(rig.repos.arenaCampaigns.require(c.id)).toMatchObject({ state: 'paused', pauseReason: 'user' })
    expect(rig.host.created).toHaveLength(0)
  })
})

describe('recovery after a restart', () => {
  it('continues a campaign with trials in every state', async () => {
    let provisionCalls = 0
    let evaluateCalls = 0
    const never = new Promise<never>(() => undefined)
    const realMod = await import('@main/modules/arena')
    rig = makeRig({
      overrides: {
        provision: (input) => (provisionCalls++ === 0 ? never : realMod.provisionTrial(input)),
        evaluate: (input) => (evaluateCalls++ === 0 ? never : realMod.evaluateTrial(input)),
      },
    })
    // trial 1: provisioning forever. trial 2: run never ends. trial 3: run ends, evaluation never returns. trial 4: queued.
    rig.host.behavior = (_i, input) => (input.strategy === 'BUILD' ? 'hang' : 'solve')
    const c = await create(rig, { strategies: ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS'], maxConcurrentTrials: 3 })
    await rig.service.start(c.id)
    await waitFor(() => states(rig!, c.id).join() === 'provisioning,running,evaluating,queued', 'mid-flight states', 15_000).catch((e) => {
      throw new Error(`${e.message}: ${states(rig!, c.id).join()}`)
    })
    const trials = rig.repos.arenaTrials.listByCampaign(c.id)
    const runningRun = trials[1]!.runId!

    // "Restart": the old process is gone (its in-flight work never completes), a new service takes over.
    rig.service.dispose()
    rig.host.behavior = () => 'solve'
    const restarted = rig.restart({ provision: realMod.provisionTrial, evaluate: realMod.evaluateTrial })
    expect(rig.repos.arenaCampaigns.require(c.id).state).toBe('running')
    restarted.recover()
    // the run of the "running" trial finishes while we were down
    await rig.host.apply(runningRun, 'solve')
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'recovered completion', 120_000)
    expect(states(rig, c.id)).toEqual(['passed', 'passed', 'passed', 'passed'])
    // the provisioning trial was provisioned from scratch, the evaluating one re-evaluated exactly once
    const evaluations = trials.map((t) => rig!.repos.arenaEvaluations.latestForTrial(t.id))
    expect(evaluations.every((e) => e !== null && e.passed)).toBe(true)
    expect(rig.repos.arenaEvaluations.listByCampaign(c.id)).toHaveLength(4)
    expect(rig.repos.arenaMetrics.listByCampaign(c.id)).toHaveLength(4)
  })

  it('cancels open trials of a campaign that was cancelled before the restart', async () => {
    rig = makeRig()
    const c = await create(rig, { strategies: ['SINGLE'] })
    rig.repos.arenaCampaigns.update(c.id, { state: 'cancelled' })
    rig.restart().recover()
    expect(states(rig, c.id)).toEqual(['cancelled'])
  })

  it('resumes a run that was paused for recovery', async () => {
    rig = makeRig()
    rig.host.behavior = () => 'hang'
    const c = await create(rig, { strategies: ['SINGLE'] })
    await rig.service.start(c.id)
    await waitFor(() => rig!.host.created.length === 1, 'run')
    const trial = rig.repos.arenaTrials.listByCampaign(c.id)[0]!
    rig.service.dispose()
    rig.repos.runs.update(trial.runId!, { state: 'paused', pauseReason: 'recovery', resumeState: 'executing' })
    rig.restart().recover()
    await waitFor(() => rig!.host.resumed.includes(trial.runId!), 'run resumed by the arena')
    await rig.host.apply(trial.runId!, 'solve')
    await waitFor(() => campaignState(rig!, c.id) === 'completed', 'completion')
    expect(states(rig, c.id)).toEqual(['passed'])
  })
})
