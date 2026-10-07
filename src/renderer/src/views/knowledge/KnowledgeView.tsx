import { useState } from 'react'
import type { ContextNode, ContextNodeDetail, ContextSpace } from '@shared/context-graph'
import { contextRef } from '@shared/context-graph'
import { useCurrentProject } from '../../app/useCurrent'
import { formatCount, formatDateTime, formatRelative, formatTokens } from '../../lib/format'
import {
  useKnowledgeArchive,
  useKnowledgeConfirm,
  useKnowledgeHealth,
  useKnowledgeNode,
  useKnowledgePromote,
  useKnowledgeRefresh,
  useKnowledgeSearch,
  useKnowledgeTree,
} from '../../lib/queries-v71'
import { useDebounced } from '../../lib/useDebounced'
import { Badge, Button, ChevronDownIcon, ChevronRightIcon, EmptyState, ErrorNote, Input, IntelligenceIcon, Loading, Notice, PageHeader, RefreshIcon, SearchIcon, SegmentedControl, Toggle } from '../../components/ui'
import { STATUS_LABEL, TRUST_LABEL, TRUST_MEANING, groupRelations, statusNotice, statusTone, trustTone, typeLabel } from './knowledgeModel'

/** A page of children. Deeper levels load when a branch is opened: the whole graph never reaches the renderer. */
function Branch({ projectId, space, parentId, depth, history, open, toggle, selected, select }: {
  projectId: string
  space: ContextSpace
  parentId: string | null
  depth: number
  history: boolean
  open: ReadonlySet<string>
  toggle: (id: string) => void
  selected: string | null
  select: (id: string) => void
}) {
  const level = useKnowledgeTree(projectId, space, parentId, history)
  if (level.isPending) return depth === 0 ? <Loading label="Loading the graph" /> : <div className="py-1 text-small text-text-muted" style={{ paddingLeft: 12 + depth * 14 }}>Loading…</div>
  if (level.isError) return <ErrorNote error={level.error} className="m-2" />
  const { children, total, childCounts } = level.data
  return (
    <ul className="m-0 list-none p-0" role={depth === 0 ? 'tree' : 'group'}>
      {children.map((n) => {
        const count = childCounts[n.id] ?? 0
        const isOpen = open.has(n.id)
        return (
          <li key={n.id} role="treeitem" aria-expanded={count > 0 ? isOpen : undefined} aria-selected={selected === n.id}>
            <div
              className={`flex items-center gap-1 pr-2 ${selected === n.id ? 'bg-accent-soft' : 'hover:bg-surface-muted'}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              data-testid="knowledge-tree-row"
              data-path={n.path}
            >
              {count > 0 ? (
                <button type="button" className="flex size-5 shrink-0 items-center justify-center rounded-sm text-text-muted hover:text-text-primary" aria-label={isOpen ? `Collapse ${n.title}` : `Expand ${n.title}`} onClick={() => toggle(n.id)}>
                  {isOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                </button>
              ) : (
                <span className="size-5 shrink-0" />
              )}
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" onClick={() => select(n.id)}>
                <span className={`truncate ${n.type === 'SECTION' ? 'font-medium' : ''} ${n.status === 'ARCHIVED' || n.status === 'SUPERSEDED' ? 'text-text-muted line-through' : ''}`}>{n.title}</span>
                {count > 0 ? <span className="tnum shrink-0 text-caption text-text-muted">{formatCount(count)}</span> : null}
                {n.status !== 'CURRENT' ? <Badge tone={statusTone(n.status)} className="ml-auto shrink-0">{STATUS_LABEL[n.status]}</Badge> : null}
              </button>
            </div>
            {isOpen && count > 0 ? <Branch projectId={projectId} space={space} parentId={n.id} depth={depth + 1} history={history} open={open} toggle={toggle} selected={selected} select={select} /> : null}
          </li>
        )
      })}
      {total > children.length ? (
        <li className="py-1 text-small text-text-muted" style={{ paddingLeft: 26 + depth * 14 }}>
          {formatCount(total - children.length)} more. Use search to find them.
        </li>
      ) : null}
      {depth === 0 && children.length === 0 ? <li className="px-4 py-3 text-text-muted">Nothing here yet.</li> : null}
    </ul>
  )
}

function NodeRow({ node, onSelect }: { node: ContextNode; onSelect: (id: string) => void }) {
  return (
    <button type="button" className="flex w-full flex-col gap-0.5 border-b px-4 py-2 text-left hover:bg-surface-muted" onClick={() => onSelect(node.id)} data-testid="knowledge-search-result">
      <span className="flex items-center gap-2">
        <Badge mono>{typeLabel(node.type)}</Badge>
        <span className="truncate font-medium">{node.title}</span>
        {node.status !== 'CURRENT' ? <Badge tone={statusTone(node.status)}>{STATUS_LABEL[node.status]}</Badge> : null}
      </span>
      <span className="truncate font-mono text-code text-text-muted">{node.path || '/'}</span>
    </button>
  )
}

function Inspector({ projectId, detail, onSelect }: { projectId: string; detail: ContextNodeDetail; onSelect: (id: string) => void }) {
  const n = detail.node
  const confirm = useKnowledgeConfirm()
  const promote = useKnowledgePromote()
  const archive = useKnowledgeArchive()
  const notice = statusNotice(n)
  const relations = groupRelations(detail.outgoing, detail.incoming)
  const files = detail.sources.filter((s) => s.kind === 'file')
  const others = detail.sources.filter((s) => s.kind !== 'file')
  const text = detail.originText ?? n.body ?? n.summary
  const isNote = n.type === 'NOTE' && n.originKind === 'graph'
  const error = confirm.error ?? promote.error ?? archive.error
  return (
    <div className="flex flex-col gap-4 p-5" data-testid="knowledge-inspector" data-path={n.path}>
      <nav aria-label="Path" className="flex flex-wrap items-center gap-1 text-small text-text-muted">
        {detail.ancestors.map((a) => (
          <span key={a.id} className="flex items-center gap-1">
            <button type="button" className="hover:text-text-primary hover:underline" onClick={() => onSelect(a.id)}>{a.title}</button>
            <ChevronRightIcon size={10} />
          </span>
        ))}
        <span className="text-text-secondary">{n.title}</span>
      </nav>
      <header className="flex flex-wrap items-start gap-2">
        <h2 className="m-0 min-w-0 flex-1 break-words text-heading font-semibold text-text-primary">{n.title}</h2>
        <Badge mono>{typeLabel(n.type)}</Badge>
        <Badge tone={statusTone(n.status)} data-testid="knowledge-node-status">{STATUS_LABEL[n.status]}</Badge>
        <Badge tone={trustTone(n.trust)} title={TRUST_MEANING[n.trust]} data-testid="knowledge-node-trust">{TRUST_LABEL[n.trust]}</Badge>
      </header>
      {notice ? <Notice tone={notice.tone === 'waiting' ? 'warning' : notice.tone === 'review' ? 'active' : notice.tone === 'danger' ? 'danger' : notice.tone === 'warning' ? 'warning' : 'neutral'}>{notice.text}</Notice> : null}
      {text.trim() !== '' ? <p className="m-0 whitespace-pre-wrap break-words" data-testid="knowledge-node-text">{text}</p> : null}
      {n.provenance.evidence ? (
        <div className="flex flex-col gap-1">
          <div className="text-caption font-medium text-text-muted">Evidence given when it was recorded</div>
          <p className="m-0 whitespace-pre-wrap break-words text-text-secondary">{n.provenance.evidence}</p>
        </div>
      ) : null}
      <dl className="m-0 grid grid-cols-[9rem_1fr] gap-y-1.5">
        <dt className="text-text-muted">Reference</dt>
        <dd className="m-0 break-all font-mono text-code">{contextRef(n)}</dd>
        <dt className="text-text-muted">Trust</dt>
        <dd className="m-0">{TRUST_LABEL[n.trust]}. {TRUST_MEANING[n.trust]}</dd>
        <dt className="text-text-muted">Confidence</dt>
        <dd className="m-0">{n.confidence}</dd>
        <dt className="text-text-muted">Recorded by</dt>
        <dd className="m-0">{n.provenance.source.replace(/_/g, ' ')}</dd>
        <dt className="text-text-muted">Version</dt>
        <dd className="tnum m-0">{n.version}, updated <span title={formatDateTime(n.updatedAt)}>{formatRelative(n.updatedAt)}</span></dd>
        <dt className="text-text-muted">Last checked</dt>
        <dd className="m-0">{n.refreshedAt ? <span title={formatDateTime(n.refreshedAt)}>{formatRelative(n.refreshedAt)}</span> : 'never'}</dd>
        <dt className="text-text-muted">Size</dt>
        <dd className="tnum m-0">about {formatTokens(n.tokenEstimate)} tokens (estimated)</dd>
      </dl>
      {n.status === 'STALE' || isNote ? (
        <div className="flex flex-wrap items-center gap-2">
          {n.status === 'STALE' ? <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate({ projectId, nodeId: n.id })} data-testid="knowledge-confirm">It still holds</Button> : null}
          {isNote && n.trust === 'AGENT_NOTE' && n.status === 'CURRENT' ? <Button size="sm" loading={promote.isPending} onClick={() => promote.mutate({ projectId, nodeId: n.id })} data-testid="knowledge-promote">Mark as confirmed by me</Button> : null}
          {isNote && n.status !== 'ARCHIVED' ? <Button size="sm" variant="ghost" loading={archive.isPending} onClick={() => archive.mutate({ projectId, nodeId: n.id, reason: 'Archived by the user.' })} data-testid="knowledge-archive">Archive</Button> : null}
        </div>
      ) : null}
      {error ? <ErrorNote error={error} /> : null}

      {files.length > 0 || others.length > 0 ? (
        <section className="flex flex-col gap-1.5" data-testid="knowledge-sources">
          <h3 className="m-0 text-caption font-medium text-text-muted">Sources</h3>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-code">
            {files.map((s) => <li key={`f${s.ref}`} className="break-all">{s.ref}</li>)}
            {others.map((s) => <li key={`${s.kind}${s.ref}`} className="break-all text-text-muted">{s.kind}: {s.ref}</li>)}
          </ul>
        </section>
      ) : null}

      {relations.length > 0 ? (
        <section className="flex flex-col gap-2" data-testid="knowledge-relations">
          <h3 className="m-0 text-caption font-medium text-text-muted">Related</h3>
          {relations.map((g) => (
            <div key={g.label} className="flex flex-col gap-0.5">
              <div className="text-small text-text-secondary">{g.label}</div>
              <ul className="m-0 flex list-none flex-col p-0">
                {g.items.map((r) => (
                  <li key={r.node.id}>
                    <button type="button" className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-surface-muted" onClick={() => onSelect(r.node.id)}>
                      <Badge mono>{typeLabel(r.node.type)}</Badge>
                      <span className="truncate">{r.node.title}</span>
                      {r.node.status !== 'CURRENT' ? <Badge tone={statusTone(r.node.status)}>{STATUS_LABEL[r.node.status]}</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {detail.children.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="m-0 text-caption font-medium text-text-muted">Contains {formatCount(detail.childrenTotal)}</h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {detail.children.slice(0, 30).map((c) => (
              <li key={c.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-surface-muted" onClick={() => onSelect(c.id)}>
                  <Badge mono>{typeLabel(c.type)}</Badge>
                  <span className="truncate">{c.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.history.length > 0 ? (
        <section className="flex flex-col gap-1.5" data-testid="knowledge-history">
          <h3 className="m-0 text-caption font-medium text-text-muted">History</h3>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.history.slice(0, 20).map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-28 shrink-0 text-small text-text-muted" title={formatDateTime(e.createdAt)}>{formatRelative(e.createdAt)}</span>
                <span className="min-w-0"><span className="font-medium">{e.event.replace(/_/g, ' ')}</span> <span className="text-text-secondary">{e.detail}</span></span>
              </li>
            ))}
          </ol>
          {detail.versions.length > 0 ? (
            <details className="text-small">
              <summary className="cursor-pointer text-text-muted">{detail.versions.length} earlier version{detail.versions.length === 1 ? '' : 's'}</summary>
              <ul className="m-0 mt-1 flex list-none flex-col gap-2 p-0">
                {detail.versions.map((v) => (
                  <li key={v.id} className="rounded-md border p-2">
                    <div className="text-text-muted">Version {v.version}, {formatDateTime(v.createdAt)}, {TRUST_LABEL[v.trust]}</div>
                    <div className="whitespace-pre-wrap break-words">{v.body ?? v.summary}</div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

/** The Context Graph: what NEXUS knows about a project, as a tree to browse and a node to inspect. */
export function KnowledgeView() {
  const project = useCurrentProject()
  const projectId = project?.id ?? null
  const health = useKnowledgeHealth(projectId)
  const refresh = useKnowledgeRefresh()
  const [spaceKey, setSpaceKey] = useState<string | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim(), 250)
  const results = useKnowledgeSearch(projectId, query, history)
  const node = useKnowledgeNode(projectId, selected, true)

  const spaces = health.data?.spaces ?? []
  const current = spaces.find((s) => `${s.space.kind}:${s.space.id}` === spaceKey) ?? spaces[0] ?? null
  const h = current?.health ?? null
  const toggle = (id: string): void => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="knowledge-view">
      <PageHeader
        title="Context"
        context="Intelligence"
        actions={
          <Button icon={<RefreshIcon size={12} />} loading={refresh.isPending} disabled={!project} onClick={() => project && refresh.mutate({ projectId: project.id })} data-testid="knowledge-refresh">
            Refresh
          </Button>
        }
      />
      {!project ? (
        <EmptyState title="No project selected" icon={<IntelligenceIcon size={22} />}>Open a project to browse what NEXUS knows about it.</EmptyState>
      ) : health.isPending ? (
        <Loading label="Loading the graph" />
      ) : health.isError ? (
        <ErrorNote error={health.error} className="m-5" />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-surface px-5 py-2" data-testid="knowledge-health">
            {spaces.length > 1 ? (
              <SegmentedControl
                size="sm"
                label="Graph"
                value={current ? `${current.space.kind}:${current.space.id}` : ''}
                onChange={(v) => {
                  setSpaceKey(v)
                  setSelected(null)
                  setOpen(new Set())
                }}
                options={spaces.map((s) => ({ value: `${s.space.kind}:${s.space.id}`, label: s.space.kind === 'workspace' ? `Workspace: ${s.name}` : s.name }))}
              />
            ) : (
              <span className="font-medium">{current?.name}</span>
            )}
            {h ? (
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-text-muted">
                <span><span className="tnum text-text-primary">{formatCount(h.nodes)}</span> nodes</span>
                <span><span className="tnum text-text-primary">{formatCount(h.edges)}</span> relations</span>
                <span><span className="tnum text-text-primary">{formatCount(h.byStatus.CURRENT)}</span> current</span>
                <span><span className="tnum text-text-primary">{formatCount(h.byStatus.STALE)}</span> stale</span>
                <span><span className="tnum text-text-primary">{formatCount(h.byStatus.CONFLICTED)}</span> in conflict</span>
                <span title="Estimated tokens of every current entry: what sending the whole graph would cost. Agents receive a selection.">about <span className="tnum text-text-primary">{formatTokens(h.activeTokenEstimate)}</span> tokens if sent whole (estimated)</span>
                {h.lastRefresh ? <span title={formatDateTime(h.lastRefresh.finishedAt)}>checked {formatRelative(h.lastRefresh.finishedAt)}</span> : null}
              </span>
            ) : null}
            <span className="ml-auto text-small text-text-muted" data-testid="knowledge-enabled">
              {health.data.enabled ? 'Agents receive a selection of this graph and can browse it.' : 'Agents do not receive this graph (Settings, Tokens).'}
            </span>
          </div>
          {refresh.data ? (
            <div className="shrink-0 border-b bg-surface px-5 py-1.5 text-small text-text-muted" role="status" data-testid="knowledge-refresh-result">
              Refreshed: {refresh.data.sync.created} new, {refresh.data.sync.updated} changed, {refresh.data.sync.archived} archived, {refresh.data.job.nodesStale} newly stale ({refresh.data.job.changedFiles} changed files checked).
            </div>
          ) : null}
          {refresh.isError ? <ErrorNote error={refresh.error} className="m-3" /> : null}
          {!h ? (
            <EmptyState title="No graph yet" icon={<IntelligenceIcon size={22} />}>The graph is built when a mission starts. Use Refresh to build it now.</EmptyState>
          ) : (
            <div className="flex min-h-0 flex-1">
              <aside className="flex w-[340px] shrink-0 flex-col border-r bg-surface" aria-label="Knowledge navigator">
                <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2">
                  <div className="relative">
                    <SearchIcon size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                    <Input aria-label="Search the graph" className="pl-6" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="knowledge-search" />
                  </div>
                  <Toggle checked={history} onChange={setHistory} label="Show history" data-testid="knowledge-history-toggle" />
                </div>
                <div className="min-h-0 flex-1 overflow-auto py-1" data-testid="knowledge-tree">
                  {query ? (
                    results.isPending ? <Loading label="Searching" /> : results.isError ? <ErrorNote error={results.error} className="m-2" /> : results.data.length === 0 ? (
                      <p className="m-0 px-4 py-3 text-text-muted">Nothing matches.</p>
                    ) : (
                      results.data.map((n) => <NodeRow key={n.id} node={n} onSelect={setSelected} />)
                    )
                  ) : current ? (
                    <Branch projectId={project.id} space={current.space} parentId={null} depth={0} history={history} open={open} toggle={toggle} selected={selected} select={setSelected} />
                  ) : null}
                </div>
              </aside>
              <section className="min-w-0 flex-1 overflow-auto bg-surface" aria-label="Selected node">
                {!selected ? (
                  <EmptyState title="Select a node" icon={<IntelligenceIcon size={22} />}>Its text, sources, relations and history appear here.</EmptyState>
                ) : node.isPending ? (
                  <Loading label="Loading the node" />
                ) : node.isError ? (
                  <ErrorNote error={node.error} className="m-5" />
                ) : (
                  <Inspector projectId={project.id} detail={node.data} onSelect={setSelected} />
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  )
}
