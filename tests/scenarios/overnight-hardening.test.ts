import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT } from '@shared/overnight'
import { createHarness, fileWorker, ipc, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'
import { attachOvernight, type Overnight } from './overnight-harness'

const MINUTE = 60_000
const onePlan = plan([plannedTask('only')])
const hangingWorker: FakeScript = async (_spec, ctx) => {
  await ctx.sleep(10 * MINUTE)
}

/** Regressions for the findings of the 0.2.1 audit of Overnight Mode. */
describe('scenario: Overnight Mode hardening', () => {
  let h: Harness
  let o: Overnight
  let restarted: Harness | undefined
  afterEach(async () => {
    o?.dispose()
    await restarted?.dispose()
    restarted = undefined
    await h?.dispose()
  })

  async function setup(script: FakeScript): Promise<void> {
    h = await createHarness({ script })
    o = attachOvernight(h)
  }

  // ───────────────────────────── integrity of the stored authorization ─────────────────────────────

  it('a policy edited in the database behind the supervisor is refused: report, no power action, failsafe cancelled', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start({ policy: { endAction: 'SLEEP', shutdownOn: { success: false, failure: false, blocker: false, quotaExhausted: false, timeout: false, cancellation: false } } })
    expect(o.record(run.id).authorization.seal).toBeTruthy()
    // What an agent with shell access to the data directory could do: turn the policy into "shut down on everything".
    const tampered = { ...o.record(run.id).policy, endAction: 'SHUTDOWN' as const, forceCloseApplications: true, shutdownOn: { ...DEFAULT_OVERNIGHT_POLICY.shutdownOn, cancellation: true } }
    h.db.prepare('UPDATE overnight_runs SET policy = ? WHERE run_id = ?').run(JSON.stringify(tampered), run.id)
    await o.supervisor.finalize(run.id, 'BLOCKED')
    const record = o.record(run.id)
    expect(record.state).toBe('DONE')
    expect(record.powerAction).toBeNull()
    expect(record.finalReport).toContain('failed its integrity check')
    expect(o.power.callsOf('scheduleShutdown')).toHaveLength(1)
    expect(o.power.getState().pending).toBeNull()
    expect(h.repos.powerAudit.listByRun(run.id).map((a) => a.operation)).toContain('denied')
  })

  it('a forged authorization row for another policy does not verify either, and cannot be amended', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start({ policy: { endAction: 'NONE' } })
    const record = o.record(run.id)
    const forged = { ...record.authorization, policy: { ...record.policy, endAction: 'SHUTDOWN' }, seal: 'AAAA' }
    h.db.prepare('UPDATE overnight_runs SET policy = ?, "authorization" = ? WHERE run_id = ?').run(JSON.stringify(forged.policy), JSON.stringify(forged), run.id)
    await expect(o.supervisor.changeEndPolicy(run.id, { finalDelaySeconds: 30 })).rejects.toThrow(/integrity/)
    await o.supervisor.finalize(run.id, 'SUCCESS')
    expect(o.record(run.id).powerAction).toBeNull()
    expect(o.power.calls).toHaveLength(0)
  })

  it('a change made through the supervisor is sealed again and still verifies', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    const before = o.record(run.id).authorization.seal
    await o.supervisor.changeEndPolicy(run.id, { finalDelaySeconds: 30 })
    expect(o.record(run.id).authorization.seal).not.toBe(before)
    await o.supervisor.finalize(run.id, 'BLOCKED')
    expect(o.record(run.id)).toMatchObject({ state: 'POWER_ACTION_SCHEDULED', powerAction: { action: 'SHUTDOWN' } })
  })

  // ───────────────────────────── timers never left behind ─────────────────────────────

  it('when arming fails after Windows accepted the failsafe, the timer is cancelled and the run does not start', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const setValue = h.repos.settings.setValue.bind(h.repos.settings)
    h.repos.settings.setValue = (key: string, value: unknown) => {
      if (key.startsWith('overnight-heartbeat:')) throw new Error('disk full')
      setValue(key, value)
    }
    await expect(o.start()).rejects.toThrow(/disk full/)
    h.repos.settings.setValue = setValue
    expect(o.power.calls.map((c) => c.operation)).toEqual(['scheduleShutdown', 'cancelShutdown'])
    expect(o.power.getState().pending).toBeNull()
    expect(o.supervisor.hasActive()).toBe(false)
    const [record] = h.repos.overnight.listAll()
    expect(record).toMatchObject({ state: 'DONE' })
    expect(record?.failsafe?.cancelledAt).not.toBeNull()
    expect(h.repos.runs.require(record?.runId ?? '').state).toBe('cancelled')
    expect(h.runtime.sessions).toHaveLength(0)
  })

  it('two starts at the same moment cannot both pass, even without a failsafe to collide on', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const results = await Promise.allSettled([o.start({ policy: { failsafeEnabled: false } }), o.start({ policy: { failsafeEnabled: false } })])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(h.repos.overnight.listLive()).toHaveLength(1)
  })

  it('a crash right after Windows accepted the final shutdown: the next start adopts that timer and it can be cancelled', async () => {
    h = await createHarness({ script: scenarioScript({ plan: onePlan }) })
    const first = attachOvernight(h)
    const run = await first.start({ policy: { forceCloseApplications: true } })
    await first.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    first.dispose()
    // The state NEXUS would have left behind had it died before recording the result.
    const action = h.repos.overnight.require(run.id).powerAction
    h.repos.overnight.update(run.id, { powerAction: action ? { ...action, result: null } : null })
    restarted = await h.restart()
    restarted.orchestrator.recoverOnStartup()
    o = attachOvernight(restarted, { power: first.power })
    await o.supervisor.recover()
    const record = o.record(run.id)
    expect(record.state).toBe('POWER_ACTION_SCHEDULED')
    expect(record.powerAction?.result?.ok).toBe(true)
    expect(o.supervisor.pendingPowerAction(run.id)).toMatchObject({ kind: 'final' })
    // Exactly one final timer exists in Windows; the second request was answered with 1190.
    expect(first.power.getState().pending?.purpose).toBe('final')
    await o.supervisor.cancelPower(run.id)
    expect(first.power.getState().pending).toBeNull()
    expect(o.record(run.id).state).toBe('DONE')
  })

  it('a crash in the middle of finalization after the final timer was armed does not strand it', async () => {
    h = await createHarness({ script: scenarioScript({ plan: onePlan }) })
    const first = attachOvernight(h)
    const run = await first.start({ policy: { forceCloseApplications: true } })
    await first.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    first.dispose()
    h.repos.overnight.update(run.id, { state: 'FINALIZING', powerAction: null })
    restarted = await h.restart()
    restarted.orchestrator.recoverOnStartup()
    o = attachOvernight(restarted, { power: first.power })
    await o.supervisor.recover()
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.powerAction?.result?.output).toMatch(/adopted/)
    expect(o.supervisor.pendingPowerAction(run.id)).toMatchObject({ kind: 'final' })
    await o.supervisor.cancelPower(run.id)
    expect(first.power.getState().pending).toBeNull()
  })

  it('a crash while the user was cancelling a final Windows timer: the next start finishes the cancellation', async () => {
    h = await createHarness({ script: scenarioScript({ plan: onePlan }) })
    const first = attachOvernight(h)
    const run = await first.start({ policy: { forceCloseApplications: true } })
    await first.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    first.dispose()
    h.repos.overnight.update(run.id, { state: 'CANCELLING' })
    restarted = await h.restart()
    restarted.orchestrator.recoverOnStartup()
    o = attachOvernight(restarted, { power: first.power })
    await o.supervisor.recover()
    expect(o.record(run.id).state).toBe('DONE')
    expect(o.record(run.id).powerAction?.cancelledAt).not.toBeNull()
    expect(first.power.getState().pending).toBeNull()
  })

  it('a crash while arming: the next start drops whatever timer Windows accepted and does not start the run', async () => {
    h = await createHarness({ script: scenarioScript({ plan: onePlan, worker: hangingWorker }) })
    const first = attachOvernight(h)
    const run = await first.start()
    first.dispose()
    // Died after Windows accepted the failsafe and before the record said so.
    h.repos.overnight.update(run.id, { state: 'ARMING', failsafe: null })
    restarted = await h.restart(undefined, { crash: true })
    restarted.orchestrator.recoverOnStartup()
    o = attachOvernight(restarted, { power: first.power })
    await o.supervisor.recover()
    expect(o.record(run.id).state).toBe('DONE')
    expect(first.power.getState().pending).toBeNull()
    expect(o.supervisor.hasActive()).toBe(false)
    // The run itself is an ordinary paused run the user can resume by hand.
    expect(restarted.repos.runs.require(run.id)).toMatchObject({ state: 'paused', pauseReason: 'recovery' })
  })

  it('an app countdown that is badly overdue (the PC slept, the clock jumped) is not executed late', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const run = await o.start()
    await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    o.advance(3 * 60 * MINUTE)
    await o.supervisor.tick()
    const record = o.record(run.id)
    expect(record.state).toBe('POWER_ACTION_FAILED')
    expect(record.error).toMatch(/not executed late/)
    expect(o.power.callsOf('scheduleShutdown')).toHaveLength(1)
    // The failsafe is still shown and can be cancelled.
    expect(o.supervisor.pendingPowerAction(run.id)).toMatchObject({ kind: 'failsafe' })
    await o.supervisor.cancelPower(run.id)
    expect(o.power.getState().pending).toBeNull()
  })

  it('setting the end action to NONE cancels the failsafe; switching it back on arms it again', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start()
    let status = await o.supervisor.changeEndPolicy(run.id, { endAction: 'NONE' })
    expect(status.failsafe?.cancelledAt).not.toBeNull()
    expect(o.power.getState().pending).toBeNull()
    status = await o.supervisor.changeEndPolicy(run.id, { endAction: 'SLEEP' })
    expect(status.failsafe).toMatchObject({ cancelledAt: null })
    expect(o.power.getState().pending?.purpose).toBe('failsafe')
    o.power.failNext.scheduleShutdown = 1
    await o.supervisor.changeEndPolicy(run.id, { endAction: 'NONE' })
    await expect(o.supervisor.changeEndPolicy(run.id, { endAction: 'SHUTDOWN' })).rejects.toThrow(/no failsafe is armed/)
  })

  it('a project cannot be removed while its overnight run has a timer or a power action pending', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitForState(run.id, 'completed')
    await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    await expect(ipc(h, 'projects.remove', { projectId: h.project.id })).rejects.toThrow(/shutdown timer or power action still pending/)
    expect(h.repos.overnight.getByRun(run.id)).not.toBeNull()
    await o.supervisor.cancelPower(run.id)
    await ipc(h, 'projects.remove', { projectId: h.project.id })
    expect(h.repos.overnight.getByRun(run.id)).toBeNull()
    expect(o.power.getState().pending).toBeNull()
  })

  // ───────────────────────────── quota, watchdog, approvals ─────────────────────────────

  it('quota: a rejection without a reset time that follows one with a reset time still waits', async () => {
    let limited = false
    await setup(scenarioScript({ plan: onePlan }))
    h.runtime.script = scenarioScript({
      plan: onePlan,
      worker: async (spec, ctx) => {
        if (!limited) {
          limited = true
          // What the real runtime does: the rate-limit event with the reset time, then the assistant error without one.
          await ctx.rateLimit({ status: 'rejected', resetsAt: Math.round((o.now() + 10 * MINUTE) / 1000), limitType: 'five_hour' })
          await ctx.rateLimit({ status: 'rejected', resetsAt: null, limitType: null })
          await ctx.completeTurn({ text: 'usage limit reached', outcome: 'quota' })
          return
        }
        await fileWorker(spec, ctx)
      },
    })
    const run = await o.start()
    const record = await o.waitForOvernight(run.id, 'QUOTA_PAUSED')
    expect(record.quota?.resetsAt).not.toBeNull()
    expect(record.terminalReason).toBeNull()
  })

  it('quota with the END_RUN policy ends the run although the reset time is known', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    h.runtime.script = scenarioScript({
      plan: onePlan,
      worker: async (_spec, ctx) => {
        await ctx.rateLimit({ status: 'rejected', resetsAt: Math.round((o.now() + 10 * MINUTE) / 1000), limitType: 'five_hour' })
        await ctx.completeTurn({ text: 'usage limit reached', outcome: 'quota' })
      },
    })
    const run = await o.start({ policy: { quotaPolicy: 'END_RUN', forceCloseApplications: true } })
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('QUOTA_EXHAUSTED')
  })

  it('watchdog: a check command that is still running is not a stall', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start()
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'worker session')
    // Three check commands were started (15 minutes each by default) and none has completed.
    h.bus.emit({ runId: run.id, type: 'checks.started', payload: { commands: ['pnpm typecheck', 'pnpm build', 'pnpm test'] } })
    o.advance(60 * MINUTE)
    await o.supervisor.tick()
    expect(o.record(run.id).watchdog).toHaveLength(0)
    // Past the whole check budget it is a stall after all.
    o.advance(20 * MINUTE)
    await o.supervisor.tick()
    expect(o.record(run.id).watchdog.map((d) => d.stage)).toEqual(['stalled', 'reconciled'])
  })

  it('a high-risk task is never started unattended, even with plan changes auto-approved', async () => {
    await setup(scenarioScript({ plan: plan([plannedTask('danger', { requiresApproval: true, risk: 'high' }), plannedTask('safe', { requiresApproval: true, risk: 'low' })]) }))
    const run = await o.start({ policy: { endAction: 'NONE' } })
    await o.waitForOvernight(run.id, 'DONE')
    expect(h.task(run.id, 'danger').state).toBe('cancelled')
    expect(h.task(run.id, 'safe').state).toBe('completed')
  })

  it('approvals left pending by a restart are answered when the overnight run is recovered', async () => {
    let stalled = false
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('first'), plannedTask('gated', { requiresApproval: true, dependencies: ['first'] })]),
        worker: async (_spec, ctx) => {
          stalled = true
          await ctx.sleep(10 * MINUTE)
        },
      }),
    })
    const first = attachOvernight(h)
    const run = await first.start({ policy: { endAction: 'NONE' } })
    await h.waitFor(() => stalled, 'first task running')
    first.dispose()
    // A task-start request that was raised and not yet answered when NEXUS stopped.
    h.orchestrator.core.approvals.create({ runId: run.id, taskId: h.task(run.id, 'gated').id, agentId: null, kind: 'task', action: 'Start task "gated"', reason: 'needs approval', command: null, requestedBy: 'Scheduler', risk: 'low' })
    restarted = await h.restart(scenarioScript({ plan: onePlan }), { crash: true })
    restarted.orchestrator.recoverOnStartup()
    o = attachOvernight(restarted, { power: first.power })
    await o.supervisor.recover()
    await restarted.waitFor(() => restarted?.repos.approvals.listPending(run.id).length === 0, 'the pending approval to be answered')
    expect(restarted.repos.approvals.listByRun(run.id).filter((a) => a.kind === 'task').every((a) => a.status !== 'pending')).toBe(true)
    await restarted.waitForState(run.id, 'completed')
  })

  it('the start request itself still needs the exact confirmation', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    await expect(o.supervisor.start({ projectId: h.project.id, prompt: 'x', preset: 'balanced', policy: DEFAULT_OVERNIGHT_POLICY, confirmed: true, confirmation: `${OVERNIGHT_CONFIRMATION_TEXT} ` })).rejects.toThrow(/authorization/)
  })
})
