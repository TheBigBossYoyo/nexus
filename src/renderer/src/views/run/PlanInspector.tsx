import { useMemo, useState, type ReactNode } from 'react'
import type { MissionPlan } from '@shared/domain'
import type { GraphProposal, GraphRevision, PlanningCandidate, PlanningCritique, ProposalStatus } from '@shared/v2'
import { Badge, ErrorNote, Loading, Select } from '../../components/ui'
import { formatCost, formatDateTime, formatDuration } from '../../lib/format'
import { useGraphProposals, useGraphRevisions, usePlanningCandidates } from '../../lib/queries'
import { severityStatus, type Tone } from '../../lib/status'
import { diffSnapshots, isEmptyDiff, sortRevisions } from '../../lib/v2logic'
import { CandidatesSection } from './CandidatesSection'
import { useRunCtx } from './runContext'

function Section({ title, count, testId, children }: { title: string; count?: number; testId?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h3 className="m-0 border-b pb-1 text-heading font-semibold text-text-primary">
        {title}
        {count !== undefined ? <span className="ml-1.5 font-mono text-text-muted">{count}</span> : null}
      </h3>
      {children}
    </section>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <div className="text-text-muted">{children}</div>
}

function PlanTaskList({ plan }: { plan: MissionPlan }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {plan.tasks.map((t) => (
        <li key={t.id} className="flex flex-col gap-0.5 border-l-2 border-border-strong pl-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-small">{t.id}</span>
            <Badge mono>{t.role}</Badge>
            <span className="text-text-muted">
              {t.complexity} complexity · {t.risk} risk
            </span>
          </div>
          <div>{t.title}</div>
          {t.dependencies.length > 0 ? <div className="font-mono text-small text-text-muted">after {t.dependencies.join(', ')}</div> : null}
        </li>
      ))}
    </ul>
  )
}

function CandidateCard({ candidate: c }: { candidate: PlanningCandidate }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="flex flex-col gap-1 rounded-md border bg-surface p-2" data-testid="plan-candidate" data-valid={c.valid ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.label}</span>
        <Badge tone={c.valid ? 'success' : 'danger'}>{c.valid ? 'valid' : 'invalid'}</Badge>
        <span className="text-text-secondary">{c.lens}</span>
        <span className="ml-auto flex gap-3 font-mono text-small text-text-secondary">
          <span>{c.model ?? 'model unknown'}</span>
          <span>{formatDuration(c.durationMs)}</span>
          {c.costUsd !== null ? <span>{formatCost(c.costUsd)}</span> : null}
        </span>
      </div>
      {c.errors.length > 0 ? (
        <ul className="m-0 list-disc pl-5 text-tone-danger">
          {c.errors.map((e, i) => (
            <li key={i} className="break-words">
              {e}
            </li>
          ))}
        </ul>
      ) : null}
      {c.plan ? (
        <>
          <button
            type="button"
            className="self-start text-accent hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            data-testid="candidate-toggle"
          >
            {open ? 'Hide' : 'Show'} {c.plan.tasks.length} task{c.plan.tasks.length === 1 ? '' : 's'}
          </button>
          {open ? (
            <div className="flex flex-col gap-1.5">
              <p className="m-0 whitespace-pre-wrap break-words text-text-secondary">{c.plan.summary}</p>
              <PlanTaskList plan={c.plan} />
            </div>
          ) : null}
        </>
      ) : (
        <Muted>No plan was produced.</Muted>
      )}
    </article>
  )
}

