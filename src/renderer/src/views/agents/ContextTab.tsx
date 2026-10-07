import type { Agent } from '@shared/domain'
import { cacheReadShare } from '@shared/token'
import { formatCount, formatRelative, formatTokens } from '../../lib/format'
import { useAgentTokens } from '../../lib/queries-v71'
import { Badge, ErrorNote, Loading } from '../../components/ui'
import { BASIS_LABEL, COMPONENT_LABEL, MISS_CAUSE_LABEL, percent } from '../knowledge/knowledgeModel'

const ACTION_LABEL: Record<string, string> = {
  STABLE_PREFIX: 'Stable prefix',
  DEFER_TOOLS: 'Tools left behind tool search',
  LOAD_TOOLS_UPFRONT: 'Tools loaded upfront',
  RETRIEVE_GRAPH_BRANCH: 'Graph branch retrieved',
  EXPAND_GRAPH_NODE: 'Graph node opened',
  WIDEN_RETRIEVAL: 'Retrieval widened',
  FILTER_OUTPUT: 'Output filtered',
  CLEAR_TOOL_RESULTS: 'Old tool results may be cleared',
  COMPACT: 'Compacted',
  ROTATE_SESSION: 'Session rotated',
  PROGRAMMATIC_TOOLS: 'Aggregating tool',
  KEEP_FULL_CONTEXT: 'Full context kept',
}

/** Why this agent's context is what it is: what it was made of, what the cache did, which graph nodes it got and every context decision. */
export function ContextTab({ agent }: { agent: Agent }) {
  const q = useAgentTokens(agent.id)
  if (q.isPending) return <Loading label="Loading the context" />
  if (q.isError) return <ErrorNote error={q.error} className="m-5" />
  const v = q.data
  const b = v.breakdown
  const first = v.cache.find((e) => e.requestIndex === 0) ?? null
  const totals = v.cache.reduce((n, e) => ({ inputTokens: n.inputTokens + e.inputTokens, cacheReadTokens: n.cacheReadTokens + e.cacheReadTokens, cacheWriteTokens: n.cacheWriteTokens + e.cacheWriteTokens }), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const loaded = v.graphNodes.filter((n) => n.included)
  const available = v.graphNodes.filter((n) => !n.included)
  const rows = b ? [...b.components].sort((x, y) => y.tokens - x.tokens) : []
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-5" data-testid="agent-context">
      <section className="flex flex-col gap-2" data-testid="agent-context-breakdown">
        <h3 className="m-0 text-caption font-medium text-text-muted">Current context</h3>
        {b ? (
          <>
            <p className="m-0">
              <span className="tnum text-[1.23rem] font-semibold">{formatTokens(b.totalTokens)}</span>
              {b.maxTokens ? <span className="text-text-muted"> of a {formatTokens(b.maxTokens)} window</span> : null}
              <span className="text-text-muted"> ({BASIS_LABEL[b.basis].toLowerCase()})</span>
            </p>
            <table className="w-full max-w-2xl border-collapse">
              <tbody>
                {rows.map((c, i) => (
                  <tr key={`${c.component}${i}`} className="border-b last:border-b-0">
                    <td className="py-1 pr-3">{COMPONENT_LABEL[c.component]}</td>
                    <td className="tnum py-1 pr-3 text-right">{formatTokens(c.tokens)}</td>
                    <td className="tnum w-12 py-1 pr-3 text-right text-text-muted">{b.totalTokens > 0 ? `${Math.round((c.tokens / b.totalTokens) * 100)}%` : ''}</td>
                    <td className="py-1 text-small text-text-muted">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="m-0 text-text-muted">The runtime reported no breakdown for this session.</p>
        )}
      </section>

      <section className="flex flex-col gap-2" data-testid="agent-context-cache">
        <h3 className="m-0 text-caption font-medium text-text-muted">Cache</h3>
        {v.cache.length === 0 ? (
          <p className="m-0 text-text-muted">No request was recorded for this session.</p>
        ) : (
          <dl className="m-0 grid max-w-2xl grid-cols-[12rem_1fr] gap-y-1.5">
            <dt className="text-text-muted">Requests</dt>
            <dd className="tnum m-0">{formatCount(v.cache.length)}</dd>
            <dt className="text-text-muted">Read from cache</dt>
            <dd className="tnum m-0">{percent(cacheReadShare(totals))} ({formatTokens(totals.cacheReadTokens)} read, {formatTokens(totals.cacheWriteTokens)} written, {formatTokens(totals.inputTokens)} uncached)</dd>
            <dt className="text-text-muted">First request</dt>
            <dd className="m-0">
              {first ? (first.result === 'read' ? 'Read its prefix from cache' : first.result === 'write' ? 'Wrote its prefix' : first.result === 'partial' ? 'Read part of its prefix' : 'No cache figures reported') : '—'}
              {first?.cause ? <span className="text-text-muted">. {MISS_CAUSE_LABEL[first.cause] ?? first.cause} (NEXUS's inference)</span> : null}
            </dd>
          </dl>
        )}
      </section>

      <section className="flex flex-col gap-2" data-testid="agent-context-graph">
        <h3 className="m-0 text-caption font-medium text-text-muted">Why this context? Context Graph nodes</h3>
        {v.graphNodes.length === 0 ? (
          <p className="m-0 text-text-muted">No graph node was considered for this agent's context.</p>
        ) : (
          <>
            <div className="text-small text-text-secondary">Loaded ({loaded.length})</div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {loaded.map((n, i) => (
                <li key={`${n.nodeId}${i}`} className="flex flex-col">
                  <span className="font-medium">{n.title}</span>
                  <span className="text-small text-text-muted">{n.reason}</span>
                </li>
              ))}
            </ul>
            {available.length > 0 ? (
              <details>
                <summary className="cursor-pointer text-small text-text-secondary">Considered and left out ({available.length})</summary>
                <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                  {available.map((n, i) => (
                    <li key={`${n.nodeId}${i}`} className="flex flex-col">
                      <span>{n.title}</span>
                      <span className="text-small text-text-muted">{n.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </section>

      <section className="flex flex-col gap-2" data-testid="agent-context-decisions">
        <h3 className="m-0 text-caption font-medium text-text-muted">Context decisions</h3>
        {v.decisions.length === 0 && v.compactions.length === 0 ? (
          <p className="m-0 text-text-muted">None recorded.</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {v.decisions.map((d) => (
              <li key={d.id} className="flex gap-3">
                <span className="w-24 shrink-0 text-small text-text-muted">{formatRelative(d.createdAt)}</span>
                <span className="min-w-0">
                  <Badge>{ACTION_LABEL[d.action] ?? d.action}</Badge> <span className="text-text-secondary">{d.reason}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {v.efficiency.length > 0 ? (
          <p className="m-0 text-small text-text-muted">
            Session checks: {v.efficiency.map((e) => `${e.action === 'KEEP' ? 'kept' : e.action === 'HANDOFF_AND_ROTATE' ? 'rotated' : e.action.toLowerCase().replace(/_/g, ' ')} at ${e.turns} turns (${e.pressure.toLowerCase()} pressure)`).join('; ')}.
          </p>
        ) : null}
      </section>
    </div>
  )
}
