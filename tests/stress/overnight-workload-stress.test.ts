import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { newId } from '@shared/ids'
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
import { OvernightSupervisor, type AutonomousWorkload, type OvernightOrchestrator, type WorkloadDeadlineState, type WorkloadPhase } from '@main/modules/overnight'
import { createRepositories, openDatabase, type Repositories } from '@main/modules/persistence'
import { ObservedPower } from '../scenarios/overnight-harness'

/**
 * Seeded stress of the overnight supervisor with a workload that is not a mission (the Overnight Arena path).
 * The workload is a stub with the phases a campaign has; every seed draws a random policy and a random
 * sequence of campaign outcomes, usage limits, user actions, clock jumps, refused power commands and restarts
 * of NEXUS or Windows, and checks the same power invariants as the mission stress after every step.
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

const reportsDir = mkdtempSync(join(tmpdir(), 'nexus-overnight-workload-stress-'))
afterAll(() => rmSync(reportsDir, { recursive: true, force: true }))

const noGit = new Proxy({}, { get: () => () => Promise.reject(new Error('no git in the state-machine stress')) }) as unknown as GitService
const noOrchestrator = new Proxy({}, { get: () => () => Promise.reject(new Error('not a mission')) }) as unknown as OvernightOrchestrator

/** What the stub campaign looks like; it lives outside the supervisor, so it survives a restart of NEXUS. */
interface Campaign {
  phase: WorkloadPhase
  outcome: WorkloadDeadlineState['outcome']
  resetsAt: number | null
  started: boolean
  checkpoints: number
}

class World {
  readonly db = openDatabase(':memory:')
  readonly repos: Repositories = createRepositories(this.db)
  readonly bus = new EventBus(this.repos.events, this.repos.transaction)
  readonly power: ObservedPower
  readonly gateAtFinal: boolean[] = []
  readonly campaigns = new Map<string, Campaign>()
  offset = 0
  boot = 0
  supervisor: OvernightSupervisor
  id = ''
  injectedFailures = 0

  constructor() {
    this.power = new ObservedPower({ now: () => this.now() })
    this.power.inspect = () => {
      const record = this.repos.overnight.getByRun(this.id)
      this.gateAtFinal.push(record !== null && record.terminalReason !== null && decidePowerAction(record, this.id, record.terminalReason).action !== null)
      return record?.finalReport != null
    }
    this.supervisor = this.createSupervisor()
  }

  now(): number {
    return Date.now() + this.offset
  }

  campaign(): Campaign {
    return this.campaigns.get(this.id) as Campaign
  }

  private workload(id: string): AutonomousWorkload {
    const get = (): Campaign | undefined => this.campaigns.get(id)
    const terminal = (): boolean => ['completed', 'failed', 'cancelled', 'missing'].includes(get()?.phase ?? 'missing')
    return {
      id,
      type: 'arena_campaign',
      get state() {
        return get()?.phase ?? 'missing'
      },
      start: async () => {
        const c = get()
        if (c) c.started = true
      },
      pause: async () => {
        const c = get()
        if (c && !terminal()) c.phase = 'paused'
      },
      resume: async () => {
        const c = get()
        if (c && c.phase === 'paused') c.phase = 'working'
      },
      cancel: async () => {
        const c = get()
        if (c && !terminal()) {
          c.phase = 'cancelled'
          c.outcome = { reason: 'USER_CANCELLED' }
        }
      },
      checkpoint: () => {
        const c = get()
        if (c) c.checkpoints++
        return c !== undefined
      },
      isTerminal: terminal,
      summarize: (input) => `# stub campaign ${id}\n\n${input.reason}\n\n## Power action\n\n${input.powerPlan}\n`,
      getDeadlineState: () => {
        const c = get()
        if (!c) return { phase: 'missing', outcome: { reason: 'FAILED', detail: 'missing' }, quotaResetsAt: null }
        return { phase: c.phase, outcome: c.outcome, quotaResetsAt: c.phase === 'quota_wait' ? c.resetsAt : null }
      },
      getFinalizationState: async () => null,
      projectRoot: () => null,
      extend: () => undefined,
      recoverAfterRestart: async () => undefined,
    }
  }

  createSupervisor(): OvernightSupervisor {
    const supervisor = new OvernightSupervisor({
      repos: this.repos,
      bus: this.bus,
      orchestrator: noOrchestrator,
      power: this.power,
      git: noGit,
      push: () => undefined,
      flush: () => undefined,
      reportsDir,
      now: () => this.now(),
      bootTime: () => this.boot,
      tickIntervalMs: 0,
      stopTimeoutMs: 2000,
      gitTimeoutMs: 2000,
    })
    supervisor.registerWorkload('arena_campaign', (id) => this.workload(id), {
      createCampaign: async () => {
        this.id = newId()
        this.campaigns.set(this.id, { phase: 'working', outcome: null, resetsAt: null, started: false, checkpoints: 0 })
        return { id: this.id }
      },
      cancel: (id) => {
        const c = this.campaigns.get(id)
        if (c) {
          c.phase = 'cancelled'
          c.outcome = { reason: 'USER_CANCELLED' }
        }
      },
      arenaStatus: async () => ({ ok: true, message: '' }),
    })
    return supervisor
  }

