import { z } from 'zod'

/**
 * Overnight Mode: an unattended run with a user-approved end-of-run power policy. Everything here is
 * data and pure decisions; the only code that touches the operating system lives in the main process
 * (`modules/power`), and only the OvernightSupervisor calls it.
 */

export const END_ACTIONS = ['NONE', 'SHUTDOWN', 'SLEEP', 'HIBERNATE'] as const
export const EndActionSchema = z.enum(END_ACTIONS)
export type EndAction = z.infer<typeof EndActionSchema>
export type PowerAction = Exclude<EndAction, 'NONE'>

export const TERMINAL_REASONS = ['SUCCESS', 'FAILED', 'BLOCKED', 'QUOTA_EXHAUSTED', 'TIME_LIMIT', 'USER_CANCELLED'] as const
export type TerminalReason = (typeof TERMINAL_REASONS)[number]

export const OVERNIGHT_STATES = [
  'IDLE',
  'ARMING',
  'RUNNING',
  /** The run is paused on a Claude usage limit and will be resumed when the limit resets. Not a failure. */
  'QUOTA_PAUSED',
  'FINALIZING',
  'POWER_ACTION_SCHEDULED',
  'DONE',
  'CANCELLING',
  'FINALIZATION_FAILED',
  'POWER_ACTION_FAILED',
] as const
export type OvernightState = (typeof OVERNIGHT_STATES)[number]

/** States in which the supervisor still owns the run (failsafe may be armed, a power action may be pending). */
export const LIVE_OVERNIGHT_STATES: readonly OvernightState[] = ['ARMING', 'RUNNING', 'QUOTA_PAUSED', 'FINALIZING', 'POWER_ACTION_SCHEDULED', 'CANCELLING']

/** Which terminal reasons the end action applies to. */
export const EndConditionsSchema = z
  .object({
    success: z.boolean(),
    failure: z.boolean(),
    blocker: z.boolean(),
    quotaExhausted: z.boolean(),
    timeout: z.boolean(),
    cancellation: z.boolean(),
  })
  .strict()
export type EndConditions = z.infer<typeof EndConditionsSchema>

export const RunBudgetsSchema = z
  .object({
    /** Total SDK sessions the run may start before it is finalized as blocked. */
    maxAgentSessions: z.number().int().min(1).max(5000),
    /** Total repair tasks (task-level and mission-level) before the run is finalized as blocked. */
    maxTotalRepairs: z.number().int().min(0).max(1000),
  })
  .strict()
export type RunBudgets = z.infer<typeof RunBudgetsSchema>

export const WatchdogPolicySchema = z
  .object({
    /** No durable event for this long while the run should be working counts as a stall. */
    stallMinutes: z.number().int().min(1).max(240),
    /** Time after the reconciliation attempt before a still-stalled run is finalized as blocked. */
    graceMinutes: z.number().int().min(1).max(240),
  })
  .strict()

/** Longest delay Windows accepts for `shutdown /t` (ten years, in seconds). */
export const MAX_SHUTDOWN_DELAY_SECONDS = 315_360_000

export const OvernightPolicySchema = z
  .object({
    enabled: z.literal(true),
    maxDurationMinutes: z.number().int().min(1).max(24 * 60),
    endAction: EndActionSchema,
    /** Named after the release brief; reads as "apply the end action on". */
    shutdownOn: EndConditionsSchema,
    finalDelaySeconds: z.number().int().min(10).max(3600),
    forceCloseApplications: z.boolean(),
    failsafeEnabled: z.boolean(),
    failsafeAfterMinutes: z.number().int().min(2).max(48 * 60),
    requireExplicitConfirmation: z.literal(true),
    saveFinalReport: z.boolean(),
    commitCompletedWork: z.boolean(),
    stopWorkersBeforePowerAction: z.boolean(),
    quotaPolicy: z.enum(['WAIT_AND_RETRY', 'END_RUN']),
    /**
     * Nobody is there to answer approval requests. Tool approvals (sensitive shell commands and the like)
     * are always denied; with this flag, task-start and graph-change approvals are granted.
     */
    autoApprovePlanChanges: z.boolean(),
    budgets: RunBudgetsSchema,
    watchdog: WatchdogPolicySchema,
    checkpointIntervalMinutes: z.number().int().min(1).max(240),
  })
  .strict()
  .refine((p) => !p.failsafeEnabled || p.failsafeAfterMinutes > p.maxDurationMinutes, {
    message: 'The failsafe must fire after the mission deadline',
    path: ['failsafeAfterMinutes'],
  })
export type OvernightPolicy = z.infer<typeof OvernightPolicySchema>

