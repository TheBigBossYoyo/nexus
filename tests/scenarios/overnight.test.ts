import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { OVERNIGHT_CONFIRMATION_TEXT } from '@shared/overnight'
import { createHarness, fileWorker, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'
import { attachOvernight, policyWith, type Overnight } from './overnight-harness'

const MINUTE = 60_000
const onePlan = plan([plannedTask('only')])

/** Never finishes on its own; returns when its session is stopped. */
const hangingWorker: FakeScript = async (_spec, ctx) => {
  await ctx.sleep(10 * MINUTE)
}

const failingWorker: FakeScript = async (_spec, ctx) => {
  await ctx.completeTurn({ text: 'cannot do this', outcome: 'error' })
}

const quotaWorker =
  (resetsAt: () => number | null, times = 1): FakeScript =>
  async (spec, ctx) => {
    if (times-- > 0) {
      await ctx.rateLimit({ status: 'rejected', resetsAt: resetsAt(), limitType: 'five_hour' })
      await ctx.completeTurn({ text: 'usage limit reached', outcome: 'quota' })
      return
    }
    await fileWorker(spec, ctx)
  }

describe('scenario: Overnight Mode', () => {
  let h: Harness
  let o: Overnight
  afterEach(async () => {
    o?.dispose()
    await h?.dispose()
  })

  async function setup(script: FakeScript): Promise<void> {
    h = await createHarness({ script })
    o = attachOvernight(h)
  }

  const shutdowns = (): string[][] => o.power.callsOf('scheduleShutdown').map((c) => c.args)
  const audit = (runId: string): string[] => h.repos.powerAudit.listByRun(runId).map((a) => a.operation)

  // ───────────────────────────── authorization ─────────────────────────────

  it('refuses to start without the explicit run-level authorization and touches nothing', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    await expect(o.start({ confirmed: false })).rejects.toThrow(/authorization/)
    await expect(o.start({ confirmation: 'yes whatever' })).rejects.toThrow(/authorization/)
    expect(h.repos.runs.listByProject(h.project.id)).toHaveLength(0)
    expect(o.power.calls).toHaveLength(0)
    expect(h.repos.overnight.listAll()).toHaveLength(0)
  })

  it('persists the approved policy and authorization with the run, and arms the failsafe before any agent starts', async () => {
    let powerCallsAtFirstSession = -1
    let recordAtFirstSession: string | null = null
    await setup(scenarioScript({ plan: onePlan }))
    const base = h.runtime.script
    h.runtime.script = async (spec, ctx) => {
      if (powerCallsAtFirstSession < 0) {
        powerCallsAtFirstSession = o.power.callsOf('scheduleShutdown').length
        recordAtFirstSession = h.repos.overnight.listLive()[0]?.state ?? null
      }
      await base(spec, ctx)
    }
    const run = await o.start()
    const record = o.record(run.id)
    expect(record.authorization).toMatchObject({ runId: run.id, confirmation: OVERNIGHT_CONFIRMATION_TEXT })
    expect(Date.parse(record.authorization.authorizedAt)).not.toBeNaN()
    expect(record.authorization.policy).toEqual(policyWith())
    expect(record.policy).toEqual(policyWith())
    expect(run.mode).toBe('mission')
    expect(run.config.requirePlanApproval).toBe(false)
    expect(run.config.maxDurationMinutes).toBe(480)

    // 9 hours, no /f unless the user asked for a forced close.
    expect(shutdowns()[0]).toEqual(['/s', '/t', '32400', '/c', expect.stringContaining('failsafe')])
    expect(record.failsafe).toMatchObject({ cancelledAt: null, lostAt: null, result: { ok: true } })
    // The failsafe is timed from the moment Windows accepted it, a few milliseconds after the run started.
    expect(Math.abs(Date.parse(record.failsafe?.deadline ?? '') - Date.parse(record.startedAt) - 540 * MINUTE)).toBeLessThan(2000)
    expect(Date.parse(record.deadlineAt) - Date.parse(record.startedAt)).toBe(480 * MINUTE)

    await h.waitForState(run.id, 'completed')
    expect(powerCallsAtFirstSession).toBe(1)
    expect(recordAtFirstSession).toBe('RUNNING')
    expect(h.eventsOfType(run.id, 'overnight.started')).toHaveLength(1)
  })

  it('does not start any agent when Windows refuses the failsafe timer', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    o.power.simulateForeignShutdown(3600)
    await expect(o.start()).rejects.toThrow(/already has a shutdown scheduled/)
    const [run] = h.repos.runs.listByProject(h.project.id)
    expect(run?.state).toBe('cancelled')
    await h.orchestrator.idle(run?.id ?? '')
    expect(h.runtime.sessions).toHaveLength(0)
    expect(h.repos.overnight.listLive()).toHaveLength(0)
    expect(o.supervisor.hasActive()).toBe(false)
    // The foreign timer was not touched.
    expect(o.power.callsOf('cancelShutdown')).toHaveLength(0)
  })

  it('allows only one overnight run at a time (Windows has one shutdown timer)', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    await o.start()
    await expect(o.start()).rejects.toThrow(/already active/)
    expect(shutdowns()).toHaveLength(1)
  })

  // ───────────────────────────── terminal reasons ─────────────────────────────

  it('success: report saved, failsafe replaced by a normal shutdown after the countdown', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const run = await o.start()
    await h.waitForState(run.id, 'completed')
    let record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('SUCCESS')
    expect(record.finalReport).toContain('# NEXUS Overnight Run')
    expect(record.finalReport).toContain('**SUCCESS**')
    expect(record.powerAction).toMatchObject({ action: 'SHUTDOWN', mechanism: 'app_timer', forced: false, executedAt: null })
    // A normal shutdown has no Windows timer: the failsafe is still armed during the countdown.
    expect(record.failsafe?.cancelledAt).toBeNull()
    expect(shutdowns()).toHaveLength(1)
    expect(o.supervisor.pendingPowerAction(run.id)).toMatchObject({ kind: 'final', action: 'SHUTDOWN' })

    // Nothing happens before the delay has passed.
    await o.supervisor.tick()
    expect(o.record(run.id).state).toBe('POWER_ACTION_SCHEDULED')
    o.advance(61_000)
    record = await o.waitForOvernight(run.id, 'DONE')
    expect(record.failsafe?.cancelledAt).not.toBeNull()
    expect(o.power.calls.map((c) => c.operation)).toEqual(['scheduleShutdown', 'cancelShutdown', 'scheduleShutdown'])
    // Immediate, and without /f: applications may still veto it.
    expect(shutdowns()[1]).toEqual(['/s', '/t', '0', '/c', expect.stringContaining('mission has ended')])
    expect(o.power.reportSavedAtFinal).toEqual([true])
    expect(audit(run.id)).toEqual(['arm_failsafe', 'schedule_final', 'cancel_failsafe', 'execute_final'])
    expect(record.finalReport).toContain('### Power action result')

    // The report is on disk in the data directory and in the project, outside git's view.
    expect(record.reportPath).toContain(join('.nexus', 'reports'))
    expect(readFileSync(record.reportPath ?? '', 'utf8')).toContain('**SUCCESS**')
    expect(existsSync(join(h.dir, 'reports'))).toBe(true)
    expect((await h.git.status(h.repoDir)).clean).toBe(true)
    expect(o.supervisor.hasActive()).toBe(false)
  })

  it('forced close: /f on both timers, and the final shutdown is a Windows timer scheduled after the report', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitForState(run.id, 'completed')
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(shutdowns()).toEqual([
      ['/s', '/f', '/t', '32400', '/c', expect.any(String)],
      ['/s', '/f', '/t', '60', '/c', expect.any(String)],
    ])
    expect(o.power.calls.map((c) => c.operation)).toEqual(['scheduleShutdown', 'cancelShutdown', 'scheduleShutdown'])
    expect(record.powerAction).toMatchObject({ mechanism: 'os_timer', forced: true, result: { ok: true } })
    expect(record.failsafe?.cancelledAt).not.toBeNull()
    expect(o.power.reportSavedAtFinal).toEqual([true])
    expect(o.power.getState().pending?.purpose).toBe('final')
  })

  it('failure: a run that fails gets its report and the configured shutdown', async () => {
    await setup(scenarioScript({ plan: () => ({ nonsense: true }) }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitForState(run.id, 'failed')
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('FAILED')
    expect(record.finalReport).toContain('FAILED')
    expect(o.power.reportSavedAtFinal).toEqual([true])
    expect(shutdowns()).toHaveLength(2)
  })

  it('blocker: an intervention pause ends the overnight run as BLOCKED and the run stays resumable', async () => {
    await setup(scenarioScript({ plan: plan([plannedTask('a'), plannedTask('b', { dependencies: ['a'] })]), worker: failingWorker }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitForState(run.id, 'paused')
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('BLOCKED')
    expect(record.terminalDetail).toMatch(/Intervention required/)
    expect(record.finalReport).toContain('## Remaining issues')
    expect(record.finalReport).toContain('`a` [failed]')
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    expect(shutdowns()).toHaveLength(2)
  })

  it('quota exhausted: no reset time means the run ends as QUOTA_EXHAUSTED, not as a failure', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: quotaWorker(() => null) }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitForState(run.id, 'paused')
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('QUOTA_EXHAUSTED')
    expect(record.quota).toMatchObject({ resumeAt: null, resetsAt: null })
    expect(h.task(run.id, 'only').state).not.toBe('failed')
    expect(h.eventsOfType(run.id, 'task.failed')).toHaveLength(0)
    expect(h.repos.runs.require(run.id)).toMatchObject({ state: 'paused', pauseReason: 'quota' })
    expect(record.finalReport).toContain('QUOTA_EXHAUSTED')
    expect(shutdowns()).toHaveLength(2)
  })

  it('quota with a reset inside the mission time: waits in QUOTA_PAUSED, resumes by itself and finishes', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const resetsAtSeconds = (): number => Math.round((o.now() + 10 * MINUTE) / 1000)
    h.runtime.script = scenarioScript({ plan: onePlan, worker: quotaWorker(resetsAtSeconds) })
    const run = await o.start()
    await h.waitForState(run.id, 'paused')
    let record = await o.waitForOvernight(run.id, 'QUOTA_PAUSED')
    expect(record.quota?.waits).toBe(1)
    expect(Date.parse(record.quota?.resumeAt ?? '')).toBeGreaterThan(Date.parse(record.quota?.resetsAt ?? ''))
    // Still waiting: no power call beyond the failsafe, the run is untouched.
    await o.supervisor.tick()
    expect(o.record(run.id).state).toBe('QUOTA_PAUSED')
    expect(o.power.calls).toHaveLength(1)

    o.advance(12 * MINUTE)
    await o.supervisor.tick()
    await h.waitForState(run.id, 'completed')
    record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('SUCCESS')
    expect(h.eventsOfType(run.id, 'overnight.quota').map((e) => e.payload.action)).toEqual(['waiting', 'resumed'])
    expect(sessionsOf(h, 'worker')).toHaveLength(2)
  })

  it('quota with a reset after the deadline, or with the END_RUN policy, ends the run', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    h.runtime.script = scenarioScript({ plan: onePlan, worker: quotaWorker(() => Math.round((o.now() + 9 * 60 * MINUTE) / 1000)) })
    const run = await o.start({ policy: { forceCloseApplications: true } })
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('QUOTA_EXHAUSTED')
    expect(record.terminalDetail).toMatch(/after the mission deadline/)
  })

  it('timeout: the wall-clock deadline stops the agents, saves the report and schedules the shutdown', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'worker session')
    await o.supervisor.tick()
    expect(o.record(run.id).state).toBe('RUNNING')

    o.advance(8 * 60 * MINUTE + 1000)
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('TIME_LIMIT')
    expect(record.finalReport).toContain('TIMEOUT')
    expect(h.repos.runs.require(run.id).state).toBe('paused')
    expect(h.repos.agents.listActive(run.id)).toHaveLength(0)
    expect(o.power.reportSavedAtFinal).toEqual([true])
    expect(shutdowns()[1]).toEqual(['/s', '/f', '/t', '60', '/c', expect.any(String)])
  })

  it('sleep and hibernate run through the countdown and never use shutdown.exe /s', async () => {
    for (const endAction of ['SLEEP', 'HIBERNATE'] as const) {
      await setup(scenarioScript({ plan: onePlan }))
      const run = await o.start({ policy: { endAction } })
      await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
      o.advance(61_000)
      const record = await o.waitForOvernight(run.id, 'DONE')
      expect(record.powerAction).toMatchObject({ action: endAction, mechanism: 'app_timer' })
      expect(o.power.calls.map((c) => c.operation)).toEqual(['scheduleShutdown', 'cancelShutdown', endAction === 'SLEEP' ? 'sleep' : 'hibernate'])
      expect(o.power.reportSavedAtFinal).toEqual([true])
      o.dispose()
      await h.dispose()
    }
  })

  // ───────────────────────────── the gate ─────────────────────────────

  it('applies no power action when the policy does not cover the terminal reason, and cancels the failsafe', async () => {
    await setup(scenarioScript({ plan: () => ({ nonsense: true }) }))
    const run = await o.start({ policy: { shutdownOn: { success: true, failure: false, blocker: true, quotaExhausted: true, timeout: true, cancellation: false } } })
    const record = await o.waitForOvernight(run.id, 'DONE')
    expect(record.terminalReason).toBe('FAILED')
    expect(record.powerAction).toBeNull()
    expect(record.failsafe?.cancelledAt).not.toBeNull()
    expect(o.power.calls.map((c) => c.operation)).toEqual(['scheduleShutdown', 'cancelShutdown'])
    expect(audit(run.id)).toEqual(['arm_failsafe', 'denied', 'cancel_failsafe'])
    expect(record.finalReport).toContain('No power action')
  })

  it('end action NONE: the report is written and nothing is scheduled', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const run = await o.start({ policy: { endAction: 'NONE' } })
    const record = await o.waitForOvernight(run.id, 'DONE')
    expect(record.finalReport).toContain('**SUCCESS**')
    // No power action was asked for, so not even the failsafe timer was armed.
    expect(o.power.calls).toHaveLength(0)
    expect(record.failsafe).toBeNull()
    expect(o.power.getState().pending).toBeNull()
  })

  it('finalization is idempotent: concurrent and repeated calls schedule one action and keep one report', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'worker session')
    await Promise.all([
      o.supervisor.finalize(run.id, 'BLOCKED', 'first'),
      o.supervisor.finalize(run.id, 'FAILED', 'second'),
      o.supervisor.finalize(run.id, 'TIME_LIMIT', 'third'),
      o.supervisor.tick(),
    ])
    await o.supervisor.finalize(run.id, 'SUCCESS')
    await o.supervisor.tick()
    const record = o.record(run.id)
    expect(record.state).toBe('POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('BLOCKED')
    expect(record.terminalDetail).toBe('first')
    expect(shutdowns()).toHaveLength(2)
    expect(o.power.callsOf('cancelShutdown')).toHaveLength(1)
    expect(h.eventsOfType(run.id, 'overnight.report')).toHaveLength(1)
    expect(record.finalReport?.match(/# NEXUS Overnight Run/g)).toHaveLength(1)
  })

  it('a refused final shutdown is reported and the failsafe is restored', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    o.power.failNext.scheduleShutdown = 2
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_FAILED')
    expect(record.error).toMatch(/refused the final shutdown/)
    expect(record.finalReport).toContain('**SUCCESS**')
    // Failsafe, two refused attempts, then the failsafe again.
    expect(o.power.callsOf('scheduleShutdown').map((c) => c.ok)).toEqual([true, false, false, true])
    expect(o.record(run.id).failsafe).toMatchObject({ cancelledAt: null })
    expect(o.supervisor.pendingPowerAction(run.id)).toMatchObject({ kind: 'failsafe' })
    // The user can still call it off.
    await o.supervisor.cancelPower(run.id)
    expect(o.power.getState().pending).toBeNull()
  })

  // ───────────────────────────── user actions ─────────────────────────────

  it('CANCEL SHUTDOWN during the run: failsafe cancelled, end action NONE, mission continues to the end', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    await setup(
      scenarioScript({
        plan: onePlan,
        worker: async (spec, ctx) => {
          await gate
          await fileWorker(spec, ctx)
        },
      }),
    )
    const run = await o.start()
    const status = await o.supervisor.cancelPower(run.id)
    expect(status.policy.endAction).toBe('NONE')
    expect(status.failsafe?.cancelledAt).not.toBeNull()
    expect(status.amendments).toHaveLength(1)
    // The approved policy is kept as it was authorized.
    expect(status.authorization.policy.endAction).toBe('SHUTDOWN')
    expect(status.state).toBe('RUNNING')
    release()
    await h.waitForState(run.id, 'completed')
    const record = await o.waitForOvernight(run.id, 'DONE')
    expect(record.powerAction).toBeNull()
    expect(o.power.calls.map((c) => c.operation)).toEqual(['scheduleShutdown', 'cancelShutdown'])
  })

  it('CANCEL SHUTDOWN during the final countdown aborts the Windows timer', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    const status = await o.supervisor.cancelPower(run.id)
    expect(status.state).toBe('DONE')
    expect(status.powerAction?.cancelledAt).not.toBeNull()
    expect(o.power.getState().pending).toBeNull()
    expect(audit(run.id).at(-1)).toBe('cancel_final')
    o.advance(10 * MINUTE)
    await o.supervisor.tick()
    expect(shutdowns()).toHaveLength(2)
  })

  it('CANCEL SHUTDOWN during an app countdown stops the action from ever running', async () => {
    await setup(scenarioScript({ plan: onePlan }))
    const run = await o.start()
    await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    await o.supervisor.cancelPower(run.id)
    o.advance(10 * MINUTE)
    await o.supervisor.tick()
    expect(o.record(run.id).state).toBe('DONE')
    expect(shutdowns()).toHaveLength(1)
    expect(o.power.getState().pending).toBeNull()
  })

  it('CHANGE END ACTION is recorded as a user amendment and decides what happens at the end', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start()
    const status = await o.supervisor.changeEndPolicy(run.id, { endAction: 'HIBERNATE', finalDelaySeconds: 30 })
    expect(status.policy).toMatchObject({ endAction: 'HIBERNATE', finalDelaySeconds: 30 })
    expect(status.amendments[0]).toMatchObject({ by: 'user' })
    expect(h.eventsOfType(run.id, 'overnight.amended')).toHaveLength(1)
    await expect(o.supervisor.changeEndPolicy(run.id, { endAction: 'REBOOT' as never })).rejects.toThrow()
    await o.supervisor.finalize(run.id, 'BLOCKED')
    o.advance(31_000)
    await o.waitForOvernight(run.id, 'DONE')
    expect(o.power.callsOf('hibernate')).toHaveLength(1)
  })

  it('re-enabling the end action after CANCEL SHUTDOWN restores the failsafe', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start()
    await o.supervisor.cancelPower(run.id)
    expect(o.power.getState().pending).toBeNull()
    const status = await o.supervisor.changeEndPolicy(run.id, { endAction: 'SHUTDOWN' })
    expect(status.failsafe).toMatchObject({ cancelledAt: null })
    expect(o.power.getState().pending?.purpose).toBe('failsafe')
  })

  it('EXTEND MISSION moves the deadline and the failsafe together', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start()
    const before = o.record(run.id)
    const status = await o.supervisor.extend(run.id, 60)
    expect(Date.parse(status.deadlineAt) - Date.parse(before.deadlineAt)).toBe(60 * MINUTE)
    expect(Math.abs(Date.parse(status.failsafe?.deadline ?? '') - Date.parse(before.failsafe?.deadline ?? '') - 60 * MINUTE)).toBeLessThan(5000)
    expect(o.power.calls.map((c) => c.operation)).toEqual(['scheduleShutdown', 'cancelShutdown', 'scheduleShutdown'])
    expect(h.repos.runs.require(run.id).config.maxDurationMinutes).toBe(540)
    // The old deadline no longer ends the run.
    o.advance(8 * 60 * MINUTE + 1000)
    await o.supervisor.tick()
    expect(o.record(run.id).state).toBe('RUNNING')
  })

  it('cancelling the mission ends Overnight Mode and cancels the failsafe (no shutdown unless the policy covers cancellation)', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start()
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'worker session')
    const status = await o.supervisor.cancelMission(run.id)
    expect(status).toMatchObject({ state: 'DONE', terminalReason: 'USER_CANCELLED', powerAction: null })
    expect(status.failsafe?.cancelledAt).not.toBeNull()
    expect(h.repos.runs.require(run.id).state).toBe('cancelled')
    expect(o.power.getState().pending).toBeNull()
    expect(shutdowns()).toHaveLength(1)
  })

  it('a user pause does not finalize; the deadline and the failsafe stay in force', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start()
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'worker session')
    await h.orchestrator.pauseRun(run.id)
    await o.supervisor.tick()
    expect(o.record(run.id)).toMatchObject({ state: 'RUNNING', terminalReason: null })
    expect(o.power.getState().pending?.purpose).toBe('failsafe')
    o.advance(8 * 60 * MINUTE + 1000)
    expect((await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')).terminalReason).toBe('TIME_LIMIT')
  })

  // ───────────────────────────── unattended operation ─────────────────────────────

  it('denies tool approvals and grants task-start approvals while nobody is present', async () => {
    const allowed: boolean[] = []
    await setup(
      scenarioScript({
        plan: plan([plannedTask('risky', { requiresApproval: true })]),
        worker: async (spec, ctx) => {
          allowed.push(await ctx.useTool('Bash', { command: 'git push origin main' }))
          await fileWorker(spec, ctx)
        },
      }),
    )
    const run = await o.start({ policy: { endAction: 'NONE' } })
    await h.waitForState(run.id, 'completed')
    expect(allowed).toEqual([false])
    const approvals = h.repos.approvals.listByRun(run.id)
    expect(approvals.find((a) => a.kind === 'task')?.status).toBe('approved')
    expect(approvals.find((a) => a.kind === 'tool')?.status).toBe('denied')
    expect(h.eventsOfType(run.id, 'overnight.approval').map((e) => e.payload.decision).sort()).toEqual(['approved', 'denied'])
  })

  it('with autoApprovePlanChanges off, a task that needs approval is cancelled and the run ends as blocked', async () => {
    await setup(scenarioScript({ plan: plan([plannedTask('risky', { requiresApproval: true }), plannedTask('after', { dependencies: ['risky'] })]) }))
    const run = await o.start({ policy: { autoApprovePlanChanges: false, endAction: 'NONE' } })
    const record = await o.waitForOvernight(run.id, 'DONE')
    expect(h.task(run.id, 'risky').state).toBe('cancelled')
    expect(h.task(run.id, 'after').state).not.toBe('completed')
    expect(record.terminalReason).toBe('BLOCKED')
    expect(h.repos.approvals.listByRun(run.id).find((a) => a.kind === 'task')?.status).toBe('denied')
    expect(sessionsOf(h, 'worker')).toHaveLength(0)
  })

  it('watchdog: a silent run is snapshotted and reconciled first, and only then finalized as blocked', async () => {
    await setup(scenarioScript({ plan: onePlan, worker: hangingWorker }))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'worker session')
    await o.supervisor.tick()
    expect(o.record(run.id).watchdog).toHaveLength(0)

    o.advance(31 * MINUTE)
    await o.supervisor.tick()
    let record = o.record(run.id)
    expect(record.state).toBe('RUNNING')
    expect(record.watchdog.map((d) => d.stage)).toEqual(['stalled', 'reconciled'])
    expect(record.watchdog[0]).toMatchObject({ runState: 'executing', activeAgents: 1 })
    expect(record.watchdog[0]?.tasks).toEqual({ running: 1 })

    // Inside the grace period nothing more happens.
    o.advance(5 * MINUTE)
    await o.supervisor.tick()
    expect(o.record(run.id).state).toBe('RUNNING')

    o.advance(11 * MINUTE)
    record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('BLOCKED')
    expect(record.terminalDetail).toMatch(/Watchdog/)
    expect(record.watchdog.map((d) => d.stage)).toEqual(['stalled', 'reconciled', 'blocked'])
    expect(record.finalReport).toContain('## Watchdog')
  })

  it('budgets: exceeding the session budget ends the run as blocked instead of looping', async () => {
    await setup(scenarioScript({ plan: plan([plannedTask('a'), plannedTask('b', { dependencies: ['a'] })]), worker: hangingWorker }))
    const run = await o.start({ policy: { endAction: 'NONE', budgets: { maxAgentSessions: 1, maxTotalRepairs: 60 } } })
    await h.waitFor(() => sessionsOf(h, 'worker').length === 1, 'worker session')
    const record = await o.waitForOvernight(run.id, 'DONE')
    expect(record.terminalReason).toBe('BLOCKED')
    expect(record.terminalDetail).toMatch(/budget exhausted: 2 agent sessions/)
    expect(record.watchdog.at(-1)?.stage).toBe('budget')
  })

  it('checkpoints are written after planning, task completion and integration', async () => {
    await setup(scenarioScript({ plan: plan([plannedTask('a'), plannedTask('b', { dependencies: ['a'] })]) }))
    const run = await o.start({ policy: { endAction: 'NONE' } })
    await o.waitForOvernight(run.id, 'DONE')
    const checkpoints = h.repos.checkpoints.listByRun(run.id)
    const reasons = checkpoints.map((c) => c.reason)
    expect(reasons).toContain('planning')
    expect(reasons.filter((r) => r === 'task completion')).toHaveLength(2)
    expect(reasons).toContain('integration')
    const last = checkpoints.at(-1)?.snapshot
    expect(last?.tasks.map((t) => t.key).sort()).toEqual(['a', 'b'])
    expect(last?.graphVersion).toBe(1)
    expect(last?.sessions.length).toBeGreaterThan(0)
    expect(last?.integrationBranch).toBeTruthy()
  })

  it('unfinished work in a task worktree is committed on its task branch during finalization', async () => {
    await setup(
      scenarioScript({
        plan: onePlan,
        worker: async (spec, ctx) => {
          await ctx.useTool('Write', { file_path: join(spec.cwd, 'half-done.txt'), content: 'wip' }, async () => {
            const { writeFile } = await import('node:fs/promises')
            await writeFile(join(spec.cwd, 'half-done.txt'), 'wip\n')
            return 'written'
          })
          await ctx.sleep(10 * MINUTE)
        },
      }),
    )
    const run = await o.start({ policy: { endAction: 'NONE' } })
    await h.waitFor(() => h.eventsOfType(run.id, 'agent.tool.completed').length > 0, 'the write')
    await o.supervisor.finalize(run.id, 'TIME_LIMIT')
    const record = o.record(run.id)
    expect(record.finalReport).toContain('Unfinished work committed on task branches')
    const branch = h.repos.worktrees.listByRun(run.id).find((w) => w.taskId !== null)?.branch ?? ''
    expect(await h.git.changedFiles(h.repoDir, 'main', branch)).toContain('half-done.txt')
    // The user's checkout is untouched.
    expect(existsSync(join(h.repoDir, 'half-done.txt'))).toBe(false)
  })
})

