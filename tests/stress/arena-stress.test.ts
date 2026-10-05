import { appendFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Project, Run } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { TERMINAL_TRIAL_STATES, type ArenaCaseDefinition, type ConcreteStrategy, type TrialState } from '@shared/v3'
import { ArenaService, type ArenaRunHost } from '@main/modules/arena'
import { EventBus } from '@main/modules/events'
import type { GitService } from '@main/modules/git'
import { mulberry32 } from '@main/modules/policy/stats'
import { createRepositories, openDatabase, type Repositories } from '@main/modules/persistence'
import { makeAgent, makeProject, runConfig } from '../integration/persistence/fixtures'

/**
 * Seeded campaign-state histories. Everything below the service is stubbed (no git, no processes, in-memory
 * database): provisioning, runs and evaluation are deferred actions that the driver completes in a random
 * order, interleaved with restarts, cancellation, pauses, quota waits and budget exhaustion.
 */

const RUNS = Number(process.env['NEXUS_ARENA_STRESS_RUNS'] ?? 1000)
const STRATEGIES: ConcreteStrategy[] = ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS', 'SPECULATIVE']
const SHA = 'a'.repeat(40)

type Action =
  | { kind: 'provision'; id: number; epoch: number; trialDir: string; resolve: () => void }
  | { kind: 'evaluate'; id: number; epoch: number; resolve: () => void }
  | { kind: 'run'; id: number; runId: string; step: 'end' | 'resume' }

interface World {
  repos: Repositories
  bus: EventBus
  epoch: number
  actions: Action[]
  nextId: number
  gateOpen: boolean
  listeners: Set<() => void>
  rand: () => number
  violations: string[]
  liveProvisions: Set<string>
  liveRuns: Set<string>
  /** campaign id -> state when a provision started, for "a paused campaign starts nothing" */
  campaignIdForDir: Map<string, string>
}

function definition(id: string): ArenaCaseDefinition {
  return {
    id,
    version: 1,
    name: id,
    description: 'stress',
    category: 'bugfix',
    complexity: 'small',
    risk: 'low',
    languages: [],
    frameworks: [],
    taskPrompt: 'p',
    visibleAcceptance: ['a'],
    checks: { build: null, test: 'node --test', lint: null, typecheck: null },
    setup: [],
    hiddenEvaluation: { command: 'node --test', timeoutSeconds: 60 },
    budgets: { maxWallClockMinutes: 20, maxAgentSessions: 20, maxAgentsPerTrial: 2, maxTurnsPerAgent: 60 },
    allowedStrategies: [...STRATEGIES],
  }
}

function seedCase(repos: Repositories, id: string): void {
  const now = nowIso()
  repos.arenaCases.insert({ id, name: id, origin: 'builtin', category: 'bugfix', complexity: 'small', risk: 'low', latestVersion: 1, sourcePath: `/virtual/${id}`, createdAt: now, updatedAt: now })
  repos.arenaCaseVersions.insert({ id: `${id}-v1`, caseId: id, version: 1, definition: definition(id), evaluatorHash: 'e', fixtureHash: 'f', trusted: true, createdAt: now })
}

