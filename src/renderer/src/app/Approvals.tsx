import { useState } from 'react'
import type { ApprovalRequest, Risk } from '@shared/domain'
import { assertNever } from '@shared/result'
import { usePendingApprovals, useResolveApproval } from '../lib/queries'
import { shortId } from '../lib/format'
import type { Tone } from '../lib/status'
import { useUiStore } from '../store/ui'
import { Badge, Button, CodeBlock, Drawer, EmptyState, ErrorNote, Input, TimeAgo } from '../components/ui'

function riskTone(risk: Risk): Tone {
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

/** Persistent amber strip across the top of the content area while anything awaits a human decision. */
export function ApprovalBar() {
  const pending = usePendingApprovals().data ?? []
  const setDrawer = useUiStore((s) => s.setDrawer)
  const first = pending[0]
  if (!first) return null
  return (
    <div
      data-testid="approval-bar"
      role="status"
      className="flex h-8 shrink-0 items-center gap-3 border-b border-tone-waiting bg-tone-waiting px-3 text-accent-fg"
    >
      <span className="font-semibold">
        {pending.length} approval{pending.length === 1 ? '' : 's'} pending
      </span>
      <span className="min-w-0 flex-1 truncate opacity-80">
        {first.action}
        {first.command ? `: ${first.command}` : ''}
      </span>
      <button
        type="button"
        data-testid="approval-bar-review"
        onClick={() => setDrawer('approvals')}
        className="h-6 rounded-[3px] border border-accent-fg/50 bg-accent-fg/10 px-2 font-medium hover:bg-accent-fg/20"
      >
        Review
      </button>
    </div>
  )
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const resolve = useResolveApproval()
  const openRun = useUiStore((s) => s.openRun)
  const setDrawer = useUiStore((s) => s.setDrawer)
  const [note, setNote] = useState('')
  const submit = (approve: boolean) =>
    resolve.mutate({ approvalId: approval.id, approve, ...(note.trim() ? { note: note.trim() } : {}) })

  return (
    <li data-testid={`approval-${approval.id}`} className="flex flex-col gap-2 border-b border-l-2 border-l-tone-waiting p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{approval.action}</span>
        <Badge tone={riskTone(approval.risk)}>{approval.risk} risk</Badge>
        <Badge mono>{approval.kind}</Badge>
        <TimeAgo iso={approval.createdAt} className="ml-auto text-fg-faint" />
      </div>
      <div className="text-fg-muted">{approval.reason}</div>
      {approval.command ? <CodeBlock>{approval.command}</CodeBlock> : null}
      <div className="flex items-center gap-2 text-[0.85rem] text-fg-faint">
        <span>by {approval.requestedBy}</span>
        <span className="font-mono">run {shortId(approval.runId)}</span>
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => {
            openRun(approval.runId)
            setDrawer(null)
          }}
        >
          Open run
        </button>
      </div>
      {resolve.error ? <ErrorNote error={resolve.error} /> : null}
      <div className="flex items-center gap-2">
        <Input placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
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
    <Drawer open={open} onClose={() => setDrawer(null)} title={`Approvals (${pending.length})`} testId="approval-drawer" width={480}>
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