function CritiqueCard({ critique }: { critique: PlanningCritique }) {
  const o = critique.output
  return (
    <article className="flex flex-col gap-1.5 rounded-md border bg-surface p-2" data-testid="plan-critique">
      <p className="m-0 whitespace-pre-wrap break-words">{o.summary}</p>
      <div>
        <span className="text-text-muted">Preferred candidate: </span>
        <span className="font-medium" data-testid="critique-preferred">
          {o.preferredCandidate}
        </span>
      </div>
      {o.findings.length === 0 ? (
        <Muted>No findings.</Muted>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {o.findings.map((f, i) => {
            const sev = severityStatus(f.severity)
            return (
              <li key={i} className="flex flex-col gap-0.5 border-l-2 border-tone-review bg-surface-muted px-2 py-1" data-testid="critique-finding">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={sev.tone}>{sev.label}</Badge>
                  <span className="font-mono text-small text-text-secondary">{f.candidate}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{f.issue}</div>
                {f.recommendation ? (
                  <div className="whitespace-pre-wrap break-words text-text-secondary">
                    <span className="text-text-muted">Recommendation: </span>
                    {f.recommendation}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}

function DiffList({ title, tone, lines }: { title: string; tone: Tone; lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[0.85rem] text-text-secondary">
        <Badge tone={tone}>{title}</Badge> <span className="font-mono text-text-muted">{lines.length}</span>
      </div>
      <ul className="m-0 list-none p-0 font-mono text-small">
        {lines.map((l, i) => (
          <li key={i} className="break-words">
            {l}
          </li>
        ))}
      </ul>
    </div>
  )
}

function RevisionDiffView({ from, to }: { from: GraphRevision; to: GraphRevision }) {
  const diff = useMemo(() => diffSnapshots(from.snapshot, to.snapshot), [from, to])
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-surface p-2" data-testid="revision-diff">
      <div className="text-text-secondary">
        Changes from v{from.version} to v{to.version}
      </div>
      {isEmptyDiff(diff) ? <Muted>No differences between these snapshots.</Muted> : null}
      <DiffList title="Tasks added" tone="success" lines={diff.addedTasks.map((t) => `${t.key}  ${t.title} (${t.role}, ${t.state})`)} />
      <DiffList title="Tasks removed" tone="danger" lines={diff.removedTasks.map((t) => `${t.key}  ${t.title}`)} />
      <DiffList title="Tasks changed" tone="waiting" lines={diff.changedTasks.map((t) => `${t.key}  ${t.changes.join('; ')}`)} />
      <DiffList title="Dependencies added" tone="success" lines={diff.addedDependencies.map((d) => `${d.taskKey} after ${d.dependsOnKey}`)} />
      <DiffList title="Dependencies removed" tone="danger" lines={diff.removedDependencies.map((d) => `${d.taskKey} no longer after ${d.dependsOnKey}`)} />
    </div>
  )
}

function Revisions({ revisions }: { revisions: readonly GraphRevision[] }) {
  const sorted = useMemo(() => sortRevisions(revisions), [revisions])
  const latest = sorted[sorted.length - 1]
  const [fromChoice, setFromChoice] = useState<number | null>(null)
  const [toChoice, setToChoice] = useState<number | null>(null)

  if (!latest) {
    return <Muted>No graph revisions. The plan is at v1 until an agent proposes a change that is applied.</Muted>
  }
  const to = sorted.find((r) => r.version === toChoice) ?? latest
  const from = sorted.find((r) => r.version === fromChoice) ?? sorted[Math.max(0, sorted.indexOf(to) - 1)] ?? to
  const options = sorted.map((r) => ({ value: String(r.version), label: `v${r.version}` }))

  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col p-0" data-testid="revision-list">
        {[...sorted].reverse().map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-2 border-b py-1" data-testid="revision-item" data-version={r.version}>
            <Badge mono tone={r.version === latest.version ? 'active' : 'neutral'}>
              v{r.version}
            </Badge>
            <span className="min-w-0 flex-1 break-words">{r.reason}</span>
            <span className="font-mono text-small text-text-muted">{r.snapshot.tasks.length} tasks</span>
            <span className="text-text-muted">{formatDateTime(r.createdAt)}</span>
          </li>
        ))}
      </ul>
      {sorted.length > 1 ? (
        <>
          <div className="flex items-center gap-2">
            <label htmlFor="rev-from" className="text-text-secondary">
              Compare
            </label>
            <Select id="rev-from" className="w-auto!" value={String(from.version)} onChange={(v) => setFromChoice(Number(v))} options={options} data-testid="revision-from" />
            <label htmlFor="rev-to" className="text-text-secondary">
              with
            </label>
            <Select id="rev-to" className="w-auto!" value={String(to.version)} onChange={(v) => setToChoice(Number(v))} options={options} data-testid="revision-to" />
          </div>
          <RevisionDiffView from={from} to={to} />
        </>
      ) : null}
    </div>
  )
}

const PROPOSAL_STATUS: Record<ProposalStatus, { label: string; tone: Tone }> = {
  proposed: { label: 'proposed', tone: 'active' },
  awaiting_approval: { label: 'awaiting approval', tone: 'waiting' },
  applied: { label: 'applied', tone: 'success' },
  rejected: { label: 'rejected', tone: 'danger' },
}

function ProposalList({ proposals }: { proposals: readonly GraphProposal[] }) {
  const sorted = useMemo(() => [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [proposals])
  if (sorted.length === 0) return <Muted>No graph change proposals.</Muted>
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="proposal-list">
      {sorted.map((p) => {
        const st = PROPOSAL_STATUS[p.status]
        return (
          <li key={p.id} className="flex flex-col gap-1 rounded-md border bg-surface p-2" data-testid="proposal" data-status={p.status}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge mono>{p.type}</Badge>
              <Badge tone={st.tone}>{st.label}</Badge>
              <span className="text-text-secondary">by {p.proposedBy}</span>
              <span className="ml-auto text-text-muted">{formatDateTime(p.createdAt)}</span>
            </div>
            <div className="whitespace-pre-wrap break-words">{p.reason}</div>
            <div className="whitespace-pre-wrap break-words text-text-secondary">
              <span className="text-text-muted">Evidence: </span>
              {p.evidence}
            </div>
            {p.changes.tasks.length > 0 ? (
              <div className="font-mono text-small text-text-muted">tasks: {p.changes.tasks.map((t) => t.key).join(', ')}</div>
            ) : null}
            {p.changes.targetTask ? (
              <div className="font-mono text-small text-text-muted">
                target: {p.changes.targetTask}
                {p.changes.dependsOn ? ` after ${p.changes.dependsOn}` : ''}
              </div>
            ) : null}
            {p.rejectionReason ? (
              <div className="border-l-2 border-tone-danger bg-tone-danger/10 px-2 py-1 text-tone-danger" data-testid="proposal-rejection">
                {p.rejectionReason}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** Plan Inspector: how the plan came to be (candidates, critique, synthesis) and how it changed since (revisions, proposals). */
export function PlanInspector() {
  const { detail } = useRunCtx()
  const { run } = detail
  const candidates = usePlanningCandidates(run.id)
  const revisions = useGraphRevisions(run.id)
  const proposals = useGraphProposals(run.id)
  const consensus = run.config.planningMode === 'consensus'

  return (
    <div className="h-full min-h-0 overflow-auto bg-surface" data-testid="plan-inspector">
      <div className="flex flex-col gap-4 p-4">
        <CandidatesSection />
        <Section title="Candidate plans" count={candidates.data?.candidates.length} testId="plan-candidates">
          {candidates.isPending ? (
            <Loading />
          ) : candidates.isError ? (
            <ErrorNote error={candidates.error} />
          ) : candidates.data.candidates.length === 0 ? (
            <Muted>
              {consensus
                ? 'No candidate plans have been recorded yet.'
                : 'This run used a single planner, so there are no competing candidates.'}
            </Muted>
          ) : (
            <div className="flex flex-col gap-1.5">
              {candidates.data.candidates.map((c) => (
                <CandidateCard key={c.id} candidate={c} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Critic findings" count={candidates.data?.critiques.length} testId="plan-critiques">
          {candidates.data && candidates.data.critiques.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {candidates.data.critiques.map((c) => (
                <CritiqueCard key={c.id} critique={c} />
              ))}
            </div>
          ) : (
            <Muted>No critique. A critic runs only when at least two candidates are valid.</Muted>
          )}
        </Section>

        <Section title="Final plan" testId="plan-final">
          {run.plan ? (
            <div className="flex flex-col gap-1.5">
              <p className="m-0 whitespace-pre-wrap break-words">{run.plan.summary}</p>
              <PlanTaskList plan={run.plan} />
            </div>
          ) : (
            <Muted>No plan has been stored on this run yet.</Muted>
          )}
        </Section>

        <Section title="Graph revisions" count={revisions.data?.length} testId="plan-revisions">
          {revisions.isPending ? (
            <Loading />
          ) : revisions.isError ? (
            <ErrorNote error={revisions.error} />
          ) : (
            <Revisions revisions={revisions.data} />
          )}
        </Section>

        <Section title="Change proposals" count={proposals.data?.length} testId="plan-proposals">
          {proposals.isPending ? (
            <Loading />
          ) : proposals.isError ? (
            <ErrorNote error={proposals.error} />
          ) : (
            <ProposalList proposals={proposals.data} />
          )}
        </Section>
      </div>
    </div>
  )
}
