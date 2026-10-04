import { useState } from 'react'
import type { AcceptanceCriterion, CommandResult, Message, Review, Verification } from '@shared/domain'
import { Badge, Button, CodeBlock, Input } from '../../components/ui'
import { formatDateTime, formatDuration } from '../../lib/format'
import { severityStatus, type Tone } from '../../lib/status'
import { useUpdateCriterion } from '../../lib/queries'
import { readArbitration } from '../../lib/v2logic'
import { FindingCard } from './FindingCard'
import { sortFindings } from './diffModel'
import { clockTime, clockTimeSeconds } from './runContext'

/** A check command as a terminal block: timestamp, command, exit code, duration and the output tail. */
export function CommandBlock({ result, at }: { result: CommandResult; at: string }) {
  const ok = result.exitCode === 0 && !result.timedOut
  return (
    <div className="border bg-background" data-testid="command-block" data-ok={ok ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-surface-muted px-2 py-1 font-mono text-small">
        <span className="text-text-muted">{clockTimeSeconds(at)}</span>
        <span className="text-text-secondary">$</span>
        <span className="min-w-0 flex-1 break-all">{result.command}</span>
        <Badge tone={ok ? 'success' : 'danger'} mono>
          {result.timedOut ? 'timed out' : `exit ${result.exitCode ?? '?'}`}
        </Badge>
        <span className="text-text-secondary">{formatDuration(result.durationMs)}</span>
      </div>
      <div className="px-2 pt-1 font-mono text-[0.82em] text-text-muted">{result.name} · {result.cwd}</div>
      {result.output.trim() === '' ? (
        <div className="px-2 pb-1.5 text-text-muted">(no output)</div>
      ) : (
        <CodeBlock wrap maxHeight={220} className="rounded-none border-0">
          {result.output}
        </CodeBlock>
      )}
    </div>
  )
}

/** What the finding arbiter decided, when this review went through it. Renders nothing otherwise. */
function ArbitrationBlock({ review }: { review: Review }) {
  const arb = readArbitration(review)
  if (!arb) return null
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-surface-muted p-2" data-testid="review-arbitration">
      <div className="flex items-center gap-2">
        <span className="text-heading font-semibold text-text-primary">Arbiter</span>
        <Badge tone="success">{arb.accepted} accepted</Badge>
        <Badge tone={arb.rejected > 0 ? 'warning' : 'neutral'}>{arb.rejected} rejected</Badge>
      </div>
      {arb.summary ? <div className="whitespace-pre-wrap break-words text-text-secondary">{arb.summary}</div> : null}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {arb.decisions.map((d, i) => (
          <li key={i} className="flex gap-2" data-testid="arbiter-decision" data-accepted={d.accepted ? 'true' : 'false'}>
            <Badge tone={d.accepted ? 'success' : 'warning'}>{d.accepted ? 'accepted' : 'rejected'}</Badge>
            <div className="min-w-0">
              <div className="font-medium">{d.findingTitle ?? `Finding #${d.findingIndex + 1}`}</div>
              <div className="whitespace-pre-wrap break-words text-text-secondary">{d.reason}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ReviewCard({ review, label }: { review: Review; label?: string }) {
  const approved = review.verdict === 'approved'
  return (
    <article className="flex flex-col gap-1.5 rounded-md border bg-surface p-2.5" data-testid="review-card" data-verdict={review.verdict}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={approved ? 'success' : 'warning'}>{approved ? 'Approved' : 'Changes requested'}</Badge>
        <span className="text-text-secondary">attempt {review.attempt}</span>
        {label ? <span className="font-mono text-small">{label}</span> : null}
        <span className="ml-auto text-text-muted">{formatDateTime(review.createdAt)}</span>
      </div>
      <p className="m-0 whitespace-pre-wrap break-words">{review.summary}</p>
      <ArbitrationBlock review={review} />
      {review.findings.length === 0 ? (
        <div className="text-text-muted">No findings.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sortFindings(review.findings).map((f, i) => (
            <FindingCard key={`${f.title}-${i}`} finding={f} />
          ))}
        </div>
      )}
    </article>
  )
}

export function VerificationCard({ verification: v, label }: { verification: Verification; label?: string }) {
  return (
    <article className="flex flex-col gap-2 rounded-md border bg-surface p-2.5" data-testid="verification-card" data-passed={v.passed ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={v.passed ? 'success' : 'danger'}>{v.passed ? 'Passed' : 'Failed'}</Badge>
        <Badge mono>{v.kind === 'checks' ? 'checks' : 'verifier'}</Badge>
        <span className="text-text-secondary">attempt {v.attempt}</span>
        <span className="text-text-secondary">{v.taskId ? (label ?? 'task') : 'mission level'}</span>
        <span className="ml-auto text-text-muted">{formatDateTime(v.createdAt)}</span>
      </div>
      {v.summary ? <p className="m-0 whitespace-pre-wrap break-words">{v.summary}</p> : null}
      {v.criteria.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {v.criteria.map((c, i) => (
            <li key={i} className="flex gap-2">
              <Badge tone={c.passed ? 'success' : 'danger'}>{c.passed ? 'pass' : 'fail'}</Badge>
              <div className="min-w-0">
                <div>{c.criterion}</div>
                <div className="whitespace-pre-wrap break-words text-text-secondary">{c.evidence}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {v.failures.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {v.failures.map((f, i) => (
            <div key={i} className="border-l-2 border-tone-danger bg-tone-danger/10 px-2.5 py-1.5" data-testid="verification-failure">
              <div className="font-medium">{f.criterion}</div>
              <div className="whitespace-pre-wrap break-words text-text-secondary">{f.evidence}</div>
              {f.likelyCause ? (
                <div>
                  <span className="text-text-muted">Likely cause: </span>
                  {f.likelyCause}
                </div>
              ) : null}
              {f.relevantFiles.length > 0 ? (
                <div className="font-mono text-small text-text-secondary">{f.relevantFiles.join(', ')}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {v.commands.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {v.commands.map((c, i) => (
            <CommandBlock key={`${c.name}-${i}`} result={c} at={v.createdAt} />
          ))}
        </div>
      ) : null}
    </article>
  )
}

const CRITERION_TONE: Record<AcceptanceCriterion['status'], Tone> = { pending: 'neutral', passed: 'success', failed: 'danger' }

/** Acceptance criteria with status and evidence; the text can be edited in place. */
export function CriteriaList({ criteria, emptyText }: { criteria: readonly AcceptanceCriterion[]; emptyText: string }) {
  const update = useUpdateCriterion()
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')

  if (criteria.length === 0) return <div className="p-3 text-text-secondary">{emptyText}</div>
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="criteria-list">
      {criteria.map((c) => (
        <li key={c.id} className="flex flex-col gap-1 rounded-md border bg-surface p-2" data-testid={`criterion-${c.id}`} data-status={c.status}>
          {editing === c.id ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                const next = text.trim()
                if (next === '' || next === c.text) {
                  setEditing(null)
                  return
                }
                update.mutate({ criterionId: c.id, text: next }, { onSuccess: () => setEditing(null) })
              }}
            >
              <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Criterion text" data-testid="criterion-input" />
              <Button type="submit" size="sm" variant="primary" loading={update.isPending} data-testid="criterion-save">
                Save
              </Button>
              <Button size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex items-start gap-2">
              <Badge tone={CRITERION_TONE[c.status]}>{c.status}</Badge>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{c.text}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText(c.text)
                  setEditing(c.id)
                }}
                data-testid="criterion-edit"
              >
                Edit
              </Button>
            </div>
          )}
          {c.evidence ? <div className="whitespace-pre-wrap break-words text-text-secondary">Evidence: {c.evidence}</div> : null}
        </li>
      ))}
    </ul>
  )
}

export function MessageRow({ message: m }: { message: Message }) {
  const sev = m.severity ? severityStatus(m.severity) : null
  return (
    <article className="flex flex-col gap-0.5 border-b px-3 py-2" data-testid="message-row">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-text-muted">{clockTime(m.createdAt)}</span>
        <span className="font-medium">{m.fromLabel}</span>
        <span className="text-text-muted">→</span>
        <span className="font-medium">{m.toLabel}</span>
        <span className="ml-auto font-mono text-small uppercase tracking-wide text-text-secondary">
          {m.type.replace(/_/g, ' ')}
          {sev ? <span className={sev.tone === 'danger' ? 'text-tone-danger' : ''}> · {sev.label.toUpperCase()}</span> : null}
        </span>
      </div>
      <div className="font-medium">{m.subject}</div>
      <div className="whitespace-pre-wrap break-words text-text-secondary">{m.body}</div>
    </article>
  )
}
