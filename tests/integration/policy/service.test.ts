import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/domain'
import type { PushMessage } from '@shared/events'
import { newId } from '@shared/ids'
import type { ConcreteStrategy, ArenaCampaign } from '@shared/v3'
import { PolicyService } from '@main/modules/policy'
import { makeAgent, makeProject, makeRun, makeTask, openMemory } from '../persistence/fixtures'

const CTX = 'feature|medium|low'
const USER = { category: 'feature', complexity: 'medium', risk: 'low' } as const
const NOW = Date.UTC(2026, 5, 1)

function setup() {
  const { repos } = openMemory()
  const pushes: PushMessage[] = []
  const clock = { t: NOW }
  const service = new PolicyService({
    repos,
    now: () => clock.t,
    nexusVersion: '0.3.0-test',
    push: (m) => pushes.push(m),
    seed: () => 42,
  })
  const project = repos.projects.insert(makeProject())
  const campaign: ArenaCampaign = {
    id: newId(),
    name: 'c',
    state: 'completed',
    pauseReason: null,
    caseVersionIds: [],
    strategies: ['BUILD', 'SWARM'],
    repetitions: 1,
    modelPreset: 'balanced',
    budgets: { preset: 'balanced', maxWallClockMinutes: 60, maxTrials: 100, maxConcurrentTrials: 1, maxAgentSessions: 100, maxAgentsPerTrial: 4 },
    overnight: false,
    policySnapshotId: null,
    nexusVersion: 'x',
    environment: { platform: 'win32', osRelease: '', nodeVersion: '', sdkVersion: null, gitVersion: null, modelTiers: {} },
    error: null,
    createdAt: new Date(NOW).toISOString(),
    startedAt: null,
    completedAt: null,
  }
  repos.arenaCampaigns.insert(campaign)
  let ordinal = 0

  const addTrials = (contextKey: string, strategy: ConcreteStrategy, pass: number, fail: number, runId: string | null = null) => {
    for (let i = 0; i < pass + fail; i++) {
      const profile = repos.taskProfiles.insert({
        id: newId(),
        projectId: null,
        runId: null,
        arenaTrialId: null,
        contextKey,
        features: {} as never,
        profilerVersion: 'profiler-v1',
        createdAt: new Date(NOW).toISOString(),
      })
      const trial = repos.arenaTrials.insert({
        id: newId(),
        campaignId: campaign.id,
        caseId: `case-${ordinal % 5}`,
        caseVersionId: 'cv',
        strategy,
        repetition: ordinal,
        ordinal: ordinal++,
        state: i < pass ? 'passed' : 'failed',
        projectId: null,
        runId: i === 0 ? runId : null,
        repoPath: null,
        baselineCommit: null,
        resultCommit: null,
        policySnapshotId: null,
        taskProfileId: profile.id,
        models: {},
        detail: null,
        blockKind: null,
        createdAt: new Date(NOW).toISOString(),
        startedAt: null,
        finishedAt: new Date(NOW - 1000).toISOString(),
      })
      repos.arenaMetrics.replaceForTrial({
        id: newId(),
        trialId: trial.id,
        buildPassed: null,
        typecheckPassed: null,
        testsPassed: null,
        hiddenPassed: i < pass,
        acceptanceTotal: null,
        acceptancePassed: null,
        verifierPassed: null,
        criticalFindings: 0,
        highFindings: 0,
        mediumFindings: 0,
        repairs: 0,
        wallClockMs: 60_000,
        sessions: strategy === 'SWARM' ? 6 : 3,
        turns: null,
        inputTokens: null,
        outputTokens: null,
        toolCalls: null,
        humanInterventions: 0,
        approvals: 0,
        manualRetries: 0,
        blockers: 0,
        crashedAgents: 0,
        recoveredSessions: 0,
        schedulerFailures: 0,
        unfinishedTasks: 0,
        quotaPauses: 0,
        quotaWaitMs: 0,
        autoResumeSuccesses: 0,
        throttleEvents: 0,
        createdAt: new Date(NOW).toISOString(),
      })
    }
  }

  const seedStrongSwarm = () => {
    addTrials(CTX, 'BUILD', 10, 10)
    addTrials(CTX, 'SWARM', 28, 2)
  }

  const adaptive = (runId = newId(), p: Project = project) =>
    service.decideForRun({ project: p, prompt: 'Add an export option', runId, preset: 'balanced', requested: 'ADAPTIVE', user: USER })

  return { repos, service, pushes, project, clock, addTrials, seedStrongSwarm, adaptive }
}

