import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ApprovalRequest, Run } from '@shared/domain'
import type { PauseCause } from '@shared/events'
import {
  decidePowerAction,
  DEFAULT_OVERNIGHT_POLICY,
  LIVE_OVERNIGHT_STATES,
  OVERNIGHT_CONFIRMATION_TEXT,
  TERMINAL_REASONS,
  type EndAction,
  type OvernightPolicy,
  type OvernightRun,
  type TerminalReason,
} from '@shared/overnight'
import { EventBus } from '@main/modules/events'
import type { GitService } from '@main/modules/git'
import { OvernightSupervisor, type OvernightOrchestrator } from '@main/modules/overnight'
import { createRepositories, openDatabase, type Repositories } from '@main/modules/persistence'
import { makeProject, makeRun } from '../integration/persistence/fixtures'
import { ObservedPower } from '../scenarios/overnight-harness'

/**
 * Seeded stress of the overnight state machine. Every seed draws a random policy and a random sequence
 * of run outcomes, user actions, clock jumps, refused power commands and restarts of NEXUS or Windows,
 * and checks the power invariants after every step. The orchestrator is a stub that only moves the run
 * row and emits the events the real one emits; the power controller is the fake. Nothing touches the OS.
 *
 * NEXUS_OVERNIGHT_STRESS_RUNS / NEXUS_OVERNIGHT_STRESS_START select the seeds.
 */
const RUNS = Number(process.env['NEXUS_OVERNIGHT_STRESS_RUNS'] ?? 1000)
const START = Number(process.env['NEXUS_OVERNIGHT_STRESS_START'] ?? 1)
const MINUTE = 60_000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const reportsDir = mkdtempSync(join(tmpdir(), 'nexus-overnight-stress-'))
afterAll(() => rmSync(reportsDir, { recursive: true, force: true }))

/** Git is irrelevant here; every call fails and the supervisor records that in the report. */
const noGit = new Proxy({}, { get: () => () => Promise.reject(new Error('no git in the state-machine stress')) }) as unknown as GitService

class World {
  readonly db = openDatabase(':memory:')
  readonly repos: Repositories = createRepositories(this.db)
  readonly bus = new EventBus(this.repos.events, this.repos.transaction)
  readonly power: ObservedPower
  /** For every final power request: did the gate allow it at that moment? */
  readonly gateAtFinal: boolean[] = []
  offset = 0
  boot = 0
  supervisor: OvernightSupervisor
  runId = ''
  injectedFailures = 0
  readonly project = makeProject({ rootPath: join(reportsDir, 'no-such-project') })

  constructor() {
    this.repos.projects.insert(this.project)
    this.power = new ObservedPower({ now: () => this.now() })
    this.power.inspect = () => {
      const record = this.repos.overnight.getByRun(this.runId)
      this.gateAtFinal.push(record !== null && record.terminalReason !== null && decidePowerAction(record, this.runId, record.terminalReason).action !== null)
      return record?.finalReport != null
    }
    this.supervisor = this.createSupervisor()
  }

  now(): number {
    return Date.now() + this.offset
  }

  createSupervisor(): OvernightSupervisor {
    return new OvernightSupervisor({
      repos: this.repos,
      bus: this.bus,
      orchestrator: this.orchestrator,
      power: this.power,
      git: noGit,
      push: () => undefined,
      flush: () => undefined,
      reportsDir,
      now: () => this.now(),
      bootTime: () => this.boot,
      tickIntervalMs: 0,
      stopTimeoutMs: 1000,
    })
  }

  private setRun(patch: Partial<Run>): Run {
    return this.repos.runs.update(this.runId, patch)
  }

  readonly orchestrator: OvernightOrchestrator = {
    createRun: async (input) => {
      const run = this.repos.runs.insert(makeRun(this.project.id, { mode: input.mode, prompt: input.prompt, state: 'planning', startedAt: null, finishedAt: null }))
      this.runId = run.id
      try {
        await input.prepare?.(run)
      } catch (e) {
        this.setRun({ state: 'cancelled' })
        this.bus.emit({ runId: run.id, type: 'run.cancelled', payload: {} })
        throw e
      }
      return this.setRun({ state: 'executing', startedAt: new Date().toISOString() })
    },
    pauseRun: async (runId, reason = 'user', detail, cause) => {
      const run = this.repos.runs.require(runId)
      if (run.state === 'paused' || ['completed', 'failed', 'cancelled'].includes(run.state)) throw new Error(`cannot pause a ${run.state} run`)
      this.setRun({ state: 'paused', resumeState: run.state, pauseReason: reason })
      const why: PauseCause = cause ?? (reason === 'user' ? (detail ? 'intervention' : 'user') : reason)
      this.bus.emit({ runId, type: 'run.paused', payload: { reason, cause: why, ...(detail ? { detail } : {}) } })
      return this.repos.runs.require(runId)
    },
    resumeRun: async (runId) => {
      const run = this.repos.runs.require(runId)
      if (run.state !== 'paused') throw new Error('not paused')
      this.setRun({ state: run.resumeState ?? 'executing', resumeState: null, pauseReason: null })
      this.bus.emit({ runId, type: 'run.resumed', payload: {} })
      return this.repos.runs.require(runId)
    },
    cancelRun: async (runId) => {
      const run = this.repos.runs.require(runId)
      if (!['completed', 'failed', 'cancelled'].includes(run.state)) {
        this.setRun({ state: 'cancelled' })
        this.bus.emit({ runId, type: 'run.cancelled', payload: {} })
      }
      return this.repos.runs.require(runId)
    },
    recover: async (runId) => this.orchestrator.resumeRun(runId),
    requestTick: () => undefined,
    resolveApproval: () => ({}) as ApprovalRequest,
  }

