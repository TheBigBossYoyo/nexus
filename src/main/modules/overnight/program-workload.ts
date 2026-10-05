import { outcomeLabel } from '@shared/overnight'
import type { Program, ProgramDetail } from '@shared/program'
import type { AutonomousWorkload, WorkloadDeadlineState, WorkloadPhase, WorkloadSummaryInput } from './workload'

/** The program engine calls a program workload needs. The ProgramEngine satisfies it. */
export interface ProgramWorkloadHost {
  start(programId: string): Promise<unknown>
  pause(programId: string): Promise<unknown>
  resume(programId: string): Promise<unknown>
  cancel(programId: string): Promise<unknown>
  detail(programId: string): ProgramDetail
  checkpointNow(programId: string, reason: string): boolean
  idle(): Promise<void>
}

export interface ProgramWorkloadDeps {
  host: ProgramWorkloadHost
  get(programId: string): Program | null
  /** When the Claude usage limit resets (epoch ms), if the runtime said so. */
  quotaResetsAt: () => number | null
}

const oneLine = (text: string | null | undefined, max = 240): string => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/**
 * A program under the overnight supervisor: the supervisor's deadline is the end of the autonomous work
 * window, and at the end the program is paused in a safe state before the configured power action.
 */
export class ProgramWorkload implements AutonomousWorkload {
  readonly type = 'program' as const

  constructor(
    readonly id: string,
    private readonly deps: ProgramWorkloadDeps,
  ) {}

  get state(): WorkloadPhase {
    const p = this.deps.get(this.id)
    if (!p) return 'missing'
    switch (p.state) {
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
        return 'paused'
      default:
        return 'working'
    }
  }

  async start(): Promise<void> {
    const p = this.deps.get(this.id)
    if (p?.state === 'DRAFT') await this.deps.host.start(this.id)
    else if (p?.state === 'PAUSED' || p?.state === 'BLOCKED') await this.deps.host.resume(this.id)
  }

  async pause(): Promise<void> {
    if (this.isTerminal()) return
    const p = this.deps.get(this.id)
    if (p && p.state !== 'PAUSED' && p.state !== 'BLOCKED' && p.state !== 'DRAFT') await this.deps.host.pause(this.id)
    await this.deps.host.idle()
  }

  async resume(): Promise<void> {
    await this.deps.host.resume(this.id)
  }

  async cancel(): Promise<void> {
    await this.deps.host.cancel(this.id)
  }

  checkpoint(reason: string): boolean {
    return this.deps.host.checkpointNow(this.id, reason)
  }

  isTerminal(): boolean {
    const phase = this.state
    return phase === 'missing' || phase === 'completed' || phase === 'failed' || phase === 'cancelled'
  }

  getDeadlineState(): WorkloadDeadlineState {
    const p = this.deps.get(this.id)
    const phase = this.state
    const base = { phase, quotaResetsAt: phase === 'quota_wait' ? this.deps.quotaResetsAt() : null }
    if (!p) return { ...base, outcome: { reason: 'FAILED', detail: 'The program no longer exists.' } }
    if (p.state === 'COMPLETED') return { ...base, outcome: { reason: 'SUCCESS' } }
    if (p.state === 'FAILED') return { ...base, outcome: { reason: 'FAILED', ...(p.error ? { detail: p.error } : {}) } }
    if (p.state === 'CANCELLED') return { ...base, outcome: { reason: 'USER_CANCELLED' } }
    // Nobody is there overnight: a program that needs a person cannot go on until the morning.
    if (p.state === 'BLOCKED') return { ...base, outcome: { reason: 'BLOCKED', detail: p.blockedReason ?? 'The program is blocked.' } }
    if (p.state === 'PAUSED' && p.pauseReason !== 'work_window') return { ...base, outcome: { reason: 'BLOCKED', detail: p.pauseReason === 'approval' ? 'A plan is waiting for approval.' : `The program is paused (${p.pauseReason ?? 'user'}).` } }
    return { ...base, outcome: null }
  }

  async getFinalizationState(): Promise<ProgramDetail | null> {
    try {
      return this.deps.host.detail(this.id)
    } catch {
      return null
    }
  }

  projectRoot(): string | null {
    return null
  }

  extend(): void {}

  /** The program engine recovers its own programs at startup. */
  async recoverAfterRestart(): Promise<void> {}

  summarize(input: WorkloadSummaryInput): string {
    const { record, reason } = input
    const detail = (input.finalization as ProgramDetail | null) ?? this.deps.host.detail(this.id)
    const p = detail.program
    const completed = detail.roadmap.filter((m) => m.state === 'COMPLETED').length
    const out: string[] = []
    out.push('# NEXUS Overnight Program Window', '')
    out.push(`- Program ID: ${p.id}`)
    out.push(`- Program: ${oneLine(p.name, 120)}`)
    out.push(`- Window started: ${record.startedAt}`)
    out.push(`- Window ended: ${input.finishedAt}`)
    out.push(`- Window deadline: ${record.deadlineAt}`, '')
    out.push('## Outcome', '')
    out.push(`**${outcomeLabel(reason, completed, detail.roadmap.length)}** (terminal reason: ${reason}; program state: ${p.state}${p.pauseReason ? `, ${p.pauseReason}` : ''})`)
    if (input.detail) out.push('', `Detail: ${oneLine(input.detail, 600)}`)
    out.push('', 'A program is long-running: the end of a work window is not the end of the program. It continues in the next window or when resumed.', '')
    out.push('## Roadmap', '')
    for (const m of detail.roadmap) out.push(`- \`${m.key}\` [${m.state}] ${oneLine(m.title, 120)}${m.attempts > 0 ? ` (missions: ${m.attempts})` : ''}`)
    out.push('', `Missions so far: ${p.missions}. Plan version: ${p.planVersion}. Reassessments: ${p.replans}. Branch with the accepted work: ${p.branch ?? 'none'}.`, '')
    out.push('## Decisions in this window', '')
    const since = Date.parse(record.startedAt)
    const decisions = detail.decisions.filter((d) => Date.parse(d.createdAt) >= since).reverse()
    for (const d of decisions.slice(-40)) out.push(`- ${d.createdAt} ${d.kind}: ${oneLine(d.summary)}`)
    if (decisions.length === 0) out.push('- none')
    out.push('', `Open backlog items: ${detail.backlogOpen}. Memory entries: ${detail.memory.length}.`, '')
    out.push('## Usage limit', '')
    out.push(record.quota ? `- Waits for a usage limit: ${record.quota.waits}; last pause ${record.quota.pausedAt}; reset reported: ${record.quota.resetsAt ?? 'not reported'}` : '- No usage limit was met.', '')
    out.push('## Power action', '', input.powerPlan, '')
    return out.join('\n')
  }
}
