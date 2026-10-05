import { useState } from 'react'
import type { PolicyCandidate } from '@shared/v3'
import { usePromoteCandidate, useRejectCandidate } from '../../lib/queries-v3'
import { Badge, Button, Card, ConfirmDialog, EmptyState, TimeAgo } from '../../components/ui'
import { evidenceText, evidenceTone } from '../arena/arenaModel'
import { SHADOW_NOTE, formatContextKey, switchText } from './policyModel'

function CandidateCard({ c, onPromote }: { c: PolicyCandidate; onPromote: () => void }) {
  const reject = useRejectCandidate()
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border bg-surface px-4 py-3"
      data-testid={`policy-candidate-${c.id}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{formatContextKey(c.contextKey)}</span>
        <span className="rounded-sm bg-accent-subtle px-1.5 text-body font-semibold text-accent">
          {switchText(c.fromStrategy, c.toStrategy)}
        </span>
        <Badge tone={evidenceTone(c.label)}>{evidenceText(c.label)} evidence</Badge>
        <span className="ml-auto text-small text-text-muted">
          Proposed <TimeAgo iso={c.createdAt} />
        </span>
      </div>
      <p className="m-0 text-small text-text-secondary">
        Evidence: <span className="tnum">{c.arenaTrials}</span> Arena trial
        {c.arenaTrials === 1 ? '' : 's'} (controlled) and <span className="tnum">{c.missions}</span>{' '}
        real mission{c.missions === 1 ? '' : 's'} (observational).
      </p>
      {c.expected.length > 0 ? (
        <ul className="m-0 list-disc pl-5 text-text-secondary">
          {c.expected.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
      <p className="m-0 text-text-secondary">{c.reason}</p>
      {c.shadow ? (
        <div
          className="rounded-md bg-surface-muted px-3 py-2 text-small"
          data-testid="policy-shadow"
        >
          <div className="text-text-secondary">
            Shadow check: replayed <span className="tnum">{c.shadow.profilesReplayed}</span> stored
            task profiles; <span className="tnum">{c.shadow.decisionsChanged}</span> decisions would
            change, <span className="tnum">{c.shadow.changedWithKnownOutcome}</span> with a known
            outcome.
          </div>
          {c.shadow.note ? <div className="text-text-muted">{c.shadow.note}</div> : null}
          <div className="text-text-muted">{SHADOW_NOTE}</div>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          onClick={() => reject.mutate({ candidateId: c.id })}
          loading={reject.isPending}
          data-testid={`policy-reject-${c.id}`}
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={onPromote}
          data-testid={`policy-promote-${c.id}`}
        >
          Promote
        </Button>
      </div>
    </li>
  )
}

export function Candidates({ candidates }: { candidates: readonly PolicyCandidate[] }) {
  const promote = usePromoteCandidate()
  const [pending, setPending] = useState<PolicyCandidate | null>(null)
  const proposed = candidates.filter((c) => c.status === 'proposed')
  return (
    <Card
      title="Candidates"
      description="Proposed changes to the policy. Nothing changes until you promote one."
      data-testid="policy-candidates"
    >
      {proposed.length === 0 ? (
        <EmptyState title="No candidates" className="py-6" data-testid="policy-candidates-empty">
          A candidate appears only after a strategy has enough evidence to be worth proposing. Use
          Learn from evidence to check.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {proposed.map((c) => (
            <CandidateCard key={c.id} c={c} onPromote={() => setPending(c)} />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title="Promote this candidate?"
        confirmLabel="Promote"
        loading={promote.isPending}
        onConfirm={() =>
          pending &&
          promote.mutate({ candidateId: pending.id }, { onSuccess: () => setPending(null) })
        }
        testId="policy-promote-dialog"
      >
        {pending ? (
          <>
            For <strong>{formatContextKey(pending.contextKey)}</strong> the policy will choose{' '}
            <strong>{switchText(pending.fromStrategy, pending.toStrategy)}</strong>. This creates a
            new policy version. You can roll back to the previous one at any time.
          </>
        ) : null}
      </ConfirmDialog>
    </Card>
  )
}
