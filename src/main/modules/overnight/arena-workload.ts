import { outcomeLabel } from '@shared/overnight'
import type { ArenaCampaign, ArenaTrial } from '@shared/v3'
import type { Repositories } from '@main/modules/persistence'
import type { AutonomousWorkload, WorkloadDeadlineState, WorkloadPhase, WorkloadSummaryInput } from './workload'

/** The Arena calls a campaign workload needs. The ArenaService satisfies it. */
export interface ArenaCampaignHost {
  start(campaignId: string): Promise<unknown>
  /** No new trial starts and the trials in flight are stopped; the campaign stays resumable. */
  suspend(campaignId: string, detail: string): unknown
  resume(campaignId: string): unknown
  cancel(campaignId: string): unknown
  /** Resolves when no trial of the campaign is being worked on. */
  idleCampaign(campaignId: string): Promise<void>
}

export interface ArenaWorkloadDeps {
  repos: Repositories
  host: ArenaCampaignHost
  /** When the Claude usage limit resets (epoch ms), if the runtime said so. */
  quotaResetsAt: () => number | null
  now: () => number
  log: (line: string) => void
}

const checkpointKey = (campaignId: string): string => `overnight-arena-checkpoint:${campaignId}`
const iso = (ms: number): string => new Date(ms).toISOString()

/** Campaign names are user text and trial details can quote agent output: one line, as data. */
function oneLine(text: string | null | undefined, max = 200): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

