import { Graph, layout } from '@dagrejs/dagre'
import type { Task, TaskDependency } from '@shared/domain'

export const NODE_WIDTH = 224
export const NODE_HEIGHT = 74

export interface GraphEdgeModel {
  id: string
  source: string
  target: string
  /** 'repair' links a repair task to the task it repairs (parentTaskId); dependencies come from task_dependencies. */
  kind: 'dependency' | 'repair'
}

export interface GraphModel {
  nodeIds: string[]
  edges: GraphEdgeModel[]
  /** Changes only when the set of nodes or edges changes, never when a task changes state. */
  signature: string
}

/** Nodes and edges for the task DAG. Edges whose endpoints are unknown are dropped; a repair link wins over a duplicate dependency. */
export function buildGraphModel(tasks: readonly Task[], dependencies: readonly TaskDependency[]): GraphModel {
  const ids = new Set(tasks.map((t) => t.id))
  const byPair = new Map<string, GraphEdgeModel>()
  for (const d of dependencies) {
    if (!ids.has(d.taskId) || !ids.has(d.dependsOnTaskId)) continue
    const id = `${d.dependsOnTaskId}->${d.taskId}`
    byPair.set(id, { id, source: d.dependsOnTaskId, target: d.taskId, kind: 'dependency' })
  }
  for (const t of tasks) {
    if (!t.parentTaskId || !ids.has(t.parentTaskId)) continue
    const id = `${t.parentTaskId}->${t.id}`
    byPair.set(id, { id, source: t.parentTaskId, target: t.id, kind: 'repair' })
  }
  const nodeIds = tasks.map((t) => t.id).sort()
  const edges = [...byPair.values()].sort((a, b) => a.id.localeCompare(b.id))
  const signature = `${nodeIds.join(',')}|${edges.map((e) => `${e.id}:${e.kind}`).join(',')}`
  return { nodeIds, edges, signature }
}

export interface Position {
  x: number
  y: number
}

/** Top-to-bottom dagre layout. Returns top-left positions (what React Flow expects). */
export function layoutGraph(model: Pick<GraphModel, 'nodeIds' | 'edges'>): Record<string, Position> {
  const g = new Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 56, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const id of model.nodeIds) g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const e of model.edges) g.setEdge(e.source, e.target)
  layout(g)
  const out: Record<string, Position> = {}
  for (const id of model.nodeIds) {
    const n = g.node(id)
    if (n) out[id] = { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 }
  }
  return out
}

/** A dependency is satisfied once the task it points from has completed. */
export function isEdgeSatisfied(edge: GraphEdgeModel, tasksById: ReadonlyMap<string, Task>): boolean {
  return tasksById.get(edge.source)?.state === 'completed'
}
