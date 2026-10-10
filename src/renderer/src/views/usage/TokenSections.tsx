import type { CacheEvent, CacheTotalsView, TokenOverview } from '@shared/token'
import { cacheReadShare } from '@shared/token'
import { formatCount, formatRelative, formatTokens } from '../../lib/format'
import { useTokenOverview } from '../../lib/queries-v71'
import { Badge, Card, DataTable, type Column } from '../../components/ui'
import { BASIS_LABEL, COMPONENT_LABEL, MISS_CAUSE_LABEL, percent } from '../knowledge/knowledgeModel'
import { BlockSkeleton, Caption, ReadError, TableFrame } from './shared'

const DAYS = 7

const TECHNIQUE_LABEL: Record<string, { name: string; what: string }> = {
  stablePrefix: { name: 'Stable prefix', what: 'Keep per-session text out of the system prompt.' },
  contextGraph: { name: 'Context Graph in packs', what: 'Give agents a selection of the graph and the tools to browse it.' },
  toolLoading: { name: 'NEXUS tools loaded upfront', what: 'Put the NEXUS tool definitions in the prompt instead of behind tool search.' },
  outputFiltering: { name: 'Failures first in check output', what: 'Show the failures that lie before the tail of a long output.' },
  pressureRotation: { name: 'Rotation by context pressure', what: 'Rotate a session when its context is full, not at a turn count.' },
}

const cacheColumns = (first: string): Column<CacheTotalsView>[] => [
  { key: 'k', header: first, render: (r) => <span className="font-medium">{r.key}</span> },
  { key: 's', header: 'Sessions', numeric: true, render: (r) => formatCount(r.sessions) },
  { key: 'q', header: 'Requests', numeric: true, render: (r) => formatCount(r.requests) },
  { key: 'u', header: 'Uncached input', numeric: true, render: (r) => formatTokens(r.inputTokens) },
  { key: 'r', header: 'Cache read', numeric: true, render: (r) => formatTokens(r.cacheReadTokens) },
  { key: 'w', header: 'Cache write', numeric: true, render: (r) => formatTokens(r.cacheWriteTokens) },
  { key: 'h', header: 'Read from cache', numeric: true, render: (r) => percent(cacheReadShare(r)) },
  { key: 'ws', header: 'Warm / cold starts', numeric: true, render: (r) => `${formatCount(r.warmStarts)} / ${formatCount(r.coldStarts)}` },
]

const missColumns: Column<CacheEvent>[] = [
  { key: 'at', header: 'When', render: (e) => formatRelative(e.createdAt) },
  { key: 'role', header: 'Role', render: (e) => e.role ?? '—' },
  { key: 'w', header: 'Written again', numeric: true, render: (e) => formatTokens(e.cacheWriteTokens) },
  { key: 'c', header: 'Likely cause', render: (e) => (e.cause ? (MISS_CAUSE_LABEL[e.cause] ?? e.cause) : '—') },
]

function Metric({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1" title={hint}>
      <div className="text-small text-text-muted">{label}</div>
      <div className="tnum text-[1.23rem] font-semibold leading-6">{children}</div>
    </div>
  )
}

function CacheBody({ o }: { o: TokenOverview }) {
  const c = o.cache
  if (c.requests === 0) return <p className="m-0 text-text-muted">No model request has been recorded in the last {DAYS} days. Figures appear after the next mission.</p>
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-5" data-testid="usage-cache-measures">
        <Metric label="Read from cache" hint="Cache read as a share of all processed input (uncached + cache read + cache write).">{percent(cacheReadShare(c))}</Metric>
        <Metric label="Cache read">{formatTokens(c.cacheReadTokens)}</Metric>
        <Metric label="Cache write">{formatTokens(c.cacheWriteTokens)}</Metric>
        <Metric label="Uncached input">{formatTokens(c.inputTokens)}</Metric>
        <Metric label="Warm / cold session starts" hint="A warm start read its prefix from cache; a cold start wrote it.">{formatCount(c.warmStarts)} / {formatCount(c.coldStarts)}</Metric>
      </div>
      <p className="m-0 text-small text-text-muted">
        Reported by the runtime for {formatCount(c.requests)} requests in {formatCount(c.sessions)} sessions over the last {DAYS} days. Each role has its own tools and role prompt, so the first session of
        a role writes its prefix; later sessions of that role read it while the cache lives.
      </p>
      {o.byRole.length > 0 ? (
        <div className="flex flex-col gap-1.5" data-testid="usage-cache-by-role">
          <Caption>By role</Caption>
          <TableFrame>
            <DataTable columns={cacheColumns('Role')} rows={o.byRole} rowKey={(r) => r.key} caption="Cache by role" />
          </TableFrame>
        </div>
      ) : null}
      {o.byModel.length > 1 || o.byProvider.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <Caption>By model</Caption>
          <TableFrame>
            <DataTable columns={cacheColumns('Model')} rows={o.byModel} rowKey={(r) => r.key} caption="Cache by model" />
          </TableFrame>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5" data-testid="usage-cache-misses">
        <Caption>Prefixes written again when a read was possible</Caption>
        {o.misses.length === 0 ? (
          <p className="m-0 text-text-muted">None in the last {DAYS} days.</p>
        ) : (
          <>
            <TableFrame>
              <DataTable columns={missColumns} rows={o.misses} rowKey={(e) => e.id} caption="Cache misses" />
            </TableFrame>
            <p className="m-0 text-small text-text-muted">The token figures are the runtime's. The cause is NEXUS's own inference from the parts of the prefix it controls; the runtime gives no cache diagnosis.</p>
          </>
        )}
      </div>
    </div>
  )
}

