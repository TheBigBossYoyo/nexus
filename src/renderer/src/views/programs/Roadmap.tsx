import type { Milestone, MilestoneEvidence } from '@shared/program'
import { cn } from '../../lib/cn'
import { Badge, CheckIcon, StatusBadge, XIcon } from '../../components/ui'
import { evidenceSummary, expertiseLabel, gateLabel, milestoneStateInfo } from './programsModel'
import { Empty } from './programsUi'

function Pass({ ok }: { ok: boolean }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 font-medium', ok ? 'text-success' : 'text-danger')}>
      {ok ? <CheckIcon size={12} /> : <XIcon size={12} />}
      {ok ? 'Passed' : 'Failed'}
    </span>
  )
}

/** The verification evidence of a milestone: gates, each criterion with its evidence, verdict, reason, gaps. */
export function EvidenceView({ evidence }: { evidence: MilestoneEvidence }) {
  const accepted = evidence.verdict === 'accepted'
  return (
    <div className="flex flex-col gap-2.5" data-testid="milestone-evidence">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={accepted ? 'success' : 'warning'}>{accepted ? 'Verdict: accepted' : 'Verdict: rejected'}</Badge>
        <span className="text-text-secondary">{evidence.reason}</span>
      </div>
      <div>
        <h4 className="m-0 mb-1 text-caption font-medium text-text-muted">Gates</h4>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {evidence.gates.map((g) => (
            <li key={g.name} className="flex flex-wrap items-baseline gap-x-2" data-gate={g.name} data-passed={g.passed}>
              <Pass ok={g.passed} />
              <span className="font-medium">{gateLabel(g.name)}</span>
              <span className="text-small text-text-secondary">{g.detail}</span>
            </li>
          ))}
        </ul>
      </div>
      {evidence.judgment ? (
        <div>
          <h4 className="m-0 mb-1 text-caption font-medium text-text-muted">Acceptance criteria as judged</h4>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {evidence.judgment.criteria.map((c, i) => (
              <li key={i} className="flex items-start gap-2" data-met={c.met}>
                <span className={cn('mt-0.5 inline-flex shrink-0 items-center gap-1 font-medium', c.met ? 'text-success' : 'text-danger')}>
                  {c.met ? <CheckIcon size={12} /> : <XIcon size={12} />}
                  {c.met ? 'Met' : 'Not met'}
                </span>
                <span className="min-w-0">
                  <span className="block">{c.criterion}</span>
                  <span className="block text-small text-text-secondary">{c.evidence}</span>
                </span>
              </li>
            ))}
          </ul>
          {evidence.judgment.gaps.length > 0 ? (
            <div className="mt-2">
              <h4 className="m-0 mb-0.5 text-caption font-medium text-text-muted">Gaps</h4>
              <ul className="m-0 list-disc pl-5 text-text-secondary">
                {evidence.judgment.gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="m-0 text-small text-text-muted">No verifier judgment was recorded.</p>
      )}
      {evidence.resultCommit ? (
        <p className="m-0 text-small text-text-muted">
          Result commit <span className="font-mono text-code">{evidence.resultCommit.slice(0, 10)}</span>
        </p>
      ) : null}
    </div>
  )
}

function MilestoneRow({ m, isCurrent, last }: { m: Milestone; isCurrent: boolean; last: boolean }) {
  const info = milestoneStateInfo(m.state)
  const settled = m.state === 'COMPLETED' || m.state === 'CANCELLED' || m.state === 'DEFERRED'
  return (
    <li
      data-testid={`milestone-${m.key}`}
      data-state={m.state}
      className="relative pb-4 pl-7 last:pb-0"
      {...(isCurrent ? { 'aria-current': 'step' as const } : {})}
    >
      {last ? null : <span aria-hidden="true" className="absolute bottom-0 left-[9px] top-5 w-px bg-border" />}
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-1 flex size-[19px] items-center justify-center rounded-full border-2 bg-surface',
          m.state === 'COMPLETED' ? 'border-success text-success' : isCurrent ? 'border-accent text-accent' : m.state === 'BLOCKED' ? 'border-warning text-warning' : 'border-border-strong text-text-muted',
        )}
      >
        {m.state === 'COMPLETED' ? <CheckIcon size={11} /> : <span className="tnum text-[10px] font-semibold leading-none">{m.ordinal + 1}</span>}
      </span>
      <div className={cn('rounded-lg border bg-surface px-3.5 py-2.5', isCurrent && 'border-accent/50 ring-1 ring-accent/20')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="m-0 min-w-0 flex-1 text-heading font-semibold">{m.title}</h3>
          {isCurrent ? <Badge tone="active">Current</Badge> : null}
          <StatusBadge status={info} />
        </div>
        <p className="m-0 mt-1 text-text-secondary">{m.objective}</p>
        <ul className="m-0 mt-1.5 list-disc pl-5 text-small text-text-secondary" aria-label="Acceptance criteria">
          {m.acceptanceCriteria.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-text-muted">
          <span>
            Expertise <span className="font-medium text-text-secondary">{expertiseLabel(m.expertise)}</span>
          </span>
          <span className="tnum">
            Missions used <span className="font-medium text-text-secondary">{m.attempts}</span>
          </span>
          <span>
            Dependencies{' '}
            <span className="font-mono text-code text-text-secondary">{m.dependsOn.length ? m.dependsOn.join(', ') : 'none'}</span>
          </span>
          <span className="font-mono text-code">{m.key}</span>
        </div>
        {m.blockedReason ? (
          <p className="m-0 mt-2 text-small text-warning" data-testid={`milestone-${m.key}-blocked`}>
            Blocked: {m.blockedReason}
          </p>
        ) : null}
        {!m.evidence && m.gaps.length > 0 ? (
          <div className="mt-2 text-small text-text-secondary">
            Gaps from the last attempt:
            <ul className="m-0 list-disc pl-5">
              {m.gaps.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {m.evidence ? (
          <details className="mt-2 rounded-md border bg-surface-muted px-3 py-2" {...(settled ? {} : { open: true })}>
            <summary className="cursor-pointer font-medium text-text-primary" data-testid={`milestone-${m.key}-evidence-summary`}>
              Verification evidence <span className="font-normal text-text-secondary">· {evidenceSummary(m.evidence)}</span>
            </summary>
            <div className="mt-2">
              <EvidenceView evidence={m.evidence} />
            </div>
          </details>
        ) : null}
      </div>
    </li>
  )
}

export function Roadmap({ roadmap, currentMilestoneId }: { roadmap: readonly Milestone[]; currentMilestoneId: string | null }) {
  if (roadmap.length === 0)
    return <Empty testId="program-roadmap-empty">There is no accepted plan yet. The roadmap appears when a plan is accepted.</Empty>
  const rows = [...roadmap].sort((a, b) => a.ordinal - b.ordinal)
  return (
    <ol className="m-0 list-none p-0" aria-label="Milestones in order">
      {rows.map((m, i) => (
        <MilestoneRow key={m.id} m={m} isCurrent={m.id === currentMilestoneId} last={i === rows.length - 1} />
      ))}
    </ol>
  )
}
