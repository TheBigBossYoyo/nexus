import type { AgentPurpose, PlannedTask, RunMode, Task, TaskKind } from '@shared/domain'

/** The kind a task gets from its role (planned tasks and tasks added by graph proposals alike). */
export function kindFor(mode: RunMode, task: Pick<PlannedTask, 'role' | 'dependencies'>): TaskKind {
  if (mode === 'audit') return task.dependencies.length > 0 ? 'synthesis' : 'audit'
  switch (task.role) {
    case 'worker':
      return 'implement'
    case 'debugger':
      return 'repair'
    case 'architect':
      return 'design'
    case 'reviewer':
    case 'security_reviewer':
    case 'verifier':
      return 'audit'
    case 'planner':
    case 'researcher':
      return 'research'
  }
}

/** The purpose of the session that works on a task. */
export function purposeFor(task: Pick<Task, 'role' | 'kind'>): AgentPurpose {
  if (task.kind === 'ask') return 'ask'
  if (task.kind === 'synthesis') return 'synthesis'
  switch (task.role) {
    case 'worker':
      return 'implement'
    case 'debugger':
      return 'diagnose'
    case 'reviewer':
    case 'security_reviewer':
      return 'audit'
    case 'verifier':
      return 'verify'
    case 'planner':
    case 'architect':
    case 'researcher':
      return 'research'
  }
}
