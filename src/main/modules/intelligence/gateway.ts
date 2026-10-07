import { randomUUID } from 'node:crypto'
import type { DirectorInvocation, IntelligenceContext } from '@shared/intelligence'
import type { IntelligenceStore } from '../persistence/repositories/intelligence'
import type { AdvisoryProvider } from './compiler'
import { conveneCouncil, requestDirectorMemo } from './director'
import { CapacityWaitError } from '../capacity/registry'
import { PlanInferenceError } from './openai'

/** Explicit advisory requests only. No scheduler, execution authority or hidden provider fallback. */
export class DirectorGateway {
  private active = new Set<string>()
  constructor(private readonly store: IntelligenceStore) {}
  async invoke(input: {
    projectId: string
    objective: string
    level: DirectorInvocation['level']
    reasons: string[]
    context: IntelligenceContext[]
    strategic?: AdvisoryProvider
    technical?: AdvisoryProvider
    provider: string | null
    model: string | null
  }): Promise<DirectorInvocation> {
    if (!input.objective.trim() || input.objective.length > 32000)
      throw new Error('Director objective must contain 1–32000 characters')
    if (this.active.has(input.projectId))
      throw new Error('A Director request is already in progress for this project')
    this.active.add(input.projectId)
    try {
      const intentId = this.store.saveIntent(input.projectId, input.objective)
      const now = new Date().toISOString()
      const invocation: DirectorInvocation = {
        id: randomUUID(),
        projectId: input.projectId,
        objective: input.objective,
        level: input.level,
        reasons: input.reasons,
        state: 'PENDING',
        dependencies: input.context.map(({ id, version }) => ({ id, version })),
        provider: input.provider,
        model: input.model,
        memo: null,
        challenge: null,
        synthesis: null,
        unresolvedDisagreements: [],
        message: null,
        executionAuthorized: false,
        createdAt: now,
        updatedAt: now,
      }
      const save = () => {
        invocation.updatedAt = new Date().toISOString()
        this.store.saveDirector(invocation, intentId)
      }
      save() // Durable admission precedes any external work.
      const missing =
        input.level === 1
          ? !input.technical
          : input.level === 2
            ? !input.strategic
            : input.level === 3
              ? !input.strategic || !input.technical
              : false
      if (missing) {
        invocation.state = 'WAITING_FOR_PROVIDER'
        invocation.message =
          input.level === 1 || input.level === 3
            ? 'Technical Director integration and council validation are deferred in this build. No Claude call was made. This request will not resume automatically; retry after the required capability is enabled.'
            : 'Connect ChatGPT, select a model and confirm usage settings in Providers.'
      } else {
        try {
          if (input.level === 3) {
            const result = await conveneCouncil({
              objective: input.objective,
              context: input.context,
              strategic: input.strategic!,
              technical: input.technical!,
              onArtifact: (artifact) => {
                if (artifact.stage === 'STRATEGIC_MEMO') invocation.memo = artifact.memo
                else if (artifact.stage === 'TECHNICAL_CHALLENGE') {
                  invocation.challenge = artifact.challenge
                  invocation.unresolvedDisagreements = [
                    ...artifact.challenge.disagreements,
                    ...artifact.challenge.missingEvidence,
                  ]
                } else invocation.synthesis = artifact.synthesis
                save() // Each validated stage is durable before the next provider request.
              },
            })
            invocation.memo = result.memo
            invocation.challenge = result.challenge
            invocation.synthesis = result.synthesis
            invocation.unresolvedDisagreements = [
              ...result.challenge.disagreements,
              ...result.challenge.missingEvidence,
            ]
          } else if (input.level > 0) {
            invocation.memo = await requestDirectorMemo({
              objective: input.objective,
              context: input.context,
              provider: input.level === 1 ? input.technical! : input.strategic!,
            })
          }
          invocation.state = 'COMPLETED'
          invocation.message =
            input.level === 0
              ? 'No Director requested. No model call was made.'
              : 'Advisory material only. Execution requires the normal task and policy gates.'
        } catch (error) {
          invocation.state =
            error instanceof CapacityWaitError || error instanceof PlanInferenceError
              ? 'WAITING_FOR_PROVIDER'
              : 'FAILED'
          invocation.message =
            error instanceof CapacityWaitError
              ? error.message
              : error instanceof PlanInferenceError
                ? `Provider reported ${error.state.toLowerCase().replaceAll('_', ' ')}. Original objective is saved. A later explicit request may probe after backoff; no automatic retry was sent.`
                : 'Director request failed. Original intent is saved. Inspect the provider connection and retry explicitly; no automatic duplicate request was sent.'
        }
      }
      save()
      return invocation
    } finally {
      this.active.delete(input.projectId)
    }
  }
}
