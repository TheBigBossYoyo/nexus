import type { ZodType } from 'zod'
import type { MemoryEntry, MissionPlan, ProjectProfile, Run } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { PlanCritiqueOutputSchema, type PlanCritiqueOutput, type PlanningCandidate } from '@shared/v2'
import {
  buildCriticPrompt,
  buildPlannerPrompt,
  buildSynthesizerPrompt,
  missionPlanJsonSchema,
  planCritiqueJsonSchema,
  type CandidatePlan,
} from '@main/modules/context/context-builder'
import { selectFactsForTask } from '@main/modules/intelligence'
import { PLANNER_LENSES } from '@main/modules/planning'
import type { AgentRunResult, SessionControl } from './agent-runner'
import { graphContextForRequest } from './context-graph'
import type { Core } from './core'

/** Same contract as the single planner's validation: schema, plan rules and mode rules. */
export type PlanValidator = (run: Run, output: unknown, agentError: string | null) => { plan?: MissionPlan; errors: string[] }

export type ConsensusResult =
  /** The plan to materialize: a synthesis, or the only valid candidate. */
  | { status: 'plan'; plan: MissionPlan }
  /** Paused, cancelled, quota or auth: the caller does nothing; a resume plans again. */
  | { status: 'halt' }
  /** No candidate was valid: the caller runs the single-planner loop with these errors. */
  | { status: 'fallback'; errors: string[] }

export interface ConsensusInput {
  run: Run
  profile: ProjectProfile
  projectRoot: string
  control: SessionControl
  memory: MemoryEntry[]
  feedback?: string
  previousPlan?: MissionPlan
  validate: PlanValidator
  /** Attempts the synthesis gets to produce a valid plan (an invalid one is fed back with its errors). */
  maxSynthesisAttempts: number
}

type Structured<T> = { status: 'ok'; value: T; agentId: string } | { status: 'halt' } | { status: 'failed'; error: string }

/**
 * Consensus planning: independent planners with different lenses, then a critic and a synthesizer when at
 * least two candidates are valid. Every session goes through the normal agent runner, so routing, usage,
 * pause and quota behave exactly as for the single planner.
 */
export class ConsensusPlanner {
  constructor(private readonly core: Core) {}

  async run(input: ConsensusInput): Promise<ConsensusResult> {
    const { repos, bus } = this.core.deps
    const { run, control } = input

    // A new round (replan, or a rerun after a halt) replaces the previous round's records.
    for (const old of repos.planningCandidates.listByRun(run.id)) repos.planningCandidates.delete(old.id)
    for (const old of repos.planningCritiques.listByRun(run.id)) repos.planningCritiques.delete(old.id)

    const candidates = await this.runCandidates(input)
    if (candidates === 'halt') return { status: 'halt' }
    const valid = candidates.filter((c) => c.valid && c.plan !== null)
    const total = candidates.length

    if (valid.length === 0) {
      return { status: 'fallback', errors: candidates.flatMap((c) => c.errors.map((e) => `${c.label}: ${e}`)) }
    }
    const plans: CandidatePlan[] = valid.map((c) => ({ label: c.label, plan: c.plan as MissionPlan }))
    if (valid.length === 1) {
      bus.emit({ runId: run.id, type: 'planning.synthesized', payload: { candidates: total, validCandidates: 1 } })
      return { status: 'plan', plan: (valid[0] as PlanningCandidate).plan as MissionPlan }
    }

    // The critic sees the structured plans and the project profile only.
    const critic = await this.structured(input, {
      label: 'Plan critic',
      role: 'reviewer',
      purpose: 'critique',
      prompt: buildCriticPrompt({ run, profile: input.profile, candidates: plans }).prompt,
      schema: PlanCritiqueOutputSchema,
      jsonSchema: planCritiqueJsonSchema,
    })
    if (critic.status === 'halt') return { status: 'halt' }
    let critique: PlanCritiqueOutput | null = null
    if (critic.status === 'ok') {
      critique = critic.value
      const row = repos.planningCritiques.insert({ id: newId(), runId: run.id, agentId: critic.agentId, output: critic.value, createdAt: nowIso() })
      bus.emit({
        runId: run.id,
        agentId: critic.agentId,
        type: 'planning.critique',
        payload: { critiqueId: row.id, findings: critic.value.findings.length, preferred: critic.value.preferredCandidate },
      })
    }
    // Without a critique the synthesis still runs and says so in its prompt; the run never stalls on the critic.
    const preferred = plans.find((p) => p.label.toLowerCase() === critique?.preferredCandidate.trim().toLowerCase()) ?? plans[0]

    const facts = selectFactsForTask(
      repos.facts.listByProject(run.projectId),
      {
        title: run.prompt.slice(0, 200),
        description: run.prompt,
        suggestedFiles: [...new Set(plans.flatMap((p) => p.plan.tasks.flatMap((t) => t.suggestedFiles)))],
      },
      10,
    ).map((s) => s.fact)

    let previousErrors: string[] | undefined
    for (let attempt = 1; attempt <= input.maxSynthesisAttempts; attempt++) {
      const result = await this.core.agents.run({
        run,
        task: null,
        role: 'planner',
        purpose: 'synthesize',
        label: 'Plan synthesizer',
        cwd: input.projectRoot,
        worktreeRoot: input.projectRoot,
        projectRoot: input.projectRoot,
        prompt: buildSynthesizerPrompt({ run, profile: input.profile, candidates: plans, critique, facts, ...(previousErrors ? { previousErrors } : {}) }).prompt,
        outputSchema: missionPlanJsonSchema,
        control,
      })
      if (this.halted(input, result)) return { status: 'halt' }
      const checked = input.validate(run, result.outcome === 'success' ? result.structuredOutput : undefined, result.error)
      if (checked.plan) {
        bus.emit({ runId: run.id, type: 'planning.synthesized', payload: { candidates: total, validCandidates: valid.length } })
        return { status: 'plan', plan: checked.plan }
      }
      previousErrors = checked.errors
      bus.emit({ runId: run.id, type: 'plan.invalid', payload: { errors: checked.errors, attempt } })
    }
    // The synthesis never became valid: the preferred candidate is, so the mission goes on with that instead of failing.
    bus.emit({ runId: run.id, type: 'planning.synthesized', payload: { candidates: total, validCandidates: valid.length } })
    return { status: 'plan', plan: (preferred as CandidatePlan).plan }
  }