describe('scenario: Overnight Mode recovery', () => {
  let original: Harness
  let restarted: Harness | undefined
  let o: Overnight | undefined
  afterEach(async () => {
    o?.dispose()
    await restarted?.dispose()
    await original?.dispose()
  })

  async function crashMidRun(): Promise<{ runId: string; first: Overnight }> {
    original = await createHarness({ script: scenarioScript({ plan: onePlan, worker: hangingWorker }) })
    const first = attachOvernight(original)
    const run = await first.start({ policy: { forceCloseApplications: true } })
    await original.waitFor(() => sessionsOf(original, 'worker').length === 1, 'worker session')
    await first.supervisor.tick()
    first.dispose()
    return { runId: run.id, first }
  }

  it('NEXUS restarts mid-run: the run resumes by itself and the Windows failsafe is neither cancelled nor scheduled twice', async () => {
    const { runId, first } = await crashMidRun()
    restarted = await original.restart(scenarioScript({ plan: onePlan }), { crash: true })
    restarted.orchestrator.recoverOnStartup()
    expect(restarted.repos.runs.require(runId)).toMatchObject({ state: 'paused', pauseReason: 'recovery' })

    // The OS timer of the previous process is still there.
    o = attachOvernight(restarted, { power: first.power })
    const callsBefore = first.power.calls.length
    const statuses = await o.supervisor.recover()
    expect(statuses.map((s) => s.state)).toEqual(['RUNNING'])
    expect(first.power.calls).toHaveLength(callsBefore)
    expect(o.record(runId).failsafe).toMatchObject({ cancelledAt: null, lostAt: null })
    expect(o.supervisor.pendingPowerAction(runId)).toMatchObject({ kind: 'failsafe', action: 'SHUTDOWN' })
    expect(o.supervisor.hasActive()).toBe(true)
    expect(restarted.eventsOfType(runId, 'overnight.state_changed').some((e) => e.payload.detail === 'RECOVERING OVERNIGHT RUN')).toBe(true)

    await restarted.waitForState(runId, 'completed')
    const record = await o.waitForOvernight(runId, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('SUCCESS')
    expect(first.power.callsOf('scheduleShutdown')).toHaveLength(2)
    expect(first.power.getState().pending?.purpose).toBe('final')
    expect(restarted.repos.checkpoints.listByRun(runId).map((c) => c.reason)).toContain('recovery')
  })

  it('a restart after the deadline finalizes as TIME_LIMIT when NEXUS was only briefly away', async () => {
    const { runId, first } = await crashMidRun()
    restarted = await original.restart(undefined, { crash: true })
    restarted.orchestrator.recoverOnStartup()
    // The previous instance was alive until just before the deadline.
    restarted.repos.settings.setValue(`overnight-heartbeat:${runId}`, new Date(Date.now() + 8 * 60 * MINUTE - 30_000).toISOString())
    o = attachOvernight(restarted, { power: first.power, offsetMs: 8 * 60 * MINUTE + 5000 })
    await o.supervisor.recover()
    const record = await o.waitForOvernight(runId, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('TIME_LIMIT')
    expect(first.power.getState().pending?.purpose).toBe('final')
  })

  it('a long absence of NEXUS ends the unattended session: report, no power action, failsafe cancelled', async () => {
    const { runId, first } = await crashMidRun()
    restarted = await original.restart(undefined, { crash: true })
    restarted.orchestrator.recoverOnStartup()
    o = attachOvernight(restarted, { power: first.power, offsetMs: 9 * 60 * MINUTE })
    await o.supervisor.recover()
    const record = await o.waitForOvernight(runId, 'DONE')
    expect(record.terminalReason).toBe('BLOCKED')
    expect(record.powerAction).toBeNull()
    expect(record.finalReport).toContain('power authorization lapsed')
    expect(first.power.callsOf('scheduleShutdown')).toHaveLength(1)
    expect(first.power.getState().pending).toBeNull()
    expect(restarted.repos.runs.require(runId).state).toBe('paused')
  })

  it('Windows restarted: the failsafe is recorded as lost and nothing powers the machine off on the next launch', async () => {
    const { runId } = await crashMidRun()
    restarted = await original.restart(undefined, { crash: true })
    restarted.orchestrator.recoverOnStartup()
    // A fresh OS: no timer, and a boot time after the run began.
    o = attachOvernight(restarted, { bootTime: () => Date.now() + 60_000 })
    await o.supervisor.recover()
    const record = await o.waitForOvernight(runId, 'DONE')
    expect(record.failsafe?.lostAt).not.toBeNull()
    expect(record.powerAction).toBeNull()
    expect(record.finalReport).toContain('Windows restarted')
    // Nothing is inferred from clocks: Windows is asked to drop any timer (it has none), and nothing is scheduled.
    expect(o.power.calls.map((c) => c.operation)).toEqual(['cancelShutdown'])
    expect(o.supervisor.pendingPowerAction(runId)).toBeNull()
  })

  it('a crash in the middle of finalization is finished on the next start with the same reason', async () => {
    const { runId, first } = await crashMidRun()
    original.repos.overnight.update(runId, { state: 'FINALIZING', terminalReason: 'QUOTA_EXHAUSTED', terminalDetail: 'limit' })
    restarted = await original.restart(undefined, { crash: true })
    restarted.orchestrator.recoverOnStartup()
    o = attachOvernight(restarted, { power: first.power })
    await o.supervisor.recover()
    const record = await o.waitForOvernight(runId, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('QUOTA_EXHAUSTED')
    expect(record.finalReport).toContain('QUOTA_EXHAUSTED')
    expect(first.power.callsOf('scheduleShutdown')).toHaveLength(2)
  })

  it('a pending final Windows shutdown stays represented after a restart and can still be cancelled', async () => {
    original = await createHarness({ script: scenarioScript({ plan: onePlan }) })
    const first = attachOvernight(original)
    const run = await first.start({ policy: { forceCloseApplications: true } })
    await first.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    first.dispose()
    restarted = await original.restart()
    restarted.orchestrator.recoverOnStartup()
    o = attachOvernight(restarted, { power: first.power })
    await o.supervisor.recover()
    expect(o.record(run.id).state).toBe('POWER_ACTION_SCHEDULED')
    expect(o.supervisor.pendingPowerAction(run.id)).toMatchObject({ kind: 'final' })
    expect(first.power.callsOf('scheduleShutdown')).toHaveLength(2)
    await o.supervisor.cancelPower(run.id)
    expect(first.power.getState().pending).toBeNull()
  })
})
