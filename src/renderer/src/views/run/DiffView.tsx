import { useMemo, useState, type ReactNode } from 'react'
import { Diff, Hunk, type FileData } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './run.css'
import type { ReviewFinding } from '@shared/domain'
import type { DiffFile, DiffResult } from '@shared/ipc'
import { Badge, ChevronDownIcon, ChevronRightIcon, CodeBlock, Notice } from '../../components/ui'
import { cn } from '../../lib/cn'
import { FindingCard } from './FindingCard'
import { annotateFile, filePathOf, findingsForFile, matchesFile, normalizePath, parsePatch } from './diffModel'

const STATUS_TONE = { added: 'success', modified: 'active', deleted: 'danger', renamed: 'review' } as const

interface Row {
  path: string
  file: DiffFile | null
  parsed: FileData | null
}

function buildRows(files: readonly DiffFile[], parsed: readonly FileData[]): Row[] {
  const used = new Set<FileData>()
  const rows: Row[] = files.map((f) => {
    const p = parsed.find((pf) => !used.has(pf) && matchesFile(pf, f)) ?? null
    if (p) used.add(p)
    return { path: f.path, file: f, parsed: p }
  })
  for (const p of parsed) if (!used.has(p)) rows.push({ path: filePathOf(p), file: null, parsed: p })
  return rows
}

function countParsed(file: FileData): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const h of file.hunks) {
    for (const c of h.changes) {
      if (c.type === 'insert') additions++
      else if (c.type === 'delete') deletions++
    }
  }
  return { additions, deletions }
}

/**
 * Unified diff viewer. Files come from DiffResult.files (with the stat counts), the patch is rendered with
 * react-diff-view, and review findings with a line number become widgets next to the matching change.
 * `owners` names the task(s) that own each file; for a task diff pass a single label.
 */
export function DiffView({
  diff,
  findings = [],
  ownerOf,
  testId = 'diff-view',
}: {
  diff: DiffResult
  findings?: readonly ReviewFinding[]
  ownerOf?: (path: string) => readonly string[]
  testId?: string
}) {
  const parsedPatch = useMemo(() => parsePatch(diff.patch), [diff.patch])
  const rows = useMemo(() => buildRows(diff.files, parsedPatch.files), [diff.files, parsedPatch.files])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(rows.slice(0, 6).map((r) => r.path)))

  const totals = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const f of diff.files) {
      additions += f.additions
      deletions += f.deletions
    }
    return { additions, deletions }
  }, [diff.files])

  if (rows.length === 0 && diff.patch.trim() === '') {
    return (
      <div className="p-3 text-text-secondary" data-testid={`${testId}-empty`}>
        No changes{diff.base && diff.head ? ` between ${diff.base} and ${diff.head}` : ''}.
      </div>
    )
  }

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 text-text-secondary">
        <span className="font-mono text-small">
          {diff.base ?? '?'} → {diff.head ?? '?'}
        </span>
        <span>
          {rows.length} file{rows.length === 1 ? '' : 's'}
        </span>
        <span className="font-mono text-tone-success">+{totals.additions}</span>
        <span className="font-mono text-tone-danger">−{totals.deletions}</span>
      </div>
      {diff.truncated ? (
        <Notice tone="warning" title="Diff truncated" data-testid={`${testId}-truncated`}>
          The patch exceeded the size limit, so later files or hunks are not shown. The file list above is complete.
        </Notice>
      ) : null}
      {parsedPatch.error ? (
        <Notice tone="danger" title="Could not parse the patch">
          {parsedPatch.error}. The raw patch is shown instead.
        </Notice>
      ) : null}
      {parsedPatch.error ? <CodeBlock wrap={false} maxHeight={480}>{diff.patch}</CodeBlock> : null}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.map((row) => (
          <FileSection
            key={row.path}
            row={row}
            expanded={open.has(row.path)}
            onToggle={() => toggle(row.path)}
            findings={findingsForFile(findings, row.path)}
            owners={ownerOf?.(row.path) ?? []}
            truncatedPatch={diff.truncated}
          />
        ))}
      </ul>
    </div>
  )
}