  /** Quota and auth pause the run; a stop, pause or cancel while the session ran means the caller must do nothing. */
  private halted(input: ConsensusInput, result: AgentRunResult): boolean {
    const { repos } = this.core.deps
    const runId = input.run.id
    if (input.control.stopReason || repos.runs.require(runId).state !== 'planning') return true
    if (result.outcome === 'quota') {
      this.core.pauseRun(runId, 'quota', 'Claude usage limit reached')
      return true
    }
    if (result.outcome === 'auth') {
      this.core.pauseRun(runId, 'user', 'Claude authentication required', 'auth')
      return true
    }
    return false
  }

  /** The independent planners, concurrently. Each gets the normal planner prompt plus only its own lens. */
  private async runCandidates(input: ConsensusInput): Promise<PlanningCandidate[] | 'halt'> {
    const { repos, bus } = this.core.deps
    const { run, control } = input
    // Retrieved once: every lens plans from the same project knowledge.
    const knowledge = graphContextForRequest(this.core, run, new Set(input.memory.map((m) => m.id)))
    const sessions = await Promise.all(
      PLANNER_LENSES.map(async (lens) => {
        const started = Date.now()
        const result = await this.core.agents.run({
          run,
          task: null,
          role: 'planner',
          purpose: 'plan',
          label: lens.label,
          cwd: input.projectRoot,
          worktreeRoot: input.projectRoot,
          projectRoot: input.projectRoot,
          prompt: buildPlannerPrompt({
            run,
            profile: input.profile,
            memory: input.memory,
            knowledge,
            ...(input.feedback ? { feedback: input.feedback } : {}),
            ...(input.previousPlan ? { previousPlan: input.previousPlan } : {}),
            lens: { label: lens.label, guidance: lens.guidance },
          }).prompt,
          outputSchema: missionPlanJsonSchema,
          control,
        })
        return { lens, result, durationMs: Date.now() - started }
      }),
    )

    // A session that was stopped or hit a limit produced nothing; the others are real results and are kept.
    const candidates: PlanningCandidate[] = []
    for (const { lens, result, durationMs } of sessions) {
      if (result.outcome === 'stopped' || result.outcome === 'quota' || result.outcome === 'auth') continue
      const checked = input.validate(run, result.outcome === 'success' ? result.structuredOutput : undefined, result.error)
      const agent = repos.agents.require(result.agentId)
      const row = repos.planningCandidates.insert({
        id: newId(),
        runId: run.id,
        label: lens.label,
        lens: lens.lens,
        agentId: result.agentId,
        plan: checked.plan ?? null,
        valid: checked.plan !== undefined,
        errors: checked.errors,
        durationMs,
        model: agent.model,
        costUsd: agent.metrics.costUsd,
        createdAt: nowIso(),
      })
      bus.emit({ runId: run.id, agentId: result.agentId, type: 'planning.candidate', payload: { candidateId: row.id, label: row.label, valid: row.valid } })
      candidates.push(row)
    }
    for (const { result } of sessions) if (this.halted(input, result)) return 'halt'
    return candidates
  }

  /** A read-only structured session with one retry, like the review and verification gates. */
  private async structured<T>(
    input: ConsensusInput,
    spec: {
      label: string
      role: 'reviewer'
      purpose: 'critique'
      prompt: string
      schema: ZodType<T>
      jsonSchema: Record<string, unknown>
    },
  ): Promise<Structured<T>> {
    let error = 'unknown'
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.core.agents.run({
        run: input.run,
        task: null,
        role: spec.role,
        purpose: spec.purpose,
        label: spec.label,
        cwd: input.projectRoot,
        worktreeRoot: input.projectRoot,
        projectRoot: input.projectRoot,
        prompt: spec.prompt,
        outputSchema: spec.jsonSchema,
        control: input.control,
      })
      if (this.halted(input, result)) return { status: 'halt' }
      if (result.outcome === 'success') {
        const parsed = spec.schema.safeParse(result.structuredOutput)
        if (parsed.success) return { status: 'ok', value: parsed.data, agentId: result.agentId }
        error = `invalid structured output: ${parsed.error.message}`
      } else {
        error = result.error ?? result.outcome
      }
    }
    return { status: 'failed', error }
  }
}
