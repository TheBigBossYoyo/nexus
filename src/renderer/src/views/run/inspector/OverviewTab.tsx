import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { TERMINAL_RUN_STATES, TERMINAL_TASK_STATES, type Task } from '@shared/domain'
import {
  defaultIntentMetadata,
  type CompilationMode,
  type CompiledTaskSpec,
} from '@shared/intelligence'
import { CompilationPreview } from '../../projects/CompilationPreview'
import {
  Button,
  ErrorNote,
  KeyValue,
  Markdown,
  Notice,
  NumberField,
  SourceLabel,
  StatusBadge,
  StatusText,
  Textarea,
} from '../../../components/ui'
import { DASH, formatDateTime, formatSpan, formatTokens } from '../../../lib/format'
import { agentStatus, taskStatus } from '../../../lib/status'
import {
  useCancelTask,
  useInstructTask,
  useResolveBlocker,
  useRetryTask,
  useRoutingDecisions,
  useSetTaskPriority,
} from '../../../lib/queries'
import { useUiStore } from '../../../store/ui'
import { claudeModelLabel } from '../../agents/agentLogic'
import { CriteriaList } from '../blocks'
import { useNow, useRunCtx } from '../runContext'

function Group({ title, children, testId, aside }: { title: string; children: ReactNode; testId?: string; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h3 className="m-0 flex items-center gap-2 text-body font-semibold text-text-primary">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  )
}

function sumNullable(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null)
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
}

