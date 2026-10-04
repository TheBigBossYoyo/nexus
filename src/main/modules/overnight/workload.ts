import type { OvernightRun, TerminalReason, WorkloadType } from '@shared/overnight'

/**
 * Where a workload stands, as the supervisor needs to know it.
 * `quota_wait`: paused on a Claude usage limit, not a failure. `paused`: stopped by a person or by NEXUS.
 */
export type WorkloadPhase = 'working' | 'paused' | 'quota_wait' | 'completed' | 'failed' | 'cancelled' | 'missing'

export interface WorkloadDeadlineState {
  phase: WorkloadPhase
  /** Set when the workload ended by itself: the terminal reason the supervisor finalizes with. */
  outcome: { reason: TerminalReason; detail?: string } | null
  /** While `quota_wait`: when the limit resets (epoch ms), if the runtime said so. */
  quotaResetsAt: number | null
}

export interface WorkloadSummaryInput {
  record: OvernightRun
  reason: TerminalReason
  detail: string | null
  finishedAt: string
  /** What `getFinalizationState` returned, or null when it did not finish in time. */
  finalization: unknown
  /** One line on the power action as decided at report time. */
  powerPlan: string
}

/**
 * What the OvernightSupervisor supervises. The supervisor owns the deadline, the failsafe, the quota
 * decision, finalization and the power action; a workload only knows how to run, stop and describe its own
 * work. A workload never holds the power controller and takes no part in the power decision.
 */
export interface AutonomousWorkload {
  readonly id: string
  readonly type: WorkloadType
  readonly state: WorkloadPhase
  /** Begin the work. Called once, after the failsafe is armed. */
  start(): Promise<void>
  /** Stop working and stay resumable. Resolves when nothing of the workload is running any more. */
  pause(detail: string): Promise<void>
  resume(): Promise<void>
  /** End the work for good. */
  cancel(): Promise<void>
  /** Record a durable checkpoint. True when one was written. */
  checkpoint(reason: string): boolean
  isTerminal(): boolean
  /** The durable end-of-workload report, built from persisted state only. */
  summarize(input: WorkloadSummaryInput): string
  getDeadlineState(now: number): WorkloadDeadlineState
  /** After the workload stopped: preserve unfinished work and capture what there is to report. */
  getFinalizationState(options: { commitWork: boolean }): Promise<unknown>
  /** A project directory that also receives the report (`<root>/.nexus/reports`), or null. */
  projectRoot(): string | null
  /** The deadline moved by `minutes`: keep the workload's own time limit in step. */
  extend(minutes: number): void
  /** NEXUS restarted while the workload was live: continue it. Throws when it cannot be continued. */
  recoverAfterRestart(): Promise<void>
}

export type WorkloadFactory = (id: string) => AutonomousWorkload