  /** What the real orchestrator does on its own: the run ends or pauses, and says so. */
  outcome(kind: 'completed' | 'failed' | 'quota' | 'intervention' | 'user_pause' | 'resume', resetsAt: number | null = null): void {
    const run = this.repos.runs.require(this.runId)
    const terminal = ['completed', 'failed', 'cancelled'].includes(run.state)
    if (kind === 'resume') {
      if (run.state === 'paused') void this.orchestrator.resumeRun(this.runId)
      return
    }
    if (terminal || run.state === 'paused') return
    if (kind === 'completed') {
      this.setRun({ state: 'completed' })
      this.bus.emit({ runId: this.runId, type: 'run.completed', payload: { summary: 'done' } })
    } else if (kind === 'failed') {
      this.setRun({ state: 'failed', error: 'boom' })
      this.bus.emit({ runId: this.runId, type: 'run.failed', payload: { error: 'boom' } })
    } else if (kind === 'quota') {
      this.bus.emit({ runId: this.runId, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt, limitType: 'five_hour' } })
      void this.orchestrator.pauseRun(this.runId, 'quota', 'Claude usage limit reached')
    } else if (kind === 'intervention') {
      void this.orchestrator.pauseRun(this.runId, 'user', 'Intervention required: tasks a are failed or blocked')
    } else {
      void this.orchestrator.pauseRun(this.runId, 'user')
    }
  }

  /** NEXUS (and possibly Windows) restarts: a new supervisor on the same database. */
  async restart(options: { reboot: boolean; gapMs: number }): Promise<void> {
    this.supervisor.dispose()
    const run = this.repos.runs.require(this.runId)
    // What the real orchestrator's startup recovery does to a run that was active.
    if (!['completed', 'failed', 'cancelled', 'paused', 'awaiting_approval'].includes(run.state)) {
      this.setRun({ state: 'paused', resumeState: run.state, pauseReason: 'recovery' })
    }
    this.offset += options.gapMs
    if (options.reboot) {
      this.boot = this.now() - 1000
      this.power.simulateReboot()
    }
    this.supervisor = this.createSupervisor()
    await this.supervisor.recover()
  }

  record(): OvernightRun {
    return this.repos.overnight.require(this.runId)
  }

  close(): void {
    this.supervisor.dispose()
    this.db.close()
  }
}

function randomPolicy(rand: () => number): OvernightPolicy {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
  const flag = (p = 0.5): boolean => rand() < p
  const maxDurationMinutes = pick([1, 30, 240, 480])
  return {
    ...DEFAULT_OVERNIGHT_POLICY,
    maxDurationMinutes,
    endAction: pick<EndAction>(['SHUTDOWN', 'SHUTDOWN', 'SHUTDOWN', 'SLEEP', 'HIBERNATE', 'NONE']),
    shutdownOn: { success: flag(0.8), failure: flag(0.8), blocker: flag(0.8), quotaExhausted: flag(0.8), timeout: flag(0.8), cancellation: flag(0.2) },
    finalDelaySeconds: pick([10, 60, 600]),
    forceCloseApplications: flag(),
    failsafeEnabled: flag(0.85),
    failsafeAfterMinutes: maxDurationMinutes + pick([1, 60]),
    saveFinalReport: flag(),
    commitCompletedWork: flag(),
    quotaPolicy: pick(['WAIT_AND_RETRY', 'END_RUN'] as const),
  }
}