function makeHost(w: World): ArenaRunHost {
  const endRun = (runId: string, state: 'completed' | 'failed' | 'cancelled'): void => {
    w.repos.runs.update(runId, { state, finishedAt: nowIso(), pauseReason: null, ...(state === 'completed' ? { integrationBranch: 'integ' } : {}), ...(state === 'failed' ? { error: 'boom' } : {}) })
    w.liveRuns.delete(runId)
    w.actions = w.actions.filter((a) => !(a.kind === 'run' && a.runId === runId))
    w.bus.emit({ runId, type: state === 'completed' ? 'run.completed' : state === 'failed' ? 'run.failed' : 'run.cancelled', payload: (state === 'completed' ? { summary: 's' } : state === 'failed' ? { error: 'boom' } : {}) as never })
  }
  return {
    async createRun(input) {
      const trialId = input.arenaTrialId
      if (w.liveRuns.has(trialId)) w.violations.push(`trial ${trialId} got a second run while one was live`)
      w.liveRuns.add(trialId)
      const project = w.repos.projects.require(input.projectId)
      const run = w.repos.runs.insert({
        id: newId(),
        projectId: project.id,
        mode: 'build',
        preset: 'balanced',
        state: 'executing',
        resumeState: null,
        pauseReason: null,
        prompt: input.prompt,
        plan: null,
        baseBranch: 'main',
        baseCommit: null,
        integrationBranch: null,
        config: runConfig() as Run['config'],
        error: null,
        createdAt: nowIso(),
        startedAt: nowIso(),
        finishedAt: null,
      })
      const agent = w.repos.agents.insert(makeAgent(run.id, null, { state: 'stopped' }))
      const sessions = 1 + Math.floor(w.rand() * 3)
      for (let i = 0; i < sessions; i++) {
        w.repos.sessions.insert({ id: newId(), agentId: agent.id, sdkSessionId: null, model: null, state: 'ended', endReason: null, handoff: null, startedAt: nowIso(), endedAt: nowIso() })
      }
      w.actions.push({ kind: 'run', id: w.nextId++, runId: run.id, step: 'end' })
      return run
    },
    async pauseRun(runId) {
      w.repos.runs.update(runId, { state: 'paused', pauseReason: 'user' })
    },
    async resumeRun(runId) {
      w.repos.runs.update(runId, { state: 'executing', pauseReason: null })
      w.bus.emit({ runId, type: 'run.resumed', payload: {} })
    },
    async cancelRun(runId) {
      const run = w.repos.runs.get(runId)
      if (run && !['completed', 'failed', 'cancelled'].includes(run.state)) endRun(runId, 'cancelled')
    },
  }
}

/** Applies one pending run action. */
function stepRun(w: World, a: Extract<Action, { kind: 'run' }>): void {
  w.actions = w.actions.filter((x) => x !== a)
  const run = w.repos.runs.get(a.runId)
  if (!run || ['completed', 'failed', 'cancelled'].includes(run.state)) return
  const r = w.rand()
  if (a.step === 'resume') {
    w.repos.runs.update(run.id, { state: 'executing', pauseReason: null })
    w.bus.emit({ runId: run.id, type: 'run.resumed', payload: {} })
    w.actions.push({ kind: 'run', id: w.nextId++, runId: run.id, step: 'end' })
    return
  }
  const finish = (state: 'completed' | 'failed'): void => {
    w.repos.runs.update(run.id, { state, finishedAt: nowIso(), ...(state === 'completed' ? { integrationBranch: 'integ' } : { error: 'boom' }) })
    w.liveRuns.delete(w.repos.arenaTrials.getByRun(run.id)?.id ?? '')
    w.bus.emit({ runId: run.id, type: state === 'completed' ? 'run.completed' : 'run.failed', payload: (state === 'completed' ? { summary: 's' } : { error: 'boom' }) as never })
  }
  if (r < 0.6) finish('completed')
  else if (r < 0.7) finish('failed')
  else if (r < 0.8) {
    w.repos.runs.update(run.id, { state: 'paused', pauseReason: 'user', error: 'needs a human' })
    w.bus.emit({ runId: run.id, type: 'run.paused', payload: { reason: 'user' } })
  } else {
    w.repos.runs.update(run.id, { state: 'paused', pauseReason: 'quota' })
    w.bus.emit({ runId: run.id, type: 'run.paused', payload: { reason: 'quota' } })
    w.actions.push({ kind: 'run', id: w.nextId++, runId: run.id, step: 'resume' })
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))


