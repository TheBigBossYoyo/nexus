import { RuntimeAvailabilityProbe, QuotaRecoveryController, UsageIntelligenceService } from '@main/modules/usage'
import type { QuotaRecoveryOptions } from '@main/modules/usage'
import type { Harness } from './harness'

/** A manual clock shared by the usage service, the controller, the probe and the fake account. */
export class ManualClock {
  // Starts a day ahead of the wall clock, on the hour. Durable events are stamped with the real clock, and the
  // controller compares its own times with theirs; a fixed date fails once the wall clock passes it.
  constructor(public t = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 24 * 3_600_000) {}
  now = (): number => this.t
  advance(ms: number): number {
    this.t += ms
    return this.t
  }
}

export interface UsageStack {
  clock: { now: () => number }
  usage: UsageIntelligenceService
  probe: RuntimeAvailabilityProbe
  controller: QuotaRecoveryController
  dispose(): void
}

/**
 * Wires the 0.3 usage stack onto a scenario harness exactly as `src/main/index.ts` does: service, probe,
 * controller (manual ticks), the orchestrator's dispatch gate, and `recover()`.
 */
export function attachUsage(
  h: Harness,
  options: { clock?: { now: () => number }; isOvernightRun?: (runId: string) => boolean; overrides?: QuotaRecoveryOptions['overrides'] } = {},
): UsageStack {
  const clock = options.clock ?? new ManualClock()
  h.runtime.usage.now = clock.now
  const usage = new UsageIntelligenceService({ repos: h.repos, bus: h.bus, runtime: h.runtime, push: (m) => void h.pushes.push(m), now: clock.now })
  const probe = new RuntimeAvailabilityProbe({ runtime: h.runtime, settings: () => h.repos.settings.get(), now: clock.now })
  const controller = new QuotaRecoveryController({
    repos: h.repos,
    bus: h.bus,
    usage,
    probe,
    orchestrator: h.orchestrator,
    push: (m) => void h.pushes.push(m),
    now: clock.now,
    tickIntervalMs: 0,
    isOvernightRun: options.isOvernightRun ?? (() => false),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  })
  h.orchestrator.setDispatchGate(usage)
  controller.recover()
  return {
    clock,
    usage,
    probe,
    controller,
    dispose() {
      controller.dispose()
      usage.dispose()
      h.orchestrator.setDispatchGate(null)
    },
  }
}
