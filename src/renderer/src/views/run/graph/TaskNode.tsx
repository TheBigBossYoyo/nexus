import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { TERMINAL_TASK_STATES, type Agent, type Task } from '@shared/domain'
import { StatusDot } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { formatSpan } from '../../../lib/format'
import { TONE_CLASSES, taskStatus } from '../../../lib/status'
import { claudeModelLabel } from '../../agents/agentLogic'
import { useNow } from '../runContext'
import { NODE_HEIGHT, NODE_WIDTH } from './graphModel'

export interface TaskNodeData extends Record<string, unknown> {
  task: Task
  agent: Agent | null
  /** A pending approval request exists for this task, or the task needs approval that was not granted yet. */
  needsApproval: boolean
  selected: boolean
  /** Version of the graph revision that added this task (v2 and later); null for the original plan and repair tasks. */
  addedInVersion: number | null
  /** Version of the revision that cancelled this task, when a revision did. */
  cancelledInVersion: number | null
  /** What the revision selected in the revision bar did to this task. */
  highlight: 'added' | 'changed' | 'removed' | null
}

export type TaskFlowNode = Node<TaskNodeData, 'task'>

/** Compact task node: white surface, hairline border, a small state dot with the state in words, selection ring in the accent. */
function TaskNodeImpl({ data }: NodeProps<TaskFlowNode>) {
  const { task, agent, needsApproval, selected, addedInVersion, cancelledInVersion, highlight } = data
  const status = taskStatus(task.state)
  const tone = TONE_CLASSES[status.tone]
  const live = task.startedAt !== null && !TERMINAL_TASK_STATES.includes(task.state)
  const now = useNow(live)
  const blocked = task.state === 'blocked' || task.blockedReason !== null
  const active = task.state === 'running' || task.state === 'assigned'

  return (
    <div
      data-testid={`task-node-${task.key}`}
      data-state={task.state}
      data-added-in={addedInVersion ?? undefined}
      data-highlight={highlight ?? undefined}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        'flex cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded-md border bg-surface px-2.5 py-1.5 text-small leading-tight transition-colors hover:border-border-strong',
        task.state === 'failed' && 'border-danger/40 bg-danger-subtle',
        active && 'border-info/50',
        selected && 'border-text-primary ring-1 ring-text-primary',
        highlight === 'added' && 'outline outline-2 -outline-offset-2 outline-success',
        highlight === 'changed' && 'outline outline-2 -outline-offset-2 outline-warning',
        highlight === 'removed' && 'outline outline-2 -outline-offset-2 outline-dashed outline-danger',
        task.state === 'cancelled' && 'opacity-55',
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="flex items-center gap-1.5">
        <StatusDot tone={status.tone} />
        <span className={cn('font-medium', tone.text)}>{status.label}</span>
        {addedInVersion !== null ? (
          <span
            className="rounded-sm bg-accent-subtle px-1 font-mono text-caption text-accent"
            title={`Added by plan revision v${addedInVersion}`}
            data-testid={`task-revision-${task.key}`}
          >
            v{addedInVersion}
          </span>
        ) : null}
        {cancelledInVersion !== null ? (
          <span className="font-mono text-caption text-text-muted" title={`Cancelled by plan revision v${cancelledInVersion}`}>
            cancelled by v{cancelledInVersion}
          </span>
        ) : null}
        {blocked ? (
          <span className="text-caption text-warning" title={task.blockedReason ?? 'Blocked'}>
            blocked
          </span>
        ) : null}
        {needsApproval ? <span className="text-caption text-warning">needs approval</span> : null}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-caption text-text-muted">{task.key}</span>
      </div>
      <div className="truncate text-body font-medium text-text-primary" title={task.title}>
        {task.title}
      </div>
      <div className="flex items-center gap-1.5 text-caption text-text-muted">
        <span className="shrink-0">{agent ? agent.label : task.role}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 flex-1 truncate" title={agent?.model ?? undefined}>
          {agent?.model ? claudeModelLabel(agent.model).replace('Claude · ', '') : 'not started'}
        </span>
        {task.kind === 'repair' ? <span className="text-warning">repair</span> : null}
        <span className="tnum">{formatSpan(task.startedAt, task.finishedAt, now)}</span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

export const TaskNode = memo(TaskNodeImpl)