export function OverviewTab({ task }: { task: Task }) {
  const { detail, tasksById } = useRunCtx()
  const retry = useRetryTask()
  const cancel = useCancelTask()
  const setPriority = useSetTaskPriority()
  const resolve = useResolveBlocker()
  const instruct = useInstructTask()
  const routing = useRoutingDecisions(detail.run.id)
  const selectTask = useUiStore((s) => s.selectTask)
  const selectAgent = useUiStore((s) => s.selectAgent)
  const setView = useUiStore((s) => s.setView)

  const [priority, setPriorityValue] = useState(task.priority)
  const [note, setNote] = useState('')
  const [instruction, setInstruction] = useState('')
  const [instructionMode, setInstructionMode] = useState<CompilationMode>('AUTO')
  const [instructionSpec, setInstructionSpec] = useState<CompiledTaskSpec | null>(null)
  const [resolutionMode, setResolutionMode] = useState<CompilationMode>('AUTO')
  const [resolutionSpec, setResolutionSpec] = useState<CompiledTaskSpec | null>(null)
  useEffect(() => setPriorityValue(task.priority), [task.id, task.priority])

  const terminal = TERMINAL_TASK_STATES.includes(task.state)
  const now = useNow(task.startedAt !== null && task.finishedAt === null)
  const worktree = detail.worktrees.find((w) => w.id === task.worktreeId) ?? detail.worktrees.find((w) => w.taskId === task.id)
  const runFinished = TERMINAL_RUN_STATES.includes(detail.run.state)
  const blocked = task.state === 'blocked' || task.blockedReason !== null

  const agents = useMemo(
    () => detail.agents.filter((a) => a.taskId === task.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [detail.agents, task.id],
  )
  const criteria = detail.criteria.filter((c) => c.taskId === task.id)
  const deps = detail.dependencies
    .filter((d) => d.taskId === task.id)
    .map((d) => tasksById.get(d.dependsOnTaskId))
    .filter((t): t is Task => t !== undefined)
  // The model that matters is the implementing agent's, not the verifier's.
  const latestAgent = agents.filter((a) => a.purpose === 'implement').at(-1) ?? agents.at(-1) ?? null
  const decision = (routing.data ?? [])
    .filter((d) => (latestAgent ? d.agentId === latestAgent.id : d.taskId === task.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const inputTokens = sumNullable(agents.map((a) => a.metrics.inputTokens))
  const outputTokens = sumNullable(agents.map((a) => a.metrics.outputTokens))
  const turns = agents.reduce((n, a) => n + a.metrics.turns, 0)

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="inspector-overview">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <StatusBadge status={taskStatus(task.state)} />
          <span className="font-mono text-code text-text-muted">{task.key}</span>
        </div>
        <h2 className="m-0 text-[1.15rem] font-semibold leading-snug text-text-primary">{task.title}</h2>
        <div className="flex flex-wrap gap-2">
          {task.state === 'failed' || task.state === 'blocked' ? (
            <Button size="sm" variant="primary" loading={retry.isPending} disabled={runFinished} onClick={() => retry.mutate({ taskId: task.id })} data-testid="task-retry">
              Retry
            </Button>
          ) : null}
          {!terminal ? (
            <Button size="sm" variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate({ taskId: task.id })} data-testid="task-cancel">
              Cancel task
            </Button>
          ) : null}
        </div>
      </header>

      {task.error ? (
        <Notice tone="danger" title="Task failed" data-testid="task-error">
          <dl className="m-0 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
            <dt>What</dt>
            <dd className="m-0 whitespace-pre-wrap break-words">{task.error.what}</dd>
            <dt>Where</dt>
            <dd className="m-0 break-words font-mono text-code">{task.error.where ?? DASH}</dd>
            <dt>Why</dt>
            <dd className="m-0 whitespace-pre-wrap break-words">{task.error.why ?? 'Not known'}</dd>
          </dl>
          <div className="mt-1 text-small">{task.error.retryable ? 'Retryable.' : 'Not marked retryable.'}</div>
        </Notice>
      ) : null}

      {blocked ? (
        <Notice tone="warning" title="Blocked" data-testid="task-blocked">
          <div className="whitespace-pre-wrap break-words">{task.blockedReason ?? 'Waiting on a dependency or an approval.'}</div>
          <div className="mt-2 flex flex-col gap-1.5">
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => {
                setNote(e.target.value)
                setResolutionSpec(null)
              }}
              disabled={resolve.isPending}
              placeholder="Resolution note (optional)"
              aria-label="Blocker resolution note"
              data-testid="blocker-note"
            />
            <div>
              <Button
                size="sm"
                loading={resolve.isPending}
                onClick={() =>
                  resolve.mutate(
                    {
                      taskId: task.id,
                      note,
                      compilationMode: resolutionMode,
                      ...(resolutionSpec ? { compiledSpecId: resolutionSpec.id } : {}),
                    },
                    {
                      onSuccess: () => {
                        setNote('')
                        setResolutionSpec(null)
                      },
                    },
                  )
                }
                data-testid="resolve-blocker"
              >
                Mark blocker resolved
              </Button>
            </div>
            {note.trim() ? (
              <CompilationPreview
                projectId={detail.run.projectId}
                raw={note}
                executionScope={{ runId: detail.run.id, taskId: task.id }}
                metadata={defaultIntentMetadata(note, 'TASK_INSTRUCTION')}
                mode={resolutionMode}
                onModeChange={(mode) => {
                  setResolutionMode(mode)
                  setResolutionSpec(null)
                }}
                spec={resolutionSpec}
                onSpec={setResolutionSpec}
              />
            ) : null}
            {resolve.isError ? <ErrorNote error={resolve.error} /> : null}
          </div>
        </Notice>
      ) : null}

      <KeyValue
        labelWidth="6.5rem"
        rows={[
          { label: 'Role', value: task.role },
          {
            label: 'Model',
            value: latestAgent ? (
              <span>
                {claudeModelLabel(latestAgent.model)}
                {decision ? (
                  <span className="block text-small text-text-muted" data-testid="task-routing-reason">
                    {decision.reasons.length > 0 ? decision.reasons.join(' · ') : `Policy ${decision.resolvedPolicy}; no rule changed it.`}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-text-muted">Not assigned yet</span>
            ),
          },
          {
            label: 'Depends on',
            value:
              deps.length === 0 ? (
                <span className="text-text-muted">Nothing</span>
              ) : (
                <span className="flex flex-wrap gap-x-2 gap-y-0.5" data-testid="task-dependencies">
                  {deps.map((d) => (
                    <button key={d.id} type="button" className="font-mono text-code text-accent hover:underline" onClick={() => selectTask(d.id)}>
                      {d.key}
                    </button>
                  ))}
                </span>
              ),
          },
          { label: 'Elapsed', value: formatSpan(task.startedAt, task.finishedAt, now), mono: true },
          { label: 'Attempts', value: `${task.attempt} · ${task.repairCycles} repair cycles`, mono: true },
          { label: 'Size / risk', value: `${task.complexity} / ${task.risk}` },
          { label: 'Branch', value: task.branch ?? DASH, mono: true },
          { label: 'Worktree', value: worktree ? `${worktree.path} (${worktree.state})` : DASH, mono: true },
          { label: 'Started', value: formatDateTime(task.startedAt), mono: true },
          { label: 'Approval', value: task.requiresApproval ? (task.approvalGranted ? 'required, granted' : 'required, not granted') : 'not required' },
        ]}
      />

      <Group
        title="Observed usage"
        aside={<SourceLabel confidence="OBSERVED" source="LOCAL_AGGREGATION" />}
        testId="task-usage"
      >
        {agents.length === 0 ? (
          <p className="m-0 text-small text-text-muted">No Claude session has run for this task yet.</p>
        ) : (
          <div className="flex gap-6 text-body">
            <span>
              <span className="tnum font-semibold">{formatTokens(inputTokens)}</span>{' '}
              <span className="text-text-muted">input</span>
            </span>
            <span>
              <span className="tnum font-semibold">{formatTokens(outputTokens)}</span>{' '}
              <span className="text-text-muted">output</span>
            </span>
            <span>
              <span className="tnum font-semibold">{turns}</span>{' '}
              <span className="text-text-muted">turns</span>
            </span>
          </div>
        )}
      </Group>

      <Group title="Acceptance criteria" testId="inspector-criteria">
        {criteria.length === 0 && task.acceptanceCriteria.length > 0 ? (
          <ul className="m-0 list-disc pl-5">
            {task.acceptanceCriteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : (
          <CriteriaList criteria={criteria} emptyText="This task has no acceptance criteria." />
        )}
      </Group>

      <Group title="Agents on this task" testId="inspector-agents">
        {agents.length === 0 ? (
          <p className="m-0 text-small text-text-muted">No agent has worked on this task yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {agents.map((a) => (
              <li key={a.id} className="border-b last:border-b-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted"
                  data-testid={`task-agent-${a.id}`}
                  onClick={() => {
                    selectAgent(a.id)
                    setView('agents')
                  }}
                >
                  <StatusText status={agentStatus(a.state)} />
                  <span className="font-medium">{a.role}</span>
                  <span className="text-text-muted">{a.purpose}</span>
                  <span className="ml-auto text-small text-text-muted">{a.metrics.turns} {a.metrics.turns === 1 ? 'turn' : 'turns'}</span>
                </button>
                {a.error ? <div className="pb-1.5 text-small text-danger">{a.error}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title="Description">
        <Markdown>{task.description}</Markdown>
      </Group>

      {task.suggestedFiles.length > 0 ? (
        <Group title="Suggested files">
          <ul className="m-0 list-none p-0 font-mono text-code">
            {task.suggestedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Group>
      ) : null}

      {task.resultSummary ? (
        <Group title="Result summary">
          <div className="rounded-md border bg-surface-muted p-2.5" data-testid="task-result">
            <Markdown>{task.resultSummary}</Markdown>
          </div>
        </Group>
      ) : null}

      <Group title="Priority">
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
          <span className="text-small text-text-muted">-100 to 100, higher runs first</span>
        </div>
      </Group>

      <Group title="Send instruction">
        <Textarea
          rows={3}
          value={instruction}
          onChange={(e) => {
            setInstruction(e.target.value)
            setInstructionSpec(null)
          }}
          placeholder="Guidance for the agent working on this task"
          aria-label="Instruction"
          disabled={terminal || instruct.isPending}
          data-testid="task-instruction"
        />
        <div>
          <Button
            size="sm"
            variant="primary"
            disabled={terminal || instruction.trim() === ''}
            loading={instruct.isPending}
            onClick={() =>
              instruct.mutate(
                {
                  taskId: task.id,
                  instruction,
                  compilationMode: instructionMode,
                  ...(instructionSpec ? { compiledSpecId: instructionSpec.id } : {}),
                },
                {
                  onSuccess: () => {
                    setInstruction('')
                    setInstructionSpec(null)
                  },
                },
              )
            }
            data-testid="task-instruct"
          >
            Send
          </Button>
        </div>
        <CompilationPreview
          projectId={detail.run.projectId}
          raw={instruction}
          executionScope={{ runId: detail.run.id, taskId: task.id }}
          metadata={defaultIntentMetadata(instruction, 'TASK_INSTRUCTION')}
          mode={instructionMode}
          onModeChange={(mode) => {
            setInstructionMode(mode)
            setInstructionSpec(null)
          }}
          spec={instructionSpec}
          onSpec={setInstructionSpec}
        />
        {instruct.isError ? <ErrorNote error={instruct.error} /> : null}
      </Group>
    </div>
  )
}
