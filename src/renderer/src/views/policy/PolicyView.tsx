import { useState } from 'react'
import type { LearnResult } from '@shared/v3-read'
import {
  usePolicyOverview,
  useLearn,
  useRollbackPolicy,
  useSetPolicyConfig,
} from '../../lib/queries-v3'
import { formatDateTime } from '../../lib/format'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  PolicyIcon,
  Select,
  Stat,
} from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import { Candidates } from './Candidates'
import { ContextsTable } from './ContextsTable'
import { Decisions } from './Decisions'
import { HistorySection } from './HistorySection'
import {
  EPISTEMIC_LINE,
  EXPLORATION_HINT,
  EXPLORATION_OPTIONS,
  SPECULATION_OPTIONS,
  canRollback,
} from './policyModel'

function LearnResultNote({ r, onDismiss }: { r: LearnResult; onDismiss: () => void }) {
  return (
    <div
      className="rounded-lg border border-info/30 bg-info-subtle px-4 py-3"
      role="status"
      data-testid="policy-learn-result"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-medium text-text-primary">
          Computed statistics for {r.statistics} group{r.statistics === 1 ? '' : 's'}.{' '}
          {r.candidates.length === 0
            ? 'No candidate was proposed.'
            : `${r.candidates.length} candidate${r.candidates.length === 1 ? '' : 's'} proposed, shown below.`}
        </div>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {r.notes.length > 0 ? (
        <ul className="m-0 mt-1 list-disc pl-5 text-text-secondary">
          {r.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Adaptive policy: what NEXUS prefers per kind of task, why, and every explicit change to it. */
export function PolicyView() {
  const q = usePolicyOverview()
  const learn = useLearn()
  const rollback = useRollbackPolicy()
  const config = useSetPolicyConfig()
  const [learned, setLearned] = useState<LearnResult | null>(null)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const o = q.data
  const pinned = !!o?.pointer.pinnedId
  const cfg = o?.active.config
  const noEvidence = !!o && o.evidence.arenaCampaigns === 0 && o.evidence.arenaTrials === 0 && o.evidence.missions === 0
  const nothingYet = !!o && o.contexts.length === 0 && o.candidates.length === 0 && o.history.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="policy-view">
      <PageHeader
        title="Policy"
        context="Intelligence"
        actions={
          <>
            {o ? (
              <span className="inline-flex items-center gap-1.5" data-testid="policy-version">
                <Badge tone="neutral" mono>
                  v{o.active.version}
                </Badge>
                {pinned ? (
                  <Badge tone="active" data-testid="policy-pinned">
                    Pinned
                  </Badge>
                ) : null}
              </span>
            ) : null}
            <Button
              size="sm"
              loading={learn.isPending}
              disabled={!o || noEvidence}
              title={noEvidence ? 'No evidence yet. Run an Arena campaign or complete missions first.' : undefined}
              onClick={() => learn.mutate({}, { onSuccess: setLearned })}
              data-testid="policy-learn"
            >
              Learn from evidence
            </Button>
            <Button
              size="sm"
              disabled={!o || !canRollback(o.pointer)}
              onClick={() => setConfirmRollback(true)}
              data-testid="policy-rollback"
            >
              Rollback
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-5">
          {q.isPending ? (
            <BlockSkeleton rows={5} testId="policy-loading" />
          ) : q.isError || !o ? (
            <ReadError
              error={q.error}
              calm="The adaptive policy is not available in this build yet."
              onRetry={() => void q.refetch()}
            />
          ) : (
            <>
              <Card data-testid="policy-summary">
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
                  <Stat
                    label="Policy version"
                    value={`v${o.active.version}`}
                    hint={pinned ? 'Pinned by you' : o.active.origin}
                  />
                  <Stat
                    label="Arena trials"
                    value={o.evidence.arenaTrials}
                    hint={`${o.evidence.arenaCampaigns} campaign${o.evidence.arenaCampaigns === 1 ? '' : 's'}`}
                  />
                  <Stat
                    label="Real mission outcomes"
                    value={o.evidence.missions}
                    hint="Observational"
                  />
                  <Stat label="Learned preferences" value={o.active.preferences.length} />
                  <Stat
                    label="Last computed"
                    value={
                      <span className={o.evidence.computedAt ? 'text-body font-medium' : 'text-body font-normal text-text-muted'}>
                        {o.evidence.computedAt ? formatDateTime(o.evidence.computedAt) : 'Never'}
                      </span>
                    }
                  />
                </div>
                <p className="m-0 mt-3 border-t pt-2 text-small text-text-muted">
                  {EPISTEMIC_LINE}
                </p>
              </Card>
              {learned ? <LearnResultNote r={learned} onDismiss={() => setLearned(null)} /> : null}
              {cfg ? (
                <Card title="Policy settings" description="How NEXUS tries alternatives and whether it may run candidates in parallel." data-testid="policy-config">
                  <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <label className="font-medium" htmlFor="policy-exploration-select">
                        Exploration
                      </label>
                      <Select
                        id="policy-exploration-select"
                        className="w-48!"
                        value={cfg.exploration}
                        options={EXPLORATION_OPTIONS}
                        onChange={(v) => config.mutate({ exploration: v })}
                        data-testid="policy-exploration"
                        disabled={config.isPending}
                      />
                      <span className="text-small text-text-muted">{EXPLORATION_HINT[cfg.exploration]}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-medium" htmlFor="policy-speculation-select">
                        Speculation
                      </label>
                      <Select
                        id="policy-speculation-select"
                        className="w-48!"
                        value={cfg.speculation}
                        options={SPECULATION_OPTIONS}
                        onChange={(v) => config.mutate({ speculation: v })}
                        data-testid="policy-speculation"
                        disabled={config.isPending}
                      />
                      <span className="text-small text-text-muted">Whether risky tasks may try two or three candidates side by side.</span>
                    </div>
                  </div>
                </Card>
              ) : null}
              {nothingYet ? (
                <Card>
                  <EmptyState icon={<PolicyIcon size={20} />} title="The default policy is active" data-testid="policy-empty">
                    <span data-testid="policy-candidates-empty">
                      NEXUS has no recorded evidence yet, so there are no learned preferences, candidates or history. Run an Arena
                      campaign or complete missions, then use Learn from evidence.
                    </span>
                  </EmptyState>
                </Card>
              ) : (
                <>
                  <ContextsTable rows={o.contexts} />
                  <Candidates candidates={o.candidates} />
                  <HistorySection overview={o} />
                </>
              )}
              <Decisions />
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmRollback}
        onClose={() => setConfirmRollback(false)}
        title="Roll back the policy?"
        confirmLabel="Roll back"
        loading={rollback.isPending}
        onConfirm={() => rollback.mutate({}, { onSuccess: () => setConfirmRollback(false) })}
        testId="policy-rollback-dialog"
      >
        The previous policy version becomes active again. Learned preferences promoted since then
        stop applying. History is kept.
      </ConfirmDialog>
    </div>
  )
}
