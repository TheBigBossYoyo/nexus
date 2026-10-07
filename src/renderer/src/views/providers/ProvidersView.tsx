import { useState } from 'react'
import { ChatGPTCard } from './ChatGPTCard'
import {
  PROVIDER_NAMES,
  type ProviderId,
  type ProviderPolicy,
  type ProvidersOverview,
  type ProviderStatus,
} from '@shared/provider'
import {
  useProbeProvider,
  useProvidersOverview,
  useRefreshProviders,
  useSetProviderPolicy,
} from '../../lib/queries-v6'
import { formatTokens } from '../../lib/format'
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  KeyValue,
  Notice,
  PageHeader,
  RefreshIcon,
  Select,
  TimeAgo,
  Toggle,
} from '../../components/ui'
import {
  capabilityRows,
  enableConsent,
  enableSwitch,
  providerHeadline,
  safetyLine,
  sessionOutcome,
  sessionProviderLabel,
  usageLine,
  useAvailability,
  withEnabled,
} from './providersModel'

function ProviderCard({
  status,
  overview,
  onPolicy,
  saving,
}: {
  status: ProviderStatus
  overview: ProvidersOverview
  onPolicy: (p: ProviderPolicy) => void
  saving: boolean
}) {
  const probe = useProbeProvider()
  const [probed, setProbed] = useState<{ ok: boolean; detail: string } | null>(null)
  const policy = overview.policy
  const enabled = policy.enabled[status.id]
  const headline = providerHeadline(status, enabled)
  const sw = enableSwitch(status, policy)
  const performance = overview.performance.find((p) => p.provider === status.id)
  const usage = overview.usage.find((u) => u.provider === status.id)
  // A test is a real session with that provider: it is offered only for a provider you have enabled.
  const canProbe =
    status.installed === 'installed' &&
    status.supported &&
    status.auth !== 'auth_required' &&
    (status.required || enabled)
  return (
    <Card
      title={status.displayName}
      description={
        status.required
          ? 'Required. Plans, implements and verifies; every fallback goes here.'
          : 'Optional. Used only for what you switch on below.'
      }
      data-testid={`provider-${status.id}`}
      actions={
        <div className="flex items-center gap-2">
          <Badge tone={headline.tone} data-testid={`provider-state-${status.id}`}>
            {headline.label}
          </Badge>
          {canProbe ? (
            <Button
              size="sm"
              loading={probe.isPending}
              onClick={() =>
                probe.mutate(
                  { provider: status.id },
                  { onSuccess: (r) => setProbed({ ok: r.ok, detail: r.detail }) },
                )
              }
              title="Runs one minimal session with this provider. It uses a little of that provider's quota."
              data-testid={`provider-probe-${status.id}`}
            >
              Test
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {headline.detail ? (
          <p
            className="m-0 text-small text-text-secondary"
            data-testid={`provider-detail-${status.id}`}
          >
            {headline.detail}
          </p>
        ) : null}
        {probed ? (
          <Notice
            tone={probed.ok ? 'success' : 'danger'}
            title={probed.ok ? 'The test session worked' : 'The test session failed'}
            data-testid={`provider-probe-result-${status.id}`}
          >
            {probed.detail}
          </Notice>
        ) : null}
        {probe.error ? <ErrorNote error={probe.error} /> : null}
        {canProbe ? (
          <p
            className="m-0 text-small text-text-muted"
            data-testid={`provider-probe-note-${status.id}`}
          >
            Test runs one minimal session with {status.displayName} and uses a little of its quota.
          </p>
        ) : null}
        <p className="m-0 text-small font-medium" data-testid={`provider-safety-${status.id}`}>
          {safetyLine(status)}
        </p>
        <KeyValue
          rows={[
            { label: 'Version', value: status.version ?? '—', mono: true },
            {
              label: 'Sign-in',
              value:
                status.auth === 'authenticated'
                  ? (status.authDetail ?? 'Signed in')
                  : status.auth === 'auth_required'
                    ? 'Not signed in'
                    : 'Not known',
            },
            {
              label: 'Models',
              value:
                status.models.length > 0 ? status.models.map((m) => m.displayName).join(', ') : '—',
            },
            ...capabilityRows(status.capabilities).map((r) => ({ label: r.label, value: r.value })),
          ]}
          labelWidth="8.5rem"
        />
        <div
          className="rounded-md border bg-surface px-3 py-2 text-small"
          data-testid={`provider-usage-${status.id}`}
        >
          <p className="m-0">{usage ? usageLine(usage) : 'Plan usage: not known.'}</p>
          <p
            className="m-0 mt-1 text-text-secondary"
            data-testid={`provider-performance-${status.id}`}
          >
            Recent sessions: {performance?.sessions ?? 0} ({performance?.completed ?? 0} completed,{' '}
            {performance?.failed ?? 0} failed
            {performance && performance.fallbacksFrom > 0
              ? `, ${performance.fallbacksFrom} done by Claude instead`
              : ''}
            ). Observed tokens: {formatTokens(usage?.observed.inputTokens ?? 0)} in,{' '}
            {formatTokens(usage?.observed.outputTokens ?? 0)} out. These are counts, not a ranking.
          </p>
        </div>
        {sw.shown ? (
          <div className="flex flex-col gap-1">
            <Toggle
              checked={sw.checked}
              disabled={saving || sw.disabledReason !== null}
              onChange={(on) =>
                onPolicy(withEnabled(policy, status.id as Exclude<ProviderId, 'claude'>, on))
              }
              label={`Allow NEXUS to use ${status.displayName}`}
              description={enableConsent(status)}
              data-testid={`provider-enable-${status.id}`}
            />
            {sw.disabledReason ? (
              <p
                className="m-0 pl-[42px] text-small text-text-muted"
                data-testid={`provider-enable-blocked-${status.id}`}
              >
                {sw.disabledReason}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function RoutingCard({
  overview,
  onPolicy,
  saving,
}: {
  overview: ProvidersOverview
  onPolicy: (p: ProviderPolicy) => void
  saving: boolean
}) {
  const policy = overview.policy
  const others = overview.statuses
    .filter((s) => !s.required)
    .map((s) => ({ value: s.id, label: s.displayName }))
  const review = useAvailability(
    'review',
    policy.crossModelReview.reviewer,
    policy,
    overview.statuses,
  )
  const speculation = useAvailability(
    'speculation',
    policy.heterogeneousSpeculation.secondCandidate,
    policy,
    overview.statuses,
  )
  return (
    <Card
      title="Routing"
      description="What other providers are used for. With everything off, every session runs on Claude, exactly as before 0.6."
      data-testid="providers-routing"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Toggle
            checked={policy.crossModelReview.enabled}
            disabled={saving || (!policy.crossModelReview.enabled && !review.available)}
            onChange={(on) =>
              onPolicy({ ...policy, crossModelReview: { ...policy.crossModelReview, enabled: on } })
            }
            label="Cross-model review"
            description="Claude implements, another provider reviews, Claude verifies. The diff and the files the reviewer reads are sent to that provider. A reviewer's finding is a claim to check against tests and source, never the verdict. If that provider cannot be used, Claude reviews instead when Fall back to Claude is on, and the mission shows it."
            data-testid="routing-review"
          />
          <div className="flex items-center gap-2 pl-[42px]">
            <span className="text-small text-text-secondary">Reviewer</span>
            <div className="w-44 shrink-0">
              <Select
                value={policy.crossModelReview.reviewer}
                options={others}
                disabled={saving}
                onChange={(reviewer) =>
                  onPolicy({ ...policy, crossModelReview: { enabled: false, reviewer } })
                }
                data-testid="routing-review-provider"
                aria-label="Reviewing provider"
              />
            </div>
            {!review.available && review.reason ? (
              <span className="text-small text-text-muted" data-testid="routing-review-blocked">
                {review.reason}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Toggle
            checked={policy.heterogeneousSpeculation.enabled}
            disabled={
              saving || (!policy.heterogeneousSpeculation.enabled && !speculation.available)
            }
            onChange={(on) =>
              onPolicy({
                ...policy,
                heterogeneousSpeculation: { ...policy.heterogeneousSpeculation, enabled: on },
              })
            }
            label="Heterogeneous speculation"
            description="In a speculative task, candidate A is written by Claude and candidate B by another provider, from the same commit in separate clones. The tournament stays objective."
            data-testid="routing-speculation"
          />
          <div className="flex items-center gap-2 pl-[42px]">
            <span className="text-small text-text-secondary">Candidate B</span>
            <div className="w-44 shrink-0">
              <Select
                value={policy.heterogeneousSpeculation.secondCandidate}
                options={others}
                disabled={saving}
                onChange={(secondCandidate) =>
                  onPolicy({
                    ...policy,
                    heterogeneousSpeculation: { enabled: false, secondCandidate },
                  })
                }
                data-testid="routing-speculation-provider"
                aria-label="Provider of candidate B"
              />
            </div>
            {!speculation.available && speculation.reason ? (
              <span
                className="text-small text-text-muted"
                data-testid="routing-speculation-blocked"
              >
                {speculation.reason}
              </span>
            ) : null}
          </div>
        </div>
        <Toggle
          checked={policy.fallbackToClaude}
          disabled={saving}
          onChange={(on) => onPolicy({ ...policy, fallbackToClaude: on })}
          label="Fall back to Claude"
          description="When the chosen provider cannot be used, Claude does the work and the reason is recorded. Off: that session is refused instead."
          data-testid="routing-fallback"
        />
      </div>
    </Card>
  )
}

function RecentSessions({ overview }: { overview: ProvidersOverview }) {
  const other = overview.recent.filter((s) => s.provider !== 'claude' || s.requested !== 'claude')
  return (
    <Card
      title="Sessions that involved another provider"
      description="Sessions another provider ran, and sessions Claude ran in its place."
      data-testid="providers-recent"
    >
      {other.length === 0 ? (
        <p className="m-0 text-small text-text-muted" data-testid="providers-recent-empty">
          None yet. Every session so far ran on Claude.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {other.slice(0, 20).map((s) => {
            const outcome = sessionOutcome(s)
            return (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border bg-surface px-3 py-1.5 text-small"
                data-testid={`provider-session-${s.id}`}
                data-provider={s.provider}
                data-requested={s.requested}
              >
                <Badge tone={outcome.tone}>{outcome.label}</Badge>
                <span className="font-medium">{s.role.replace('_', ' ')}</span>
                <span>{sessionProviderLabel(s)}</span>
                <span className="text-text-muted">
                  <TimeAgo iso={s.createdAt} />
                </span>
                {s.fallbackReason ? (
                  <span className="basis-full text-text-secondary">{s.fallbackReason}</span>
                ) : null}
                {s.error && s.outcome === 'failed' ? (
                  <span className="basis-full text-danger">{s.error}</span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/** Providers: which agent runtimes exist on this computer, what the user allows, and who did what. */
export function ProvidersView() {
  const overview = useProvidersOverview()
  const refresh = useRefreshProviders()
  const save = useSetProviderPolicy()
  const o = overview.data ?? null
  const onPolicy = (policy: ProviderPolicy): void => save.mutate({ policy })
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="providers-page">
      <PageHeader
        title="Providers"
        context="Intelligence"
        actions={
          <Button
            size="sm"
            icon={<RefreshIcon size={13} />}
            onClick={() => refresh.mutate({})}
            loading={refresh.isPending}
            data-testid="providers-refresh"
          >
            Detect again
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-6 py-5">
          <ChatGPTCard />
          {overview.error ? (
            <div className="flex flex-col items-start gap-2" data-testid="providers-error">
              <ErrorNote error={overview.error} />
              <Button size="sm" onClick={() => void overview.refetch()}>
                Try again
              </Button>
            </div>
          ) : null}
          {refresh.error ? <ErrorNote error={refresh.error} /> : null}
          {save.error ? (
            <div data-testid="providers-policy-error">
              <ErrorNote error={save.error} />
            </div>
          ) : null}
          {!o ? overview.error ? null : (
              <p className="m-0 text-text-muted" role="status" data-testid="providers-loading">
                Detecting providers…
              </p>
            ) : (
            <>
              <p className="m-0 text-small text-text-secondary" data-testid="providers-intro">
                These execution providers are detected through their command line tools without
                sending a model prompt. {PROVIDER_NAMES.claude} currently plans and implements missions;
                optional providers handle only the roles enabled below. The ChatGPT strategy
                connection above has separate sign-in and consent controls.
              </p>
              <div className="grid gap-4 xl:grid-cols-3" data-testid="providers-list">
                {o.statuses.map((s) => (
                  <ProviderCard
                    key={s.id}
                    status={s}
                    overview={o}
                    onPolicy={onPolicy}
                    saving={save.isPending}
                  />
                ))}
              </div>
              <RoutingCard overview={o} onPolicy={onPolicy} saving={save.isPending} />
              <RecentSessions overview={o} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
