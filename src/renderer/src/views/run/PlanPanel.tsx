import { useMemo, useState, type ReactNode } from 'react'
import type { AgentOutput } from '@shared/domain'
import { Badge, Button, CheckIcon, Notice, Panel, Spinner, Textarea } from '../../components/ui'
import { useAgentOutput, useAgentTools, useApprovePlan, useReplan } from '../../lib/queries'
import { useLiveText } from '../../store/live'
import { clockTimeSeconds, useRunCtx } from './runContext'

function List({ items, empty }: { items: readonly string[]; empty: string }) {
  if (items.length === 0) return <div className="text-text-muted">{empty}</div>
  return (
    <ul className="m-0 list-disc pl-5">
      {items.map((s, i) => (
        <li key={i} className="whitespace-pre-wrap break-words">
          {s}
        </li>
      ))}
    </ul>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="m-0 text-heading font-semibold text-text-primary">{title}</h3>
      {children}
    </section>
  )
}

/** The proposed plan, awaiting the user's decision: approve it or send it back with feedback. */
export function PlanPanel() {
  const { detail } = useRunCtx()
  const { run } = detail
  const plan = run.plan
  const approve = useApprovePlan()
  const replan = useReplan()
  const [feedback, setFeedback] = useState('')

  return (
    <Panel
      title="Plan approval"
      data-testid="plan-panel"
      className="h-full"
      actions={
        <Button
          size="sm"
          variant="primary"
          icon={<CheckIcon size={12} />}
          loading={approve.isPending}
          disabled={!plan}
          onClick={() => approve.mutate({ runId: run.id })}
          data-testid="approve-plan"
        >
          Approve plan
        </Button>
      }
    >
      {!plan ? (
        <Notice tone="warning" title="No plan available">
          The run is awaiting approval but no plan is stored on it.
        </Notice>
      ) : (
        <div className="flex flex-col gap-3">
          <Block title="Summary">
            <p className="m-0 whitespace-pre-wrap break-words">{plan.summary}</p>
          </Block>
          <Block title="Mission acceptance criteria">
            <List items={plan.acceptanceCriteria} empty="None defined." />
          </Block>
          <Block title="Assumptions">
            <List items={plan.assumptions} empty="None stated." />
          </Block>
          <Block title="Risks">
            {plan.risks.length === 0 ? (
              <div className="text-text-muted">None identified.</div>
            ) : (
              <ul className="m-0 list-disc pl-5">
                {plan.risks.map((r, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words">
                    {r.description}
                    {r.mitigation ? <span className="text-text-secondary"> Mitigation: {r.mitigation}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Block>
          <Block title={`Tasks (${plan.tasks.length})`}>
            <div className="overflow-auto border">
              <table className="w-full border-collapse text-left" data-testid="plan-tasks">
                <thead>
                  <tr className="border-b bg-surface-muted text-caption text-text-muted">
                    <th className="px-3 py-1.5 font-medium">Task</th>
                    <th className="px-3 py-1.5 font-medium">Role</th>
                    <th className="px-3 py-1.5 font-medium">Depends on</th>
                    <th className="px-3 py-1.5 font-medium">Size / risk</th>
                    <th className="px-3 py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {plan.tasks.map((t) => (
                    <tr key={t.id} className="border-b last:border-b-0 align-top">
                      <td className="px-2 py-1">
                        <div className="font-medium">{t.title}</div>
                        <div className="font-mono text-small text-text-muted">{t.id}</div>
                      </td>
                      <td className="px-2 py-1">{t.role}</td>
                      <td className="px-2 py-1 font-mono text-small">{t.dependencies.length > 0 ? t.dependencies.join(', ') : '—'}</td>
                      <td className="px-2 py-1">
                        {t.complexity} / {t.risk}
                      </td>
                      <td className="px-2 py-1">
                        <span className="flex flex-wrap gap-1">
                          {t.parallelizable ? <Badge>parallel</Badge> : null}
                          {t.requiresApproval ? <Badge tone="waiting">approval</Badge> : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Block>
          <Block title="Request replanning">
            <Textarea
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should the planner change?"
              aria-label="Replanning feedback"
              data-testid="replan-feedback"
            />
            <div>
              <Button
                size="sm"
                loading={replan.isPending}
                onClick={() => replan.mutate({ runId: run.id, feedback: feedback.trim() }, { onSuccess: () => setFeedback('') })}
                data-testid="request-replan"
              >
                Request replanning
              </Button>
            </div>
          </Block>
        </div>
      )}
    </Panel>
  )
}

const MAX_OUTPUT_ITEMS = 12

/** While the run is planning: the planner agent's visible output and tool activity, live. */
export function PlannerActivity() {
  const { detail } = useRunCtx()
  const planners = useMemo(() => detail.agents.filter((a) => a.role === 'planner'), [detail.agents])
  const agent = useMemo(() => {
    let best = planners[0] ?? null
    for (const a of planners) if (best && a.createdAt >= best.createdAt) best = a
    return best
  }, [planners])
  const agentId = agent?.id ?? null
  const output = useAgentOutput(agentId, { limit: 200 })
  const tools = useAgentTools(agentId)
  const live = useLiveText(agentId)

  const items: AgentOutput[] = (output.data ?? []).filter((o) => o.kind === 'text' || o.kind === 'error').slice(-MAX_OUTPUT_ITEMS)
  const toolRows = (tools.data ?? []).slice(-10)

  return (
    <Panel
      title="Planner activity"
      data-testid="planner-activity"
      className="h-full"
      actions={
        <span className="flex items-center gap-1.5 text-text-secondary">
          <Spinner size={12} />
          Planning
        </span>
      }
    >
      {!agent ? (
        <div className="text-text-secondary">Waiting for the planner agent to start.</div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-text-secondary">
            <span className="font-medium text-text-primary">{agent.label}</span>
            <Badge mono>{agent.state}</Badge>
            <span className="font-mono text-small">{agent.model ?? 'model unknown'}</span>
            {agent.activity ? <span>{agent.activity}</span> : null}
          </div>
          {toolRows.length > 0 ? (
            <ul className="m-0 list-none p-0 font-mono text-small">
              {toolRows.map((t) => (
                <li key={t.id} className="flex gap-2 border-b py-0.5">
                  <span className="text-text-muted">[{clockTimeSeconds(t.startedAt)}]</span>
                  <span className="text-accent">{t.toolName}</span>
                  <span className="min-w-0 flex-1 truncate text-text-secondary">{summarizeInput(t.input)}</span>
                  <span className={t.status === 'failed' || t.status === 'denied' ? 'text-tone-danger' : 'text-text-muted'}>{t.status}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {items.map((o) => (
            <div key={o.id} className="whitespace-pre-wrap break-words border-l-2 pl-2 text-text-secondary">
              {o.content}
            </div>
          ))}
          {live ? <div className="whitespace-pre-wrap break-words border-l-2 border-accent pl-2">{live}</div> : null}
          {items.length === 0 && !live && toolRows.length === 0 ? <div className="text-text-muted">No output yet.</div> : null}
        </div>
      )}
    </Panel>
  )
}

function summarizeInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
    const v = input[key]
    if (typeof v === 'string') return v
  }
  return Object.keys(input).join(', ')
}
