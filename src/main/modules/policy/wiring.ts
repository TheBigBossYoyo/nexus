import type { PushMessage } from '@shared/events'
import type { EventBus } from '@main/modules/events'
import type { Repositories } from '@main/modules/persistence'
import type { PolicyService } from './service'

/**
 * Records a mission outcome whenever a run reaches an end the policy can learn from: completed, failed,
 * cancelled, or paused because nothing can make progress. The recording reads durable rows only, so it
 * runs after the event is committed, and it never throws into the orchestrator. Returns an unsubscribe.
 */
export function attachOutcomeRecording(bus: EventBus, policy: Pick<PolicyService, 'recordOutcome'>): () => void {
  return bus.subscribe((event) => {
    const ended =
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled' ||
      (event.type === 'run.paused' && 'cause' in event.payload && event.payload.cause === 'intervention')
    if (!ended) return
    const outcome = policy.recordOutcome(event.runId)
    if (!outcome) return
    bus.emit({
      runId: event.runId,
      type: 'outcome.recorded',
      payload: { outcomeId: outcome.id, strategy: outcome.strategy, success: outcome.success },
    })
  })
}

/**
 * Wraps the Arena's push so that a campaign reaching its end refreshes the evidence statistics and lets the
 * learning step propose candidates. This is what makes an unattended campaign leave a policy candidate
 * behind for the user to judge. It proposes only: the active policy is never changed here.
 */
export function learnOnCampaignEnd(
  repos: Pick<Repositories, 'arenaCampaigns'>,
  policy: Pick<PolicyService, 'learn'>,
  push: (message: PushMessage) => void,
  logger?: (line: string) => void,
): (message: PushMessage) => void {
  const learned = new Set<string>()
  return (message) => {
    push(message)
    if (message.kind !== 'arena' || learned.has(message.campaignId)) return
    const campaign = repos.arenaCampaigns.get(message.campaignId)
    if (campaign?.state !== 'completed') return
    learned.add(message.campaignId)
    try {
      const result = policy.learn()
      logger?.(`arena campaign ${campaign.name} completed: ${result.statistics} evidence rows, ${result.candidates.length} policy candidate(s)`)
    } catch (e) {
      logger?.(`learning after campaign ${campaign.name} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
