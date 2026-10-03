import type { MissionPlan, PlannedTask, Task, TaskDependency } from '@shared/domain'

let counter = 0

export function makeTask(key: string, overrides: Partial<Task> = {}): Task {
  counter++
  return {
    id: key,
    runId: 'run-1',
    key,
    title: key,
    description: key,
    role: 'worker',
    kind: 'implement',
    state: 'ready',
    priority: 0,
    complexity: 'small',
    risk: 'low',
    parallelizable: true,
    requiresApproval: false,
    approvalGranted: false,
    suggestedFiles: [],
    acceptanceCriteria: ['works'],
    attempt: 0,
    repairCycles: 0,
    parentTaskId: null,
    modelTierOverride: null,
    branch: null,
    worktreeId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    resultSummary: null,
    blockedReason: null,
    error: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

/** dep('b', 'a') means b depends on a. */
export const dep = (taskId: string, dependsOnTaskId: string): TaskDependency => ({
  taskId,
  dependsOnTaskId,
})

export function plannedTask(id: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id,
    title: id,
    description: id,
    role: 'worker',
    dependencies: [],
    parallelizable: true,
    suggestedFiles: [],
    acceptanceCriteria: ['works'],
    complexity: 'small',
    risk: 'low',
    requiresApproval: false,
    ...overrides,
  }
}

export function makePlan(tasks: PlannedTask[], overrides: Partial<MissionPlan> = {}): MissionPlan {
  return {
    summary: 'plan',
    assumptions: [],
    acceptanceCriteria: ['mission done'],
    tasks,
    risks: [],
    ...overrides,
  }
}
