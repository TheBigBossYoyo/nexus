import type { Task, TaskDependency } from '@shared/domain'
import { NexusError } from '@shared/result'

/** Edges point from a task to the tasks it depends on. */
function adjacency(
  deps: readonly TaskDependency[],
  direction: 'dependencies' | 'dependants',
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const d of deps) {
    const [from, to] =
      direction === 'dependencies' ? [d.taskId, d.dependsOnTaskId] : [d.dependsOnTaskId, d.taskId]
    const list = map.get(from)
    if (list) {
      if (!list.includes(to)) list.push(to)
    } else {
      map.set(from, [to])
    }
  }
  return map
}

function reachable(adj: ReadonlyMap<string, readonly string[]>, start: string): string[] {
  const seen = new Set<string>([start])
  const order: string[] = []
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    for (const next of adj.get(queue[i] as string) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      order.push(next)
      queue.push(next)
    }
  }
  return order
}

export function dependenciesOf(deps: readonly TaskDependency[], taskId: string): string[] {
  return adjacency(deps, 'dependencies').get(taskId) ?? []
}

export function dependantsOf(deps: readonly TaskDependency[], taskId: string): string[] {
  return adjacency(deps, 'dependants').get(taskId) ?? []
}

/** Everything the task needs, directly or indirectly, in breadth-first order. */
export function transitiveDependencies(deps: readonly TaskDependency[], taskId: string): string[] {
  return reachable(adjacency(deps, 'dependencies'), taskId)
}

/** Everything that is (indirectly) blocked by the task: the set to block or cancel in a cascade. */
export function transitiveDependants(deps: readonly TaskDependency[], taskId: string): string[] {
  return reachable(adjacency(deps, 'dependants'), taskId)
}

/** True if adding "taskId depends on dependsOnTaskId" would make the graph cyclic. */
export function wouldCreateCycle(
  deps: readonly TaskDependency[],
  taskId: string,
  dependsOnTaskId: string,
): boolean {
  if (taskId === dependsOnTaskId) return true
  return reachable(adjacency(deps, 'dependencies'), dependsOnTaskId).includes(taskId)
}

/**
 * All cycles found by a depth-first search, each as a closed path ([a, b, a]).
 * Not every elementary cycle is enumerated, but every node on a cycle is covered.
 */
export function findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles: string[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (node: string): void => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      const s = state.get(next)
      if (s === 'visiting') {
        cycles.push([...stack.slice(stack.indexOf(next)), next])
      } else if (s === undefined) {
        visit(next)
      }
    }
    stack.pop()
    state.set(node, 'done')
  }

  for (const node of edges.keys()) {
    if (!state.has(node)) visit(node)
  }
  return cycles
}

function restrictedEdges(
  tasks: readonly Task[],
  deps: readonly TaskDependency[],
): { ids: string[]; edges: Map<string, string[]> } {
  const ids = tasks.map((t) => t.id)
  const known = new Set(ids)
  const edges = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const d of deps) {
    if (!known.has(d.taskId) || !known.has(d.dependsOnTaskId)) continue
    const list = edges.get(d.taskId) as string[]
    if (!list.includes(d.dependsOnTaskId)) list.push(d.dependsOnTaskId)
  }
  return { ids, edges }
}

/**
 * Task ids ordered so every task appears after all its dependencies. Ties keep input order.
 * Dependencies on tasks outside `tasks` are ignored. Throws invalid_input on a cycle.
 */
export function topologicalOrder(tasks: readonly Task[], deps: readonly TaskDependency[]): string[] {
  const { ids, edges } = restrictedEdges(tasks, deps)
  const done = new Set<string>()
  const order: string[] = []
  while (order.length < ids.length) {
    const next = ids.find(
      (id) => !done.has(id) && (edges.get(id) ?? []).every((dep) => done.has(dep)),
    )
    if (next === undefined) {
      const remaining = new Map([...edges].filter(([id]) => !done.has(id)))
      const cycle = findCycles(remaining)[0] ?? []
      throw new NexusError('invalid_input', `Dependency cycle: ${cycle.join(' -> ')}`, { cycle })
    }
    done.add(next)
    order.push(next)
  }
  return order
}

/** Depth of each task: 0 for tasks with no dependencies, else 1 + the deepest dependency. */
export function taskDepths(tasks: readonly Task[], deps: readonly TaskDependency[]): Map<string, number> {
  const { edges } = restrictedEdges(tasks, deps)
  const depths = new Map<string, number>()
  for (const id of topologicalOrder(tasks, deps)) {
    let depth = 0
    for (const dep of edges.get(id) ?? []) depth = Math.max(depth, (depths.get(dep) ?? 0) + 1)
    depths.set(id, depth)
  }
  return depths
}

/** Task ids grouped by depth, for display: layers[0] has no dependencies. */
export function computeLayers(tasks: readonly Task[], deps: readonly TaskDependency[]): string[][] {
  const layers: string[][] = []
  for (const [id, depth] of taskDepths(tasks, deps)) {
    ;(layers[depth] ??= []).push(id)
  }
  return layers
}
