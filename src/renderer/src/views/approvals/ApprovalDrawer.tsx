import { useState } from 'react'
import type { ApprovalRequest, Risk } from '@shared/domain'
import { assertNever } from '@shared/result'
import { usePendingApprovals, useResolveApproval, useRunDetail } from '../../lib/queries'
import { formatDateTime, shortId } from '../../lib/format'
import type { Tone } from '../../lib/status'
import { useUiStore } from '../../store/ui'
import { Badge, Button, CodeBlock, Drawer, EmptyState, ErrorNote, Input, TimeAgo } from '../../components/ui'

export function riskTone(risk: Risk): Tone {
  switch (risk) {
    case 'low':
      return 'neutral'
    case 'medium':
      return 'waiting'
    case 'high':
      return 'danger'
    default:
      return assertNever(risk, 'risk')
  }
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const resolve = useResolveApproval()
  const openRun = useUiStore((s) => s.openRun)
  const selectTask = useUiStore((s) => s.selectTask)
  const setDrawer = useUiStore((s) => s.setDrawer)
  const run = useRunDetail(approval.runId).data
  const [note, setNote] = useState('')

  const task = run?.tasks.find((t) => t.id === approval.taskId) ?? null
  const agent = run?.agents.find((a) => a.id === approval.agentId) ?? null
  const isPlan = approval.kind === 'plan'
  const isGraph = approval.kind === 'graph'

  const submit = (approve: boolean) =>
    resolve.mutate({ approvalId: approval.id, approve, ...(note.trim() ? { note: note.trim() } : {}) })
  const goToRun = () => {
    openRun(approval.runId)
    if (task) selectTask(task.id)
    setDrawer(null)
  }

  return (
    <li data-testid="approval-item" className="flex flex-col gap-2 border-b border-l-2 border-l-tone-waiting p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{approval.action}</span>
        <Badge tone={riskTone(approval.risk)} data-testid="approval-risk">
          {approval.risk} risk
        </Badge>
        <Badge mono>{approval.kind}</Badge>
        <TimeAgo iso={approval.createdAt} className="ml-auto text-text-muted" />
      </div>
      {isGraph ? (
        <div className="flex flex-col gap-1 border-l-2 border-tone-review bg-surface-muted px-2.5 py-1.5" data-testid="approval-graph-change">
          <div className="text-caption font-semibold text-tone-review">Proposed plan change</div>
          <div className="whitespace-pre-wrap break-words">{approval.reason}</div>
          {approval.command ? (
            <div className="whitespace-pre-wrap break-words font-mono text-[0.9em] text-text-secondary" data-testid="approval-graph-summary">
              {approval.command}
            </div>
          ) : null}
          <div className="text-text-muted">Approving applies it to the task graph as a new plan revision; denying leaves the graph unchanged.</div>
        </div>
      ) : (
        <div className="text-text-secondary">{approval.reason}</div>
      )}
      {isPlan ? (
        <div className="text-text-secondary">
          The plan is reviewed in the run view.{' '}
          <button type="button" className="text-accent hover:underline" onClick={goToRun} data-testid="approval-open-plan">
            Open plan panel
          </button>
        </div>
      ) : isGraph ? null : approval.command ? (
        <CodeBlock>{approval.command}</CodeBlock>
      ) : null}
      <dl className="m-0 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[0.88rem]">
        <dt className="text-text-muted">Requested by</dt>
        <dd className="m-0">{agent ? `${agent.label} (${approval.requestedBy})` : approval.requestedBy}</dd>
        <dt className="text-text-muted">Run</dt>
        <dd className="m-0 min-w-0">
          <span className="font-mono">{shortId(approval.runId)}</span>
          {run ? <span className="ml-2 text-text-secondary">{run.run.prompt.slice(0, 100)}{run.run.prompt.length > 100 ? '…' : ''}</span> : null}
        </dd>
        {approval.taskId ? (
          <>
            <dt className="text-text-muted">Task</dt>
            <dd className="m-0">{task ? `${task.key}: ${task.title}` : shortId(approval.taskId)}</dd>
          </>
        ) : null}
        <dt className="text-text-muted">Created</dt>
        <dd className="m-0 font-mono">{formatDateTime(approval.createdAt)}</dd>
      </dl>
      {!isPlan ? (
        <div>
          <button type="button" className="text-small text-accent hover:underline" onClick={goToRun}>
            Open run
          </button>
        </div>
      ) : null}
      {resolve.error ? <ErrorNote error={resolve.error} /> : null}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Optional note"
          aria-label="Note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
        />
        <Button variant="primary" loading={resolve.isPending} onClick={() => submit(true)} data-testid="approval-approve">
          Approve
        </Button>
        <Button variant="danger" disabled={resolve.isPending} onClick={() => submit(false)} data-testid="approval-deny">
          Deny
        </Button>
      </div>
    </li>
  )
}

export function ApprovalDrawer() {
  const open = useUiStore((s) => s.drawer === 'approvals')
  const setDrawer = useUiStore((s) => s.setDrawer)
  const pending = usePendingApprovals().data ?? []
  return (
    <Drawer open={open} onClose={() => setDrawer(null)} title={`Approvals (${pending.length})`} testId="approval-drawer" width={520}>
      {pending.length === 0 ? (
        <EmptyState title="Nothing awaiting approval" />
      ) : (
        <ul className="m-0 list-none p-0">
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </ul>
      )}
    </Drawer>
  )
}
