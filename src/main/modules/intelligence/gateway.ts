import { randomUUID } from 'node:crypto'
import type {
  DirectorInvocation,
  DirectorDecision,
  DirectorOutcome,
  StrategicEscalation,
  IntelligenceContext,
} from '@shared/intelligence'
import type { IntelligenceStore } from '../persistence/repositories/intelligence'
import type { AdvisoryProvider } from './compiler'
import { conveneCouncil, requestDirectorMemo } from './director'
import { CapacityWaitError } from '../capacity/registry'
import { PlanInferenceError } from './openai'
import { CapacityRoutingWaitError } from '../capacity/router'
import type { AdvisoryRoutingService } from './routing'
import { ChatGPTBusyError } from './connection'

/** Explicit advisory requests only. No scheduler, execution authority or hidden provider fallback. */
export class DirectorGateway {
  private active = new Set<string>()
  constructor(
    private readonly store: IntelligenceStore,
    private readonly routing?: AdvisoryRoutingService,
  ) {}
  escalate(
    input: Pick<
      StrategicEscalation,
      'projectId' | 'objective' | 'reasons' | 'level' | 'runId' | 'taskId'
    >,
  ): StrategicEscalation {
    if (
      !input.objective.trim() ||
      input.objective.length > 32000 ||
      input.reasons.length > 10 ||
      input.reasons.some((r) => r.length > 4000)
    )
      throw new Error('Escalation exceeds the bounded request contract')
    const now = new Date().toISOString()
    const record: StrategicEscalation = {
      ...input,
      id: randomUUID(),
      invocationId: null,
      kind: 'ESCALATION',
      state: 'REQUESTED',
      executionAuthorized: false,
      createdAt: now,
      updatedAt: now,
    }
    this.store.saveDirectorRecord(record)
    return record // Recording an escalation never sends a provider request.
  }
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
    escalationId?: string
  }): Promise<DirectorInvocation> {
    if (!input.objective.trim() || input.objective.length > 32000)
      throw new Error('Director objective must contain 1–32000 characters')
    if (this.active.has(input.projectId))
      throw new Error('A Director request is already in progress for this project')
    this.active.add(input.projectId)
    try {
      const intentId = this.store.saveIntent(input.projectId, input.objective)
      const escalation = input.escalationId
        ? this.store.directorRecord(input.projectId, input.escalationId)
        : null
      if (
        input.escalationId &&
        (!escalation ||
          escalation.kind !== 'ESCALATION' ||
          escalation.state !== 'REQUESTED' ||
          escalation.objective !== input.objective ||
          escalation.level !== input.level)
      )
        throw new Error(
          'Escalation is not an unclaimed matching request. Retry requires a new explicit request.',
        )
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
        decisionId: null,
        outcomeId: null,
        escalationId: input.escalationId ?? null,
      }
      const save = () => {
        invocation.updatedAt = new Date().toISOString()
        this.store.saveDirector(invocation, intentId)
      }
      this.store.atomic(() => {
        save() // Durable admission precedes any external work.
        if (escalation?.kind === 'ESCALATION')
          this.store.saveDirectorRecord({
            ...escalation,
            invocationId: invocation.id,
            state: 'INVOKING',
            updatedAt: now,
          })
      })
      let providers: { strategic?: AdvisoryProvider; technical?: AdvisoryProvider } = {
        strategic: input.strategic,
        technical: input.technical,
      }
      let routingFailed = false
      if (input.level > 0 && this.routing) {
        try {
          providers = await this.routing.providers(input.projectId, invocation.id, 'DIRECTOR')
        } catch {
          routingFailed = true
          invocation.state = 'FAILED'
          invocation.message =
            'Provider admission could not be established. No Director call was sent.'
        }
      }
      const missing =
        input.level === 1
          ? !providers.technical
          : input.level === 2
            ? !providers.strategic
            : input.level === 3
              ? !providers.strategic || !providers.technical
              : false
      if (!routingFailed && missing) {
        invocation.state = 'WAITING_FOR_PROVIDER'
        invocation.message =
          input.level === 1 || input.level === 3
            ? 'Required technical capacity and quality admission are unavailable. No Council stage was sent. Retry explicitly after the required capability is admitted.'
            : 'Connect ChatGPT, select a model and confirm usage settings in Providers.'
      } else if (!routingFailed) {
        try {
          if (input.level === 3) {
            const result = await conveneCouncil({
              objective: input.objective,
              context: input.context,
              strategic: providers.strategic!,
              technical: providers.technical!,
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
              provider: input.level === 1 ? providers.technical! : providers.strategic!,
            })
          }
          invocation.state = 'COMPLETED'
          invocation.message =
            input.level === 0
              ? 'No Director requested. No model call was made.'
              : 'Advisory material only. Execution requires the normal task and policy gates.'
        } catch (error) {
          invocation.state =
            error instanceof CapacityWaitError ||
            error instanceof ChatGPTBusyError ||
            error instanceof CapacityRoutingWaitError ||
            error instanceof PlanInferenceError
              ? 'WAITING_FOR_PROVIDER'
              : 'FAILED'
          invocation.message =
            error instanceof CapacityWaitError ||
            error instanceof CapacityRoutingWaitError ||
            error instanceof ChatGPTBusyError
              ? error.message
              : error instanceof PlanInferenceError
                ? `Provider reported ${error.state.toLowerCase().replaceAll('_', ' ')}. Original objective is saved. A later explicit request may probe after backoff; no automatic retry was sent.`
                : 'Director request failed. Original intent is saved. Inspect the provider connection and retry explicitly; no automatic duplicate request was sent.'
        }
      }
      if (invocation.state === 'PENDING')
        throw new Error('Director request did not reach a terminal advisory state')
      const recommendation = invocation.synthesis?.decision ?? invocation.memo?.recommendation
      const decision: DirectorDecision | null =
        invocation.state === 'COMPLETED' && recommendation
          ? {
              id: randomUUID(),
              invocationId: invocation.id,
              projectId: input.projectId,
              kind: 'DECISION',
              recommendation,
              unresolvedDisagreements: [...invocation.unresolvedDisagreements],
              evidenceRefs: invocation.synthesis?.evidenceRefs ?? invocation.memo!.evidenceRefs,
              executionAuthorized: false,
              createdAt: new Date().toISOString(),
            }
          : null
      const routes = this.store.routingHistory(input.projectId, invocation.id)
      const calls = routes.filter((r) => !r.stage.endsWith(':ADMISSION'))
      const outcome: DirectorOutcome = {
        id: randomUUID(),
        invocationId: invocation.id,
        projectId: input.projectId,
        kind: 'OUTCOME',
        state: invocation.state,
        completedStages: [
          ...(invocation.memo ? ['MEMO' as const] : []),
          ...(invocation.challenge ? ['CHALLENGE' as const] : []),
          ...(invocation.synthesis ? ['SYNTHESIS' as const] : []),
        ],
        routingIds: routes.map((r) => r.id),
        consumption:
          input.level === 0 || missing || routingFailed
            ? 'NONE'
            : calls.length && calls.every((r) => r.consumption === 'PROVIDER_REPORTED')
              ? 'RECORDED_BY_PROVIDER_ADAPTER'
              : 'UNKNOWN',
        replayAllowed: false,
        executionAuthorized: false,
        createdAt: new Date().toISOString(),
      }
      invocation.decisionId = decision?.id ?? null
      invocation.outcomeId = outcome.id
      // Per-stage routing is authoritative when the production capacity layer is present.
      if (this.routing) {
        invocation.provider = null
        invocation.model = null
      }
      this.store.atomic(() => {
        save()
        if (decision) this.store.saveDirectorRecord(decision)
        this.store.saveDirectorRecord(outcome)
        if (escalation?.kind === 'ESCALATION')
          this.store.saveDirectorRecord({
            ...escalation,
            invocationId: invocation.id,
            state: outcome.state,
            updatedAt: invocation.updatedAt,
          })
      })
      return invocation
    } finally {
      this.active.delete(input.projectId)
    }
  }
}
