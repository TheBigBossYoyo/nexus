import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { RuntimeAvailabilityProbe } from '@main/modules/usage'
import { createHarness, fileWorker, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'
import { attachOvernight, type Overnight } from './overnight-harness'
import { attachUsage, type UsageStack } from './usage-harness'

const MINUTE = 60_000
const onePlan = plan([plannedTask('only')])

describe('scenario: Overnight quota wait with probing', () => {
  let h: Harness
  let o: Overnight
  let stack: UsageStack | undefined
  afterEach(async () => {
    stack?.dispose()
    stack = undefined
    o?.dispose()
    await h?.dispose()
  })

  /** The first worker session hits the limit: exact reset `resetInMs` ahead, or none. */
  const limitedOnce = (resetInMs: number | null): FakeScript => {
    let hit = false
    return async (spec, ctx) => {
      if (!hit) {
        hit = true
        ctx.usage.limit(resetInMs === null ? null : o.now() + resetInMs)
        await ctx.rateLimit({ status: 'rejected', resetsAt: ctx.usage.resetAtSeconds(), limitType: 'five_hour' })
        await ctx.completeTurn({ text: 'usage limit reached', outcome: 'quota' })
        return
      }
      await fileWorker(spec, ctx)
    }
  }

  async function setup(worker: FakeScript, options: { useStack?: boolean } = {}): Promise<void> {
    h = await createHarness({ script: scenarioScript({ plan: onePlan, worker }) })
    o = attachOvernight(h, {
      probe: (now) => new RuntimeAvailabilityProbe({ runtime: h.runtime, settings: () => h.repos.settings.get(), now }),
    })
    h.runtime.usage.now = o.now
    if (options.useStack) stack = attachUsage(h, { clock: { now: o.now }, isOvernightRun: (id) => h.repos.overnight.getByRun(id) !== null })
  }

  const rowsOf = (runId: string) => h.repos.quotaPauses.listByRun(runId)
  const probesOf = (runId: string) => h.repos.quotaResumes.listByRun(runId).filter((r) => r.kind === 'probe')

  it('17: a reset before the deadline waits, probes before resuming, then resumes and finishes', async () => {
    await setup(limitedOnce(10 * MINUTE), { useStack: true })
    const run = await o.start()
    await h.waitForState(run.id, 'paused')
    let record = await o.waitForOvernight(run.id, 'QUOTA_PAUSED')
    const deadline = record.deadlineAt
    const failsafe = record.failsafe?.deadline
    expect(record.quota).toMatchObject({ waits: 1 })
    expect(Date.parse(record.quota?.resumeAt ?? '') - Date.parse(record.quota?.resetsAt ?? '')).toBe(60_000)
    // The supervisor owns the wait: the ordinary-run controller wrote nothing for this run.
    expect(rowsOf(run.id)).toHaveLength(1)
    expect(rowsOf(run.id)[0]).toMatchObject({ scope: 'overnight', state: 'waiting', resetConfidence: 'EXACT' })
    expect(h.repos.quotaPauses.liveGlobal()).toBeNull()
    expect(stack?.usage.status()).toBe('WAITING_FOR_RESET')
    expect(h.repos.checkpoints.listByRun(run.id).some((c) => c.reason === 'quota')).toBe(true)

    // Not before the planned time.
    o.advance(10 * MINUTE)
    await o.supervisor.tick()
    expect(h.runtime.usage.probes).toBe(0)
    expect(o.record(run.id).state).toBe('QUOTA_PAUSED')

    o.advance(2 * MINUTE)
    await o.supervisor.tick()
    expect(h.runtime.usage.probes).toBe(1) // probed first
    await h.waitForState(run.id, 'completed')
    record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('SUCCESS')
    expect(h.eventsOfType(run.id, 'overnight.quota').map((e) => e.payload.action)).toEqual(['waiting', 'resumed'])
    expect(sessionsOf(h, 'worker')).toHaveLength(2)
    // The same rows and history as an ordinary run, owned by the supervisor.
    expect(rowsOf(run.id).map((p) => ({ scope: p.scope, state: p.state }))).toEqual([{ scope: 'overnight', state: 'resumed' }])
    expect(h.repos.quotaResumes.listByRun(run.id).map((r) => `${r.kind}:${r.result}`)).toEqual(['probe:available', 'resume:resumed'])
    expect(h.repos.quotaPauses.listLive()).toHaveLength(0)
    // A quota wait never moves the deadline or the failsafe.
    expect(record.deadlineAt).toBe(deadline)
    expect(record.failsafe?.deadline).toBe(failsafe)
    expect(stack?.usage.status()).toBe('AVAILABLE')
  })

  it('a probe that still finds the limit re-plans (backoff after a past reset) and does not shut down', async () => {
    await setup(limitedOnce(10 * MINUTE))
    h.runtime.usage.probeFailures = 1
    const run = await o.start()
    await h.waitForState(run.id, 'paused')
    await o.waitForOvernight(run.id, 'QUOTA_PAUSED')
    const callsBefore = o.power.calls.length

    o.advance(11 * MINUTE)
    await o.supervisor.tick() // probe 1: still limited
    expect(h.runtime.usage.probes).toBe(1)
    let record = o.record(run.id)
    expect(record.state).toBe('QUOTA_PAUSED')
    // The past reset continues on the backoff schedule: five minutes after the failed probe. The harness
    // clock is real time plus an offset, so the few milliseconds the probe took are allowed for.
    const untilResume = Date.parse(record.quota?.resumeAt ?? '') - o.now()
    expect(untilResume).toBeLessThanOrEqual(5 * MINUTE)
    expect(untilResume).toBeGreaterThan(5 * MINUTE - 5000)
    expect(o.power.calls).toHaveLength(callsBefore) // a temporary window never triggers the power action
    expect(rowsOf(run.id)[0]).toMatchObject({ state: 'waiting', probes: 1 })

    o.advance(5 * MINUTE)
    await o.supervisor.tick()
    await h.waitForState(run.id, 'completed')
    record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('SUCCESS')
    expect(probesOf(run.id).map((r) => r.result)).toEqual(['still_limited', 'available'])
  })

  it('18: a reset after the deadline finalizes as QUOTA_EXHAUSTED (unchanged), with no probe', async () => {
    await setup(limitedOnce(9 * 60 * MINUTE))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('QUOTA_EXHAUSTED')
    expect(record.terminalDetail).toMatch(/after the mission deadline/)
    expect(h.runtime.usage.probes).toBe(0)
    expect(h.repos.quotaPauses.listLive()).toHaveLength(0)
  })

  it('18: an unknown reset probes on the backoff schedule until the next probe would pass the deadline, then ends', async () => {
    await setup(limitedOnce(null))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitForState(run.id, 'paused')
    let record = await o.waitForOvernight(run.id, 'QUOTA_PAUSED')
    expect(record.quota).toMatchObject({ resetsAt: null })
    const deadline = Date.parse(record.deadlineAt)
    const gaps: number[] = []
    let guard = 0
    while (o.record(run.id).state === 'QUOTA_PAUSED' && guard++ < 40) {
      const next = Date.parse(o.record(run.id).quota?.resumeAt ?? '')
      expect(next).toBeLessThan(deadline)
      gaps.push(Math.round((next - o.now()) / MINUTE))
      o.advance(next - o.now())
      await o.supervisor.tick()
    }
    record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('QUOTA_EXHAUSTED')
    expect(record.terminalDetail).toMatch(/deadline/)
    expect(gaps.slice(0, 5)).toEqual([5, 10, 20, 30, 30])
    expect(h.runtime.usage.probes).toBe(gaps.length)
    expect(h.runtime.usage.probeSuccesses).toBe(0)
    expect(rowsOf(run.id).map((p) => p.state)).toEqual(['ended'])
    expect(probesOf(run.id).every((r) => r.result === 'still_limited')).toBe(true)
    // It never waited past the deadline it was given.
    expect(o.now()).toBeLessThan(deadline)
  })

  it('18: an unknown reset that clears while probing resumes the run', async () => {
    await setup(limitedOnce(null), { useStack: true })
    const run = await o.start()
    await h.waitForState(run.id, 'paused')
    await o.waitForOvernight(run.id, 'QUOTA_PAUSED')
    o.advance(5 * MINUTE)
    await o.supervisor.tick() // probe 1: still limited
    expect(o.record(run.id).state).toBe('QUOTA_PAUSED')
    h.runtime.usage.restore()
    o.advance(10 * MINUTE)
    await o.supervisor.tick() // probe 2: available
    await h.waitForState(run.id, 'completed')
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('SUCCESS')
    expect(record.quota?.waits).toBe(1)
    expect(probesOf(run.id).map((r) => r.result)).toEqual(['still_limited', 'available'])
  })

  it('the END_RUN policy ends on a limit even with a known reset and a probe', async () => {
    await setup(limitedOnce(10 * MINUTE))
    const run = await o.start({ policy: { quotaPolicy: 'END_RUN', forceCloseApplications: true } })
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('QUOTA_EXHAUSTED')
    expect(h.runtime.usage.probes).toBe(0)
  })

  it('with overnightWaitForReset off the supervisor ends the run instead of waiting', async () => {
    h = await createHarness({
      script: scenarioScript({ plan: onePlan, worker: limitedOnce(10 * MINUTE) }),
      settings: (s) => ({ ...s, usage: { ...s.usage, overnightWaitForReset: false } }),
    })
    o = attachOvernight(h, { probe: (now) => new RuntimeAvailabilityProbe({ runtime: h.runtime, settings: () => h.repos.settings.get(), now }) })
    const run = await o.start({ policy: { forceCloseApplications: true } })
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('QUOTA_EXHAUSTED')
    expect(record.terminalDetail).toMatch(/switched off/)
  })

  it('a deadline reached while waiting finalizes as TIME_LIMIT and closes the open wait row', async () => {
    await setup(limitedOnce(null))
    const run = await o.start({ policy: { forceCloseApplications: true } })
    await h.waitForState(run.id, 'paused')
    await o.waitForOvernight(run.id, 'QUOTA_PAUSED')
    o.advance(8 * 60 * MINUTE + 1000)
    const record = await o.waitForOvernight(run.id, 'POWER_ACTION_SCHEDULED')
    expect(record.terminalReason).toBe('TIME_LIMIT')
    expect(h.repos.quotaPauses.listLive()).toHaveLength(0)
    expect(rowsOf(run.id)[0]?.state).toBe('ended')
  })
})
