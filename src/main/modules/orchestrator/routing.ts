import type { AgentPurpose, AgentRole, ModelTier, Run, Severity, Task } from '@shared/domain'
import { routeModel, aggregatePerformance, type RouteResult } from '@main/modules/routing'
import type { OrchestratorDeps } from './deps'

/** Purposes whose sessions carry the task's own attempt history and escalation. Gates and planning sessions do not. */
const TASK_WORK_PURPOSES: ReadonlySet<AgentPurpose> = new Set<AgentPurpose>(['implement', 'diagnose', 'research', 'audit', 'synthesis', 'ask'])

export interface RouteRequest {
  run: Run
  task: Task | null
  role: AgentRole
  purpose: AgentPurpose
  /** 1-based attempt about to start; defaults to the task's attempt for work sessions. */
  attempt?: number
  repairCycle?: number
  /** Severity of the review finding that caused a repair. */
  triggeringSeverity?: Severity | null
  tierOverride?: ModelTier | null
}

/**
 * The single place that turns "which agent, for which work" into a model. Every session goes through it:
 * role policy, risk, attempt, repair severity, escalation and measured performance are all inputs of the
 * pure router; the concrete model comes from settings only.
 */
export class ModelRoutingService {
  constructor(private readonly deps: Pick<OrchestratorDeps, 'repos'>) {}

  route(req: RouteRequest): RouteResult {
    const { repos } = this.deps
    const settings = repos.settings.get()
    const { run, task } = req
    const work = task !== null && TASK_WORK_PURPOSES.has(req.purpose)
    return routeModel({
      role: req.role,
      purpose: req.purpose,
      rolePolicy: run.config.modelPolicy,
      preset: run.preset,
      ...(task ? { complexity: task.complexity, risk: task.risk } : {}),
      attempt: req.attempt ?? (work ? task.attempt : 1),
      repairCycle: req.repairCycle ?? 0,
      triggeringSeverity: req.triggeringSeverity ?? null,
      tierOverride: req.tierOverride ?? (work ? task.modelTierOverride : null),
      stats: aggregatePerformance(repos.taskOutcomes.listByProject(run.projectId)),
      modelForTier: (tier) => settings.models.tiers[tier] || null,
      ...(work ? { category: task.kind } : {}),
    })
  }

  /**
   * The tier a repair attempt is escalated to, stored on the repair task so the escalation stays visible
   * and survives restarts. The first repair keeps the role's policy; later ones are promoted.
   */
  repairTier(run: Run, parent: Task, cycle: number, severity: Severity | null): ModelTier | null {
    if (cycle < 2) return null
    return this.route({ run, task: parent, role: 'debugger', purpose: 'diagnose', attempt: cycle, repairCycle: cycle, triggeringSeverity: severity, tierOverride: null }).resolvedTier
  }
}
