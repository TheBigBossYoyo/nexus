import type { ReleaseTrain, WorkspaceDetail } from '@shared/workspace'
import { useCancelRelease } from '../../lib/queries-v5'
import { Badge, BranchIcon, Button, ConfirmDialog, ErrorNote, InfoIcon, Notice, StatusBadge, TimeAgo } from '../../components/ui'
import { useState } from 'react'
import { Empty } from '../programs/programsUi'
import { RELEASE_STATEMENT, releaseStateInfo, shortCommit, versionChange } from './workspacesModel'
import { H3, Mono } from './workspacesUi'

function TrainCard({ train, onCancel }: { train: ReleaseTrain; onCancel: (t: ReleaseTrain) => void }) {
  const info = releaseStateInfo(train.state)
  return (
    <li className="list-none">
      <article className="flex flex-col gap-3 rounded-lg border bg-surface p-4" data-testid={`release-${train.id}`} data-state={train.state}>
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="m-0 flex flex-wrap items-center gap-2 text-heading font-semibold">
            {train.name}
            <span data-testid={`release-state-${train.id}`}>
              <StatusBadge status={info} />
            </span>
          </h3>
          {train.state === 'PREPARED' ? (
            <Button size="sm" variant="danger" onClick={() => onCancel(train)} aria-label={`Cancel release train ${train.name}`} data-testid={`release-cancel-${train.id}`}>
              Cancel train
            </Button>
          ) : null}
        </header>
        <p className="m-0 text-small text-text-muted">
          Prepared <TimeAgo iso={train.createdAt} />
          {train.missionId ? ' from a workspace mission' : ''}. Publishing is not available.
        </p>

        {train.plan.problems.length > 0 ? (
          <Notice tone="warning" title="Problems with this plan" data-testid={`release-problems-${train.id}`}>
            <ul className="m-0 list-disc pl-5">
              {train.plan.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </Notice>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <H3>Release in this order</H3>
          {train.plan.steps.length === 0 ? (
            <p className="m-0 text-small text-text-muted">This train has no steps.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label={`Steps of ${train.name} in release order`}>
              {train.plan.steps.map((s, i) => (
                <li key={s.repository} className="rounded-md border bg-surface-muted px-3 py-2" data-testid={`release-step-${s.repository}`} data-bump={s.bump}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="tnum text-small text-text-muted">{i + 1}.</span>
                    <span className="font-mono font-medium">{s.repository}</span>
                    <span className="tnum" data-testid={`release-version-${s.repository}`}>
                      {versionChange(s)}
                    </span>
                    <Badge tone={s.bump === 'major' ? 'warning' : 'neutral'}>{s.bump === 'none' ? 'No bump' : `${s.bump} bump`}</Badge>
                  </div>
                  <p className="m-0 mt-1 text-small text-text-secondary">{s.reason}</p>
                  <dl className="m-0 mt-1 flex flex-wrap gap-x-6 gap-y-0.5 text-small">
                    <div className="flex gap-1.5">
                      <dt className="text-text-muted">After</dt>
                      <dd className="m-0">{s.after.length > 0 ? <Mono>{s.after.join(', ')}</Mono> : 'nothing: it can go first'}</dd>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <dt className="text-text-muted">
                        <BranchIcon size={12} className="inline" /> Branch
                      </dt>
                      <dd className="m-0">{s.branch ? <Mono className="break-all">{s.branch}</Mono> : <span className="text-text-muted">None</span>}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-text-muted">Commit</dt>
                      <dd className="m-0">{s.commit ? <Mono>{shortCommit(s.commit)}</Mono> : <span className="text-text-muted">None</span>}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </div>
      </article>
    </li>
  )
}

export function ReleasesTab({ detail }: { detail: WorkspaceDetail }) {
  const cancel = useCancelRelease()
  const [cancelling, setCancelling] = useState<ReleaseTrain | null>(null)
  const trains = [...detail.releaseTrains].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <div className="flex flex-col gap-3" data-testid="workspace-releases">
      <p className="m-0 flex items-start gap-2 rounded-md border bg-surface-muted px-3 py-2 font-medium" data-testid="release-statement">
        <InfoIcon size={14} className="mt-0.5 shrink-0 text-text-muted" />
        <span>{RELEASE_STATEMENT}</span>
      </p>
      {trains.length === 0 ? (
        <Empty testId="workspace-releases-empty">No release trains yet. When a mission is completed, prepare a release train from it to get the order and the version bumps.</Empty>
      ) : (
        <ul className="m-0 flex flex-col gap-3 p-0" aria-label="Release trains">
          {trains.map((t) => (
            <TrainCard key={t.id} train={t} onCancel={setCancelling} />
          ))}
        </ul>
      )}
      {cancel.isError && !cancelling ? <ErrorNote error={cancel.error} /> : null}
      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel this release train?"
        confirmLabel="Cancel train"
        danger
        loading={cancel.isPending}
        testId="release-cancel-dialog"
        onConfirm={() => {
          if (cancelling) cancel.mutate({ trainId: cancelling.id }, { onSuccess: () => setCancelling(null) })
        }}
      >
        The prepared plan is marked cancelled. Nothing was published, so nothing needs undoing.
        {cancel.isError ? <ErrorNote error={cancel.error} className="mt-2" /> : null}
      </ConfirmDialog>
    </div>
  )
}
