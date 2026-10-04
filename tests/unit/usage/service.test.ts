import { afterEach, describe, expect, it } from 'vitest'
import type { PushMessage } from '@shared/events'
import { newId, nowIso } from '@shared/ids'
import type { MissionOutcome, UsageOverview } from '@shared/v3'
import { FakeAgentRuntime, completeWith } from '@main/modules/agent-runtime/fake-runtime'
import { EventBus } from '@main/modules/events'
import { UsageIntelligenceService } from '@main/modules/usage'
import { makeAgent, makeProject, makeRun, makeTask, openMemory } from '../../integration/persistence/fixtures'

const T0 = Date.UTC(2026, 9, 4, 22, 0, 0)

function setup() {
  const { db, repos } = openMemory()
  const bus = new EventBus(repos.events, repos.transaction)
  const runtime = new FakeAgentRuntime({ script: completeWith({ text: 'ok' }) })
  const pushes: PushMessage[] = []
  let now = T0
  const usage = new UsageIntelligenceService({ repos, bus, runtime, push: (m) => void pushes.push(m), now: () => now })
  const project = repos.projects.insert(makeProject())
  const run = repos.runs.insert(makeRun(project.id, { prompt: 'Add a settings page to the app with a long enough prompt to be cut at sixty characters' }))
  const task = repos.tasks.insert(makeTask(run.id, 'api'))
  const agent = repos.agents.insert(makeAgent(run.id, task.id, { label: 'Worker/api' }))
  const turn = (over: { input?: number; output?: number; model?: string; turns?: number; durationMs?: number } = {}) =>
    bus.emit({
      runId: run.id,
      taskId: task.id,
      agentId: agent.id,
      type: 'agent.usage',
      payload: {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turn: {
          sdkSessionId: 'sdk-1',
          role: 'worker',
          turns: over.turns ?? 1,
          durationMs: over.durationMs ?? 1000,
          models: [{ model: over.model ?? 'sonnet', inputTokens: over.input ?? 1000, outputTokens: over.output ?? 200, cacheReadTokens: 10, cacheCreationTokens: 5, costUsd: 0.01 }],
        },
      },
    })
  return { db, repos, bus, runtime, pushes, usage, project, run, task, agent, turn, setNow: (t: number) => (now = t) }
}

/** Every key that looks like a percentage must be null, or EXACT with a value. Observed data never qualifies. */
function percentViolations(value: unknown, path = '$'): string[] {
  const out: string[] = []
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...percentViolations(v, `${path}[${i}]`)))
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = `${path}.${k}`
      if (/percent/i.test(k)) {
        if (v !== null && typeof v === 'object') {
          const m = v as { value: unknown; confidence: string }
          if (m.value !== null && m.confidence !== 'EXACT') out.push(`${here} has a value with confidence ${m.confidence}`)
        } else if (v !== null && (value as { confidence?: string }).confidence !== 'EXACT') out.push(`${here} is ${String(v)} without EXACT provenance`)
      } else out.push(...percentViolations(v, here))
    }
  }
  return out
}