function ContextBody({ o }: { o: TokenOverview }) {
  if (o.composition.length === 0) {
    return <p className="m-0 text-text-muted">{o.contextUsageDetail === 'off' ? 'Context breakdowns are turned off in Settings.' : `No session has reported a context breakdown in the last ${DAYS} days.`}</p>
  }
  const top = o.composition.filter((r) => r.percent > 0)
  return (
    <div className="flex flex-col gap-4">
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="usage-context-composition">
        {top.map((r) => (
          <li key={r.component} className="grid grid-cols-[14rem_1fr_3rem] items-center gap-3">
            <span className="truncate">{COMPONENT_LABEL[r.component]}</span>
            <span className="h-2 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${r.percent}%` }} />
            </span>
            <span className="tnum text-right">{r.percent}%</span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-small text-text-muted">
        What the context of {formatCount(o.compositionSessions)} session{o.compositionSessions === 1 ? '' : 's'} was made of at its last turn. {o.compositionBasis ? `${BASIS_LABEL[o.compositionBasis]}. ` : ''}
        {o.compositionBasis === 'estimated' ? 'The runtime answers a summary breakdown from its own estimates, and NEXUS estimates the parts of its own text; treat the shares as proportions, not counts.' : ''}
      </p>
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
        <Metric label="Compactions">{formatCount(o.compactions)}</Metric>
        <Metric label="Sessions rotated">{formatCount(o.sessionActions.find((a) => a.action === 'HANDOFF_AND_ROTATE')?.n ?? 0)}</Metric>
        <Metric label="Graph retrievals">{formatCount((o.decisions.find((d) => d.action === 'RETRIEVE_GRAPH_BRANCH')?.n ?? 0) + (o.decisions.find((d) => d.action === 'WIDEN_RETRIEVAL')?.n ?? 0))}</Metric>
        <Metric label="Graph nodes opened by agents">{formatCount(o.decisions.find((d) => d.action === 'EXPAND_GRAPH_NODE')?.n ?? 0)}</Metric>
      </div>
    </div>
  )
}

function TechniqueBody({ o }: { o: TokenOverview }) {
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col p-0" data-testid="usage-techniques">
        {o.techniques.map((t) => {
          const label = TECHNIQUE_LABEL[t.technique] ?? { name: t.technique, what: '' }
          return (
            <li key={t.technique} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
              <span className="w-64 shrink-0 font-medium">{label.name}</span>
              <span className="min-w-0 flex-1 text-text-secondary">{label.what}</span>
              <Badge tone={t.enabled ? 'success' : 'neutral'}>{t.enabled ? 'On' : 'Off'}</Badge>
              <span className="w-40 shrink-0 text-small text-text-muted">{t.setting === 'auto' ? 'by the release default' : 'set by you'}</span>
            </li>
          )
        })}
      </ul>
      <p className="m-0 text-small text-text-muted">
        Quality first: a technique is on by default only where it loses no information or was measured not to lower quality. The evidence for each default is in the 0.7.1 release report. None of them
        changes a model, an effort level, the number of agents or the number of reviews.
      </p>
    </div>
  )
}

/** Cache, context composition and the context techniques in use. Added to the Usage page in 0.7.1. */
export function TokenSections() {
  const q = useTokenOverview(DAYS)
  const body = (render: (o: TokenOverview) => React.ReactNode, calm: string) =>
    q.isPending ? <BlockSkeleton rows={3} /> : q.isError ? <ReadError error={q.error} calm={calm} onRetry={() => void q.refetch()} /> : render(q.data)
  return (
    <>
      <Card title="Cache" description="How much of what sessions sent was read from the prompt cache, as the runtime reported it." data-testid="usage-cache">
        {body((o) => <CacheBody o={o} />, 'Cache figures are not available yet.')}
      </Card>
      <Card title="Context" description="What session contexts are made of, and what was done to keep them useful." data-testid="usage-context">
        {body((o) => <ContextBody o={o} />, 'Context figures are not available yet.')}
      </Card>
      <Card title="Context techniques" description="What NEXUS does to avoid wasted tokens, and which of it is on." data-testid="usage-context-techniques">
        {body((o) => <TechniqueBody o={o} />, 'Not available yet.')}
      </Card>
    </>
  )
}
