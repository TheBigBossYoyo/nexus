import type { NotificationKind } from '@shared/control-plane'
import type { PushMessage, RunEvent } from '@shared/events'

/**
 * The events outside the queue that are worth one native notification: a program milestone completed, an
 * Arena campaign that found a regression, an overnight run that ended, and a tool call the execution policy
 * refused. This module only notices them; whether a notification is shown is decided by the control plane's
 * restraint rules (one per subject in ten minutes, four in a quarter of an hour), so a burst of refusals is
 * one notification.
 */
export interface NotifierDeps {
  announce: (kind: NotificationKind, subject: string, title: string, body: string) => void
  milestones: (programId: string) => { key: string; title: string; state: string }[]
  programName: (programId: string) => string | null
  campaign: (campaignId: string) => { name: string; state: string } | null
  regressions: (campaignId: string) => number
}

export interface SecurityDecisionNotice {
  runId: string | null
  decision: string
  action: string
  reason: string
}

export class RuntimeNotifier {
  private readonly completed = new Map<string, Set<string>>()
  private readonly campaignsDone = new Set<string>()

  constructor(private readonly deps: NotifierDeps) {}

  /** Milestones that were complete before this start of the runtime are not news. */
  prime(programIds: readonly string[], campaignIds: readonly string[]): void {
    for (const id of programIds) this.completed.set(id, new Set(this.deps.milestones(id).filter((m) => m.state === 'COMPLETED').map((m) => m.key)))
    for (const id of campaignIds) this.campaignsDone.add(id)
  }

  onPush(message: PushMessage): void {
    if (message.kind === 'program') this.program(message.programId)
    else if (message.kind === 'arena') this.arena(message.campaignId)
  }

  onEvent(event: RunEvent): void {
    // The report is written when an overnight run has ended, however it ended.
    if (event.type === 'overnight.report') this.deps.announce('overnight_completed', event.runId, 'Overnight run finished', 'Its report is saved. Open NEXUS to read it.')
  }

  onSecurityDecision(entry: SecurityDecisionNotice): void {
    if (entry.decision !== 'DENY') return
    // One subject per run: repeated refusals in one run are one notification within the quiet period.
    this.deps.announce('security_high', entry.runId ?? 'no-run', 'A tool call was blocked', `${entry.reason} The Control Center lists what was blocked and why.`)
  }

  private program(programId: string): void {
    const known = this.completed.get(programId)
    const now = this.deps.milestones(programId).filter((m) => m.state === 'COMPLETED')
    if (!known) {
      // First sight of this program in this start: only what completes from here on is announced.
      this.completed.set(programId, new Set(now.map((m) => m.key)))
      if (now.length === 0) return
    }
    const seen = known ?? new Set<string>()
    const fresh = now.filter((m) => !seen.has(m.key))
    for (const m of fresh) seen.add(m.key)
    this.completed.set(programId, seen)
    if (!known || fresh.length === 0) return
    const name = this.deps.programName(programId) ?? 'Program'
    const first = fresh[0] as { title: string }
    this.deps.announce('milestone_completed', programId, 'Milestone completed', fresh.length === 1 ? `${name}: ${first.title}` : `${name}: ${fresh.length} milestones, the first "${first.title}"`)
  }

  private arena(campaignId: string): void {
    if (this.campaignsDone.has(campaignId)) return
    const campaign = this.deps.campaign(campaignId)
    if (!campaign || campaign.state !== 'completed') return
    this.campaignsDone.add(campaignId)
    const regressions = this.deps.regressions(campaignId)
    if (regressions > 0) this.deps.announce('arena_regression', campaignId, 'Arena found a regression', `${campaign.name}: ${regressions} group${regressions === 1 ? '' : 's'} did worse than before.`)
  }
}