describe('policy service: snapshots and pointer', () => {
  it('writes the default snapshot once and points at it', () => {
    const { service, repos } = setup()
    const v1 = service.ensureDefault()
    expect(v1).toMatchObject({ version: 1, origin: 'default', preferences: [], parentId: null })
    expect(v1.config.exploration).toBe('conservative')
    expect(v1.routing).toMatchObject({ strongest: expect.any(String) })
    expect(service.ensureDefault().id).toBe(v1.id)
    expect(repos.policySnapshots.list()).toHaveLength(1)
    expect(service.pointer()).toEqual({ activeId: v1.id, previousId: null, pinnedId: null })
    expect(service.active().id).toBe(v1.id)
  })

  it('snapshots are immutable: the repository has no update path and promotion leaves old ones byte-identical', () => {
    const { service, repos, seedStrongSwarm } = setup()
    const v1 = service.ensureDefault()
    const before = JSON.stringify(repos.policySnapshots.get(v1.id))
    expect('update' in repos.policySnapshots).toBe(false)
    seedStrongSwarm()
    const cand = service.learn().candidates.find((c) => c.contextKey === CTX)!
    service.promote(cand.id)
    expect(JSON.stringify(repos.policySnapshots.get(v1.id))).toBe(before)
    expect(repos.policySnapshots.list().map((s) => s.version)).toEqual([2, 1])
  })
})

