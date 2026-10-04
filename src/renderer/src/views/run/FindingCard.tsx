import type { ReviewFinding } from '@shared/domain'
import { Badge } from '../../components/ui'
import { severityStatus } from '../../lib/status'

export function findingLocation(f: ReviewFinding): string | null {
  if (!f.file) return null
  if (f.lineStart === null) return f.file
  return f.lineEnd !== null && f.lineEnd !== f.lineStart ? `${f.file}:${f.lineStart}-${f.lineEnd}` : `${f.file}:${f.lineStart}`
}

/** One review finding. `compact` is the inline annotation form used inside diffs. */
export function FindingCard({ finding: f, compact = false }: { finding: ReviewFinding; compact?: boolean }) {
  const sev = severityStatus(f.severity)
  const loc = findingLocation(f)
  return (
    <div
      className="flex flex-col gap-1 border-l-2 border-tone-review bg-surface-muted px-2.5 py-1.5 font-sans text-[0.95em] leading-snug"
      data-testid="finding"
      data-severity={f.severity}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={sev.tone}>{sev.label}</Badge>
        <Badge mono>{f.category}</Badge>
        <span className="font-medium">{f.title}</span>
        <span className="ml-auto text-small text-text-muted">confidence {f.confidence}</span>
      </div>
      {loc ? <div className="font-mono text-small text-text-secondary">{loc}</div> : null}
      {compact ? null : (
        <>
          <div className="whitespace-pre-wrap break-words text-text-secondary">{f.description}</div>
          <div className="whitespace-pre-wrap break-words">
            <span className="text-text-muted">Evidence: </span>
            {f.evidence}
          </div>
        </>
      )}
      {f.suggestedCorrection ? (
        <div className="whitespace-pre-wrap break-words">
          <span className="text-text-muted">Suggested: </span>
          {f.suggestedCorrection}
        </div>
      ) : null}
    </div>
  )
}
