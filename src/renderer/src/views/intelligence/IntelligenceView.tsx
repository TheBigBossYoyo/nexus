import { useState } from 'react'
import type { RepositoryFact } from '@shared/v2'
import { useCurrentProject } from '../../app/useCurrent'
import { useIntelligence, useRefreshIntelligence } from '../../lib/queries'
import { useDebounced } from '../../lib/useDebounced'
import { formatDateTime, formatRelative } from '../../lib/format'
import { groupFacts } from '../../lib/v2logic'
import { Badge, Button, EmptyState, ErrorNote, Input, IntelligenceIcon, Loading, RefreshIcon, SearchIcon, Toggle } from '../../components/ui'

const MAX_FILES = 5

function FactRow({ fact: f }: { fact: RepositoryFact }) {
  const [allFiles, setAllFiles] = useState(false)
  const files = allFiles ? f.files : f.files.slice(0, MAX_FILES)
  return (
    <li
      className={`flex flex-col gap-1 border-b px-3 py-1.5 ${f.stale ? 'opacity-75' : ''}`}
      data-testid="intelligence-fact"
      data-stale={f.stale ? 'true' : 'false'}
      data-kind={f.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge mono>{f.kind.replace(/_/g, ' ')}</Badge>
        <span className="font-mono text-[0.92em] font-medium">{f.subject}</span>
        {f.stale ? (
          <Badge tone="waiting" data-testid="fact-stale">
            stale
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-3 text-[0.88em] text-fg-faint">
          <span>source {f.source.replace(/_/g, ' ')}</span>
          <span>confidence {f.confidence}</span>
          <span title={`Verified ${formatDateTime(f.verifiedAt)}`}>verified {formatRelative(f.verifiedAt)}</span>
        </span>
      </div>
      <div className="whitespace-pre-wrap break-words">{f.statement}</div>
      {f.files.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[0.85em] text-fg-muted">
          {files.map((p) => (
            <span key={p} className="break-all">
              {p}
            </span>
          ))}
          {f.files.length > MAX_FILES ? (
            <button type="button" className="font-sans text-accent hover:underline" onClick={() => setAllFiles((v) => !v)}>
              {allFiles ? 'show fewer' : `+${f.files.length - MAX_FILES} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** Facts NEXUS has verified about the repository, grouped by what they describe. */
export function IntelligenceView() {
  const project = useCurrentProject()
  const [search, setSearch] = useState('')
  const [includeStale, setIncludeStale] = useState(false)
  const query = useDebounced(search.trim(), 250)
  const facts = useIntelligence(project?.id ?? null, { query, includeStale })
  const refresh = useRefreshIntelligence()
  const groups = groupFacts(facts.data ?? [])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="intelligence-view">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-surface-1 px-3 py-2">
        <h1 className="m-0 mr-2 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">
          Repository intelligence{project ? ` · ${project.name}` : ''}
        </h1>
        <div className="relative w-64">
          <SearchIcon size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint" />
          <Input
            aria-label="Search facts"
            className="pl-6"
            placeholder="Search facts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="intelligence-search"
          />
        </div>
        <Toggle checked={includeStale} onChange={setIncludeStale} label="Include stale" data-testid="intelligence-include-stale" />
        {refresh.data ? (
          <span className="font-mono text-[0.88em] text-fg-faint" data-testid="intelligence-refresh-result">
            refreshed: {refresh.data.facts} facts, {refresh.data.stale} stale
          </span>
        ) : null}
        <Button
          className="ml-auto"
          icon={<RefreshIcon size={12} />}
          loading={refresh.isPending}
          disabled={!project}
          onClick={() => project && refresh.mutate({ projectId: project.id })}
          data-testid="intelligence-refresh"
        >
          Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="intelligence-list">
        {!project ? (
          <EmptyState title="No project selected" icon={<IntelligenceIcon size={22} />}>
            Open a project to see what NEXUS knows about its repository.
          </EmptyState>
        ) : facts.isPending ? (
          <Loading label="Loading facts" />
        ) : facts.isError ? (
          <ErrorNote error={facts.error} className="m-3" />
        ) : groups.length === 0 ? (
          <EmptyState title={query ? 'No matching facts' : 'No facts yet'} icon={<IntelligenceIcon size={22} />}>
            {query
              ? 'Nothing matches that search. Stale facts are hidden unless you include them.'
              : 'Facts are recorded when a project is opened and before planning. Use Refresh to analyse the repository now.'}
          </EmptyState>
        ) : (
          groups.map((g) => (
            <section key={g.id} data-testid={`intelligence-group-${g.id}`}>
              <h2 className="sticky top-0 m-0 border-b bg-surface-2 px-3 py-1 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">
                {g.label} <span className="font-mono font-normal text-fg-faint">{g.facts.length}</span>
              </h2>
              <ul className="m-0 list-none p-0">
                {g.facts.map((f) => (
                  <FactRow key={f.id} fact={f} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
