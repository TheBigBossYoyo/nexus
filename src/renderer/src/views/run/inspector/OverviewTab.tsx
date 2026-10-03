import { useEffect, useState, type ReactNode } from 'react'
import { TERMINAL_RUN_STATES, TERMINAL_TASK_STATES, type Task } from '@shared/domain'
import { Button, KeyValue, Markdown, Notice, NumberField, StatusBadge, Textarea } from '../../../components/ui'
import { DASH, formatDateTime, formatSpan } from '../../../lib/format'
import { taskStatus } from '../../../lib/status'
import { useCancelTask, useInstructTask, useResolveBlocker, useRetryTask, useSetTaskPriority } from '../../../lib/queries'
import { useNow, useRunCtx } from '../runContext'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="m-0 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">{title}</h3>
      {children}
    </section>
  )
}

export function OverviewTab({ task }: { task: Task }) {
  const { detail } = useRunCtx()
  const retry = useRetryTask()
  const cancel = useCancelTask()
  const setPriority = useSetTaskPriority()
  const resolve = useResolveBlocker()
  const instruct = useInstructTask()

  const [priority, setPriorityValue] = useState(task.priority)
  const [note, setNote] = useState('')
  const [instruction, setInstruction] = useState('')
  useEffect(() => setPriorityValue(task.priority), [task.id, task.priority])

  const terminal = TERMINAL_TASK_STATES.includes(task.state)
  const now = useNow(task.startedAt !== null && task.finishedAt === null)
  const worktree = detail.worktrees.find((w) => w.id === task.worktreeId) ?? detail.worktrees.find((w) => w.taskId === task.id)
  const runFinished = TERMINAL_RUN_STATES.includes(detail.run.state)
  const blocked = task.state === 'blocked' || task.blockedReason !== null

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="inspector-overview">
      <div className="flex items-center gap-2">
        <StatusBadge status={taskStatus(task.state)} />
        <span className="font-mono text-[0.9em] text-fg-faint">{task.key}</span>
      </div>
      <h2 className="m-0 text-[1.1rem] font-semibold">{task.title}</h2>

      <div className="flex flex-wrap gap-2">
        {task.state === 'failed' || task.state === 'blocked' ? (
          <Button
            size="sm"
            variant="primary"
            loading={retry.isPending}
            disabled={runFinished}
            onClick={() => retry.mutate({ taskId: task.id })}
            data-testid="task-retry"
          >
            Retry
          </Button>
        ) : null}
        {!terminal ? (
          <Button size="sm" variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate({ taskId: task.id })} data-testid="task-cancel">
            Cancel task
          </Button>
        ) : null}
      </div>

      {task.error ? (
        <Notice tone="danger" title="Task failed" data-testid="task-error">
          <dl className="m-0 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
            <dt>What</dt>
            <dd className="m-0 whitespace-pre-wrap break-words">{task.error.what}</dd>
            <dt>Where</dt>
            <dd className="m-0 break-words font-mono text-[0.92em]">{task.error.where ?? DASH}</dd>
            <dt>Why</dt>
            <dd className="m-0 whitespace-pre-wrap break-words">{task.error.why ?? 'Not known'}</dd>
          </dl>
          <div className="mt-1 text-[0.85em]">{task.error.retryable ? 'Retryable.' : 'Not marked retryable.'}</div>
        </Notice>
      ) : null}

      {blocked ? (
        <Notice tone="warning" title="Blocked" data-testid="task-blocked">
          <div className="whitespace-pre-wrap break-words">{task.blockedReason ?? 'Waiting on a dependency or an approval.'}</div>
          <div className="mt-2 flex flex-col gap-1.5">
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Resolution note (optional)"
              aria-label="Blocker resolution note"
              data-testid="blocker-note"
            />
            <div>
              <Button
                size="sm"
                loading={resolve.isPending}
                onClick={() => resolve.mutate({ taskId: task.id, note: note.trim() }, { onSuccess: () => setNote('') })}
                data-testid="resolve-blocker"
              >
                Mark blocker resolved
              </Button>
            </div>
          </div>
        </Notice>
      ) : null}

      <KeyValue
        labelWidth="7.5rem"
        rows={[
          { label: 'Role', value: task.role },
          { label: 'Kind', value: task.kind },
          { label: 'State', value: task.state },
          { label: 'Complexity / risk', value: `${task.complexity} / ${task.risk}` },
          { label: 'Attempts', value: String(task.attempt), mono: true },
          { label: 'Repair cycles', value: String(task.repairCycles), mono: true },
          { label: 'Duration', value: formatSpan(task.startedAt, task.finishedAt, now), mono: true },
          { label: 'Started', value: formatDateTime(task.startedAt), mono: true },
          { label: 'Finished', value: formatDateTime(task.finishedAt), mono: true },
          { label: 'Branch', value: task.branch ?? DASH, mono: true },
          { label: 'Worktree', value: worktree ? `${worktree.path} (${worktree.state})` : DASH, mono: true },
          { label: 'Approval', value: task.requiresApproval ? (task.approvalGranted ? 'required, granted' : 'required, not granted') : 'not required' },
        ]}
      />

      <Section title="Priority">
        <div className="flex items-center gap-2">
          <NumberField value={priority} onChange={setPriorityValue} min={-100} max={100} className="w-24" aria-label="Task priority" data-testid="task-priority" />
          <Button
            size="sm"
            disabled={priority === task.priority || !Number.isInteger(priority) || priority < -100 || priority > 100}
            loading={setPriority.isPending}
            onClick={() => setPriority.mutate({ taskId: task.id, priority })}
            data-testid="task-priority-apply"
          >
            Apply
          </Button>
          <span className="text-fg-faint">-100 to 100, higher runs first</span>
        </div>
      </Section>

      <Section title="Description">
        <Markdown>{task.description}</Markdown>
      </Section>

      {task.suggestedFiles.length > 0 ? (
        <Section title="Suggested files">
          <ul className="m-0 list-none p-0 font-mono text-[0.92em]">
            {task.suggestedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {task.resultSummary ? (
        <Section title="Result summary">
          <div className="border bg-surface-1 p-2" data-testid="task-result">
            <Markdown>{task.resultSummary}</Markdown>
          </div>
        </Section>
      ) : null}

      <Section title="Send instruction">
        <Textarea
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Guidance for the agent working on this task"
          aria-label="Instruction"
          disabled={terminal}
          data-testid="task-instruction"
        />
        <div>
          <Button
            size="sm"
            variant="primary"
            disabled={terminal || instruction.trim() === ''}
            loading={instruct.isPending}
            onClick={() => instruct.mutate({ taskId: task.id, instruction: instruction.trim() }, { onSuccess: () => setInstruction('') })}
            data-testid="task-instruct"
          >
            Send
          </Button>
        </div>
      </Section>
    </div>
  )
}