export const DEFAULT_OVERNIGHT_POLICY: OvernightPolicy = {
  enabled: true,
  maxDurationMinutes: 8 * 60,
  endAction: 'SHUTDOWN',
  shutdownOn: { success: true, failure: true, blocker: true, quotaExhausted: true, timeout: true, cancellation: false },
  finalDelaySeconds: 60,
  forceCloseApplications: false,
  failsafeEnabled: true,
  failsafeAfterMinutes: 9 * 60,
  requireExplicitConfirmation: true,
  saveFinalReport: true,
  commitCompletedWork: true,
  stopWorkersBeforePowerAction: true,
  quotaPolicy: 'WAIT_AND_RETRY',
  autoApprovePlanChanges: true,
  budgets: { maxAgentSessions: 400, maxTotalRepairs: 60 },
  watchdog: { stallMinutes: 30, graceMinutes: 15 },
  checkpointIntervalMinutes: 15,
}

/** The sentence the user ticks. Stored verbatim with the authorization. */
export const OVERNIGHT_CONFIRMATION_TEXT = 'I authorize NEXUS to control Windows power state for this run.'

export interface OvernightAuthorization {
  runId: string
  authorizedAt: string
  /** The exact sentence the user confirmed. */
  confirmation: string
  /** The policy as approved. Later changes are recorded as amendments, never by rewriting this. */
  policy: OvernightPolicy
}

/** Result of one power-controller command, exactly as executed. */
export interface PowerCommandResult {
  ok: boolean
  exitCode: number | null
  output: string
  executable: string
  args: string[]
  at: string
}

export interface FailsafeRecord {
  scheduledAt: string
  /** When Windows will shut down unless the timer is cancelled. */
  deadline: string
  result: PowerCommandResult
  cancelledAt: string | null
  cancelResult: PowerCommandResult | null
  /** Set when a restart of Windows since `scheduledAt` shows the OS timer cannot exist any more. */
  lostAt: string | null
}

export interface PowerActionRecord {
  action: PowerAction
  reason: TerminalReason
  scheduledAt: string
  /** When the action takes effect. */
  executeAt: string
  /** True when Windows closes applications without waiting. */
  forced: boolean
  /** 'os_timer': Windows holds the timer. 'app_timer': NEXUS counts down, then runs the action. */
  mechanism: 'os_timer' | 'app_timer'
  result: PowerCommandResult | null
  executedAt: string | null
  cancelledAt: string | null
}

export interface QuotaPause {
  pausedAt: string
  /** When the limit resets, if the runtime said so. */
  resetsAt: string | null
  /** When the supervisor will resume the run; null when it ended the run instead. */
  resumeAt: string | null
  /** How many times this run has waited for a limit to reset. Bounded so it can never loop forever. */
  waits: number
}

/** A run waits for a usage limit at most this many times. */
export const MAX_QUOTA_WAITS = 6
/** Seconds added to the reported reset time before resuming. */
export const QUOTA_RESUME_MARGIN_SECONDS = 90

export type QuotaDecision = { action: 'wait'; resumeAt: number } | { action: 'end'; why: string }

/**
 * What to do when Claude reports a usage limit during an overnight run. Waits only when the runtime
 * said when the limit resets and that moment (plus a margin) is inside the remaining mission time.
 * All times are epoch milliseconds.
 */
export function decideQuota(input: { policy: OvernightPolicy['quotaPolicy']; now: number; deadline: number; resetsAt: number | null; waits: number }): QuotaDecision {
  if (input.policy === 'END_RUN') return { action: 'end', why: 'The policy ends the run on a usage limit.' }
  if (input.waits >= MAX_QUOTA_WAITS) return { action: 'end', why: `The run already waited for a usage limit ${input.waits} times.` }
  if (input.resetsAt === null) return { action: 'end', why: 'Claude did not report when the usage limit resets.' }
  const resumeAt = Math.max(input.resetsAt, input.now) + QUOTA_RESUME_MARGIN_SECONDS * 1000
  if (resumeAt >= input.deadline) return { action: 'end', why: 'The usage limit resets after the mission deadline.' }
  return { action: 'wait', resumeAt }
}

/** The SDK reports reset times in epoch seconds; accept milliseconds too. */
export function normalizeEpochMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
}

export interface WatchdogDiagnostic {
  at: string
  stage: 'stalled' | 'reconciled' | 'recovered' | 'blocked' | 'budget'
  detail: string
  lastEventAt: string | null
  runState: string
  tasks: Record<string, number>
  activeAgents: number
  pendingApprovals: number
}