  set(phase: WorkloadPhase, outcome: Campaign['outcome'] = null, resetsAt: number | null = null): void {
    const c = this.campaign()
    if (['completed', 'failed', 'cancelled'].includes(c.phase)) return
    c.phase = phase
    c.outcome = outcome
    c.resetsAt = resetsAt
  }

  async restart(options: { reboot: boolean; gapMs: number }): Promise<void> {
    await this.supervisor.idle()
    this.supervisor.dispose()
    this.offset += options.gapMs
    if (options.reboot) {
      this.boot = this.now() - 1000
      this.power.simulateReboot()
    }
    this.supervisor = this.createSupervisor()
    await this.supervisor.recover()
  }

  record(): OvernightRun {
    return this.repos.overnight.require(this.id)
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
  let deadlineAtStart = ''
  let extended = false
  const fail = (message: string): never => {
    const r = world.repos.overnight.getByRun(world.id)
    throw new Error(
      `seed ${seed}: ${message}\n  ops: ${log.join(' | ')}\n  record: ${JSON.stringify(r ? { state: r.state, reason: r.terminalReason, endAction: r.policy.endAction, quota: r.quota, failsafe: r.failsafe ? { cancelledAt: r.failsafe.cancelledAt, lostAt: r.failsafe.lostAt } : null, powerAction: r.powerAction, error: r.error } : null)}\n  campaign: ${JSON.stringify(world.campaigns.get(world.id))}\n  power: ${JSON.stringify(world.power.calls.map((c) => `${c.operation}${c.ok ? '' : '!'}(${c.request?.purpose ?? ''})`))}`,
    )
  }

  const check = (): void => {
    const record = world.record()
    const pending = world.power.getState().pending
    if (record.workloadType !== 'arena_campaign') fail('the record lost its workload type')
    if (world.power.reportSavedAtFinal.some((saved) => !saved)) fail('a final power action was requested before the report was saved')
    if (world.gateAtFinal.some((allowed) => !allowed)) fail('a final power action was requested although the authorization gate denies it')
    const refused = world.power.calls.filter((c) => !c.ok && c.operation !== 'cancelShutdown').length
    if (refused > world.injectedFailures) fail(`Windows refused ${refused} command(s) but only ${world.injectedFailures} were injected (double scheduling?)`)
    if (terminalReason !== null && record.terminalReason !== terminalReason) fail(`terminal reason changed from ${terminalReason} to ${String(record.terminalReason)}`)
    terminalReason = record.terminalReason
    if ((record.state === 'POWER_ACTION_SCHEDULED' || (record.state === 'DONE' && record.terminalReason !== null)) && record.finalReport === null) fail(`${record.state} without a report`)
    if (world.supervisor.hasActive() !== LIVE_OVERNIGHT_STATES.includes(record.state)) fail(`hasActive() disagrees with state ${record.state}`)
    const finals = world.power.calls.filter((c) => c.ok && (c.request?.purpose === 'final' || c.operation === 'sleep' || c.operation === 'hibernate')).length
    if (finals > 1) fail(`${finals} final power actions were executed`)
    if (record.state === 'DONE') {
      const executedShutdown = record.powerAction?.executedAt != null && record.powerAction.action === 'SHUTDOWN'
      if (pending !== null && !executedShutdown) fail('the overnight campaign is DONE but a Windows shutdown timer is still pending')
    }
    if (record.state === 'POWER_ACTION_SCHEDULED' && record.powerAction?.mechanism === 'os_timer' && pending?.purpose !== 'final' && !rebooted) fail('a final Windows timer is recorded but not pending')
    if (record.policy.endAction === 'NONE' && record.state === 'POWER_ACTION_SCHEDULED') fail('a power action is scheduled with end action NONE')
    if (rebooted && world.power.calls.slice(powerCallsAtReboot).some((c) => c.operation !== 'cancelShutdown')) fail('a power action was issued after Windows restarted')
    const armed = record.failsafe !== null && record.failsafe.result.ok && !record.failsafe.cancelledAt && !record.failsafe.lostAt
    if (armed && pending === null) fail('the record shows an armed failsafe but no Windows timer is pending')
    if (!armed && pending?.purpose === 'failsafe') fail('a failsafe timer is pending but the record does not show it as armed')
    // A usage limit never moves the deadline; only the user's extension does.
    if (!extended && record.deadlineAt !== deadlineAtStart) fail('the deadline moved without an extension')
    // A wait is only ever recorded with a resume time before the deadline.
    if (record.state === 'QUOTA_PAUSED' && record.quota?.resumeAt && Date.parse(record.quota.resumeAt) >= Date.parse(record.deadlineAt)) fail('waiting for a reset that falls after the deadline')
    // Once the supervisor finished, the campaign is not left working.
    if (!LIVE_OVERNIGHT_STATES.includes(record.state) && record.terminalReason !== null && world.campaign().phase === 'working') fail('the overnight record ended but the campaign is still working')
  }

