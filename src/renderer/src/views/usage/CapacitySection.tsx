import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/bridge'
import { useUiStore } from '../../store/ui'
import { Button, Card, ErrorNote, KeyValue, Notice } from '../../components/ui'

/** The same words as on the Providers page. */
const CONNECTION_LABEL: Record<string, string> = {
  SIGNED_OUT: 'Not connected',
  CONNECTING: 'Sign-in in progress',
  SIGNED_IN_NO_PLAN_USAGE: 'Connected · plan usage not granted',
  SIGNED_IN_PLAN_USAGE: 'Connected · plan usage granted',
  AUTH_REQUIRES_RECONNECT: 'Reconnect required',
  STORAGE_UNAVAILABLE: 'Protected storage unavailable',
}

export function CapacitySection() {
  const setView = useUiStore((s) => s.setView)
  const query = useQuery({
    queryKey: ['chatgpt-status'],
    queryFn: () => api.invoke('chatgpt.status', {}),
    refetchInterval: 5000,
  })
  const advisory = useQuery({ queryKey: ['usage-advisory'], queryFn: () => api.invoke('director.advisoryUsage', { days: 7 }), refetchInterval: 15000 })
  const connection = query.data,
    pool = connection?.capacity
  return (
    <Card
      title="Provider capacity"
      description="Provider allowance, observed request outcomes and routing policy are separate facts."
      data-testid="intelligence-capacity"
    >
      <div className="space-y-4">
        {query.error ? <ErrorNote error={query.error} /> : null}
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="space-y-2">
            <h3 className="font-medium">ChatGPT connection</h3>
            <KeyValue
              rows={[
                {
                  label: 'Connection',
                  value: connection ? CONNECTION_LABEL[connection.state] : 'Loading…',
                },
                {
                  label: 'Capacity state',
                  value:
                    pool?.state.replaceAll('_', ' ').toLowerCase() ??
                    (query.isPending
                      ? 'Loading…'
                      : query.isError
                        ? 'Unavailable'
                        : 'No registration'),
                },
                { label: 'Remaining allowance', value: 'Unknown · not exposed by this adapter' },
                { label: 'Reset time', value: 'Unknown' },
                {
                  label: 'State evidence',
                  value: pool?.stateEvidence
                    ? `${pool.stateEvidence.source.toLowerCase().replaceAll('_', ' ')} · ${pool.stateEvidence.confidence.toLowerCase()}`
                    : 'None',
                },
                ...(pool?.stateEvidence
                  ? [
                      {
                        label: 'Observed',
                        value: new Date(pool.stateEvidence.observedAt).toLocaleString(),
                      },
                    ]
                  : []),
                ...(pool?.nextProbeAt
                  ? [
                      {
                        label: 'Explicit retry eligible after',
                        value: new Date(pool.nextProbeAt).toLocaleString(),
                      },
                    ]
                  : []),
              ]}
            />
          </section>
          <section className="space-y-2">
            <h3 className="font-medium">Which provider does what</h3>
            <p className="text-small">
              This app registration supplies strategic advice and specification development. Its
              capacity binding has not been verified as shared with the Codex CLI account.
            </p>
            <p className="text-small">
              Claude worker windows and quota recovery appear below. Local token counts are workload
              measurements; they do not establish subscription allowance.
            </p>
            <p className="text-small">
              The Technical Director runs on Claude. A worker session is moved to another provider
              only where you chose that provider for the role, or where tested evidence of its
              quality is on record; none is recorded by this version, so work that Claude cannot take
              waits for Claude.
            </p>
            <Button size="sm" onClick={() => setView('providers')}>
              Manage provider connections
            </Button>
          </section>
        </div>
        <section className="space-y-2" data-testid="advisory-usage">
          <h3 className="font-medium">Used for advice and specifications, last 7 days</h3>
          {advisory.error ? <ErrorNote error={advisory.error} /> : null}
          {advisory.data && advisory.data.providers.length === 0 ? (
            <p className="text-small text-text-muted">No request was sent to a Director or for a specification in this period.</p>
          ) : null}
          {advisory.data?.providers.map((p) => (
            <KeyValue
              key={p.provider}
              rows={[
                { label: p.provider === 'openai' ? 'ChatGPT' : p.provider === 'claude' ? 'Claude' : 'Codex', value: `${p.requests} request${p.requests === 1 ? '' : 's'}` },
                { label: 'Tokens the provider reported', value: p.reported > 0 ? `${p.inputTokens.toLocaleString()} in · ${p.outputTokens.toLocaleString()} out, over ${p.reported} request${p.reported === 1 ? '' : 's'}` : 'None reported' },
                ...(p.unreported > 0 ? [{ label: 'Sent, use not reported', value: String(p.unreported) }] : []),
                ...(p.notSent > 0 ? [{ label: 'Admitted but not sent', value: String(p.notSent) }] : []),
              ]}
            />
          ))}
          <p className="text-small text-text-muted">
            Counted from the receipt kept with each request of the compiler and the Directors. These are measurements of the work, not a share of a plan&apos;s allowance, which stays unknown. Agent sessions are counted below.
          </p>
        </section>
        {pool?.nextProbeAt ? (
          <Notice tone="warning" title="Backoff is saved">
            The retry time is a local recovery policy, not a provider reset promise. A request after
            this time may probe availability. Unchanged quota does not trigger automatic retries.
          </Notice>
        ) : null}
      </div>
    </Card>
  )
}