describe('policy service: learning, promotion, rollback, pin', () => {
  it('learn writes statistics and a shadow-evaluated candidate, and is idempotent', () => {
    const { service, repos, seedStrongSwarm, pushes } = setup()
    seedStrongSwarm()
    const first = service.learn()
    expect(first.statistics).toBeGreaterThan(0)
    const cand = first.candidates.find((c) => c.contextKey === CTX)!
    expect(cand).toMatchObject({ fromStrategy: 'BUILD', toStrategy: 'SWARM', status: 'proposed', arenaTrials: 30, missions: 0 })
    expect(cand.shadow?.note).toMatch(/sanity check/i)
    expect(repos.strategyStatistics.list().length).toBe(first.statistics)
    expect(pushes.some((m) => m.kind === 'policy')).toBe(true)

    const second = service.learn()
    expect(second.candidates.map((c) => c.id).sort()).toEqual(first.candidates.map((c) => c.id).sort())
    expect(repos.policyCandidates.listRecent().length).toBe(first.candidates.length)
    // No new snapshot and no promotion from learning alone.
    expect(repos.policySnapshots.list()).toHaveLength(1)
    expect(repos.policyPromotions.listRecent()).toHaveLength(0)
  })

  it('new evidence supersedes an older proposal for the same context', () => {
    const { service, repos, seedStrongSwarm, addTrials } = setup()
    seedStrongSwarm()
    const first = service.learn().candidates.find((c) => c.contextKey === CTX)!
    addTrials(CTX, 'SWARM', 5, 0)
    const second = service.learn().candidates.find((c) => c.contextKey === CTX)!
    expect(second.id).not.toBe(first.id)
    expect(repos.policyCandidates.get(first.id)?.status).toBe('superseded')
    expect(repos.policyCandidates.listByStatus('proposed').filter((c) => c.contextKey === CTX)).toHaveLength(1)
  })

  it('an ADAPTIVE decision changes only after promotion; rollback restores it; history is not rewritten', () => {
    const { service, repos, seedStrongSwarm, adaptive, project } = setup()
    service.setConfig({ exploration: 'off' })
    seedStrongSwarm()
    const cand = service.learn().candidates.find((c) => c.contextKey === CTX)!

    const before = adaptive()
    expect(before.decision?.strategy).toBe('BUILD')
    expect(before.decision?.layer).toBe('default')
    expect(before.info.requested).toBe('ADAPTIVE')
    expect(before.info.policyDecisionId).toBe(before.decision!.id)
    expect(before.profile.contextKey).toBe(CTX)

    const overview = service.promote(cand.id)
    expect(overview.active.preferences[0]).toMatchObject({ contextKey: CTX, strategy: 'SWARM', replaces: 'BUILD', candidateId: cand.id })
    expect(overview.history[0]).toMatchObject({ action: 'promote', candidateId: cand.id })
    expect(overview.candidates.find((c) => c.id === cand.id)?.status).toBe('promoted')
    expect(overview.pointer.previousId).not.toBeNull()

    const promotedDecision = adaptive()
    expect(promotedDecision.decision).toMatchObject({ strategy: 'SWARM', layer: 'evidence', policyVersion: overview.active.version })
    expect(promotedDecision.decision?.reason).toContain('SWARM passed 28 of 30 Arena trials')
    expect(promotedDecision.plan.strategy).toBe('SWARM')
    expect(promotedDecision.plan.maxParallelAgents).toBe(promotedDecision.decision!.workerCount)

    const storedBefore = JSON.stringify(repos.policyDecisions.get(before.decision!.id))
    const back = service.rollback()
    expect(back.history[0]).toMatchObject({ action: 'rollback' })
    expect(adaptive().decision?.strategy).toBe('BUILD')
    expect(JSON.stringify(repos.policyDecisions.get(before.decision!.id))).toBe(storedBefore)
    expect(repos.policyDecisions.get(promotedDecision.decision!.id)?.strategy).toBe('SWARM')
    expect(repos.policySnapshots.list().length).toBe(3) // default, config, promotion: nothing deleted
    expect(() => service.rollback()).toThrow(/no earlier snapshot/i)
    expect(project.id).toBeTruthy()
  })

  it('pin makes new decisions use that snapshot until it is cleared', () => {
    const { service, seedStrongSwarm, adaptive } = setup()
    service.setConfig({ exploration: 'off' })
    const pinned = service.active().id
    seedStrongSwarm()
    service.promote(service.learn().candidates.find((c) => c.contextKey === CTX)!.id)
    expect(adaptive().decision?.strategy).toBe('SWARM')
    const o = service.pin(pinned)
    expect(o.pointer.pinnedId).toBe(pinned)
    expect(o.history[0]).toMatchObject({ action: 'pin', toSnapshotId: pinned })
    expect(adaptive().decision?.strategy).toBe('BUILD')
    expect(adaptive().decision?.policyVersion).toBe(2)
    const cleared = service.pin(null)
    expect(cleared.pointer.pinnedId).toBeNull()
    expect(cleared.history[0]?.action).toBe('unpin')
    expect(adaptive().decision?.strategy).toBe('SWARM')
  })

  it('reject marks the candidate and leaves the policy alone', () => {
    const { service, repos, seedStrongSwarm } = setup()
    seedStrongSwarm()
    const cand = service.learn().candidates.find((c) => c.contextKey === CTX)!
    const o = service.reject(cand.id)
    expect(o.candidates.find((c) => c.id === cand.id)?.status).toBe('rejected')
    expect(o.active.version).toBe(1)
    expect(o.history[0]).toMatchObject({ action: 'reject', candidateId: cand.id })
    expect(() => service.promote(cand.id)).toThrow(/not proposed/)
    expect(repos.policySnapshots.list()).toHaveLength(1)
  })

  it('setConfig writes a new snapshot with origin config, and compare reports the difference', () => {
    const { service } = setup()
    const v1 = service.ensureDefault()
    const o = service.setConfig({ exploration: 'research', speculation: 'AUTO' })
    expect(o.active).toMatchObject({ version: 2, origin: 'config', parentId: v1.id })
    expect(o.active.config).toMatchObject({ exploration: 'research', speculation: 'AUTO' })
    const diff = service.compare(v1.id, o.active.id)
    expect(diff.config.map((c) => c.field).sort()).toEqual(['exploration', 'speculation'])
    expect(service.setConfig({ exploration: 'research' }).active.version).toBe(2) // no change, no new snapshot
  })

  it('overview lists contexts with their evidence, counting Arena trials and missions separately', () => {
    const { service, seedStrongSwarm } = setup()
    seedStrongSwarm()
    service.learn()
    const row = service.overview().contexts.find((c) => c.contextKey === CTX)!
    expect(row).toMatchObject({ defaultStrategy: 'BUILD', preferred: 'BUILD', arenaTrials: 50, missions: 0 })
    expect(row.rows.map((r) => r.strategy)).toEqual(['BUILD', 'SWARM'])
  })
})

