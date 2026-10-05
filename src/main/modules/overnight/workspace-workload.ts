import { outcomeLabel } from '@shared/overnight'
import type { CrossRepoTask, WorkspaceMission } from '@shared/workspace'
import type { AutonomousWorkload, WorkloadDeadlineState, WorkloadPhase, WorkloadSummaryInput } from './workload'

/** The workspace engine calls a workspace-mission workload needs. The WorkspaceEngine satisfies it. */
export interface WorkspaceWorkloadHost {
  startMission(missionId: string): Promise<unknown>
  pauseMission(missionId: string): Promise<unknown>
  resumeMission(missionId: string): Promise<unknown>
  cancelMission(missionId: string): Promise<unknown>
  missionDetail(missionId: string): { mission: WorkspaceMission; tasks: CrossRepoTask[] }
  idle(): Promise<void>
}

export interface WorkspaceWorkloadDeps {
  host: WorkspaceWorkloadHost
  get(missionId: string): WorkspaceMission | null
  /** When the Claude usage limit resets (epoch ms), if the runtime said so. */
  quotaResetsAt: () => number | null
}

const oneLine = (text: string | null | undefined, max = 240): string => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/**
 * A cross-repository mission under the overnight supervisor. The mission keeps its own queue, usage wait and
 * global verification; the supervisor owns the deadline and the power lifecycle.
 */
export class WorkspaceMissionWorkload implements AutonomousWorkload {
  readonly type = 'workspace_mission' as const

  constructor(
    readonly id: string,
    private readonly deps: WorkspaceWorkloadDeps,
  ) {}

  get state(): WorkloadPhase {
    const m = this.deps.get(this.id)
    if (!m) return 'missing'
    switch (m.state) {
      case 'COMPLETED':
        return 'completed'
      case 'FAILED':
        return 'failed'
      case 'CANCELLED':
        return 'cancelled'
      case 'WAITING_FOR_QUOTA':
        return 'quota_wait'
      case 'PAUSED':
      case 'BLOCKED':
      case 'AWAITING_APPROVAL':
        return 'paused'
      default:
        return 'working'
    }
  }

  async start(): Promise<void> {
    const m = this.deps.get(this.id)
    if (m?.state === 'DRAFT') await this.deps.host.startMission(this.id)
    else if (m?.state === 'PAUSED' || m?.state === 'BLOCKED') await this.deps.host.resumeMission(this.id)
  }

  async pause(): Promise<void> {
    const m = this.deps.get(this.id)
    if (m && (m.state === 'PLANNING' || m.state === 'ACTIVE' || m.state === 'VERIFYING' || m.state === 'WAITING_FOR_QUOTA')) await this.deps.host.pauseMission(this.id)
    await this.deps.host.idle()
  }

  async resume(): Promise<void> {
    await this.deps.host.resumeMission(this.id)
  }

  async cancel(): Promise<void> {
    await this.deps.host.cancelMission(this.id)
  }

  /** Every state change of a mission and its tasks is written as it happens; there is nothing more to save. */
  checkpoint(): boolean {
    return this.deps.get(this.id) !== null
  }

  isTerminal(): boolean {
    const phase = this.state
    return phase === 'missing' || phase === 'completed' || phase === 'failed' || phase === 'cancelled'
  }

  getDeadlineState(): WorkloadDeadlineState {
    const m = this.deps.get(this.id)
    const phase = this.state
    const base = { phase, quotaResetsAt: phase === 'quota_wait' ? this.deps.quotaResetsAt() : null }
    if (!m) return { ...base, outcome: { reason: 'FAILED', detail: 'The workspace mission no longer exists.' } }
    if (m.state === 'COMPLETED') return { ...base, outcome: { reason: 'SUCCESS' } }
    if (m.state === 'FAILED') return { ...base, outcome: { reason: 'FAILED', ...(m.error ? { detail: m.error } : {}) } }
    if (m.state === 'CANCELLED') return { ...base, outcome: { reason: 'USER_CANCELLED' } }
    // Nobody is there overnight to approve a plan, resume a pause or look at a failed verification.
    if (m.state === 'BLOCKED') return { ...base, outcome: { reason: 'BLOCKED', detail: m.blockedReason ?? 'The mission is blocked.' } }
    if (m.state === 'AWAITING_APPROVAL') return { ...base, outcome: { reason: 'BLOCKED', detail: 'The cross-repository plan is waiting for approval.' } }
    if (m.state === 'PAUSED') return { ...base, outcome: { reason: 'BLOCKED', detail: 'The mission is paused.' } }
    return { ...base, outcome: null }
  }

  async getFinalizationState(): Promise<{ mission: WorkspaceMission; tasks: CrossRepoTask[] } | null> {
    try {
      return this.deps.host.missionDetail(this.id)
    } catch {
      return null
    }
  }

  projectRoot(): string | null {
    return null
  }

  extend(): void {}

  /** The workspace engine recovers its own missions at startup. */
  async recoverAfterRestart(): Promise<void> {}

  summarize(input: WorkloadSummaryInput): string {
    const { record, reason } = input
    const detail = (input.finalization as { mission: WorkspaceMission; tasks: CrossRepoTask[] } | null) ?? this.deps.host.missionDetail(this.id)
    const { mission, tasks } = detail
    const completed = tasks.filter((t) => t.state === 'COMPLETED').length
    const out: string[] = []
    out.push('# NEXUS Overnight Workspace Mission', '')
    out.push(`- Mission ID: ${mission.id}`)
    out.push(`- Goal: ${oneLine(mission.goal, 300)}`)
    out.push(`- Started: ${record.startedAt}`)
    out.push(`- Finished: ${input.finishedAt}`)
    out.push(`- Overnight deadline: ${record.deadlineAt}`, '')
    out.push('## Outcome', '')
    out.push(`**${outcomeLabel(reason, completed, tasks.length)}** (terminal reason: ${reason}; mission state: ${mission.state})`)
    if (input.detail) out.push('', `Detail: ${oneLine(input.detail, 600)}`)
    out.push('', '## Tasks by repository', '')
    for (const t of tasks) out.push(`- \`${t.key}\` in ${t.repository} [${t.state}]${t.resultBranch ? ` result ${t.resultBranch} ${t.resultCommit?.slice(0, 12) ?? ''}` : ''}${t.error ? ` (${oneLine(t.error, 160)})` : ''}`)
    if (tasks.length === 0) out.push('- no plan was accepted')
    out.push('', '## Global verification', '')
    if (mission.verification) {
      out.push(`${mission.verification.passed ? 'Passed' : 'FAILED'}.`)
      for (const c of mission.verification.checks) out.push(`- ${c.passed ? 'passed' : 'FAILED'}: ${c.name}${c.repository ? ` (${c.repository})` : ''}: ${oneLine(c.detail, 200)}`)
    } else out.push('Not reached.')
    out.push('', 'Nothing was published. The results are on the branches listed above; the original checkouts were not changed.', '')
    out.push('## Usage limit', '')
    out.push(record.quota ? `- Waits for a usage limit: ${record.quota.waits}; last pause ${record.quota.pausedAt}; reset reported: ${record.quota.resetsAt ?? 'not reported'}` : '- No usage limit was met.', '')
    out.push('## Power action', '', input.powerPlan, '')
    return out.join('\n')
  }
}
