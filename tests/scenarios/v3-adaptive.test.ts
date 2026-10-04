import { afterEach, describe, expect, it } from 'vitest'
import { newId, nowIso } from '@shared/ids'
import { ARENA_BUDGET_DEFAULTS, type ConcreteStrategy } from '@shared/v3'
import { completeWith, scriptsByRole } from '@main/modules/agent-runtime/fake-runtime'
import { approvedReview, createHarness, passedVerification, plan, plannedTask, writeFiles, type Harness } from './harness'

const PROMPT = 'Fix the off-by-one error in the pagination helper'

const script = scriptsByRole({
  planner: completeWith({ text: 'plan', structuredOutput: plan([plannedTask('alpha')]) }),
  worker: async (spec, ctx) => {
    await writeFiles(spec, ctx)
    await ctx.completeTurn({ text: 'done' })
  },
  reviewer: completeWith({ text: 'review', structuredOutput: approvedReview }),
  verifier: completeWith({ text: 'verify', structuredOutput: passedVerification }),
})

/** Finished Arena trials for one context: controlled evidence the policy may learn from. */
function seedTrials(h: Harness, contextKey: string, strategy: ConcreteStrategy, pass: number, fail: number): void {
  const { repos } = h
  const campaign =
    repos.arenaCampaigns.list()[0] ??
    repos.arenaCampaigns.insert({
      id: newId(),
      name: 'seeded evidence',
      state: 'completed',
      pauseReason: null,
      caseVersionIds: [],
      strategies: ['SINGLE', 'BUILD', 'SWARM'],
      repetitions: 1,
      modelPreset: 'balanced',
      budgets: { preset: 'balanced', ...ARENA_BUDGET_DEFAULTS.balanced },
      overnight: false,
      policySnapshotId: null,
      nexusVersion: '0.3.0-test',
      environment: { platform: 'win32', osRelease: '', nodeVersion: '', sdkVersion: null, gitVersion: null, modelTiers: {} },
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
    })
  const offset = repos.arenaTrials.count()
  for (let i = 0; i < pass + fail; i++) {
    const profile = repos.taskProfiles.insert({
      id: newId(),
      projectId: null,
      runId: null,
      arenaTrialId: null,
      contextKey,
      features: {} as never,
      profilerVersion: 'profiler-v1',
      createdAt: nowIso(),
    })
    const trial = repos.arenaTrials.insert({
      id: newId(),
      campaignId: campaign.id,
      // Evidence from one case repeated is not independent: the seeded trials rotate through four cases.
      caseId: `seeded-case-${i % 4}`,
      caseVersionId: `seeded-case-${i % 4}@1`,
      strategy,
      repetition: offset + i,
      ordinal: offset + i,
      state: i < pass ? 'passed' : 'failed',
      projectId: null,
      runId: null,
      repoPath: null,
      baselineCommit: null,
      resultCommit: null,
      policySnapshotId: null,
      taskProfileId: profile.id,
      models: {},
      detail: null,
      blockKind: null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: nowIso(),
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
      sessions: 3,
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
      createdAt: nowIso(),
    })
  }
}

