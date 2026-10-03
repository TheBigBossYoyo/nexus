import { WRITING_ROLES } from '@shared/domain'
import type { MissionPlan } from '@shared/domain'
import { findCycles } from './graph'

export type PlanValidation = { ok: true } | { ok: false; errors: string[] }

const hasText = (s: string): boolean => s.trim().length > 0

/** Errors are phrased so a planner model can repair the plan from the message alone. */
export function validatePlan(plan: MissionPlan): PlanValidation {
  const errors: string[] = []
  const ids = plan.tasks.map((t) => t.id)
  const known = new Set(ids)

  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  for (const id of duplicates) {
    errors.push(`Task id '${id}' is used by more than one task. Every task id must be unique.`)
  }

  const edges = new Map<string, string[]>()
  for (const task of plan.tasks) {
    const valid: string[] = []
    const seen = new Set<string>()
    for (const dep of task.dependencies) {
      if (dep === task.id) {
        errors.push(`Task '${task.id}' lists itself as a dependency. Remove it.`)
      } else if (!known.has(dep)) {
        errors.push(
          `Task '${task.id}' depends on '${dep}', which is not a task id in the plan. ` +
            `Use one of: ${ids.join(', ')}.`,
        )
      } else if (seen.has(dep)) {
        errors.push(`Task '${task.id}' lists dependency '${dep}' more than once.`)
      } else {
        valid.push(dep)
      }
      seen.add(dep)
    }
    edges.set(task.id, [...(edges.get(task.id) ?? []), ...valid])
  }

  for (const cycle of findCycles(edges)) {
    errors.push(
      `Dependency cycle: ${cycle.join(' -> ')} (each task depends on the next). ` +
        `Remove or reverse at least one dependency in this loop.`,
    )
  }

  if (!plan.acceptanceCriteria.some(hasText)) {
    errors.push('The plan has no mission-level acceptance criteria. Add at least one verifiable criterion.')
  }

  for (const task of plan.tasks) {
    if (WRITING_ROLES.includes(task.role) && !task.acceptanceCriteria.some(hasText)) {
      errors.push(
        `Task '${task.id}' (role ${task.role}) modifies files but has no acceptance criteria. ` +
          `Add at least one verifiable criterion.`,
      )
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
