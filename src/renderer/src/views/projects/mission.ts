import type { Preset, RunMode } from '@shared/domain'
import { ipcInputs, type IpcInput } from '@shared/ipc'
import type { PlanningMode, ReviewMode } from '@shared/v2'
import type { Strategy } from '@shared/v3'

export const MODE_INFO: Record<RunMode, string> = {
  ask: 'Answers a question with one read-only researcher task. No planner, worktree, review or verification; works outside Git.',
  build: 'Planner is told to make a small DAG of bounded tasks with tests. Then the normal pipeline: implement, review, verify.',
  swarm:
    'Planner is told to split the work as widely as file boundaries allow. Actual parallelism is still capped by the preset and file-overlap serialization.',
  repair: 'Planner is told to reproduce, diagnose, fix and add a regression test. Same pipeline as BUILD.',
  audit:
    'Read-only review: parallel reviewer tasks plus one synthesis task. Plans with writing roles are rejected, so nothing is modified. Works outside Git.',
  mission: 'Planner is told to decompose a large request into features with implementation and test tasks and a final integration check. Same pipeline as BUILD.',
  loop: 'Planner is told to write objectively checkable criteria. Max iterations below bounds the repair rounds, which every mode shares; there is no separate outer loop.',
}

export const PLANNING_MODE_INFO: Record<PlanningMode, string> = {
  single: 'One planner session produces the plan.',
  consensus:
    'Three planners with different lenses (risk-first, parallelism-first, minimal-change) plan independently, a critic reviews the plans and a synthesizer writes the final one. Uses more agent sessions.',
}

export const REVIEW_MODE_INFO: Record<ReviewMode, string> = {
  auto: 'Dual review for high-risk tasks, standard review otherwise.',
  standard: 'One reviewer checks each task.',
  dual: 'Two reviewers with different lenses run concurrently, findings are deduplicated, and an arbiter accepts or rejects each significant finding against the code. Only accepted findings can request changes.',
}

export const PRESET_INFO: Record<Preset, string> = {
  eco: 'At most 2 agents in parallel. Planner and verifier keep their configured model; other roles move one tier down and researchers use the fast tier.',
  balanced: 'Uses the role-to-model policy from Settings. Up to 4 agents in parallel (capped by the max-agents setting).',
  maximum: 'Raises parallelism only (the MAXIMUM agent cap in Settings). Same model policy as BALANCED.',
}

export const MAXIMUM_PRESET_WARNING =
  'MAXIMUM runs more agents at once with the same models as BALANCED, so it can use your Claude subscription usage limits much faster. A long mission may exhaust your limit for the current period.'

export const DIRTY_REPO_WARNING =
  'This repository has uncommitted changes. NEXUS works in separate worktrees created from the last commit, so uncommitted changes are not included in what agents see.'

export interface MissionDraft {
  projectId: string
  prompt: string
  mode: RunMode
  preset: Preset
  /** Null keeps the preset's own parallelism. */
  maxAgents: number | null
  requirePlanApproval: boolean
  maxIterations: number
  /** Omitted from the request when undefined (main applies its defaults). */
  planningMode?: PlanningMode
  reviewMode?: ReviewMode
  /** Sent as strategy when set; the composer leaves it unset for ask and audit. */
  strategy?: Strategy
  speculativeCandidates?: number
}

export function buildCreateRunInput(d: MissionDraft): IpcInput<'runs.create'> {
  const input: IpcInput<'runs.create'> = {
    projectId: d.projectId,
    mode: d.mode,
    preset: d.preset,
    prompt: d.prompt.trim(),
    requirePlanApproval: d.requirePlanApproval,
  }
  if (d.maxAgents !== null) input.maxParallelAgents = d.maxAgents
  if (d.planningMode !== undefined) input.planningMode = d.planningMode
  if (d.reviewMode !== undefined) input.reviewMode = d.reviewMode
  if (d.strategy !== undefined) input.strategy = d.strategy
  if (d.strategy === 'SPECULATIVE' && d.speculativeCandidates !== undefined) input.speculativeCandidates = d.speculativeCandidates
  if (d.mode === 'loop') input.maxIterations = d.maxIterations
  return input
}

/** Returns a human-readable problem, or null when the draft is acceptable to main. */
export function validateMission(d: MissionDraft): string | null {
  const parsed = ipcInputs['runs.create'].safeParse(buildCreateRunInput(d))
  if (parsed.success) return null
  const issue = parsed.error.issues[0]
  const field = issue?.path[0]
  switch (field) {
    case 'prompt':
      return d.prompt.trim().length === 0 ? 'Describe the mission first.' : 'The prompt is too long (limit 20,000 characters).'
    case 'maxParallelAgents':
      return 'Max agents must be a whole number from 1 to 16.'
    case 'maxIterations':
      return 'Max iterations must be a whole number from 1 to 50.'
    default:
      return issue?.message ?? 'Invalid mission.'
  }
}
