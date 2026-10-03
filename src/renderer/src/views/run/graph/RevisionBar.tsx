import { useMemo } from 'react'
import type { GraphRevision } from '@shared/v2'
import { Select } from '../../../components/ui'
import { diffSnapshots, sortRevisions } from '../../../lib/v2logic'

/** Pick a plan revision to highlight in the graph: what it added (green), changed (amber) and removed (red, dashed). */
export function RevisionBar({
  revisions,
  version,
  onChange,
}: {
  revisions: readonly GraphRevision[]
  version: number | null
  onChange: (version: number | null) => void
}) {
  const sorted = useMemo(() => sortRevisions(revisions), [revisions])
  const options = [
    { value: 'none', label: 'No revision highlighted' },
    ...sorted.map((r) => ({ value: String(r.version), label: `v${r.version}${r.version === 1 ? ' (approved plan)' : ''}` })),
  ]
  const selected = version === null ? null : (sorted.find((r) => r.version === version) ?? null)
  const previous = selected ? sorted[sorted.indexOf(selected) - 1] : undefined
  const diff = selected && previous ? diffSnapshots(previous.snapshot, selected.snapshot) : null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-surface-1 px-2 py-1" data-testid="revision-bar">
      <label htmlFor="graph-revision-select" className="text-fg-muted">
        Plan revision
      </label>
      <Select
        id="graph-revision-select"
        className="w-auto!"
        value={version === null ? 'none' : String(version)}
        onChange={(v) => onChange(v === 'none' ? null : Number(v))}
        options={options}
        data-testid="revision-select"
      />
      {selected ? (
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={selected.reason} data-testid="revision-summary">
          {diff
            ? `+${diff.addedTasks.length} added, ~${diff.changedTasks.length} changed, −${diff.removedTasks.length} removed${
                diff.removedTasks.length > 0 ? ` (${diff.removedTasks.map((t) => t.key).join(', ')})` : ''
              }`
            : 'Original approved plan'}
          {selected.reason ? ` · ${selected.reason}` : ''}
        </span>
      ) : null}
    </div>
  )
}
