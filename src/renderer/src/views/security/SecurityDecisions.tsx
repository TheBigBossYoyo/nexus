import { useMemo, useState } from 'react'
import type { SecurityDecisionRecord } from '@shared/security'
import { useSecurityDecisions } from '../../lib/queries-security'
import { shortId } from '../../lib/format'
import { Badge, Button, Card, EmptyState, TimeAgo } from '../../components/ui'
import { BlockSkeleton, LoadMore, ReadError } from '../usage/shared'
import { DECISION_LABEL, DECISION_TONE, PROVENANCE_LABEL, TRUST_LABEL } from './securityModel'

/**
 * The newest security decisions, optionally for one mission: refusals, approval requests and logged allowances only
 * (a plain allow of a read-only command is not recorded). One block per decision, so the command and the reason are
 * read in full at any width: the command wraps, the reason is never cut, and no column scrolls out of view.
 */
function DecisionRow({ d }: { d: SecurityDecisionRecord }) {
  const [open, setOpen] = useState(false)
  const detailsId = `security-decision-details-${d.id}`
  return (
    <li className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0" data-testid={`security-decision-${d.id}`} data-decision={d.decision}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={DECISION_TONE[d.decision]}>{DECISION_LABEL[d.decision]}</Badge>
        <TimeAgo iso={d.timestamp} className="whitespace-nowrap text-small text-text-muted" />
        <span className="whitespace-nowrap text-small text-text-secondary" title={TRUST_LABEL[d.classification]}>
          {TRUST_LABEL[d.classification]}
        </span>
        {/* Provenance has its own place in the expanded details below 1100 px. */}
        <span className="hidden whitespace-nowrap text-small text-text-secondary min-[1100px]:inline" data-testid={`security-provenance-${d.id}`}>
          · {PROVENANCE_LABEL[d.provenance]}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((v) => !v)}
          data-testid={`security-decision-toggle-${d.id}`}
        >
          {open ? 'Hide details' : 'Details'}
        </Button>
      </div>
      <p className="m-0 whitespace-pre-wrap break-all font-mono text-code text-text-primary" title={d.action}>
        {d.action}
      </p>
      <p className="m-0 text-text-secondary">{d.reason}</p>
      {open ? (
        <dl
          id={detailsId}
          className="m-0 mt-1 grid gap-x-4 gap-y-1 rounded-md border bg-surface-muted px-3 py-2 text-small"
          style={{ gridTemplateColumns: '8rem minmax(0,1fr)' }}
          data-testid={`security-decision-details-${d.id}`}
        >
          {[
            ['Classification', TRUST_LABEL[d.classification]],
            ['Provenance', PROVENANCE_LABEL[d.provenance]],
            ['Mission', d.runId ? shortId(d.runId) : '—'],
            ['Task', d.taskId ? shortId(d.taskId) : '—'],
            ['Agent', d.agentId ? shortId(d.agentId) : '—'],
            ['Policy version', d.policyVersion],
          ].map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-text-muted">{label}</dt>
              <dd className="m-0 min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  )
}

export function SecurityDecisions({ runId = null }: { runId?: string | null }) {
  const q = useSecurityDecisions(runId)
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.decisions) ?? [], [q.data])
  return (
    <Card
      title="Commands NEXUS refused or asked about"
      description="Why was this blocked? These are the commands and scripts NEXUS refused, asked you about or let through with a log entry. NEXUS inspects them before they run; this is not a sandbox."
      data-testid="security-decisions"
    >
      {q.isPending ? (
        <BlockSkeleton rows={4} />
      ) : q.isError ? (
        <ReadError error={q.error} calm="The security log is not available yet." onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing recorded" className="py-6">
          No command or script has been refused, held for approval or logged yet.
        </EmptyState>
      ) : (
        <>
          <ul className="m-0 list-none rounded-lg border bg-surface p-0" aria-label="Recent security decisions">
            {rows.map((d) => (
              <DecisionRow key={d.id} d={d} />
            ))}
          </ul>
          {q.hasNextPage ? <LoadMore onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>Load older</LoadMore> : null}
        </>
      )}
    </Card>
  )
}
