import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { TERMINAL_TASK_STATES, type Agent, type Task } from '@shared/domain'
import { StatusDot } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { formatSpan } from '../../../lib/format'
import { TONE_CLASSES, taskStatus } from '../../../lib/status'
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
        'flex cursor-pointer flex-col gap-0.5 overflow-hidden border border-l-[3px] bg-surface-1 px-2 py-1 text-[0.88rem] leading-tight hover:bg-surface-2',
        tone.border,
        selected ? 'ring-1 ring-accent' : '',
        highlight === 'added' && 'outline outline-2 -outline-offset-2 outline-tone-success',
        highlight === 'changed' && 'outline outline-2 -outline-offset-2 outline-tone-waiting',
        highlight === 'removed' && 'outline outline-2 -outline-offset-2 outline-dashed outline-tone-danger',
        task.state === 'cancelled' && 'opacity-50',
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="flex items-center gap-1.5">
        <StatusDot tone={status.tone} pulse={active} />
        <span className={cn('font-medium', tone.text)}>{status.label}</span>
        {addedInVersion !== null ? (
          <span
            className="rounded-[3px] bg-accent/15 px-1 font-mono text-[0.8em] text-accent"
            title={`Added by plan revision v${addedInVersion}`}
            data-testid={`task-revision-${task.key}`}
          >
            v{addedInVersion}
          </span>
        ) : null}
        {cancelledInVersion !== null ? (
          <span className="font-mono text-[0.8em] text-fg-faint" title={`Cancelled by plan revision v${cancelledInVersion}`}>
            cancelled by v{cancelledInVersion}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[0.85em] text-fg-faint">{task.key}</span>
      </div>
      <div className="truncate font-medium" title={task.title}>
        {task.title}
      </div>
      <div className="flex items-center gap-1.5 text-[0.85em] text-fg-muted">
        <span>{task.role}</span>
        <span className="text-fg-faint">·</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={agent?.model ?? undefined}>
          {agent?.model ?? 'no agent yet'}
        </span>
        <span className="font-mono">{formatSpan(task.startedAt, task.finishedAt, now)}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[0.82em] text-fg-faint">
        <span title="Implementation attempts">try {task.attempt}</span>
        <span title="Review/verification repair cycles">repair {task.repairCycles}</span>
        {task.kind === 'repair' ? <span className="text-tone-warning">repair task</span> : null}
        {blocked ? (
          <span className="ml-auto text-tone-warning" title={task.blockedReason ?? 'Blocked'}>
            blocked
          </span>
        ) : null}
        {needsApproval ? <span className={cn(blocked ? '' : 'ml-auto', 'text-tone-waiting')}>needs approval</span> : null}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

export const TaskNode = memo(TaskNodeImpl)