describe('policy service: decideForRun and preview', () => {
  it('stores the profile always and a decision only for ADAPTIVE; every run records the snapshot', () => {
    const { service, repos, project } = setup()
    const run = newId()
    const r = service.decideForRun({ project, prompt: 'Fix a typo in README.md', runId: run, preset: 'balanced', requested: 'SINGLE' })
    expect(r.decision).toBeNull()
    expect(r.plan.strategy).toBe('SINGLE')
    expect(r.info).toMatchObject({ requested: 'SINGLE', resolved: 'SINGLE', policyDecisionId: null, policySnapshotId: service.active().id, taskProfileId: r.profile.id })
    expect(repos.taskProfiles.getByRun(run)?.id).toBe(r.profile.id)
    expect(repos.policyDecisions.getByRun(run)).toBeNull()
    expect(service.runInfo(run)).toMatchObject({ decision: null, outcome: null })
    expect(service.runInfo(run).profile?.id).toBe(r.profile.id)
  })

  it('an Arena trial profile carries the trial id', () => {
    const { service, project } = setup()
    const r = service.decideForRun({ project, prompt: 'x', runId: newId(), preset: 'eco', requested: 'BUILD', arenaTrialId: 'trial-9' })
    expect(r.profile.arenaTrialId).toBe('trial-9')
    expect(r.info.arenaTrialId).toBe('trial-9')
  })

  it('preview stores nothing', () => {
    const { service, repos, project } = setup()
    const profiles = repos.taskProfiles.listRecent().length
    const p = service.preview({ projectId: project.id, prompt: 'Fix the crash in src/a.ts' })
    expect(p.profile.features.category.value).toBe('bugfix')
    expect(p.decision.strategy).toBeDefined()
    expect(repos.taskProfiles.listRecent().length).toBe(profiles)
    expect(repos.policyDecisions.listRecent()).toHaveLength(0)
  })

  it('applies the resource layer with the injected usage status', () => {
    const { repos, project } = setup()
    const service = new PolicyService({
      repos,
      nexusVersion: 'x',
      seed: () => 1,
      usage: { status: () => 'THROTTLED', recentLimitWithin: () => true },
    })
    service.setConfig({ exploration: 'off' })
    const normal = new PolicyService({ repos, nexusVersion: 'x', seed: () => 1 }).decideForRun({ project, prompt: 'Add a thing', runId: 'a', preset: 'balanced', requested: 'ADAPTIVE', user: USER })
    const throttled = service.decideForRun({ project, prompt: 'Add a thing', runId: 'b', preset: 'balanced', requested: 'ADAPTIVE', user: USER })
    expect(throttled.decision?.usageStatus).toBe('THROTTLED')
    expect(throttled.decision!.workerCount).toBeLessThan(normal.decision!.workerCount)
    expect(throttled.decision!.resourceNotes.length).toBeGreaterThan(0)
  })

  it('lists decisions newest first with paging', () => {
    const { service, adaptive } = setup()
    adaptive('r1')
    adaptive('r2')
    adaptive('r3')
    expect(service.decisions({ limit: 2 })).toHaveLength(2)
    expect(service.decisions({ limit: 2, offset: 2 })).toHaveLength(1)
  })
})

