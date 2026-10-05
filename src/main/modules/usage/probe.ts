import { tmpdir } from 'node:os'
import { normalizeEpochMs } from '@shared/overnight'
import type { Settings } from '@shared/settings'
import { errorMessage } from '@shared/result'
import { USAGE_PROBE_PROMPT, type AgentRuntime, type RuntimeUsageReport, type TurnOutcome } from '../agent-runtime/types'
import { REPORT_LIMITED_PERCENT, limitingWindow } from './classify'

export interface ProbeResult {
  available: boolean
  method: 'usage_report' | 'minimal_session' | 'none'
  /** ISO reset time the probe learned, when the runtime gave one. */
  resetAt: string | null
  detail: string
  /** Why it is not available when that is not a limit: the controller keeps those apart. */
  outcome: 'available' | 'limited' | 'auth' | 'runtime'
  windows?: RuntimeUsageReport['windows']
  /** The report that answered, for the service to record (percentages are runtime-supplied). */
  report?: RuntimeUsageReport
}

export interface AvailabilityProbe {
  /** `hint.limitType` names the window that was rejected: a still-future reset on it means still limited. */
  probe(hint?: { limitType: string | null }): Promise<ProbeResult>
}

export interface RuntimeProbeOptions {
  runtime: AgentRuntime
  settings: () => Settings
  now?: () => number
  /** Upper bound for the minimal session. Default 90 s. */
  sessionTimeoutMs?: number
  logger?: (line: string) => void
}

const SESSION_TIMEOUT_MS = 90_000

/**
 * Asks "is Claude available again?" with the least possible cost: the runtime's no-prompt usage report
 * first; one minimal session (no tools, one turn, fast tier, fixed prompt) only when the report is
 * unsupported or failed. Never more than one probe in flight: a second caller shares the first's answer.
 */
export class RuntimeAvailabilityProbe implements AvailabilityProbe {
  private inFlight: Promise<ProbeResult> | null = null
  /** Counts of what ran, for tests and diagnostics. */
  readonly stats = { reports: 0, sessions: 0 }

  constructor(private readonly options: RuntimeProbeOptions) {}

