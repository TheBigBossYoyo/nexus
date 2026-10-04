import type { Preset, RunConfig, RunMode } from '@shared/domain'
import { presetMaxAgents, type Settings } from '@shared/settings'
import {
  DEFAULT_SPECULATIVE_CANDIDATES,
  MAX_SPECULATIVE_CANDIDATES,
  type ConcreteStrategy,
} from '@shared/v3'

/**
 * A strategy is configuration of the one orchestration engine. It decides how the run is planned, how
 * many agents work at once, how deep review goes and whether the implement stage is speculative. It
 * never schedules anything itself.
 */
export interface StrategyPlan {
  strategy: ConcreteStrategy
  /** Run mode handed to the engine (selects the planner guidance). */
  mode: RunMode
  /** none: no planner session; the mission becomes one worker task. */
  planning: 'none' | 'single' | 'consensus'
  reviewMode: 'standard' | 'dual' | 'auto'
  maxParallelAgents: number
  /** 0 unless the implement stage runs candidates. */
  speculativeCandidates: number
  /** Tier of the single worker when there is no planner. */
  singleWorkerTier: 'strongest' | 'balanced'
  summary: string
}

export interface StrategyInput {
  preset: Preset
  settings: Settings
  /** Requested candidate count for SPECULATIVE; clamped to the hard maximum. */
  candidates?: number
}

export interface OrchestrationStrategy {
  readonly id: ConcreteStrategy
  readonly label: string
  readonly description: string
  configure(input: StrategyInput): StrategyPlan
}

const clampCandidates = (n: number | undefined): number =>
  Math.min(MAX_SPECULATIVE_CANDIDATES, Math.max(2, Math.floor(n ?? DEFAULT_SPECULATIVE_CANDIDATES)))

export const SingleStrategy: OrchestrationStrategy = {
  id: 'SINGLE',
  label: 'Single',
  description: 'One strong agent implements the whole mission; checks, review and verification still apply.',
  configure: ({ preset }) => ({
    strategy: 'SINGLE',
    mode: 'build',
    planning: 'none',
    reviewMode: 'auto',
    maxParallelAgents: 1,
    speculativeCandidates: 0,
    singleWorkerTier: preset === 'eco' ? 'balanced' : 'strongest',
    summary: 'No planner; one worker task; one agent at a time',
  }),
}

export const BuildStrategy: OrchestrationStrategy = {
  id: 'BUILD',
  label: 'Build',
  description: 'A planner splits the mission into a small task graph executed by a few workers.',
  configure: ({ preset, settings }) => ({
    strategy: 'BUILD',
    mode: 'build',
    planning: 'single',
    reviewMode: 'auto',
    maxParallelAgents: presetMaxAgents(preset, settings),
    speculativeCandidates: 0,
    singleWorkerTier: 'strongest',
    summary: `Single planner; up to ${presetMaxAgents(preset, settings)} agents`,
  }),
}

export const SwarmStrategy: OrchestrationStrategy = {
  id: 'SWARM',
  label: 'Swarm',
  description: 'A planner decomposes the mission as widely as is safe and many workers run in parallel.',
  configure: ({ preset, settings }) => {
    // ECO stays at its cap; otherwise the swarm uses the maximum-preset parallelism.
    const agents = preset === 'eco' ? presetMaxAgents('eco', settings) : presetMaxAgents('maximum', settings)
    return {
      strategy: 'SWARM',
      mode: 'swarm',
      planning: 'single',
      reviewMode: 'auto',
      maxParallelAgents: agents,
      speculativeCandidates: 0,
      singleWorkerTier: 'strongest',
      summary: `Single planner, wide decomposition; up to ${agents} agents`,
    }
  },
}

export const ConsensusStrategy: OrchestrationStrategy = {
  id: 'CONSENSUS',
  label: 'Consensus',
  description: 'Three planners, a critic and a synthesizer produce the plan; every reviewed task gets two reviewers.',
  configure: ({ preset, settings }) => ({
    strategy: 'CONSENSUS',
    mode: 'build',
    planning: 'consensus',
    reviewMode: 'dual',
    maxParallelAgents: presetMaxAgents(preset, settings),
    speculativeCandidates: 0,
    singleWorkerTier: 'strongest',
    summary: `Consensus planning and dual review; up to ${presetMaxAgents(preset, settings)} agents`,
  }),
}

export const SpeculativeStrategy: OrchestrationStrategy = {
  id: 'SPECULATIVE',
  label: 'Speculative',
  description: 'Independent candidates implement the same task in separate worktrees; objective checks pick one.',
  configure: ({ preset, candidates }) => {
    const n = clampCandidates(candidates)
    return {
      strategy: 'SPECULATIVE',
      mode: 'build',
      planning: 'none',
      reviewMode: 'auto',
      maxParallelAgents: n,
      speculativeCandidates: n,
      singleWorkerTier: preset === 'eco' ? 'balanced' : 'strongest',
      summary: `No planner; ${n} independent candidates, then a tournament`,
    }
  },
}

export const STRATEGY_REGISTRY: Record<ConcreteStrategy, OrchestrationStrategy> = {
  SINGLE: SingleStrategy,
  BUILD: BuildStrategy,
  SWARM: SwarmStrategy,
  CONSENSUS: ConsensusStrategy,
  SPECULATIVE: SpeculativeStrategy,
}

export function configureStrategy(strategy: ConcreteStrategy, input: StrategyInput): StrategyPlan {
  return STRATEGY_REGISTRY[strategy].configure(input)
}

/** The RunConfig fields a plan sets. Explicit user overrides are applied after these by the caller. */
export function planOverrides(plan: StrategyPlan): Partial<RunConfig> {
  return {
    maxParallelAgents: plan.maxParallelAgents,
    planningMode: plan.planning === 'consensus' ? 'consensus' : 'single',
    reviewMode: plan.reviewMode,
  }
}