describe('policy service: mission outcomes', () => {
  function seedRun(env: ReturnType<typeof setup>, over: { state?: 'completed' | 'failed' | 'executing'; criteriaPassed?: boolean | null; strategyInfo?: boolean } = {}) {
    const { repos, project, service } = env
    const run = repos.runs.insert(
      makeRun(project.id, {
        state: over.state ?? 'completed',
        startedAt: new Date(NOW - 600_000).toISOString(),
        finishedAt: new Date(NOW).toISOString(),
      }),
    )
    const decided = service.decideForRun({ project, prompt: 'Add an export option', runId: run.id, preset: 'balanced', requested: 'BUILD', user: USER })
    if (over.strategyInfo !== false) repos.runs.update(run.id, { config: { ...run.config, strategy: decided.info } })

    const impl = repos.tasks.insert(makeTask(run.id, 'impl', { state: 'completed' }))
    repos.tasks.insert(makeTask(run.id, 'impl-repair-1', { kind: 'repair', parentTaskId: impl.id, state: 'completed' }))
    repos.tasks.insert(makeTask(run.id, 'mission-fix-1', { state: 'completed' }))
    const worker = repos.agents.insert(makeAgent(run.id, impl.id, { model: 'claude-sonnet-4', metrics: { turns: 3, toolCalls: 1, filesRead: 1, filesChanged: 1, commands: 1, inputTokens: 1000, outputTokens: 400, cacheReadTokens: null, costUsd: null, contextWindow: null } }))
    repos.agents.insert(makeAgent(run.id, impl.id, { role: 'reviewer', purpose: 'review', model: 'claude-opus-4' }))
    for (const [i, agentId] of [worker.id, worker.id].entries()) {
      repos.sessions.insert({ id: newId(), agentId, sdkSessionId: `s${i}`, model: 'm', state: 'ended', endReason: null, handoff: null, startedAt: new Date(NOW).toISOString(), endedAt: null })
    }
    repos.reviews.insert({ id: newId(), runId: run.id, taskId: impl.id, agentId: null, attempt: 1, verdict: 'changes_requested', summary: '', findings: [], createdAt: new Date(NOW).toISOString() })
    repos.reviews.insert({ id: newId(), runId: run.id, taskId: impl.id, agentId: null, attempt: 2, verdict: 'approved', summary: '', findings: [], createdAt: new Date(NOW).toISOString() })
    if (over.criteriaPassed !== null) {
      repos.criteria.insert({ id: newId(), runId: run.id, taskId: null, text: 'works', status: over.criteriaPassed === false ? 'failed' : 'passed', evidence: null, updatedAt: new Date(NOW).toISOString() })
    }
    repos.events.insert({ runId: run.id, type: 'user.intervention', payload: { action: 'pause' } })
    repos.events.insert({ runId: run.id, type: 'user.intervention', payload: { action: 'retry_task' } })
    repos.quotaPauses.insert({
      id: newId(), runId: run.id, scope: 'run', state: 'resumed', pausedAt: new Date(NOW - 120_000).toISOString(), limitType: null, resetAt: null, resetConfidence: 'UNKNOWN',
      nextCheckAt: null, probes: 0, checkpointId: null, resumeState: null, endedAt: new Date(NOW - 60_000).toISOString(), endReason: null,
      createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    })
    return { run, decided }
  }

  it('builds the outcome from durable rows', () => {
    const env = setup()
    const { run, decided } = seedRun(env)
    const o = env.service.recordOutcome(run.id)!
    expect(o).toMatchObject({
      runId: run.id,
      projectId: env.project.id,
      taskProfileId: decided.profile.id,
      contextKey: CTX,
      strategy: 'BUILD',
      requestedStrategy: 'BUILD',
      planningMode: 'single',
      policySnapshotId: env.service.active().id,
      policyDecisionId: null,
      agents: 2,
      sessions: 2,
      tasks: 2, // impl and mission-fix; the repair child is counted under repairs
      tasksCompleted: 2,
      repairs: 2,
      reviews: 2,
      reviewRejections: 1,
      verificationPassed: true,
      inputTokens: 1000,
      outputTokens: 400,
      quotaPauses: 1,
      quotaWaitMs: 60_000,
      humanInterventions: 2,
      terminal: 'completed',
      success: true,
      isArena: false,
      nexusVersion: '0.3.0-test',
    })
    expect(o.models).toEqual({ worker: 'claude-sonnet-4', reviewer: 'claude-opus-4' })
    expect(o.elapsedMs).toBe(600_000)
  })

  it('is an upsert by run and reports failure when mission criteria failed', () => {
    const env = setup()
    const { run } = seedRun(env, { criteriaPassed: false })
    const first = env.service.recordOutcome(run.id)!
    expect(first).toMatchObject({ success: false, verificationPassed: false, terminal: 'completed' })
    env.repos.runs.update(run.id, { state: 'failed' })
    const second = env.service.recordOutcome(run.id)!
    expect(second.id).toBe(first.id)
    expect(second.terminal).toBe('failed')
    expect(env.repos.missionOutcomes.countMissions()).toBe(1)
    expect(env.service.runInfo(run.id).outcome?.id).toBe(first.id)
  })

  it('reports tokens as null when no agent reported any, and succeeds without mission criteria', () => {
    const env = setup()
    const { run } = seedRun(env, { criteriaPassed: null })
    for (const a of env.repos.agents.listByRun(run.id)) {
      env.repos.agents.update(a.id, { metrics: { ...a.metrics, inputTokens: null, outputTokens: null } })
    }
    const o = env.service.recordOutcome(run.id)!
    expect(o.inputTokens).toBeNull()
    expect(o.outputTokens).toBeNull()
    expect(o.verificationPassed).toBeNull()
    expect(o.success).toBe(true)
  })

  it('records nothing for a running run, a run without strategy info, or an unknown run, and never throws', () => {
    const env = setup()
    expect(env.service.recordOutcome('nope')).toBeNull()
    expect(env.service.recordOutcome(seedRun(env, { state: 'executing' }).run.id)).toBeNull()
    expect(env.service.recordOutcome(seedRun(env, { strategyInfo: false }).run.id)).toBeNull()
    expect(env.repos.missionOutcomes.countMissions()).toBe(0)
  })

  it('an intervention pause is recorded as blocked', () => {
    const env = setup()
    const { run } = seedRun(env, { state: 'executing' })
    env.repos.runs.update(run.id, { state: 'paused', pauseReason: 'user' })
    env.repos.events.insert({ runId: run.id, type: 'run.paused', payload: { reason: 'user', cause: 'intervention', detail: 'needs a person' } })
    const o = env.service.recordOutcome(run.id)!
    expect(o).toMatchObject({ terminal: 'blocked', success: false })
  })

  it('marks Arena runs and keeps them out of mission evidence', () => {
    const env = setup()
    const { run } = seedRun(env)
    env.addTrials(CTX, 'BUILD', 1, 0, run.id)
    const o = env.service.recordOutcome(run.id)!
    expect(o.isArena).toBe(true)
    expect(env.repos.missionOutcomes.listMissionsSince(new Date(0).toISOString())).toEqual([])
    const learned = env.service.learn()
    expect(learned.statistics).toBeGreaterThan(0)
    expect(env.repos.strategyStatistics.list().every((s) => s.kind === 'arena')).toBe(true)
    expect(env.service.overview().evidence.missions).toBe(0)
  })

  it('real mission outcomes are counted as their own kind', () => {
    const env = setup()
    const { run } = seedRun(env)
    env.service.recordOutcome(run.id)
    env.service.learn()
    const stats = env.repos.strategyStatistics.list().filter((s) => s.contextKey === CTX)
    expect(stats.map((s) => `${s.strategy}/${s.kind}`)).toEqual(['BUILD/mission'])
    expect(stats[0]).toMatchObject({ n: 1, effectiveN: 0.5 })
    expect(env.service.overview().evidence.missions).toBe(1)
  })
})