describe('usage service: provenance (no fabricated percentage)', () => {
  let ctx: ReturnType<typeof setup>
  afterEach(() => ctx?.usage.dispose())

  it('an overview built from observed data only has no percentage, and no remaining figure', () => {
    ctx = setup()
    ctx.turn({ input: 5_000_000, output: 2_000_000 }) // enormous observed use: still no denominator
    ctx.bus.emit({ runId: ctx.run.id, type: 'agent.message', payload: { preview: 'x' } })
    const o = ctx.usage.overview()
    expect(o.session).toMatchObject({ sessions: 1, inputTokens: 5_000_000, outputTokens: 2_000_000, turns: 1 })
    expect(o.subscriptionUtilizationPercent).toEqual({ value: null, source: 'UNKNOWN', confidence: 'UNKNOWN' })
    expect(o.windows).toEqual([])
    expect(percentViolations(o)).toEqual([])
    expect(o.status).toBe('AVAILABLE')
    expect(JSON.stringify(o)).not.toMatch(/remaining/i)
  })

  it('a raw rate-limit utilization is stored raw and never becomes a percentage', () => {
    ctx = setup()
    ctx.bus.emit({ runId: ctx.run.id, type: 'agent.rate_limited', payload: { status: 'allowed_warning', resetsAt: null, limitType: 'five_hour', utilization: 0.92 } })
    const o = ctx.usage.overview()
    expect(o.status).toBe('LIMIT_APPROACHING')
    expect(o.windows).toHaveLength(1)
    expect(o.windows[0]).toMatchObject({ limitType: 'five_hour', status: 'allowed_warning', utilizationPercent: null })
    expect(o.subscriptionUtilizationPercent.value).toBeNull()
    expect(percentViolations(o)).toEqual([])
    const row = ctx.repos.usageEvents.latestOfType('limit_warning')
    expect(row).toMatchObject({ utilization: 0.92, utilizationUnit: 'raw' })
  })

  it('observed tokens never cause LIMIT_APPROACHING', () => {
    ctx = setup()
    for (let i = 0; i < 20; i++) ctx.turn({ input: 10_000_000, output: 5_000_000 })
    expect(ctx.usage.status()).toBe('AVAILABLE')
  })

  it('a percentage appears only from a runtime usage report, as EXACT', async () => {
    ctx = setup()
    ctx.runtime.usage.set({ utilizationPercent: 42 })
    const o = await ctx.usage.refresh()
    expect(o.usageReportSupported).toBe(true)
    expect(o.subscriptionUtilizationPercent).toMatchObject({ value: 42, confidence: 'EXACT', source: 'RUNTIME' })
    expect(o.windows[0]).toMatchObject({ limitType: 'five_hour', utilizationPercent: 42, confidence: 'EXACT' })
    expect(percentViolations(o)).toEqual([])
    expect(ctx.repos.usageEvents.latestOfType('usage_report')).toMatchObject({ utilization: 42, utilizationUnit: 'percent', source: 'RUNTIME' })
    // no prompt was sent for it
    expect(ctx.runtime.sessions).toHaveLength(0)
  })

  it('an unsupported usage report leaves everything UNKNOWN', async () => {
    ctx = setup()
    ctx.runtime.usage.set({ reportSupported: false })
    const o = await ctx.usage.refresh()
    expect(o.usageReportSupported).toBe(false)
    expect(o.subscriptionUtilizationPercent.value).toBeNull()
    expect(o.nextResetAt).toEqual({ value: null, source: 'UNKNOWN', confidence: 'UNKNOWN' })
  })

  it('the account comes from the runtime, never guessed', async () => {
    ctx = setup()
    expect(ctx.usage.overview().accountMode.value).toBeNull()
    await ctx.usage.refresh()
    const o = ctx.usage.overview()
    expect(o.accountMode).toMatchObject({ value: 'subscription', confidence: 'EXACT' })
    expect(o.subscriptionType).toMatchObject({ value: 'max', confidence: 'EXACT' })
  })

  it('a reset time is EXACT when the runtime gave it, else unknown; retry-after likewise', () => {
    ctx = setup()
    ctx.bus.emit({ runId: ctx.run.id, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt: null, limitType: null } })
    expect(ctx.usage.overview().nextResetAt.value).toBeNull()
    ctx.usage.dispose()
    ctx = setup()
    const reset = Math.floor((T0 + 40 * 60_000) / 1000)
    ctx.bus.emit({ runId: ctx.run.id, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt: reset, limitType: 'five_hour' } })
    const o = ctx.usage.overview()
    expect(o.status).toBe('QUOTA_PAUSED')
    expect(o.nextResetAt).toMatchObject({ value: new Date(T0 + 40 * 60_000).toISOString(), confidence: 'EXACT' })
    expect(o.retryAfterMs).toMatchObject({ value: 40 * 60_000, confidence: 'EXACT' })
    expect(ctx.usage.canDispatch()).toBe(false)
    expect(ctx.usage.recentLimitWithin(60 * 60_000)).toBe(true)
  })

  it('a throttle is recorded but never blocks dispatch or counts as a limit', () => {
    ctx = setup()
    ctx.bus.emit({ runId: ctx.run.id, type: 'agent.rate_limited', payload: { status: 'throttled', resetsAt: null, limitType: 'overloaded' } })
    expect(ctx.usage.status()).toBe('THROTTLED')
    expect(ctx.usage.canDispatch()).toBe(true)
    expect(ctx.repos.usageEvents.latestOfType('throttle')).toMatchObject({ availability: 'THROTTLED', rawClassification: 'assistant_error:overloaded' })
    expect(ctx.usage.recentLimitWithin(60 * 60_000)).toBe(false)
    expect(ctx.repos.usageEvents.totals().limitEvents).toBe(0)
  })
})

