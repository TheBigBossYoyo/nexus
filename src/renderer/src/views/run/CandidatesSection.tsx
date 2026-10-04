import { useState } from 'react'
import { Badge, Button, CodeBlock, Dialog } from '../../components/ui'
import { useSpeculative } from '../../lib/queries-run'
import { type Tone } from '../../lib/status'
import { tournaments, type CandidateOutcome, type CandidateRowView } from './missionModel'
import { useRunCtx } from './runContext'

const OUTCOME_TONE: Record<CandidateOutcome, Tone> = {
  Winner: 'success',
  Rejected: 'neutral',
  Failed: 'danger',
  Running: 'active',
}

const HEADERS = ['Candidate', 'Outcome', 'Checks', 'Files', 'Lines', 'Duration', 'Observed tokens', '']

function DiffDialog({ row, onClose }: { row: CandidateRowView | null; onClose: () => void }) {
  return (
    <Dialog
      open={row !== null}
      onClose={onClose}
      title={row ? `Candidate ${row.label}: stored diff` : 'Stored diff'}
      width={720}
      testId="candidate-diff-dialog"
    >
      <CodeBlock wrap={false} maxHeight="60vh">
        {row?.diffPatch ?? ''}
      </CodeBlock>
    </Dialog>
  )
}

/** Speculative candidates and the tournament decision, from objective evidence only. Renders nothing without data. */
export function CandidatesSection() {
  const { detail, tasksById } = useRunCtx()
  const query = useSpeculative(detail.run.id)
  const [diffRow, setDiffRow] = useState<CandidateRowView | null>(null)
  const list = tournaments(query.data)
  if (query.isError || list.length === 0) return null
  return (
    <section className="flex flex-col gap-3" data-testid="candidates-section" aria-label="Speculative candidates">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-heading font-semibold">Candidates</h3>
        <span className="text-small text-text-muted">Decided by checks and measured size, not by an opinion.</span>
      </div>
      {list.map((t) => (
        <div key={t.speculativeRunId} className="rounded-lg border bg-surface" data-testid="tournament">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-small">
            <span className="font-medium">
              Task <span className="font-mono text-code">{tasksById.get(t.taskId)?.key ?? 'task'}</span>
            </span>
            <span className="text-text-muted">{t.state}</span>
          </div>
          <table className="w-full border-collapse text-left text-small" data-testid="candidate-table">
            <thead>
              <tr className="text-caption text-text-muted">
                {HEADERS.map((h, i) => (
                  <th key={i} scope="col" className="h-7 border-b px-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.candidates.map((c) => (
                <tr key={c.id} className="border-b last:border-b-0" data-testid={`candidate-${c.label}`} data-outcome={c.outcome}>
                  <td className="px-3 py-1.5 font-medium">{c.label}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={OUTCOME_TONE[c.outcome]}>{c.outcome}</Badge>
                  </td>
                  <td className="tnum px-3 py-1.5">{c.checks}</td>
                  <td className="tnum px-3 py-1.5">{c.files}</td>
                  <td className="tnum px-3 py-1.5">{c.lines}</td>
                  <td className="tnum px-3 py-1.5">{c.duration}</td>
                  <td className="tnum px-3 py-1.5">{c.tokens}</td>
                  <td className="px-3 py-1.5 text-right">
                    {c.hasDiff ? (
                      <Button size="sm" variant="ghost" onClick={() => setDiffRow(c)}>
                        View diff
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {t.decision ? (
            <div className="flex flex-col gap-1.5 border-t px-3 py-2 text-small" data-testid="tournament-decision">
              <div>
                <span className="font-medium">Winner: {t.decision.winner}</span>
                <span className="text-text-muted"> · {t.decision.confidence}</span>
              </div>
              <div className="text-text-secondary">{t.decision.reason}</div>
              {t.decision.comparisons.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {t.decision.comparisons.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-32 shrink-0 text-text-muted">{c.criterion}</span>
                      <span className="font-medium">{c.summary}</span>
                      <span className="min-w-0 text-text-secondary">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="border-t px-3 py-2 text-small text-text-muted">No decision yet.</div>
          )}
        </div>
      ))}
      <DiffDialog row={diffRow} onClose={() => setDiffRow(null)} />
    </section>
  )
}