describe('policy service: audit regressions', () => {
  it('does not re-propose a rejected candidate until the challenger has five more Arena trials', () => {
    const { service, seedStrongSwarm, addTrials } = setup()
    seedStrongSwarm()
    const cand = service.learn().candidates.find((c) => c.contextKey === CTX)!
    service.reject(cand.id)
    const again = service.learn()
    expect(again.candidates.filter((c) => c.contextKey === CTX)).toEqual([])
    expect(again.notes.join(' ')).toContain('was rejected on this policy')
    addTrials(CTX, 'SWARM', 4, 0)
    expect(service.learn().candidates.filter((c) => c.contextKey === CTX)).toEqual([])
    addTrials(CTX, 'SWARM', 1, 0)
    const back = service.learn().candidates.filter((c) => c.contextKey === CTX)
    expect(back).toHaveLength(1)
    expect(back[0]!.id).not.toBe(cand.id)
  })

  it('learn judges against the head, not a pinned snapshot, and promote refuses a stale candidate', () => {
    const { service, seedStrongSwarm } = setup()
    const v1 = service.ensureDefault()
    seedStrongSwarm()
    service.pin(v1.id)
    service.setConfig({ exploration: 'off' }) // head moves to a new snapshot while v1 stays pinned
    const head = service.pointer().activeId
    expect(head).not.toBe(v1.id)
    const cand = service.learn().candidates.find((c) => c.contextKey === CTX)!
    expect(cand.baseSnapshotId).toBe(head)
    // The head moves again after the candidate was proposed: the candidate is now stale.
    service.setConfig({ exploration: 'balanced' })
    expect(() => service.promote(cand.id)).toThrow(/stale candidate: run learn again/)
    const fresh = service.learn()
    expect(fresh.candidates.find((c) => c.id === cand.id)).toBeUndefined()
    const next = fresh.candidates.find((c) => c.contextKey === CTX)!
    expect(next.baseSnapshotId).toBe(service.pointer().activeId)
    expect(() => service.promote(next.id)).not.toThrow()
  })

  it('an orphan Arena run (named by its strategy info, no trial row) is not counted as a mission', () => {
    const env = setup()
    const run = env.repos.runs.insert(makeRun(env.project.id, { state: 'completed', startedAt: new Date(NOW - 1000).toISOString(), finishedAt: new Date(NOW).toISOString() }))
    const decided = env.service.decideForRun({ project: env.project, prompt: 'x', runId: run.id, preset: 'balanced', requested: 'BUILD', user: USER, arenaTrialId: 'gone-trial' })
    env.repos.runs.update(run.id, { config: { ...run.config, strategy: decided.info } })
    expect(env.service.recordOutcome(run.id)).toMatchObject({ isArena: true })
    expect(env.repos.missionOutcomes.countMissions()).toBe(0)
  })

  it('a blocked run that later completes is one outcome, and only the later state counts', () => {
    const env = setup()
    const run = env.repos.runs.insert(makeRun(env.project.id, { state: 'executing', startedAt: new Date(NOW - 1000).toISOString() }))
    const decided = env.service.decideForRun({ project: env.project, prompt: 'x', runId: run.id, preset: 'balanced', requested: 'BUILD', user: USER })
    env.repos.runs.update(run.id, { state: 'paused', pauseReason: 'user', config: { ...run.config, strategy: decided.info } })
    env.repos.events.insert({ runId: run.id, type: 'run.paused', payload: { reason: 'user', cause: 'intervention' } })
    expect(env.service.recordOutcome(run.id)?.terminal).toBe('blocked')
    env.repos.runs.update(run.id, { state: 'completed', finishedAt: new Date(NOW).toISOString() })
    expect(env.service.recordOutcome(run.id)?.terminal).toBe('completed')
    expect(env.repos.missionOutcomes.countMissions()).toBe(1)
    env.service.learn()
    const stats = env.repos.strategyStatistics.list().filter((s) => s.contextKey === CTX && s.kind === 'mission')
    expect(stats[0]).toMatchObject({ n: 1, successes: 1, stabilityFailures: 0 })
  })

  it('treats an unreadable usage service as unavailable and says so', () => {
    const { repos, project } = setup()
    const service = new PolicyService({
      repos,
      nexusVersion: 'x',
      seed: () => 1,
      usage: {
        status: () => {
          throw new Error('boom')
        },
        recentLimitWithin: () => false,
      },
    })
    service.setConfig({ exploration: 'off' })
    const r = service.decideForRun({ project, prompt: 'Add a thing', runId: 'u1', preset: 'balanced', requested: 'ADAPTIVE', user: USER })
    expect(r.decision?.usageStatus).toBe('RUNTIME_UNAVAILABLE')
    expect(r.decision?.resourceNotes.join(' ')).toContain('could not be read')
    expect(r.decision?.strategy).not.toBe('SWARM')
    expect(r.decision?.strategy).not.toBe('SPECULATIVE')
  })

  it('evidence statistics carry distinct case counts and exclude harness-blocked trials', () => {
    const { service, repos, addTrials } = setup()
    addTrials(CTX, 'BUILD', 6, 0)
    const trial = repos.arenaTrials.listFinishedSince(new Date(0).toISOString())[0]!
    repos.arenaTrials.insert({ ...trial, id: newId(), repetition: 99, ordinal: 99, state: 'blocked', blockKind: 'infrastructure', caseId: 'infra-case' })
    service.learn()
    const row = repos.strategyStatistics.list().find((s) => s.contextKey === CTX && s.strategy === 'BUILD' && s.kind === 'arena')!
    expect(row.n).toBe(6)
    expect(row.distinctUnits).toBe(5)
  })
})
