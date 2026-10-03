import { useEffect, useMemo, useRef, useState } from 'react'
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type NodeTypes } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import '../run.css'
import { EmptyState } from '../../../components/ui'
import { useGraphRevisions, useSettings } from '../../../lib/queries'
import { addedInRevision, cancelledInRevision, highlightRevision, sortRevisions } from '../../../lib/v2logic'
import { RevisionBar } from './RevisionBar'
import { latestAgentOf, useRunCtx } from '../runContext'
import { TaskNode, type TaskFlowNode } from './TaskNode'
import { buildGraphModel, isEdgeSatisfied, layoutGraph, type Position } from './graphModel'

const nodeTypes: NodeTypes = { task: TaskNode }

const COLOR = {
  satisfied: 'var(--color-tone-success)',
  pending: 'var(--color-border-strong)',
  repair: 'var(--color-tone-warning)',
}

/** Fits the viewport once, the first time nodes exist. Later state changes never move the camera. */
function FitOnce({ hasNodes }: { hasNodes: boolean }) {
  const { fitView } = useReactFlow()
  const done = useRef(false)
  useEffect(() => {
    if (!hasNodes || done.current) return
    done.current = true
    const id = requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 0 }))
    return () => cancelAnimationFrame(id)
  }, [hasNodes, fitView])
  return null
}

function GraphInner({
  selectedTaskId,
  onSelect,
  revisionVersion,
}: {
  selectedTaskId: string | null
  onSelect: (taskId: string) => void
  revisionVersion: number | null
}) {
  const { detail, tasksById } = useRunCtx()
  const { tasks, dependencies, agents, pendingApprovals } = detail
  const revisions = useGraphRevisions(detail.run.id).data
  const addedIn = useMemo(() => addedInRevision(revisions ?? []), [revisions])
  const cancelledIn = useMemo(() => cancelledInRevision(revisions ?? []), [revisions])
  const highlight = useMemo(
    () => (revisionVersion === null ? null : highlightRevision(revisions ?? [], revisionVersion)),
    [revisions, revisionVersion],
  )
  const colorMode = useSettings().data?.appearance.theme === 'light' ? 'light' : 'dark'

  const model = useMemo(() => buildGraphModel(tasks, dependencies), [tasks, dependencies])
  // Positions depend only on the node/edge set (the signature), so a state change never reshuffles the graph.
  const layoutCache = useRef<{ signature: string; positions: Record<string, Position> } | null>(null)
  if (layoutCache.current?.signature !== model.signature) {
    layoutCache.current = { signature: model.signature, positions: layoutGraph(model) }
  }
  const positions = layoutCache.current.positions

  const nodes = useMemo<TaskFlowNode[]>(() => {
    const approvalTasks = new Set(pendingApprovals.map((a) => a.taskId).filter((id): id is string => id !== null))
    return tasks.map((task) => ({
      id: task.id,
      type: 'task',
      position: positions[task.id] ?? { x: 0, y: 0 },
      draggable: false,
      connectable: false,
      data: {
        task,
        agent: latestAgentOf(agents, task.id),
        needsApproval: approvalTasks.has(task.id) || (task.requiresApproval && !task.approvalGranted && task.state === 'blocked'),
        selected: task.id === selectedTaskId,
        addedInVersion: task.kind === 'repair' ? null : (addedIn.get(task.id) ?? null),
        cancelledInVersion: task.state === 'cancelled' ? (cancelledIn.get(task.id) ?? null) : null,
        highlight: highlight
          ? highlight.added.has(task.id)
            ? 'added'
            : highlight.changed.has(task.id)
              ? 'changed'
              : highlight.removed.has(task.id)
                ? 'removed'
                : null
          : null,
      },
    }))
  }, [tasks, agents, pendingApprovals, positions, selectedTaskId, addedIn, cancelledIn, highlight])

  const edges = useMemo<Edge[]>(
    () =>
      model.edges.map((e) => {
        const satisfied = e.kind === 'dependency' && isEdgeSatisfied(e, tasksById)
        const color = e.kind === 'repair' ? COLOR.repair : satisfied ? COLOR.satisfied : COLOR.pending
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          selectable: false,
          data: { kind: e.kind, satisfied },
          style: { stroke: color, strokeWidth: satisfied ? 1.75 : 1.25, strokeDasharray: e.kind === 'repair' ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        }
      }),
    [model.edges, tasksById],
  )

  return (
    <ReactFlow
      className="nexus-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onSelect(node.id)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.2}
      maxZoom={1.75}
      proOptions={{ hideAttribution: true }}
      colorMode={colorMode}
    >
      <FitOnce hasNodes={nodes.length > 0} />
      <Background gap={20} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  )
}

export function TaskGraph({ selectedTaskId, onSelect }: { selectedTaskId: string | null; onSelect: (taskId: string) => void }) {
  const { detail } = useRunCtx()
  const revisions = useGraphRevisions(detail.run.id).data
  const [revisionVersion, setRevisionVersion] = useState<number | null>(null)
  if (detail.tasks.length === 0) {
    return (
      <EmptyState title="No tasks yet" className="h-full">
        {detail.run.state === 'planning' ? 'The planner is still decomposing the mission.' : 'This run has no tasks.'}
      </EmptyState>
    )
  }
  return (
    <div className="flex h-full w-full flex-col" data-testid="task-graph">
      {sortRevisions(revisions ?? []).length > 1 ? (
        <RevisionBar revisions={revisions ?? []} version={revisionVersion} onChange={setRevisionVersion} />
      ) : null}
      <div className="min-h-0 flex-1">
        <ReactFlowProvider>
          <GraphInner selectedTaskId={selectedTaskId} onSelect={onSelect} revisionVersion={revisionVersion} />
        </ReactFlowProvider>
      </div>
    </div>
  )
}