export interface PolicyAmendment {
  at: string
  /** Always an explicit action of the person at the keyboard; agents have no path to this. */
  by: 'user'
  change: string
}

export interface OvernightRun {
  /** Same as runId: one overnight record per run. */
  id: string
  runId: string
  projectId: string
  state: OvernightState
  policy: OvernightPolicy
  authorization: OvernightAuthorization
  startedAt: string
  deadlineAt: string
  failsafe: FailsafeRecord | null
  terminalReason: TerminalReason | null
  terminalDetail: string | null
  finalReport: string | null
  reportPath: string | null
  reportSavedAt: string | null
  powerAction: PowerActionRecord | null
  quota: QuotaPause | null
  watchdog: WatchdogDiagnostic[]
  amendments: PolicyAmendment[]
  error: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

/** What the renderer gets: the record without the report body. */
export type OvernightStatus = Omit<OvernightRun, 'finalReport'> & { hasReport: boolean }

export interface PowerAuditEntry {
  id: string
  runId: string | null
  operation: 'arm_failsafe' | 'cancel_failsafe' | 'schedule_final' | 'execute_final' | 'cancel_final' | 'rearm_failsafe' | 'denied' | 'smoke'
  action: EndAction
  detail: string
  result: PowerCommandResult | null
  createdAt: string
}

export interface RunCheckpoint {
  id: string
  runId: string
  reason: string
  snapshot: {
    runState: string
    graphVersion: number | null
    integrationBranch: string | null
    tasks: { id: string; key: string; state: string; leaseOwner: string | null; branch: string | null; repairCycles: number }[]
    worktrees: { id: string; taskId: string | null; branch: string; state: string }[]
    sessions: { agentId: string; sdkSessionId: string | null; state: string }[]
    messages: number
    decisions: number
    lastChecks: { name: string; exitCode: number | null }[]
  }
  createdAt: string
}

const CONDITION_FOR: Record<TerminalReason, keyof EndConditions> = {
  SUCCESS: 'success',
  FAILED: 'failure',
  BLOCKED: 'blocker',
  QUOTA_EXHAUSTED: 'quotaExhausted',
  TIME_LIMIT: 'timeout',
  USER_CANCELLED: 'cancellation',
}

export type PowerDecision = { action: PowerAction; reason: TerminalReason } | { action: null; why: string }

/**
 * The single gate in front of every final power action. A power action is allowed only when Overnight
 * Mode is enabled for this very run, the user's explicit authorization is stored for the same run id,
 * and the approved policy applies the end action to the reason the run ended for.
 */
export function decidePowerAction(record: OvernightRun | null, runId: string, reason: TerminalReason): PowerDecision {
  if (!record) return { action: null, why: 'No overnight record exists for this run.' }
  if (record.runId !== runId) return { action: null, why: 'The overnight record belongs to another run.' }
  const policy = OvernightPolicySchema.safeParse(record.policy)
  if (!policy.success || policy.data.enabled !== true) return { action: null, why: 'Overnight Mode is not enabled for this run.' }
  const auth = record.authorization as OvernightAuthorization | null
  if (!auth || !auth.authorizedAt || Number.isNaN(Date.parse(auth.authorizedAt))) return { action: null, why: 'No explicit authorization is stored.' }
  if (auth.runId !== runId) return { action: null, why: 'The stored authorization is for another run.' }
  if (auth.confirmation !== OVERNIGHT_CONFIRMATION_TEXT) return { action: null, why: 'The stored confirmation does not match.' }
  if (policy.data.endAction === 'NONE') return { action: null, why: 'The end action is NONE.' }
  if (!policy.data.shutdownOn[CONDITION_FOR[reason]]) return { action: null, why: `The policy does not apply the end action to ${reason}.` }
  return { action: policy.data.endAction, reason }
}

/** Report outcome label for a terminal reason, given how many tasks finished. */
export function outcomeLabel(reason: TerminalReason, completed: number, total: number): string {
  switch (reason) {
    case 'SUCCESS':
      return 'SUCCESS'
    case 'TIME_LIMIT':
      return 'TIMEOUT'
    case 'QUOTA_EXHAUSTED':
      return 'QUOTA_EXHAUSTED'
    case 'BLOCKED':
      return completed > 0 && completed < total ? 'PARTIAL (BLOCKED)' : 'BLOCKED'
    case 'FAILED':
      return completed > 0 ? 'PARTIAL (FAILED)' : 'FAILED'
    case 'USER_CANCELLED':
      return 'CANCELLED'
  }
}

export function toStatus(record: OvernightRun): OvernightStatus {
  const { finalReport, ...rest } = record
  return { ...rest, hasReport: finalReport !== null }
}