function FileSection({
  row,
  expanded,
  onToggle,
  findings,
  owners,
  truncatedPatch,
}: {
  row: Row
  expanded: boolean
  onToggle: () => void
  findings: ReviewFinding[]
  owners: readonly string[]
  truncatedPatch: boolean
}) {
  const counts = row.file ?? (row.parsed ? countParsed(row.parsed) : { additions: 0, deletions: 0 })
  const status = row.file?.status ?? 'modified'
  return (
    <li className="rounded-md border bg-surface" data-testid={`diff-file-${normalizePath(row.path)}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 bg-surface-muted px-2 py-1 text-left hover:bg-surface-muted"
      >
        {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="min-w-0 flex-1 truncate font-mono text-[0.92em]">{row.path}</span>
        {owners.length > 0 ? (
          <span className="shrink-0 text-small text-text-secondary" title="Changed by">
            {owners.join(', ')}
          </span>
        ) : null}
        {findings.length > 0 ? <Badge tone="review">{findings.length} finding{findings.length === 1 ? '' : 's'}</Badge> : null}
        <Badge tone={STATUS_TONE[status]}>{status}</Badge>
        <span className="shrink-0 font-mono text-small text-tone-success">+{counts.additions}</span>
        <span className="shrink-0 font-mono text-small text-tone-danger">−{counts.deletions}</span>
      </button>
      {expanded ? <FileBody row={row} findings={findings} truncatedPatch={truncatedPatch} /> : null}
    </li>
  )
}

function FileBody({ row, findings, truncatedPatch }: { row: Row; findings: ReviewFinding[]; truncatedPatch: boolean }) {
  const parsed = row.parsed
  const annotations = useMemo(() => (parsed ? annotateFile(parsed.hunks, findings) : null), [parsed, findings])
  const widgets = useMemo(() => {
    const out: Record<string, ReactNode> = {}
    if (!annotations) return out
    for (const [key, list] of Object.entries(annotations.anchored)) {
      out[key] = (
        <div className="flex flex-col gap-1 py-1 pr-2">
          {list.map((f, i) => (
            <FindingCard key={`${f.title}-${i}`} finding={f} compact />
          ))}
        </div>
      )
    }
    return out
  }, [annotations])

  let body: ReactNode
  if (!parsed) {
    body = (
      <div className="p-2 text-text-secondary">
        {truncatedPatch ? 'Not included in the truncated patch.' : 'No patch available for this file.'}
      </div>
    )
  } else if (parsed.isBinary) {
    body = <div className="p-2 text-text-secondary">Binary file; contents are not shown.</div>
  } else if (parsed.hunks.length === 0) {
    body = <div className="p-2 text-text-secondary">No textual changes (mode change, rename or empty file).</div>
  } else {
    body = (
      <div className={cn('nexus-diff overflow-x-auto')}>
        <Diff diffType={parsed.type} hunks={parsed.hunks} viewType="unified" widgets={widgets}>
          {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
        </Diff>
      </div>
    )
  }
  return (
    <div className="border-t">
      {body}
      {annotations && annotations.unanchored.length > 0 ? (
        <div className="flex flex-col gap-1 border-t p-2">
          <div className="text-[0.8rem] text-text-muted">Findings without a line in this diff</div>
          {annotations.unanchored.map((f, i) => (
            <FindingCard key={`${f.title}-${i}`} finding={f} compact />
          ))}
        </div>
      ) : null}
      {!parsed && findings.length > 0 ? (
        <div className="flex flex-col gap-1 border-t p-2">
          {findings.map((f, i) => (
            <FindingCard key={`${f.title}-${i}`} finding={f} compact />
          ))}
        </div>
      ) : null}
    </div>
  )
}
