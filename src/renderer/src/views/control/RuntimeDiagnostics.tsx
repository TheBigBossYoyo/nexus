import { useState } from 'react'
import { qkControl, qkRuntime, useRuntimeStatus, useRuntimeWorkers } from '../../lib/queries-v7'
import { useWrite } from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import { Badge, Button, Card, ConfirmDialog, ErrorNote, KeyValue, TimeAgo } from '../../components/ui'
import {
  identityRows,
  leaseRow,
  shortId,
  SHUTDOWN_CONFIRMATION,
  workerRow,
  type WorkerRow,
} from './runtimeModel'

/** The workers and the runtime's identity. Diagnostics, not primary UX: closed until asked for, and reads nothing while closed. */
const EVENT_LIMIT = 25

function Table({
  label,
  testId,
  head,
  children,
}: {
  label: string
  testId: string
  head: string[]
  children: React.ReactNode
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-small" aria-label={label} data-testid={testId}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="whitespace-nowrap border-b px-2 py-1 text-caption font-medium text-text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function WorkerTr({ row }: { row: WorkerRow }) {
  return (
    <tr
      className={row.attention ? 'bg-warning-subtle' : undefined}
      data-testid={`worker-row-${row.id}`}
      data-state={row.state}
      data-attention={row.attention}
    >
      <td className="whitespace-nowrap px-2 py-1 font-mono text-code" title={row.id}>
        {row.short}
      </td>
      <td className="px-2 py-1 tnum">{row.pid}</td>
      <td className="px-2 py-1">
        <Badge tone={row.tone}>{row.state}</Badge>
        {row.error ? <span className="ml-1 text-danger">{row.error}</span> : null}
      </td>
      <td className="px-2 py-1">{row.assignment}</td>
      <td className="px-2 py-1">{row.provider}</td>
      <td className="px-2 py-1 font-mono text-code">{row.session}</td>
      <td className={`whitespace-nowrap px-2 py-1 tnum ${row.heartbeatLate ? 'font-medium text-warning' : ''}`}>
        {row.heartbeat}
        {row.heartbeatLate ? ' (late)' : ''}
      </td>
      <td className="whitespace-nowrap px-2 py-1 tnum">{row.duration}</td>
      <td className="max-w-[16rem] truncate px-2 py-1 font-mono text-code" title={row.worktreeFull || undefined}>
        {row.worktree}
      </td>
      <td className="px-2 py-1 tnum">{row.assignments}</td>
    </tr>
  )
}

function Body() {
  const now = useNow(true, 5_000)
  const status = useRuntimeStatus()
  const workers = useRuntimeWorkers()
  const [confirming, setConfirming] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  const shutdown = useWrite('runtime.stop', (qc) => {
    void qc.invalidateQueries({ queryKey: qkRuntime.root() })
    void qc.invalidateQueries({ queryKey: qkControl.root() })
  })
  const w = workers.data
  return (
    <div className="flex flex-col gap-4" data-testid="runtime-diagnostics-body">
      {status.error ? <ErrorNote error={status.error} /> : null}
      {status.data ? (
        <KeyValue rows={identityRows(status.data)} labelWidth="11rem" />
      ) : status.error ? null : (
        <p className="m-0 text-small text-text-muted" role="status">
          Reading the runtime…
        </p>
      )}
      <div>
        <h3 className="m-0 mb-1 text-heading font-semibold">Workers</h3>
        {workers.error ? <ErrorNote error={workers.error} /> : null}
        {w && !w.enabled ? (
          <p className="m-0 text-small text-text-muted" data-testid="workers-disabled">
            Agent sessions run inside the runtime process; there are no worker processes to show.
          </p>
        ) : null}
        {w && w.enabled ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-small text-text-secondary" data-testid="workers-counts">
              {w.counts.live} live of {w.limits.maxWorkers} · {w.counts.busy} busy · {w.counts.idle} idle ·{' '}
              {w.counts.waitingAssignments} assignment{w.counts.waitingAssignments === 1 ? '' : 's'} waiting
            </p>
            {w.workers.length === 0 ? (
              <p className="m-0 text-small text-text-muted">No worker has started yet.</p>
            ) : (
              <Table
                label="Workers"
                testId="workers-table"
                head={['Worker', 'PID', 'State', 'Assignment', 'Provider', 'Session', 'Heartbeat', 'Running for', 'Worktree', 'Assignments']}
              >
                {w.workers.map((x) => (
                  <WorkerTr key={x.id} row={workerRow(x, now)} />
                ))}
              </Table>
            )}
            <div>
              <h3 className="m-0 mb-1 text-heading font-semibold">Recent leases</h3>
              {w.leases.length === 0 ? (
                <p className="m-0 text-small text-text-muted">No lease yet.</p>
              ) : (
                <Table label="Recent leases" testId="leases-table" head={['State', 'Agent', 'Worker', 'Granted', 'Ends', 'Reason']}>
                  {w.leases.map((l) => {
                    const r = leaseRow(l, now)
                    return (
                      <tr key={r.id} data-testid={`lease-row-${r.id}`} data-state={r.state}>
                        <td className="px-2 py-1">
                          <Badge tone={r.tone}>{r.state}</Badge>
                        </td>
                        <td className="px-2 py-1 font-mono text-code">{r.agent}</td>
                        <td className="px-2 py-1 font-mono text-code">{r.worker}</td>
                        <td className="whitespace-nowrap px-2 py-1">{r.granted}</td>
                        <td className="whitespace-nowrap px-2 py-1">{r.ends}</td>
                        <td className="px-2 py-1">{r.reason}</td>
                      </tr>
                    )
                  })}
                </Table>
              )}
            </div>
            <div>
              <h3 className="m-0 mb-1 text-heading font-semibold">Recent worker events</h3>
              {w.events.length === 0 ? (
                <p className="m-0 text-small text-text-muted">None.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="worker-events">
                  {w.events.slice(0, EVENT_LIMIT).map((e, i) => (
                    <li key={`${e.at}-${i}`} className="text-small">
                      <span className="text-text-muted">
                        <TimeAgo iso={e.at} />
                      </span>{' '}
                      <span className="font-mono text-code" title={e.workerId}>
                        {shortId(e.workerId)}
                      </span>{' '}
                      {e.kind.replace(/_/g, ' ')}
                      {e.detail ? `: ${e.detail}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col items-start gap-2 border-t pt-3">
        <Button
          variant="danger"
          onClick={() => (shutdown.reset(), setConfirming(true))}
          data-testid="runtime-shutdown"
        >
          Stop NEXUS runtime…
        </Button>
        {stopped ? (
          <p className="m-0 text-small text-text-secondary" role="status" data-testid="runtime-shutdown-result">
            {stopped}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() =>
          shutdown.mutate(
            {},
            {
              onSuccess: (r) => {
                setConfirming(false)
                setStopped(r.stopping ? 'The runtime is stopping.' : 'The runtime kept running.')
              },
            },
          )
        }
        title={SHUTDOWN_CONFIRMATION.title}
        confirmLabel={SHUTDOWN_CONFIRMATION.confirmLabel}
        cancelLabel={SHUTDOWN_CONFIRMATION.keepLabel}
        danger
        loading={shutdown.isPending}
        testId="runtime-shutdown-dialog"
      >
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {SHUTDOWN_CONFIRMATION.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {shutdown.error ? <ErrorNote className="mt-3" error={shutdown.error} /> : null}
      </ConfirmDialog>
    </div>
  )
}

export function RuntimeDiagnostics() {
  const [open, setOpen] = useState(false)
  return (
    <Card
      title="Runtime diagnostics"
      description="The runtime process, its workers and leases. For troubleshooting."
      actions={
        <Button
          size="sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="runtime-diagnostics-region"
          data-testid="runtime-diagnostics-toggle"
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      }
      data-testid="runtime-diagnostics"
    >
      <div id="runtime-diagnostics-region">{open ? <Body /> : null}</div>
    </Card>
  )
}
