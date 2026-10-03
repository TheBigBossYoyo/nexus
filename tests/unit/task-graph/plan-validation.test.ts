import { describe, expect, it } from 'vitest'
import { validatePlan } from '@main/modules/task-graph'
import { makePlan, plannedTask } from '../scheduler/factories'

function errorsOf(result: ReturnType<typeof validatePlan>): string[] {
  if (result.ok) throw new Error('expected plan to be invalid')
  return result.errors
}

describe('validatePlan', () => {
  it('accepts a valid DAG', () => {
    const plan = makePlan([
      plannedTask('a'),
      plannedTask('b', { dependencies: ['a'] }),
      plannedTask('c', { dependencies: ['a', 'b'], role: 'reviewer', acceptanceCriteria: [] }),
    ])
    expect(validatePlan(plan)).toEqual({ ok: true })
  })

  it('reports duplicate task ids', () => {
    const errors = errorsOf(validatePlan(makePlan([plannedTask('a'), plannedTask('a')])))
    expect(errors.some((e) => e.includes("'a'") && e.includes('unique'))).toBe(true)
  })

  it('reports unknown dependencies and lists valid ids', () => {
    const errors = errorsOf(validatePlan(makePlan([plannedTask('a', { dependencies: ['zzz'] })])))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("'zzz'")
    expect(errors[0]).toContain('a')
  })

  it('reports self-dependency once, not as a cycle', () => {
    const errors = errorsOf(validatePlan(makePlan([plannedTask('a', { dependencies: ['a'] })])))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('itself')
  })

  it('reports the cycle path', () => {
    const plan = makePlan([
      plannedTask('a', { dependencies: ['c'] }),
      plannedTask('b', { dependencies: ['a'] }),
      plannedTask('c', { dependencies: ['b'] }),
    ])
    const errors = errorsOf(validatePlan(plan))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('a -> c -> b -> a')
  })

  it('requires at least one non-blank mission acceptance criterion', () => {
    const errors = errorsOf(
      validatePlan(makePlan([plannedTask('a')], { acceptanceCriteria: ['  '] })),
    )
    expect(errors[0]).toContain('mission-level acceptance criteria')
  })

  it('requires acceptance criteria on worker and debugger tasks only', () => {
    const plan = makePlan([
      plannedTask('w', { acceptanceCriteria: [] }),
      plannedTask('d', { role: 'debugger', acceptanceCriteria: [' '] }),
      plannedTask('r', { role: 'researcher', acceptanceCriteria: [] }),
    ])
    const errors = errorsOf(validatePlan(plan))
    expect(errors).toHaveLength(2)
    expect(errors.some((e) => e.includes("'w'"))).toBe(true)
    expect(errors.some((e) => e.includes("'d'"))).toBe(true)
  })

  it('flags repeated dependencies and collects multiple errors', () => {
    const plan = makePlan([plannedTask('a'), plannedTask('b', { dependencies: ['a', 'a', 'x'] })], {
      acceptanceCriteria: [],
    })
    expect(errorsOf(validatePlan(plan))).toHaveLength(3)
  })
})
