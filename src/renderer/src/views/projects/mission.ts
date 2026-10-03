import type { Preset, RunMode } from '@shared/domain'
import { ipcInputs, type IpcInput } from '@shared/ipc'

export const MODE_INFO: Record<RunMode, string> = {
  ask: 'Answer a question about the codebase. Read-only; nothing is modified.',
  build: 'Plan a change, implement it in isolated worktrees, then review and verify.',
  swarm: 'Split a large change into many parallel tasks with dependency-aware scheduling.',
  repair: 'Diagnose and fix a failing build, test or bug, repairing until checks pass.',
  audit: 'Review the repository for correctness, security and architecture issues. Read-only.',
  mission: 'Pursue a broad objective end to end: design, implement, review and verify.',
  loop: 'Repeat implement, check and repair until the goal is met or the iteration limit is hit.',
}

export const PRESET_INFO: Record<Preset, string> = {
  eco: 'Cheaper models for most roles and at most 2 agents in parallel.',
  balanced: 'Strongest models for planning, review and verification; balanced models for implementation.',
  maximum: 'Most parallel agents on the strongest models.',
}

export const MAXIMUM_PRESET_WARNING =
  'MAXIMUM runs many agents on the strongest models at once and can consume your Claude subscription usage limits quickly. A long mission may exhaust your limit for the current period.'

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
