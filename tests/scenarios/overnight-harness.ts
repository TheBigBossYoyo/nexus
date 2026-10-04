import { join } from 'node:path'
import type { Run } from '@shared/domain'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT, type OvernightPolicy, type OvernightRun } from '@shared/overnight'
import { OvernightSupervisor } from '@main/modules/overnight'
import { FakePowerController } from '@main/modules/power'
import type { PowerCommandResult } from '@shared/overnight'
import type { ShutdownRequest } from '@main/modules/power'
import type { Harness } from './harness'

/** A FakePowerController that also records whether the final report existed when a final action was requested. */
export class ObservedPower extends FakePowerController {
  /** For every final power request: was the report already persisted? */
  readonly reportSavedAtFinal: boolean[] = []
  inspect: (() => boolean) | null = null

  override async scheduleShutdown(request: ShutdownRequest): Promise<PowerCommandResult> {
    if (request.purpose === 'final') this.reportSavedAtFinal.push(this.inspect?.() ?? false)
    return super.scheduleShutdown(request)
  }

  override async sleep(): Promise<PowerCommandResult> {
    this.reportSavedAtFinal.push(this.inspect?.() ?? false)
    return super.sleep()
  }

  override async hibernate(): Promise<PowerCommandResult> {
    this.reportSavedAtFinal.push(this.inspect?.() ?? false)
    return super.hibernate()
  }
}

export interface Overnight {
  supervisor: OvernightSupervisor
  power: ObservedPower
  /** Move the supervisor's clock forward. */
  advance(ms: number): void
  now(): number
  start(options?: { policy?: Partial<OvernightPolicy>; prompt?: string; confirmed?: boolean; confirmation?: string }): Promise<Run>
  record(runId: string): OvernightRun
  /** Tick until the overnight record reaches one of the states. */
  waitForOvernight(runId: string, states: OvernightRun['state'] | OvernightRun['state'][], timeoutMs?: number): Promise<OvernightRun>
  dispose(): void
}

export interface AttachOptions {
  /** Epoch ms Windows booted at, as seen by this supervisor (default: long before any run). */
  bootTime?: () => number
  /** Carry the simulated OS timer of a previous app instance over a restart of NEXUS. */
  power?: ObservedPower
  /** Start the supervisor's clock this far ahead of real time. */
  offsetMs?: number
}

export function policyWith(overrides: Partial<OvernightPolicy> = {}): OvernightPolicy {
  return { ...DEFAULT_OVERNIGHT_POLICY, ...overrides }
}

/** Attaches a supervisor (fake power, manual clock, manual ticks) to a scenario harness. */
export function attachOvernight(h: Harness, options: AttachOptions = {}): Overnight {
  let offset = options.offsetMs ?? 0
  const now = (): number => Date.now() + offset
  const power = options.power ?? new ObservedPower({ now })
  let current: string | null = null
  power.inspect = () => (current ? h.repos.overnight.getByRun(current)?.finalReport != null : false)
  const supervisor = new OvernightSupervisor({
    repos: h.repos,
    bus: h.bus,
    orchestrator: h.orchestrator,
    power,
    git: h.git,
    push: (message) => void h.pushes.push(message),
    flush: () => void h.db.pragma('wal_checkpoint(TRUNCATE)'),
    reportsDir: join(h.dir, 'reports'),
    now,
    bootTime: options.bootTime ?? (() => 0),
    tickIntervalMs: 0,
    stopTimeoutMs: 20_000,
  })
  const overnight: Overnight = {
    supervisor,
    power,
    advance: (ms) => void (offset += ms),
    now,
    async start(opts = {}) {
      const { run } = await supervisor.start({
        projectId: h.project.id,
        prompt: opts.prompt ?? 'Build the thing overnight',
        preset: 'balanced',
        policy: policyWith(opts.policy),
        confirmed: opts.confirmed ?? true,
        confirmation: opts.confirmation ?? OVERNIGHT_CONFIRMATION_TEXT,
      })
      current = run.id
      return run
    },
    record(runId) {
      current = runId
      return h.repos.overnight.require(runId)
    },
    async waitForOvernight(runId, states, timeoutMs = 150_000) {
      current = runId
      const wanted = Array.isArray(states) ? states : [states]
      const deadline = Date.now() + timeoutMs
      for (;;) {
        await supervisor.idle()
        const record = h.repos.overnight.require(runId)
        if (wanted.includes(record.state)) return record
        if (Date.now() > deadline) {
          const run = h.repos.runs.get(runId)
          throw new Error(`Timed out waiting for overnight state ${wanted.join('|')}; it is ${record.state} (run ${run?.state ?? 'missing'}, error ${record.error ?? 'none'})`)
        }
        await supervisor.tick()
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
    dispose: () => supervisor.dispose(),
  }
  return overnight
}
