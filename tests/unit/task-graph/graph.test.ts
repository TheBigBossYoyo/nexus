import { describe, expect, it } from 'vitest'
import { NexusError } from '@shared/result'
import {
  computeLayers,
  dependantsOf,
  dependenciesOf,
  findCycles,
  taskDepths,
  topologicalOrder,
  transitiveDependants,
  transitiveDependencies,
  wouldCreateCycle,
} from '@main/modules/task-graph'
import { dep, makeTask } from '../scheduler/factories'

// d depends on b and c; b and c depend on a; e is independent.
const tasks = ['e', 'd', 'c', 'b', 'a'].map((k) => makeTask(k))
const deps = [dep('b', 'a'), dep('c', 'a'), dep('d', 'b'), dep('d', 'c')]

describe('graph lookups', () => {
  it('returns direct dependencies and dependants', () => {
    expect(dependenciesOf(deps, 'd').sort()).toEqual(['b', 'c'])
    expect(dependantsOf(deps, 'a').sort()).toEqual(['b', 'c'])
    expect(dependenciesOf(deps, 'a')).toEqual([])
    expect(dependantsOf(deps, 'e')).toEqual([])
  })

  it('returns transitive sets without duplicates or the start node', () => {
    expect(transitiveDependants(deps, 'a').sort()).toEqual(['b', 'c', 'd'])
    expect(transitiveDependencies(deps, 'd').sort()).toEqual(['a', 'b', 'c'])
    expect(transitiveDependants(deps, 'd')).toEqual([])
  })
})

describe('wouldCreateCycle', () => {
  it('detects self, direct and indirect cycles', () => {
    expect(wouldCreateCycle(deps, 'a', 'a')).toBe(true)
    expect(wouldCreateCycle(deps, 'a', 'b')).toBe(true) // a -> b -> a
    expect(wouldCreateCycle(deps, 'a', 'd')).toBe(true) // a -> d -> b -> a
  })

  it('allows edges that keep the graph acyclic', () => {
    expect(wouldCreateCycle(deps, 'd', 'a')).toBe(false)
    expect(wouldCreateCycle(deps, 'e', 'd')).toBe(false)
    expect(wouldCreateCycle(deps, 'b', 'c')).toBe(false)
  })
})

describe('topologicalOrder', () => {
  it('puts dependencies first and keeps input order for ties', () => {
    expect(topologicalOrder(tasks, deps)).toEqual(['e', 'a', 'c', 'b', 'd'])
  })

  it('ignores dependencies on tasks outside the list', () => {
    expect(topologicalOrder([makeTask('x')], [dep('x', 'ghost')])).toEqual(['x'])
  })

  it('throws invalid_input with the cycle path', () => {
    const cyclic = [makeTask('a'), makeTask('b'), makeTask('free')]
    try {
      topologicalOrder(cyclic, [dep('a', 'b'), dep('b', 'a')])
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(NexusError)
      expect((e as NexusError).code).toBe('invalid_input')
      expect((e as NexusError).message).toContain('a -> b -> a')
    }
  })
})

describe('layers and depths', () => {
  it('uses the longest dependency chain as depth', () => {
    const withShortcut = [...deps, dep('d', 'a')]
    const depths = taskDepths(tasks, withShortcut)
    expect(Object.fromEntries(depths)).toEqual({ e: 0, a: 0, b: 1, c: 1, d: 2 })
  })

  it('groups ids per layer', () => {
    const layers = computeLayers(tasks, deps).map((l) => [...l].sort())
    expect(layers).toEqual([['a', 'e'], ['b', 'c'], ['d']])
  })
})

describe('findCycles', () => {
  it('returns closed paths and nothing for a DAG', () => {
    expect(findCycles(new Map([['a', ['b']], ['b', []]]))).toEqual([])
    expect(findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual([['a', 'b', 'c', 'a']])
  })
})
