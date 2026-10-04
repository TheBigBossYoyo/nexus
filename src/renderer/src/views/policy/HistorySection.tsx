import { useState } from 'react'
import type { PolicyOverview } from '@shared/v3-read'
import { usePinSnapshot, usePolicyCompare, usePolicySnapshot } from '../../lib/queries-v3'
import { formatDateTime } from '../../lib/format'
import { Badge, Button, Card, Drawer, KeyValue, TimeAgo } from '../../components/ui'
import { BlockSkeleton, Caption, ReadError } from '../usage/shared'
import { strategyName } from '../arena/arenaModel'
import { actionText, diffLines, formatContextKey, snapshotLabel } from './policyModel'

const DIFF_MARK = { added: '+', removed: '−', changed: '~', config: '~' } as const
const DIFF_TEXT = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  config: 'Setting',
} as const
const DIFF_TONE = {
  added: 'success',
  removed: 'danger',
  changed: 'active',
  config: 'neutral',
} as const

function SnapshotDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = usePolicySnapshot(id)
  const s = q.data
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      title={s ? `Policy version ${s.version}` : 'Policy snapshot'}
      width={480}
      testId="policy-snapshot-drawer"
    >
      <div className="flex flex-col gap-4 p-4">
        {q.isPending ? (
          <BlockSkeleton rows={4} />
        ) : q.isError ? (
          <ReadError error={q.error} calm="This snapshot is not available." />
        ) : s ? (
          <>
            <KeyValue
              labelWidth="8rem"
              rows={[
                { label: 'Created', value: formatDateTime(s.createdAt) },
                { label: 'Origin', value: s.origin },
                { label: 'Exploration', value: s.config.exploration },
                { label: 'Speculation', value: s.config.speculation },
                { label: 'Evidence window', value: `${s.config.evidenceWindowDays} days` },
                { label: 'Note', value: s.note ?? '—' },
              ]}
            />
            <div className="flex flex-col gap-1.5">
              <Caption>Learned preferences ({s.preferences.length})</Caption>
              {s.preferences.length === 0 ? (
                <p className="m-0 text-text-muted">None. The default policy applies.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {s.preferences.map((p) => (
                    <li key={p.contextKey} className="rounded-md border px-3 py-1.5">
                      <div className="font-medium">
                        {formatContextKey(p.contextKey)}: {strategyName(p.strategy)}{' '}
                        <span className="font-normal text-text-muted">
                          (replaces {strategyName(p.replaces)})
                        </span>
                      </div>
                      <div className="text-small text-text-muted">{p.reason}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  )
}

function Compare({ a, b }: { a: string; b: string }) {
  const q = usePolicyCompare(a, b)
  if (q.isPending) return <BlockSkeleton rows={2} />
  if (q.isError) return <ReadError error={q.error} calm="Comparison is not available." />
  const lines = diffLines(q.data)
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border bg-surface-muted px-3 py-2"
      data-testid="policy-compare"
    >
      <div className="text-small font-medium">
        {snapshotLabel(q.data.a)} compared with {snapshotLabel(q.data.b)}
      </div>
      {lines.length === 0 ? (
        <p className="m-0 text-text-muted">No differences.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {lines.map((l, i) => (
            <li key={i} className="flex items-center gap-2">
              <Badge tone={DIFF_TONE[l.kind]}>
                <span aria-hidden="true">{DIFF_MARK[l.kind]}</span> {DIFF_TEXT[l.kind]}
              </Badge>
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function HistorySection({ overview }: { overview: PolicyOverview }) {
  const pin = usePinSnapshot()
  const [view, setView] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)
  const pinned = overview.pointer.pinnedId
  const byId = new Map(overview.snapshots.map((s) => [s.id, s]))
  const toggle = (id: string) => {
    setComparing(false)
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)))
  }
  const history = [...overview.history].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
  const snapshots = [...overview.snapshots].sort((a, b) => b.version - a.version)

  return (
    <Card
      title="History"
      description="Every change to the policy is an explicit action and is recorded here."
      data-testid="policy-history"
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-2">
          <Caption>Timeline</Caption>
          {history.length === 0 ? (
            <p className="m-0 text-text-muted">
              No changes yet. The default policy has never been changed.
            </p>
          ) : (
            <ol className="m-0 flex list-none flex-col p-0" data-testid="policy-timeline">
              {history.map((h) => {
                const to = byId.get(h.toSnapshotId)
                return (
                  <li key={h.id} className="relative flex gap-3 pb-3 last:pb-0">
                    <span
                      aria-hidden="true"
                      className="absolute left-[3px] top-2 h-full w-px bg-border last:hidden"
                    />
                    <span
                      aria-hidden="true"
                      className="relative mt-1.5 size-[7px] shrink-0 rounded-full bg-border-strong"
                    />
                    <div className="min-w-0">
                      <div>
                        <span className="font-medium">{actionText(h.action)}</span>
                        {to ? (
                          <span className="text-text-secondary"> · now v{to.version}</span>
                        ) : null}
                      </div>
                      <div className="text-small text-text-muted">
                        <TimeAgo iso={h.createdAt} /> · by {h.by}
                        {h.note ? ` · ${h.note}` : ''}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Caption>Snapshots</Caption>
            <Button
              size="sm"
              disabled={picked.length !== 2}
              onClick={() => setComparing(true)}
              data-testid="policy-compare-button"
            >
              Compare selected
            </Button>
          </div>
          <ul
            className="m-0 flex list-none flex-col rounded-md border p-0"
            data-testid="policy-snapshots"
          >
            {snapshots.map((s) => {
              const active = s.id === overview.pointer.activeId
              const isPinned = s.id === pinned
              return (
                <li
                  key={s.id}
                  className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-accent"
                    checked={picked.includes(s.id)}
                    onChange={() => toggle(s.id)}
                    aria-label={`Select version ${s.version} to compare`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium tnum">v{s.version}</span>
                      {active ? <Badge tone="success">Active</Badge> : null}
                      {isPinned ? <Badge tone="active">Pinned</Badge> : null}
                      <span className="text-small text-text-muted">{s.origin}</span>
                    </div>
                    <div className="truncate text-small text-text-muted">
                      {s.preferences} learned preference{s.preferences === 1 ? '' : 's'} ·{' '}
                      <TimeAgo iso={s.createdAt} />
                      {s.note ? ` · ${s.note}` : ''}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setView(s.id)}
                    data-testid={`policy-view-${s.version}`}
                  >
                    View
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={
                      pin.isPending && pin.variables?.snapshotId === (isPinned ? null : s.id)
                    }
                    onClick={() => pin.mutate({ snapshotId: isPinned ? null : s.id })}
                    data-testid={`policy-pin-${s.version}`}
                  >
                    {isPinned ? 'Unpin' : 'Pin'}
                  </Button>
                </li>
              )
            })}
          </ul>
          {picked.length === 2 && comparing ? (
            <Compare a={picked[0]!} b={picked[1]!} />
          ) : (
            <p className="m-0 text-small text-text-muted">Select two snapshots to compare them.</p>
          )}
        </div>
      </div>
      <SnapshotDrawer id={view} onClose={() => setView(null)} />
    </Card>
  )
}