function duration(fromIso: string, toIso: string): string {
  const minutes = Math.floor(Math.max(0, Date.parse(toIso) - Date.parse(fromIso)) / 60_000)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * An Arena campaign under the overnight supervisor. The campaign's own queue, quota pause and restart
 * recovery are the ArenaService's; this class only maps them to what the supervisor asks.
 */
export class ArenaCampaignWorkload implements AutonomousWorkload {
  readonly type = 'arena_campaign' as const

  constructor(
    readonly id: string,
    private readonly deps: ArenaWorkloadDeps,
  ) {}

  private campaign(): ArenaCampaign | null {
    return this.deps.repos.arenaCampaigns.get(this.id)
  }

  private counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const row of this.deps.repos.arenaTrials.countsByCampaign(this.id)) out[row.state] = row.n
    return out
  }

  get state(): WorkloadPhase {
    const c = this.campaign()
    if (!c) return 'missing'
    if (c.state === 'completed' || c.state === 'failed' || c.state === 'cancelled') return c.state
    if (c.state === 'paused') return c.pauseReason === 'quota' ? 'quota_wait' : 'paused'
    return 'working'
  }

  async start(): Promise<void> {
    await this.deps.host.start(this.id)
  }

  async pause(detail: string): Promise<void> {
    const c = this.campaign()
    if (!c || this.isTerminal()) return
    this.deps.host.suspend(this.id, detail)
    await this.deps.host.idleCampaign(this.id)
  }

  async resume(): Promise<void> {
    this.deps.host.resume(this.id)
  }

  async cancel(): Promise<void> {
    this.deps.host.cancel(this.id)
    await this.deps.host.idleCampaign(this.id)
  }

  /** Every campaign and trial state change is already durable; the checkpoint records where the campaign stood. */
  checkpoint(reason: string): boolean {
    try {
      const c = this.campaign()
      if (!c) return false
      this.deps.repos.settings.setValue(checkpointKey(this.id), { at: iso(this.deps.now()), reason, state: c.state, pauseReason: c.pauseReason, trials: this.counts() })
      return true
    } catch (e) {
      this.deps.log(`arena checkpoint ${this.id}: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  isTerminal(): boolean {
    const phase = this.state
    return phase === 'missing' || phase === 'completed' || phase === 'failed' || phase === 'cancelled'
  }

  getDeadlineState(): WorkloadDeadlineState {
    const c = this.campaign()
    const phase = this.state
    const base = { phase, quotaResetsAt: phase === 'quota_wait' ? this.deps.quotaResetsAt() : null }
    if (!c) return { ...base, outcome: { reason: 'FAILED', detail: 'The campaign no longer exists.' } }
    if (phase === 'cancelled') return { ...base, outcome: { reason: 'USER_CANCELLED' } }
    if (phase === 'failed') return { ...base, outcome: { reason: 'FAILED', ...(c.error ? { detail: c.error } : {}) } }
    if (phase === 'completed') {
      const counts = this.counts()
      const evaluated = (counts['passed'] ?? 0) + (counts['failed'] ?? 0)
      // A campaign that ran out of one of its own budgets ended early: a blocker, not a success.
      if (c.error) return { ...base, outcome: { reason: 'BLOCKED', detail: c.error } }
      if (evaluated === 0) {
        return { ...base, outcome: { reason: 'FAILED', detail: `No trial produced a result (${counts['blocked'] ?? 0} blocked, ${counts['cancelled'] ?? 0} cancelled).` } }
      }
      return { ...base, outcome: { reason: 'SUCCESS' } }
    }
    return { ...base, outcome: null }
  }

  async getFinalizationState(): Promise<{ trials: ArenaTrial[] }> {
    return { trials: this.deps.repos.arenaTrials.listByCampaign(this.id, { limit: 2000 }) }
  }

  projectRoot(): string | null {
    return null
  }

  /** The campaign's budget counts active time and is its own; the overnight deadline lives in the record. */
  extend(): void {}

  /** The ArenaService re-attaches the campaign's trials at startup; nothing more is needed here. */
  async recoverAfterRestart(): Promise<void> {}

  summarize(input: WorkloadSummaryInput): string {
    const { repos } = this.deps
    const { record, reason } = input
    const c = this.campaign()
    const trials = (input.finalization as { trials: ArenaTrial[] } | null)?.trials ?? repos.arenaTrials.listByCampaign(this.id, { limit: 2000 })
    const evaluated = trials.filter((t) => t.state === 'passed' || t.state === 'failed')
    const out: string[] = []
    out.push('# NEXUS Overnight Arena Campaign', '')
    out.push(`- Campaign ID: ${this.id}`)
    out.push(`- Campaign: ${c ? oneLine(c.name, 120) : 'missing'}`)
    out.push(`- Started: ${record.startedAt}`)
    out.push(`- Finished: ${input.finishedAt}`)
    out.push(`- Duration: ${duration(record.startedAt, input.finishedAt)}`)
    out.push(`- Overnight deadline: ${record.deadlineAt}`, '')

    out.push('## Outcome', '')
    out.push(`**${outcomeLabel(reason, evaluated.length, trials.length)}** (terminal reason: ${reason}; campaign state: ${c?.state ?? 'missing'}${c?.pauseReason ? `, ${c.pauseReason}` : ''})`)
    if (input.detail) out.push('', `Detail: ${oneLine(input.detail, 600)}`)
    out.push('')

    out.push('## Trials', '')
    const byState: Record<string, number> = {}
    for (const t of trials) byState[t.state] = (byState[t.state] ?? 0) + 1
    out.push(`${trials.length} trial(s); ${evaluated.length} evaluated. By state: ${JSON.stringify(byState)}`, '')
    if (c) {
      out.push('| Strategy | Passed | Failed | Blocked | Cancelled | Not finished |', '|---|---|---|---|---|---|')
      for (const strategy of c.strategies) {
        const own = trials.filter((t) => t.strategy === strategy)
        const n = (state: ArenaTrial['state']): number => own.filter((t) => t.state === state).length
        const open = own.filter((t) => t.state === 'queued' || t.state === 'provisioning' || t.state === 'running' || t.state === 'evaluating').length
        out.push(`| ${strategy} | ${n('passed')} | ${n('failed')} | ${n('blocked')} | ${n('cancelled')} | ${open} |`)
      }
      out.push('')
      out.push('Counts are what happened in this campaign. They are not a claim that one strategy is better; see the Arena page for evidence labels.', '')
    }
    const blocked = trials.filter((t) => t.state === 'blocked')
    if (blocked.length > 0) {
      out.push('### Blocked trials', '')
      for (const t of blocked.slice(0, 30)) out.push(`- ${t.caseId} / ${t.strategy} #${t.repetition} (${t.blockKind ?? 'unknown'}): ${oneLine(t.detail)}`)
      out.push('')
    }

    out.push('## Usage limit', '')
    if (record.quota) {
      out.push(`- Waits for a usage limit: ${record.quota.waits}`)
      out.push(`- Last pause: ${record.quota.pausedAt}; reset reported: ${record.quota.resetsAt ?? 'not reported'}`)
    } else out.push('- No usage limit was met.')
    out.push('')

    out.push('## Policy candidates', '')
    const since = Date.parse(record.startedAt)
    const candidates = repos.policyCandidates.listRecent(50).filter((p) => Date.parse(p.createdAt) >= since)
    if (candidates.length === 0) out.push('- none proposed')
    for (const p of candidates) out.push(`- ${p.contextKey}: ${p.fromStrategy} -> ${p.toStrategy} (${p.label}, ${p.arenaTrials} Arena trials, status ${p.status})`)
    out.push('', 'A candidate is a proposal. The active policy changes only when a person promotes it.', '')

    out.push('## Policy and authorization', '')
    out.push(`- End action: ${record.policy.endAction}; applies on ${Object.entries(record.policy.shutdownOn).filter(([, on]) => on).map(([k]) => k).join(', ') || 'nothing'}`)
    out.push(`- Authorized: ${record.authorization.authorizedAt}`)
    for (const a of record.amendments) out.push(`- Amended ${a.at} by ${a.by}: ${oneLine(a.change)}`)
    out.push('')

    out.push('## Power action', '', input.powerPlan, '')
    return out.join('\n')
  }
}