  probe(hint?: { limitType: string | null }): Promise<ProbeResult> {
    if (!this.inFlight) {
      this.inFlight = this.run(hint).finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  private async run(hint: { limitType: string | null } | undefined): Promise<ProbeResult> {
    const settings = this.options.settings()
    if (settings.usage.useRuntimeUsageReport && this.options.runtime.getUsageReport) {
      this.stats.reports += 1
      const report = await this.options.runtime
        .getUsageReport({ subscriptionMode: settings.claude.subscriptionMode })
        .catch(() => null)
      const answered = report ? this.fromReport(report, hint) : null
      if (answered) return answered
    }
    this.stats.sessions += 1
    return this.minimalSession(settings)
  }

  /** Null when the report carries no usable percentage: the caller falls back to a session. */
  private fromReport(report: RuntimeUsageReport, hint: { limitType: string | null } | undefined): ProbeResult | null {
    if (!report.rateLimitsAvailable) return null
    const now = (this.options.now ?? Date.now)()
    const resetOf = (w: RuntimeUsageReport['windows'][number]): number | null => {
      const ms = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN
      return Number.isFinite(ms) ? ms : null
    }
    const result = (w: RuntimeUsageReport['windows'][number], limited: boolean): ProbeResult => ({
      available: !limited,
      method: 'usage_report',
      resetAt: limited ? w.resetsAt : null,
      detail: limited ? `${w.limitType} window at ${w.utilizationPercent ?? 'an unknown share of'}%` : `${w.limitType} window at ${w.utilizationPercent}%; capacity available`,
      outcome: limited ? 'limited' : 'available',
      windows: report.windows,
      report,
    })
    if (hint) {
      // A rejection that names no window (billing, overage, no limit type) cannot be explained by the report:
      // do not trust it alone, ask with one minimal session instead.
      if (hint.limitType === null) return null
      const w = report.windows.find((x) => x.limitType === hint.limitType)
      if (!w) return null
      const reset = resetOf(w)
      if (w.utilizationPercent === null) {
        // No percentage: only a reset still ahead is evidence (of a limit); otherwise the report says nothing.
        return reset !== null && reset > now ? result(w, true) : null
      }
      // A window at 100% whose reset time has passed is stale, not a limit.
      const stale = reset !== null && reset <= now
      return result(w, w.utilizationPercent >= REPORT_LIMITED_PERCENT && !stale)
    }
    // No hint (a manual check): the highest window that is not stale.
    const fresh: RuntimeUsageReport = { ...report, windows: report.windows.filter((w) => {
      const reset = resetOf(w)
      return reset === null || reset > now
    }) }
    const w = limitingWindow(fresh)
    if (!w) return null
    return result(w, (w.utilizationPercent as number) >= REPORT_LIMITED_PERCENT)
  }

  private async minimalSession(settings: Settings): Promise<ProbeResult> {
    const { runtime } = this.options
    const tier = settings.models.tiers.fast
    let outcome: TurnOutcome | 'crashed' | 'timeout' = 'crashed'
    let resetAt: string | null = null
    let error: string | null = null
    let handle: ReturnType<AgentRuntime['startSession']> | null = null
    let timer: NodeJS.Timeout | undefined
    try {
      handle = runtime.startSession({
        agentId: 'usage-probe',
        role: 'researcher',
        cwd: tmpdir(),
        ...(tier ? { model: tier } : {}),
        maxTurns: 1,
        systemPromptAppend: 'This is an availability check. Answer in one word.',
        prompt: USAGE_PROBE_PROMPT,
        tools: [],
        authorize: async () => ({ behavior: 'deny', reason: 'The availability probe uses no tools.' }),
        requestApproval: async () => false,
        loadProjectSettings: false,
        subscriptionMode: settings.claude.subscriptionMode,
      })
      const events = handle.events
      const consume = (async () => {
        for await (const event of events) {
          if (event.type === 'rate_limit' && event.status === 'rejected') {
            const ms = normalizeEpochMs(event.resetsAt)
            if (ms !== null) resetAt = new Date(ms).toISOString()
          } else if (event.type === 'turn.completed') {
            outcome = event.result.outcome
            handle?.end()
          } else if (event.type === 'session.ended' && event.error) error = event.error
        }
      })()
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS)
        timer.unref?.()
      })
      if ((await Promise.race([consume.then(() => 'done' as const), timeout])) === 'timeout') outcome = 'timeout'
    } catch (e) {
      error = errorMessage(e)
      outcome = 'crashed'
    } finally {
      clearTimeout(timer)
      try {
        await handle?.stop()
      } catch {
        // the session is already gone
      }
    }
    return this.fromOutcome(outcome, resetAt, error)
  }

  private fromOutcome(outcome: TurnOutcome | 'crashed' | 'timeout', resetAt: string | null, error: string | null): ProbeResult {
    const method = 'minimal_session' as const
    switch (outcome) {
      case 'success':
        return { available: true, method, resetAt: null, detail: 'A one-turn session completed', outcome: 'available' }
      case 'quota':
        return { available: false, method, resetAt, detail: resetAt ? `Still limited; resets ${resetAt}` : 'Still limited; no reset time reported', outcome: 'limited' }
      case 'auth':
        return { available: false, method, resetAt: null, detail: 'Claude authentication is required', outcome: 'auth' }
      case 'timeout':
        return { available: false, method, resetAt: null, detail: 'The availability session timed out', outcome: 'runtime' }
      default:
        return { available: false, method, resetAt: null, detail: `The availability session ended with ${outcome}${error ? `: ${error}` : ''}`, outcome: 'runtime' }
    }
  }
}
