import { useState } from 'react'
import type { RecoverableRun } from '@shared/ipc'
import { useRecoverableRuns, useRecoverRun } from '../../lib/queries'
import { runStatus } from '../../lib/status'
import { shortId } from '../../lib/format'
import { useUiStore } from '../../store/ui'
import { Badge, Button, Dialog, StatusBadge, TimeAgo } from '../../components/ui'

type Action = 'resume' | 'inspect' | 'cancel'

function RecoverableItem({ item, onHandled }: { item: RecoverableRun; onHandled: (runId: string) => void }) {
  const recover = useRecoverRun()
  const openRun = useUiStore((s) => s.openRun)
  const { run } = item
  const act = (action: Action) =>
    recover.mutate(
      { runId: run.id, action },
      {
        onSuccess: () => {
          onHandled(run.id)
          if (action !== 'cancel') openRun(run.id, run.projectId)
        },
      },
    )
  // The state the run was in when the app stopped: a paused run remembers it in resumeState.
  const wasIn = runStatus(run.resumeState ?? run.state)
  return (
    <li data-testid="recovery-item" className="flex flex-col gap-2 border-b py-3 first:pt-0 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="font-medium">{item.projectName}</span>
        <Badge mono>{run.mode.toUpperCase()}</Badge>
        <span className="font-mono text-[0.85em] text-fg-faint">{shortId(run.id)}</span>
        <TimeAgo iso={run.startedAt ?? run.createdAt} className="ml-auto text-fg-faint" />
      </div>
      <p className="m-0 line-clamp-3 whitespace-pre-wrap break-words text-fg-muted">{run.prompt}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.88rem] text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          Was <StatusBadge status={wasIn} />
        </span>
        <span>
          <span className="font-mono text-fg">{item.staleAgents}</span> stale agent{item.staleAgents === 1 ? '' : 's'}
        </span>
        <span>
          <span className="font-mono text-fg">{item.activeTasks}</span> active task{item.activeTasks === 1 ? '' : 's'}
        </span>
        <span>
          <span className="font-mono text-fg">{item.worktrees}</span> worktree{item.worktrees === 1 ? '' : 's'}
        </span>
      </div>
      {recover.error ? (
        <div role="alert" className="text-tone-danger">
          {recover.error.message}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" loading={recover.isPending && recover.variables.action === 'resume'} disabled={recover.isPending} onClick={() => act('resume')} data-testid="recover-resume">
          Resume
        </Button>
        <Button size="sm" disabled={recover.isPending} onClick={() => act('inspect')} data-testid="recover-inspect">
          Inspect
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={recover.isPending}
          onClick={() => act('cancel')}
          data-testid="recover-cancel"
          title="Cancel the run. Worktrees and branches are kept."
        >
          Cancel run
        </Button>
      </div>
    </li>
  )
}

/**
 * Shown at startup when runs were interrupted. Nothing is resumed automatically: every run needs an explicit
 * choice. Closing the dialog only postpones the decision until the next start.
 */
export function RecoveryDialog() {
  const query = useRecoverableRuns()
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set())
  const [dismissed, setDismissed] = useState(false)
  const items = (query.data ?? []).filter((r) => !handled.has(r.run.id))
  if (dismissed || items.length === 0) return null
  return (
    <Dialog
      open
      onClose={() => setDismissed(true)}
      title={`Interrupted runs (${items.length})`}
      width={640}
      testId="recovery-dialog"
      footer={<Button onClick={() => setDismissed(true)}>Decide later</Button>}
    >
      <p className="m-0 mb-3 text-fg-muted">
        NEXUS was closed while these runs were active. Their agent processes are gone; nothing resumes until you choose.
      </p>
      <ul className="m-0 list-none p-0">
        {items.map((item) => (
          <RecoverableItem key={item.run.id} item={item} onHandled={(id) => setHandled((s) => new Set(s).add(id))} />
        ))}
      </ul>
    </Dialog>
  )
}
