import type { Agent } from '@shared/domain'
import { useRoutingDecisions } from '../../lib/queries'
import { Badge, ErrorNote, Loading } from '../../components/ui'
import { DASH, formatDateTime } from '../../lib/format'

/** The routing decisions recorded for one agent: requested policy → resolved policy and model, with the rule reasons. */
export function RoutingSection({ agent }: { agent: Agent }) {
  const query = useRoutingDecisions(agent.runId)
  const decisions = (query.data ?? [])
    .filter((d) => d.agentId === agent.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return (
    <section data-testid="agent-routing">
      <h3 className="m-0 mb-1.5 text-heading font-semibold text-text-primary">Model routing · {decisions.length}</h3>
      {query.isError ? <ErrorNote error={query.error} /> : null}
      {query.isPending ? <Loading label="Loading routing" /> : null}
      {query.isSuccess && decisions.length === 0 ? <div className="text-text-muted">No routing decision was recorded for this agent.</div> : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {decisions.map((d) => (
          <li key={d.id} className="flex flex-col gap-1 rounded-md border bg-surface p-2.5" data-testid="routing-decision">
            <div className="flex flex-wrap items-center gap-2">
              <Badge mono>{d.requestedPolicy}</Badge>
              <span className="text-text-muted">→</span>
              <Badge mono tone={d.resolvedPolicy === d.requestedPolicy ? 'neutral' : 'active'}>
                {d.resolvedPolicy}
              </Badge>
              <span className="font-mono text-code">{d.resolvedModel ?? 'runtime default model'}</span>
              <span className="font-mono text-[0.85em] text-text-muted">tier {d.resolvedTier ?? DASH}</span>
              <span className="ml-auto text-text-muted">{formatDateTime(d.createdAt)}</span>
            </div>
            {d.reasons.length === 0 ? (
              <div className="text-text-muted">No rule changed the requested policy.</div>
            ) : (
              <ol className="m-0 list-decimal pl-5">
                {d.reasons.map((r, i) => (
                  <li key={i} className="break-words">
                    {r}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Compact header form: "requested → resolved" for the agent's latest routing decision; renders nothing without one. */
export function RoutingBadge({ agent }: { agent: Agent }) {
  const query = useRoutingDecisions(agent.runId)
  const latest = (query.data ?? []).filter((d) => d.agentId === agent.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!latest) return null
  return (
    <Badge mono data-testid="agent-routing-badge">
      {latest.requestedPolicy === latest.resolvedPolicy ? latest.resolvedPolicy : `${latest.requestedPolicy} → ${latest.resolvedPolicy}`}
    </Badge>
  )
}