  try {
    const policy = randomPolicy(rand)
    if (rand() < 0.05) world.power.simulateForeignShutdown(3600)
    const foreign = world.power.getState().pending !== null
    const input = { campaign: { name: 'stress', caseIds: ['c'], strategies: ['SINGLE' as const], repetitions: 1, modelPreset: 'balanced' as const, budgetPreset: 'eco' as const }, policy, confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT }
    try {
      await world.supervisor.startArena(input)
    } catch (e) {
      if (!(foreign && policy.failsafeEnabled && policy.endAction !== 'NONE')) throw e
      world.injectedFailures++
      if (world.supervisor.hasActive()) fail('a campaign that could not arm its failsafe is still active')
      if (world.campaign().phase !== 'cancelled') fail('the campaign was not cancelled when the failsafe could not be armed')
      if (world.campaign().started) fail('the campaign started although the failsafe could not be armed')
      return
    }
    if (foreign) return
    const wantsFailsafe = policy.failsafeEnabled && policy.endAction !== 'NONE'
    if (wantsFailsafe && world.power.getState().pending?.purpose !== 'failsafe') fail('the failsafe is not armed after start')
    if (!wantsFailsafe && world.power.calls.length > 0) fail('a timer was armed although the policy asks for none')
    if (!world.campaign().started) fail('the campaign was not started')
    deadlineAtStart = world.record().deadlineAt
    check()

    const steps = 6 + Math.floor(rand() * 16)
    for (let i = 0; i < steps; i++) {
      const op = pick(['tick', 'tick', 'advance', 'advance', 'completed', 'noResult', 'budget', 'quota', 'quotaReset', 'quotaClear', 'userPause', 'resume', 'cancelPower', 'change', 'extend', 'cancelCampaign', 'finalizeRace', 'refuse', 'restart', 'reboot', 'longAbsence'] as const)
      log.push(op)
      const quiet = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined)
      const live = ['RUNNING', 'QUOTA_PAUSED'].includes(world.record().state)
      switch (op) {
        case 'tick':
          await world.supervisor.tick()
          break
        case 'advance':
          world.offset += pick([5_000, 61_000, 10 * MINUTE, 31 * MINUTE, 5 * 60 * MINUTE])
          await world.supervisor.tick()
          break
        case 'completed':
          if (live) world.set('completed', { reason: 'SUCCESS' })
          break
        case 'noResult':
          if (live) world.set('completed', { reason: 'FAILED', detail: 'No trial produced a result' })
          break
        case 'budget':
          if (live) world.set('completed', { reason: 'BLOCKED', detail: 'Budget: maxAgentSessions' })
          break
        case 'quota':
          if (live && world.campaign().phase === 'working') world.set('quota_wait', null, null)
          break
        case 'quotaReset':
          if (live && world.campaign().phase === 'working') world.set('quota_wait', null, world.now() + pick([5 * MINUTE, 3 * 60 * MINUTE, 20 * 60 * MINUTE]))
          break
        case 'quotaClear':
          if (live && world.campaign().phase === 'quota_wait') world.set('working')
          break
        case 'userPause':
          if (live && world.campaign().phase === 'working') world.set('paused')
          break
        case 'resume':
          if (live && world.campaign().phase === 'paused') world.set('working')
          break
        case 'cancelPower':
          await quiet(world.supervisor.cancelPower(world.id))
          break
        case 'change':
          await quiet(world.supervisor.changeEndPolicy(world.id, { endAction: pick<EndAction>(['NONE', 'SHUTDOWN', 'SLEEP', 'HIBERNATE']), forceCloseApplications: rand() < 0.5 }))
          break
        case 'extend': {
          const before = world.record().deadlineAt
          await quiet(world.supervisor.extend(world.id, pick([1, 30, 120])))
          if (world.record().deadlineAt !== before) extended = true
          break
        }
        case 'cancelCampaign':
          await quiet(world.supervisor.cancelMission(world.id))
          break
        case 'finalizeRace':
          await Promise.all([world.supervisor.finalize(world.id, pick(TERMINAL_REASONS)), world.supervisor.finalize(world.id, pick(TERMINAL_REASONS)), world.supervisor.tick()])
          break
        case 'refuse': {
          const operation = pick(['scheduleShutdown', 'cancelShutdown', 'sleep', 'hibernate'] as const)
          world.power.failNext[operation] = (world.power.failNext[operation] ?? 0) + 1
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
      await new Promise((resolve) => setImmediate(resolve))
      await world.supervisor.idle()
      check()
    }

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
    if (['ARMING', 'RUNNING', 'QUOTA_PAUSED', 'FINALIZING', 'CANCELLING'].includes(end.state)) fail(`the overnight campaign is still ${end.state} long after its deadline`)
    if (end.terminalReason !== null && end.finalReport === null) fail('ended without a report')
    const audited = world.repos.powerAudit.listAll(1000).filter((a) => a.result !== null).length
    if (audited !== world.power.calls.length) fail(`${world.power.calls.length} power commands but ${audited} audit entries with a result`)
  } finally {
    world.close()
  }
}

describe('overnight workload (Arena campaign) state-machine stress', () => {
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