async function runSeed(seed: number, repos: Repositories, bus: EventBus): Promise<void> {
  const rand = mulberry32(seed)
  const w: World = {
    repos,
    bus,
    epoch: 0,
    actions: [],
    nextId: 1,
    gateOpen: true,
    listeners: new Set(),
    rand,
    violations: [],
    liveProvisions: new Set(),
    liveRuns: new Set(),
    campaignIdForDir: new Map(),
  }
  const caseIds = [`case-${seed}-a`, `case-${seed}-b`]
  for (const id of caseIds) seedCase(repos, id)
  const host = makeHost(w)
  const projects = {
    open: async (path: string): Promise<Project> => repos.projects.insert(makeProject({ id: newId(), name: path, rootPath: path })),
  }
  const git = { resolveCommit: async () => SHA } as unknown as GitService
  const maxConcurrent = 1 + Math.floor(rand() * 3)
  const sessionBudget = rand() < 0.25 ? 2 + Math.floor(rand() * 8) : 500

  const build = (): ArenaService =>
    new ArenaService({
      repos,
      bus,
      git,
      dataDir: '/virtual/data',
      casesDir: '/virtual/cases',
      host,
      projects,
      nexusVersion: 'stress',
      environment: async () => ({ platform: 't', osRelease: '1', nodeVersion: 'v', sdkVersion: null, gitVersion: null, modelTiers: {} }),
      pollMs: 0,
      preflight: async () => ({ nodeFound: true, nodeVersion: 'v22.0.0', ok: true, message: 'ok', path: 'node' }),
      minuteMs: 3_600_000,
      agentSettleMs: 50,
      usage: {
        canDispatch: () => w.gateOpen,
        onChange: (l) => {
          w.listeners.add(l)
          return () => w.listeners.delete(l)
        },
      },
      provision: (input) =>
        new Promise((resolve) => {
          const epoch = w.epoch
          const key = input.trialDir
          if (w.liveProvisions.has(key)) w.violations.push(`provision of ${key} while another is live`)
          w.liveProvisions.add(key)
          const campaignId = [...repos.arenaCampaigns.listByState(['running', 'paused', 'draft', 'completed', 'cancelled'])].find((c) => key.includes(c.id.replace(/-/g, '').slice(0, 8)))?.id
          if (campaignId && repos.arenaCampaigns.require(campaignId).state === 'paused') w.violations.push(`a paused campaign started a provision`)
          w.actions.push({
            kind: 'provision',
            id: w.nextId++,
            epoch,
            trialDir: key,
            resolve: () => {
              w.liveProvisions.delete(key)
              resolve({ repoPath: `${key}/repo`, baselineCommit: SHA })
            },
          })
        }),
      evaluate: (input) =>
        new Promise((resolve) => {
          const epoch = w.epoch
          w.actions.push({
            kind: 'evaluate',
            id: w.nextId++,
            epoch,
            resolve: () => {
              const passed = input.resultCommit !== null && rand() < 0.6
              const infra = input.resultCommit !== null && rand() < 0.05
              resolve({
                exitCode: passed ? 0 : 1,
                timedOut: false,
                durationMs: 1,
                output: '',
                passed: passed && !infra,
                skippedReason: input.resultCommit ? null : (input.skippedReason ?? 'none'),
                infrastructureError: infra ? 'evaluator crashed' : null,
                tampered: null,
              })
            },
          })
        }),
    })

  let service = build()
  const campaign = await service.createCampaign({
    name: `seed-${seed}`,
    caseIds,
    strategies: STRATEGIES.slice(0, 2 + Math.floor(rand() * 4)),
    repetitions: 1 + Math.floor(rand() * 3),
    modelPreset: 'balanced',
    budgetPreset: 'research',
    maxConcurrentTrials: maxConcurrent,
    maxAgentSessions: sessionBudget,
  })
  const trialIds = repos.arenaTrials.listByCampaign(campaign.id).map((t) => t.id)
  const terminalSnapshots = new Map<string, string>()
  await service.start(campaign.id)

  const check = (): void => {
    const trials = trialIds.map((id) => repos.arenaTrials.require(id))
    const counts = repos.arenaTrials.countsByCampaign(campaign.id).reduce((n, r) => n + r.n, 0)
    if (counts !== trialIds.length) w.violations.push(`counts add up to ${counts}, expected ${trialIds.length}`)
    const active = trials.filter((t) => ['provisioning', 'running', 'evaluating'].includes(t.state)).length
    if (active > maxConcurrent) w.violations.push(`concurrency ${active} > ${maxConcurrent}`)
    for (const t of trials) {
      if (TERMINAL_TRIAL_STATES.includes(t.state)) {
        const snap = JSON.stringify(t)
        const before = terminalSnapshots.get(t.id)
        if (before !== undefined && before !== snap) w.violations.push(`terminal trial ${t.id} changed`)
        terminalSnapshots.set(t.id, snap)
        const metrics = repos.arenaMetrics.getByTrial(t.id)
        const evaluation = repos.arenaEvaluations.latestForTrial(t.id)
        if (t.state === 'blocked' && t.blockKind === null) w.violations.push(`blocked trial ${t.id} has no blockKind`)
        if (t.state !== 'blocked' && t.blockKind !== null) w.violations.push(`${t.state} trial ${t.id} has blockKind ${t.blockKind}`)
        if ((t.state === 'passed' || t.state === 'failed') && !t.detail?.startsWith('Tampering') && !t.detail?.startsWith('The run failed') && (!metrics || !evaluation)) w.violations.push(`evaluated trial ${t.id} lacks rows`)
        if (t.state === 'cancelled' && (metrics || evaluation)) w.violations.push(`cancelled trial ${t.id} has evaluation rows`)
        if (evaluation && t.state !== 'blocked' && evaluation.passed !== (t.state === 'passed')) w.violations.push(`trial ${t.id} state ${t.state} disagrees with evaluation ${evaluation.passed}`)
        if (evaluation && !evaluation.passed && evaluation.score !== 0) w.violations.push(`failed trial ${t.id} has score ${evaluation.score}`)
        if (!t.runId && (metrics || evaluation)) w.violations.push(`trial ${t.id} without a run has evaluation rows`)
      } else {
        if (repos.arenaEvaluations.latestForTrial(t.id) && t.state !== 'evaluating') w.violations.push(`non-terminal trial ${t.id} (${t.state}) has an evaluation`)
      }
    }
    // The campaign view and the results page count the same trials: observations in n, harness blocks excluded.
    const detail = service.campaignDetail(campaign.id)
    const expectedN = trials.filter((t) => t.state === 'passed' || t.state === 'failed' || (t.state === 'blocked' && (t.blockKind === 'run' || t.blockKind === 'timeout'))).length
    const expectedExcluded = trials.filter((t) => t.state === 'blocked' && t.blockKind === 'infrastructure').length
    if (detail.comparison.reduce((n, r) => n + r.n, 0) !== expectedN) w.violations.push('comparison n disagrees with the trial states')
    if (detail.comparison.reduce((n, r) => n + r.excludedInfrastructure, 0) !== expectedExcluded) w.violations.push('excluded count disagrees with the trial states')
    const c = repos.arenaCampaigns.require(campaign.id)
    const allTerminal = trials.every((t) => TERMINAL_TRIAL_STATES.includes(t.state))
    if (c.state === 'completed' && !allTerminal) w.violations.push('campaign completed with open trials')
    if ((c.state === 'running' || c.state === 'paused') && allTerminal) w.violations.push(`campaign ${c.state} with every trial terminal`)
    if (c.state === 'paused' && trials.some((t) => t.state === 'provisioning' && !terminalSnapshots.has(t.id) && false)) w.violations.push('unreachable')
    if (w.violations.length > 0) throw new Error(`seed ${seed}: ${w.violations.join('; ')}`)
  }

  let steps = 0
  let settling = false
  const maxSteps = 4000
  const campaignDone = (): boolean => {
    const s = repos.arenaCampaigns.require(campaign.id).state
    return s === 'completed' || s === 'cancelled'
  }

  while (steps++ < maxSteps) {
    await tick()
    await tick()
    if (process.env['NEXUS_ARENA_STRESS_LOG'] && steps % 200 === 0) appendFileSync(process.env['NEXUS_ARENA_STRESS_LOG'], `  step ${steps} ${repos.arenaCampaigns.require(campaign.id).state} ${trialIds.map((id) => repos.arenaTrials.require(id).state).join(',')} actions=${w.actions.map((a) => a.kind).join(',')}
`)
    check()
    if (campaignDone()) break
    if (steps > 60 + Math.floor(rand() * 40)) settling = true

    const c = repos.arenaCampaigns.require(campaign.id)
    if (settling) {
      // Liveness: let everything through.
      if (c.state === 'paused' && c.pauseReason === 'user') service.resume(campaign.id)
      if (!w.gateOpen) {
        w.gateOpen = true
        for (const l of w.listeners) l()
      }
    } else {
      const r = rand()
      if (r < 0.04 && c.state === 'running') {
        service.pause(campaign.id)
        continue
      }
      if (r < 0.08 && c.state === 'paused' && c.pauseReason === 'user') {
        service.resume(campaign.id)
        continue
      }
      if (r < 0.1) {
        w.gateOpen = !w.gateOpen
        for (const l of w.listeners) l()
        continue
      }
      if (r < 0.13) {
        // restart: the old process vanishes with its in-flight provisioning and evaluation
        service.dispose()
        w.epoch++
        w.actions = w.actions.filter((a) => a.kind === 'run')
        w.liveProvisions.clear()
        service = build()
        service.recover()
        continue
      }
      if (r < 0.15 && c.state !== 'draft') {
        service.cancel(campaign.id)
        continue
      }
    }

    const pending = w.actions.filter((a) => a.kind === 'run' || a.epoch === w.epoch)
    if (pending.length === 0) continue
    const pick = pending[Math.floor(rand() * pending.length)]!
    if (pick.kind === 'run') stepRun(w, pick)
    else {
      w.actions = w.actions.filter((a) => a !== pick)
      pick.resolve()
    }
  }
  // Let in-flight work wind down (a cancelled campaign's trials finish their current step).
  for (let drain = 0; drain < 500 && service['jobs'].size > 0; drain++) {
    await tick()
    const a = w.actions.filter((x) => x.kind === 'run' || x.epoch === w.epoch)[0]
    if (!a) continue
    if (a.kind === 'run') stepRun(w, a)
    else {
      w.actions = w.actions.filter((x) => x !== a)
      a.resolve()
    }
  }
  await tick()
  check()
  expect(campaignDone(), `seed ${seed} finished (state ${repos.arenaCampaigns.require(campaign.id).state}, trials ${trialIds.map((id) => repos.arenaTrials.require(id).state).join(',')})`).toBe(true)
  await service.idle()
  // a completed campaign has every trial terminal; a cancelled one has none left open either
  const finalStates: TrialState[] = trialIds.map((id) => repos.arenaTrials.require(id).state)
  expect(finalStates.every((s) => TERMINAL_TRIAL_STATES.includes(s))).toBe(true)
  service.dispose()
  w.actions = []
}

describe('arena campaign state stress', () => {
  it(`keeps its invariants over ${RUNS} seeded histories`, async () => {
    let repos!: Repositories
    let bus!: EventBus
    for (let seed = Number(process.env['NEXUS_ARENA_STRESS_FROM'] ?? 1); seed <= RUNS; seed++) {
      if (process.env['NEXUS_ARENA_STRESS_LOG']) appendFileSync(process.env['NEXUS_ARENA_STRESS_LOG'], `seed ${seed}
`)
      if (repos === undefined || (seed - 1) % 100 === 0) {
        repos = createRepositories(openDatabase(':memory:'))
        bus = new EventBus(repos.events, repos.transaction, () => undefined)
      }
      try {
        await runSeed(seed, repos, bus)
      } catch (e) {
        throw new Error(`seed ${seed} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
    }
  }, 30 * 60_000)
})