describe('usage service: aggregation', () => {
  let ctx: ReturnType<typeof setup>
  afterEach(() => ctx?.usage.dispose())

  it('writes one session row per agent session, accumulating its turns', () => {
    ctx = setup()
    ctx.turn({ input: 1000, output: 200, turns: 2, durationMs: 4000 })
    ctx.turn({ input: 500, output: 100, turns: 1, durationMs: 1000 })
    const rows = ctx.repos.usageEvents.listByRun(ctx.run.id).filter((e) => e.eventType === 'session')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agentId: ctx.agent.id,
      taskId: ctx.task.id,
      role: 'worker',
      model: 'sonnet',
      sdkSessionId: 'sdk-1',
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 20,
      turns: 3,
      durationMs: 5000,
      source: 'SDK_EVENT',
      confidence: 'OBSERVED',
    })
    expect(rows[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ctx.usage.totals()).toMatchObject({ sessions: 1, turns: 3, inputTokens: 1500, outputTokens: 300 })
    expect(ctx.usage.overview().session).toMatchObject({ sessions: 1, inputTokens: 1500 })
  })

  it('records the run strategy and the Arena campaign on the row', () => {
    ctx = setup()
    ctx.repos.runs.update(ctx.run.id, { config: { ...ctx.run.config, strategy: { requested: 'ADAPTIVE', resolved: 'BUILD', speculativeCandidates: 1, policyDecisionId: null, policySnapshotId: null, taskProfileId: null, arenaTrialId: null } } })
    ctx.turn()
    expect(ctx.repos.usageEvents.listByRun(ctx.run.id)[0]?.strategy).toBe('BUILD')
    expect(ctx.usage.breakdown('strategy')[0]).toMatchObject({ key: 'BUILD', sessions: 1 })
  })

  it('breakdown labels are human: run prompt (60 chars), agent label, task key and title', () => {
    ctx = setup()
    ctx.turn()
    const run = ctx.usage.breakdown('run')[0]
    expect(run?.key).toBe(ctx.run.id)
    expect(run?.label).toBe(ctx.run.prompt.slice(0, 60))
    expect(ctx.usage.breakdown('agent')[0]?.label).toBe('Worker/api')
    expect(ctx.usage.breakdown('task')[0]?.label).toBe('api Task api')
    expect(ctx.usage.breakdown('model')[0]).toMatchObject({ key: 'sonnet', label: 'sonnet' })
    expect(ctx.usage.breakdown('role')[0]?.key).toBe('worker')
    expect(ctx.usage.breakdown('day')).toHaveLength(1)
  })

  it('runUsage totals by agent, model and role', () => {
    ctx = setup()
    ctx.turn({ input: 700, output: 100 })
    const u = ctx.usage.runUsage(ctx.run.id)
    expect(u).toMatchObject({ runId: ctx.run.id, agents: 1, totals: { sessions: 1, inputTokens: 700 } })
    expect(u.byModel[0]?.key).toBe('sonnet')
    expect(u.byRole[0]?.key).toBe('worker')
    expect(u.pauses).toEqual([])
  })

  it('limit history lists limit events and pauses with their resumes', () => {
    ctx = setup()
    ctx.bus.emit({ runId: ctx.run.id, agentId: ctx.agent.id, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt: Math.floor(T0 / 1000) + 3600, limitType: 'five_hour' } })
    // the same limit reported again without a reset (error after the event) is not a second hit
    ctx.bus.emit({ runId: ctx.run.id, agentId: ctx.agent.id, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt: null, limitType: null } })
    const at = nowIso()
    const pause = ctx.repos.quotaPauses.insert({ id: newId(), runId: ctx.run.id, scope: 'run', state: 'resumed', pausedAt: at, limitType: 'five_hour', resetAt: null, resetConfidence: 'UNKNOWN', nextCheckAt: null, probes: 1, checkpointId: null, resumeState: 'executing', endedAt: at, endReason: null, createdAt: at, updatedAt: at })
    ctx.repos.quotaResumes.insert({ id: newId(), pauseId: pause.id, runId: ctx.run.id, attemptedAt: at, kind: 'resume', result: 'resumed', method: 'usage_report', detail: null, waitedMs: 1000, createdAt: at })
    const h = ctx.usage.limitHistory({ limit: 10, offset: 0 })
    expect(h.events.filter((e) => e.eventType === 'limit_rejected')).toHaveLength(1)
    expect(h.pauses).toHaveLength(1)
    expect(h.pauses[0]).toMatchObject({ id: pause.id, runLabel: ctx.run.prompt.slice(0, 80) })
    expect(h.pauses[0]?.resumes).toHaveLength(1)
    expect(ctx.usage.totals().limitEvents).toBe(1)
  })

  it('efficiency: tokens and sessions per successful task come from observed rows and completed tasks only', () => {
    ctx = setup()
    expect(ctx.usage.efficiency()).toMatchObject({ successfulTasks: 0 })
    expect(ctx.usage.efficiency().tokensPerSuccessfulTask.value).toBeNull() // no completed task: unknown, not zero
    ctx.turn({ input: 800, output: 200 })
    const outcome = (completed: boolean, repairs: number) => ({
      id: newId(),
      projectId: ctx.project.id,
      runId: ctx.run.id,
      taskId: newId(),
      role: 'worker' as const,
      model: 'sonnet',
      tier: 'balanced' as const,
      category: 'implement' as const,
      complexity: 'small' as const,
      risk: 'low' as const,
      attempts: 1,
      firstPassVerified: completed,
      completed,
      reviewRejections: 0,
      repairCount: repairs,
      checksFailed: 0,
      humanInterventions: 0,
      elapsedMs: 1000,
      inputTokens: 1,
      outputTokens: 1,
      createdAt: nowIso(),
    })
    // task_outcomes reference tasks: reuse real task rows
    const t2 = ctx.repos.tasks.insert(makeTask(ctx.run.id, 'ui'))
    ctx.repos.taskOutcomes.upsertForTask({ ...outcome(true, 1), taskId: ctx.task.id })
    ctx.repos.taskOutcomes.upsertForTask({ ...outcome(false, 3), taskId: t2.id })
    const e = ctx.usage.efficiency()
    expect(e.successfulTasks).toBe(1)
    expect(e.tokensPerSuccessfulTask).toMatchObject({ value: 1000, confidence: 'OBSERVED', source: 'LOCAL_AGGREGATION' })
    expect(e.sessionsPerSuccessfulTask.value).toBe(1)
    expect(e.repairsPerTask.value).toBe(2)
  })

  it('efficiency by strategy keeps real missions and Arena trials apart and labels the evidence', () => {
    ctx = setup()
    const mission = (strategy: MissionOutcome['strategy'], success: boolean, i: number): MissionOutcome => {
      const run = ctx.repos.runs.insert(makeRun(ctx.project.id))
      return {
        id: newId(),
        runId: run.id,
        projectId: ctx.project.id,
        taskProfileId: null,
        contextKey: 'k',
        strategy,
        requestedStrategy: strategy,
        planningMode: 'single',
        reviewMode: 'standard',
        policyDecisionId: null,
        policySnapshotId: null,
        models: {},
        agents: 2,
        sessions: 4 + i,
        tasks: 2,
        tasksCompleted: success ? 2 : 1,
        repairs: 0,
        reviews: 2,
        reviewRejections: 0,
        verificationPassed: success,
        elapsedMs: 1000 * (i + 1),
        inputTokens: 100,
        outputTokens: 50,
        quotaPauses: 0,
        quotaWaitMs: 0,
        humanInterventions: 0,
        terminal: success ? 'completed' : 'failed',
        success,
        isArena: false,
        nexusVersion: '0.3.0',
        createdAt: nowIso(),
      }
    }
    for (let i = 0; i < 6; i++) ctx.repos.missionOutcomes.upsertForRun(mission('BUILD', i !== 0, i))
    ctx.repos.missionOutcomes.upsertForRun(mission('SWARM', true, 0))
    const rows = ctx.usage.efficiency().byStrategy
    const balanced = rows.find((r) => r.strategy === 'BUILD' && r.kind === 'mission')
    expect(balanced).toMatchObject({ n: 6, successes: 5, meanObservedTokens: 150, label: 'WEAK' })
    expect(balanced?.passRate).toBeCloseTo(5 / 6)
    expect(balanced?.meanSessions).toBeCloseTo(4 + 2.5)
    expect(rows.find((r) => r.strategy === 'SWARM')).toMatchObject({ kind: 'mission', n: 1, label: 'INSUFFICIENT' })
    expect(rows.filter((r) => r.kind === 'arena')).toEqual([])
  })

  it('a status change pushes the overview at once', () => {
    ctx = setup()
    const before = ctx.pushes.filter((m) => m.kind === 'usage').length
    ctx.bus.emit({ runId: ctx.run.id, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt: null, limitType: null } })
    const pushed = ctx.pushes.filter((m): m is Extract<PushMessage, { kind: 'usage' }> => m.kind === 'usage')
    expect(pushed.length).toBeGreaterThan(before)
    expect((pushed.at(-1) as { overview: UsageOverview }).overview.status).toBe('QUOTA_PAUSED')
  })
})