describe('v0.3 ADAPTIVE strategy through the orchestrator', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  const adaptiveRun = () =>
    h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: PROMPT, strategy: 'ADAPTIVE' })

  it('profiles the task, records the snapshot, the decision and its reason, executes, and records the outcome', async () => {
    h = await createHarness({ script, policy: true })
    h.policy!.setConfig({ exploration: 'off' })
    const snapshot = h.policy!.active()

    const run = await adaptiveRun()
    const info = run.config.strategy!
    expect(info.requested).toBe('ADAPTIVE')
    expect(info.policySnapshotId).toBe(snapshot.id)

    const profile = h.repos.taskProfiles.require(info.taskProfileId!)
    expect(profile.runId).toBe(run.id)
    expect(profile.features.category).toEqual({ value: 'bugfix', basis: 'INFERRED' })
    const decision = h.repos.policyDecisions.require(info.policyDecisionId!)
    expect(decision).toMatchObject({ runId: run.id, snapshotId: snapshot.id, strategy: info.resolved, layer: 'default', exploration: false, usageStatus: 'AVAILABLE' })
    expect(decision.reason.length).toBeGreaterThan(20)
    // With no evidence at all, the decision says so instead of citing numbers.
    expect(decision.evidenceSummary.every((row) => row.arenaN === 0 && row.missionN === 0)).toBe(true)
    expect(decision.reason).not.toMatch(/\d+ of \d+/)

    const done = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(done.state).toBe('completed')
    expect(h.eventsOfType(run.id, 'policy.decided')[0]?.payload).toMatchObject({ decisionId: decision.id, strategy: info.resolved, policyVersion: snapshot.version })
    expect(h.eventsOfType(run.id, 'strategy.selected')[0]?.payload).toMatchObject({ requested: 'ADAPTIVE', resolved: info.resolved })

    // The outcome is observational evidence about this run, with what the sessions reported.
    const outcome = h.repos.missionOutcomes.getByRun(run.id)
    expect(outcome).toMatchObject({
      strategy: info.resolved,
      requestedStrategy: 'ADAPTIVE',
      policyDecisionId: decision.id,
      policySnapshotId: snapshot.id,
      contextKey: profile.contextKey,
      terminal: 'completed',
      success: true,
      isArena: false,
    })
    expect(outcome!.sessions).toBeGreaterThan(0)
    expect(outcome!.inputTokens).toBeGreaterThan(0)
    expect(h.eventsOfType(run.id, 'outcome.recorded')).toHaveLength(1)
    // The policy did not change because one mission finished.
    expect(h.policy!.active().id).toBe(snapshot.id)
  })

  it('weak evidence keeps the default; strong evidence only proposes; promotion changes the decision; rollback restores it', async () => {
    h = await createHarness({ script: scriptsByRole({ planner: async (_s, ctx) => ctx.sleep(60_000) }), policy: true })
    const policy = h.policy!
    policy.setConfig({ exploration: 'off' })
    const baseline = policy.active()
    const { profile, decision: before } = policy.preview({ projectId: h.project.id, prompt: PROMPT })
    const context = profile.contextKey
    const incumbent = before.strategy
    const challenger: ConcreteStrategy = incumbent === 'BUILD' ? 'SINGLE' : 'BUILD'

    // Three lucky trials are not evidence: nothing is proposed and the decision does not move.
    seedTrials(h, context, challenger, 3, 0)
    seedTrials(h, context, incumbent, 0, 3)
    const weak = policy.learn()
    expect(weak.candidates).toEqual([])
    // The learning step says why, per context, instead of staying silent.
    expect(weak.notes.join(' ')).toMatch(/no candidate/i)
    expect(policy.preview({ projectId: h.project.id, prompt: PROMPT }).decision.strategy).toBe(incumbent)

    // Enough controlled evidence, clearly separated: a candidate appears, and still nothing changes.
    seedTrials(h, context, challenger, 27, 1)
    seedTrials(h, context, incumbent, 8, 20)
    const strong = policy.learn()
    const candidate = strong.candidates.find((c) => c.contextKey === context)
    expect(candidate).toMatchObject({ fromStrategy: incumbent, toStrategy: challenger, status: 'proposed' })
    expect(candidate!.arenaTrials).toBeGreaterThanOrEqual(12)
    expect(candidate!.shadow?.note).toMatch(/sanity check/i)
    expect(policy.active().id).toBe(baseline.id)
    const unpromoted = await adaptiveRun()
    expect(unpromoted.config.strategy).toMatchObject({ resolved: incumbent, policySnapshotId: baseline.id })

    // Promotion is an explicit act that writes a new snapshot; later ADAPTIVE runs use it and say why.
    const promoted = policy.promote(candidate!.id)
    expect(promoted.active.version).toBe(baseline.version + 1)
    expect(promoted.active.id).not.toBe(baseline.id)
    const after = await adaptiveRun()
    expect(after.config.strategy).toMatchObject({ resolved: challenger, policySnapshotId: promoted.active.id })
    const decision = h.repos.policyDecisions.require(after.config.strategy!.policyDecisionId!)
    expect(decision.layer).toBe('evidence')
    expect(decision.reason).toMatch(/\d+ of \d+/)
    // The run created before the promotion keeps the snapshot it was decided with.
    expect(h.repos.runs.require(unpromoted.id).config.strategy?.policySnapshotId).toBe(baseline.id)
    expect(h.repos.policySnapshots.require(baseline.id)).toEqual(baseline)

    // Rollback moves the pointer back; history is untouched.
    const rolled = policy.rollback()
    expect(rolled.active.id).toBe(baseline.id)
    const restored = await adaptiveRun()
    expect(restored.config.strategy).toMatchObject({ resolved: incumbent, policySnapshotId: baseline.id })
    expect(h.repos.policyDecisions.require(decision.id).strategy).toBe(challenger)
    expect(h.repos.policySnapshots.list()).toHaveLength(promoted.snapshots.length)

    for (const run of [unpromoted, after, restored]) await h.orchestrator.cancelRun(run.id)
  })

  it('a strategy the user chose is used as given, and its snapshot is still recorded', async () => {
    h = await createHarness({ script: scriptsByRole({ planner: async (_s, ctx) => ctx.sleep(60_000) }), policy: true })
    const run = await h.orchestrator.createRun({ projectId: h.project.id, mode: 'build', preset: 'balanced', prompt: PROMPT, strategy: 'CONSENSUS' })
    expect(run.config.strategy).toMatchObject({ requested: 'CONSENSUS', resolved: 'CONSENSUS', policyDecisionId: null, policySnapshotId: h.policy!.active().id })
    expect(run.config.strategy?.taskProfileId).toBeTruthy()
    expect(h.eventsOfType(run.id, 'policy.decided')).toEqual([])
    await h.orchestrator.cancelRun(run.id)
  })
})
