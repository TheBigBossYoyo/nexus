import type { EventBus } from '@main/modules/events'
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