async function runSeed(seed: number): Promise<void> {
  const rand = mulberry32(seed)
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
  const world = new World()
  const log: string[] = []
  let terminalReason: TerminalReason | null = null
  let rebooted = false
  let powerCallsAtReboot = 0
  const brief = (): unknown => {
    const r = world.repos.overnight.getByRun(world.runId)
    if (!r) return null
    return {
      state: r.state,
      reason: r.terminalReason,
      endAction: r.policy.endAction,
      force: r.policy.forceCloseApplications,
      failsafe: r.failsafe ? { cancelledAt: r.failsafe.cancelledAt, lostAt: r.failsafe.lostAt } : null,
      powerAction: r.powerAction,
      error: r.error,
    }
  }
  const fail = (message: string): never => {
    throw new Error(`seed ${seed}: ${message}\n  ops: ${log.join(' | ')}\n  record: ${JSON.stringify(brief())}\n  power: ${JSON.stringify(world.power.calls.map((c) => `${c.operation}${c.ok ? '' : '!'}(${c.request?.purpose ?? ''})`))}`)
  }

  const check = (): void => {
    const record = world.record()
    const pending = world.power.getState().pending
    // The report is saved before any final power request, and the gate allowed it at that moment.
    if (world.power.reportSavedAtFinal.some((saved) => !saved)) fail('a final power action was requested before the report was saved')
    if (world.gateAtFinal.some((allowed) => !allowed)) fail('a final power action was requested although the authorization gate denies it')
    // Refusals only ever come from injected failures: the supervisor never schedules on top of a pending timer.
    const refused = world.power.calls.filter((c) => !c.ok && c.operation !== 'cancelShutdown').length
    if (refused > world.injectedFailures) fail(`Windows refused ${refused} command(s) but only ${world.injectedFailures} were injected (double scheduling?)`)
    // The first terminal reason is final.
    if (terminalReason !== null && record.terminalReason !== terminalReason) fail(`terminal reason changed from ${terminalReason} to ${String(record.terminalReason)}`)
    terminalReason = record.terminalReason
    if ((record.state === 'POWER_ACTION_SCHEDULED' || (record.state === 'DONE' && record.terminalReason !== null)) && record.finalReport === null) fail(`${record.state} without a report`)
    if (world.supervisor.hasActive() !== LIVE_OVERNIGHT_STATES.includes(record.state)) fail(`hasActive() disagrees with state ${record.state}`)
    const finals = world.power.calls.filter((c) => c.ok && (c.request?.purpose === 'final' || c.operation === 'sleep' || c.operation === 'hibernate')).length
    if (finals > 1) fail(`${finals} final power actions were executed`)
    if (record.state === 'DONE') {
      const executedShutdown = record.powerAction?.executedAt != null && record.powerAction.action === 'SHUTDOWN'
      if (pending !== null && !executedShutdown) fail('the overnight run is DONE but a Windows shutdown timer is still pending')
    }
    if (record.state === 'POWER_ACTION_SCHEDULED' && record.powerAction?.mechanism === 'os_timer' && pending?.purpose !== 'final' && !rebooted) {
      fail('a final Windows timer is recorded but not pending')
    }
    // The current policy's end action NONE means no final action can be pending.
    if (record.policy.endAction === 'NONE' && record.state === 'POWER_ACTION_SCHEDULED') fail('a power action is scheduled with end action NONE')
    // After Windows restarted nothing may be scheduled or executed again (an abort asked for by the user is harmless).
    if (rebooted && world.power.calls.slice(powerCallsAtReboot).some((c) => c.operation !== 'cancelShutdown')) fail('a power action was issued after Windows restarted')
    // A failsafe the record calls armed is really pending (or Windows restarted and the record says lost).
    const armed = record.failsafe !== null && record.failsafe.result.ok && !record.failsafe.cancelledAt && !record.failsafe.lostAt
    if (armed && pending === null) fail('the record shows an armed failsafe but no Windows timer is pending')
    if (!armed && pending?.purpose === 'failsafe') fail('a failsafe timer is pending but the record does not show it as armed')
  }

  try {
    const policy = randomPolicy(rand)
    if (rand() < 0.05) world.power.simulateForeignShutdown(3600)
    const foreign = world.power.getState().pending !== null
    try {
      await world.supervisor.start({ projectId: world.project.id, prompt: 'stress', preset: 'balanced', policy, confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT })
    } catch (e) {
      if (!(foreign && policy.failsafeEnabled)) throw e
      world.injectedFailures++
      if (world.supervisor.hasActive()) fail('a run that could not arm its failsafe is still active')
      if (world.repos.runs.require(world.runId).state !== 'cancelled') fail('the run was not cancelled when the failsafe could not be armed')
      return
    }
    if (foreign) return // failsafe disabled: nothing of ours is armed, the foreign timer is not ours to manage.
    if (policy.failsafeEnabled && world.power.getState().pending?.purpose !== 'failsafe') fail('the failsafe is not armed after start')
    check()

    const steps = 6 + Math.floor(rand() * 16)
    for (let i = 0; i < steps; i++) {
      const op = pick(['tick', 'tick', 'advance', 'advance', 'completed', 'failed', 'quota', 'quotaReset', 'intervention', 'userPause', 'resume', 'cancelPower', 'change', 'extend', 'cancelMission', 'finalizeRace', 'refuse', 'restart', 'reboot', 'longAbsence'] as const)
      log.push(op)
      const quiet = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined)
      switch (op) {
        case 'tick':
          await world.supervisor.tick()
          break
        case 'advance':
          world.offset += pick([5_000, 61_000, 10 * MINUTE, 31 * MINUTE, 5 * 60 * MINUTE])
          await world.supervisor.tick()
          break
        case 'completed':
        case 'failed':
        case 'intervention':
          world.outcome(op)
          break
        case 'userPause':
          world.outcome('user_pause')
          break
        case 'resume':
          world.outcome('resume')
          break
        case 'quota':
          world.outcome('quota', null)
          break
        case 'quotaReset':
          world.outcome('quota', Math.round((world.now() + pick([5 * MINUTE, 3 * 60 * MINUTE, 20 * 60 * MINUTE])) / 1000))
          break
        case 'cancelPower':
          await quiet(world.supervisor.cancelPower(world.runId))
          break
        case 'change':
          await quiet(world.supervisor.changeEndPolicy(world.runId, { endAction: pick<EndAction>(['NONE', 'SHUTDOWN', 'SLEEP', 'HIBERNATE']), forceCloseApplications: rand() < 0.5 }))
          break
        case 'extend':
          await quiet(world.supervisor.extend(world.runId, pick([1, 30, 120])))
          break
        case 'cancelMission':
          await quiet(world.supervisor.cancelMission(world.runId))
          break
        case 'finalizeRace':
          await Promise.all([world.supervisor.finalize(world.runId, pick(TERMINAL_REASONS)), world.supervisor.finalize(world.runId, pick(TERMINAL_REASONS)), world.supervisor.tick()])
          break
        case 'refuse': {
          const operation = pick(['scheduleShutdown', 'cancelShutdown', 'sleep', 'hibernate'] as const)
          const before = world.power.failNext[operation] ?? 0
          world.power.failNext[operation] = before + 1
          if (operation !== 'cancelShutdown') world.injectedFailures++
          break
        }
        case 'restart':
          await world.restart({ reboot: false, gapMs: pick([1000, 30_000, 5 * MINUTE]) })
          break
        case 'longAbsence':
          await world.restart({ reboot: false, gapMs: pick([11 * MINUTE, 6 * 60 * MINUTE]) })
          break
        case 'reboot':
          await world.restart({ reboot: true, gapMs: pick([60_000, 2 * 60 * MINUTE]) })
          rebooted = true
          powerCallsAtReboot = world.power.calls.length
          break
      }
      await world.supervisor.idle()
      // Let deferred event handlers (setImmediate) run before the invariants are read.
      await new Promise((resolve) => setImmediate(resolve))
      await world.supervisor.idle()
      check()
    }

    // The run can never stay live forever: past every deadline, repeated passes must end it.
    log.push('drain')
    world.power.failNext.scheduleShutdown = 0
    world.power.failNext.cancelShutdown = 0
    world.power.failNext.sleep = 0
    world.power.failNext.hibernate = 0
    for (let i = 0; i < 8 && world.supervisor.hasActive(); i++) {
      world.offset += 26 * 60 * MINUTE
      await world.supervisor.tick()
      await world.supervisor.idle()
      await new Promise((resolve) => setImmediate(resolve))
      await world.supervisor.idle()
      check()
    }
    const end = world.record()
    if (['ARMING', 'RUNNING', 'QUOTA_PAUSED', 'FINALIZING', 'CANCELLING'].includes(end.state)) fail(`the overnight run is still ${end.state} long after its deadline`)
    if (end.terminalReason !== null && end.finalReport === null) fail('ended without a report')
    // Every power command is in the audit log.
    const audited = world.repos.powerAudit.listAll(1000).filter((a) => a.result !== null).length
    if (audited !== world.power.calls.length) fail(`${world.power.calls.length} power commands but ${audited} audit entries with a result`)
  } finally {
    world.close()
  }
}

describe('overnight state-machine stress', () => {
  it(`holds the power invariants over ${RUNS} seeded histories`, async () => {
    const failures: string[] = []
    for (let seed = START; seed < START + RUNS; seed++) {
      try {
        await runSeed(seed)
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e))
        if (failures.length >= 5) break
      }
    }
    expect(failures, failures.join('\n\n')).toEqual([])
  })
})
