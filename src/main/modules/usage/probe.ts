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
      this.inFlight = this.run(hint?.limitType ?? null).finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  private async run(rejectedType: string | null): Promise<ProbeResult> {
    const settings = this.options.settings()
    if (settings.usage.useRuntimeUsageReport && this.options.runtime.getUsageReport) {
      this.stats.reports += 1
      const report = await this.options.runtime
        .getUsageReport({ subscriptionMode: settings.claude.subscriptionMode })
        .catch(() => null)
      const answered = report ? this.fromReport(report, rejectedType) : null
      if (answered) return answered
    }
    this.stats.sessions += 1
    return this.minimalSession(settings)
  }

  /** Null when the report carries no usable percentage: the caller falls back to a session. */
  private fromReport(report: RuntimeUsageReport, rejectedType: string | null): ProbeResult | null {
    if (!report.rateLimitsAvailable) return null
    const now = (this.options.now ?? Date.now)()
    // The window that was rejected, reporting no percentage but a reset still ahead: still limited.
    const rejected = rejectedType ? report.windows.find((x) => x.limitType === rejectedType) : undefined
    if (rejected && rejected.utilizationPercent === null && rejected.resetsAt && Date.parse(rejected.resetsAt) > now) {
      return { available: false, method: 'usage_report', resetAt: rejected.resetsAt, detail: `${rejected.limitType} window resets ${rejected.resetsAt}`, outcome: 'limited', windows: report.windows, report }
    }
    const w = limitingWindow(report)
    if (!w) return null
    const percent = w.utilizationPercent as number
    const limited = percent >= REPORT_LIMITED_PERCENT
    // A window at its limit whose reset is still in the future is still limited; one that passed is not evidence either way.
    return {
      available: !limited,
      method: 'usage_report',
      resetAt: limited ? w.resetsAt : null,
      detail: limited ? `${w.limitType} window at ${percent}%` : `${w.limitType} window at ${percent}%; capacity available`,
      outcome: limited ? 'limited' : 'available',
      windows: report.windows,
      report,
    }
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
