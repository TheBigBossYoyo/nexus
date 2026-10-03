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
}

export type TaskFlowNode = Node<TaskNodeData, 'task'>

function TaskNodeImpl({ data }: NodeProps<TaskFlowNode>) {
  const { task, agent, needsApproval, selected } = data
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
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        'flex cursor-pointer flex-col gap-0.5 overflow-hidden border border-l-[3px] bg-surface-1 px-2 py-1 text-[0.88rem] leading-tight hover:bg-surface-2',
        tone.border,
        selected ? 'ring-1 ring-accent' : '',
        task.state === 'cancelled' && 'opacity-60',
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="flex items-center gap-1.5">
        <StatusDot tone={status.tone} pulse={active} />
        <span className={cn('font-medium', tone.text)}>{status.label}</span>
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
