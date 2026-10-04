import { API_KEY_WARNING, type AuthStatus } from '@shared/auth'
import { useAuthStatus, useRefreshAuth, useSettings, useUpdateSettings } from '../../lib/queries'
import { summarizeAuth } from '../../lib/authSummary'
import { DASH, formatDateTime } from '../../lib/format'
import { TONE_CLASSES } from '../../lib/status'
import { cn } from '../../lib/cn'
import {
  Button,
  CodeBlock,
  ErrorNote,
  InlineCode,
  KeyValue,
  Loading,
  Notice,
  PageHeader,
  Panel,
  RefreshIcon,
  StatusDot,
  Toggle,
} from '../../components/ui'

function statusRows(s: AuthStatus) {
  return [
    { label: 'Mode', value: s.mode.replace('_', ' ') },
    { label: 'Subscription', value: s.subscriptionType ?? DASH },
    { label: 'API provider', value: s.apiProvider ?? DASH },
    { label: 'Key source', value: s.apiKeySource ?? DASH },
    { label: 'Account', value: s.email ?? DASH },
    { label: 'Organization', value: s.organization ?? DASH },
    { label: 'Claude Code', value: s.claudeCodeVersion ?? DASH, mono: true },
    { label: 'Checked', value: formatDateTime(s.checkedAt), mono: true },
  ]
}

export function AuthView() {
  const auth = useAuthStatus()
  const settings = useSettings().data
  const refresh = useRefreshAuth()
  const updateSettings = useUpdateSettings()
  const status = auth.data

  const setSubscriptionMode = (v: boolean) => {
    if (!settings) return
    updateSettings.mutate({ settings: { ...settings, claude: { ...settings.claude, subscriptionMode: v } } })
  }

  const summary = status ? summarizeAuth(status) : null
  const needsLogin = status ? status.state === 'authentication_required' || status.state === 'unknown' : false

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="auth-view">
      <PageHeader
        title="Authentication"
        context="System"
        actions={
          <Button icon={<RefreshIcon size={12} />} loading={refresh.isPending} onClick={() => refresh.mutate()} data-testid="auth-refresh">
            Refresh
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {auth.isPending ? (
          <Loading label="Checking Claude status" />
        ) : auth.isError ? (
          <ErrorNote error={auth.error} />
        ) : status && summary ? (
          <>
            <Panel title="Status" data-testid="auth-status">
              <div className="mb-3 flex items-center gap-2">
                <StatusDot tone={summary.tone} className="size-2.5" />
                <span className={cn('text-heading font-semibold', TONE_CLASSES[summary.tone].text)} data-testid="auth-state-label">
                  {summary.label}
                </span>
              </div>
              {status.error ? <ErrorNote error={status.error} className="mb-3" /> : null}
              <KeyValue rows={statusRows(status)} />
              {status.warnings.length > 0 ? (
                <ul className="mb-0 mt-3 list-disc pl-5 text-tone-warning">
                  {status.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </Panel>

            {status.apiKeyEnvDetected ? (
              <Notice tone="warning" title="API key detected in the environment" data-testid="api-key-warning">
                <p className="m-0 text-text-primary">{API_KEY_WARNING}</p>
                <p className="mb-0 mt-1.5" data-testid="api-key-stripped">
                  {status.apiKeyEnvStripped
                    ? 'Subscription Mode is on: the key is removed from every agent environment, so agents cannot use it.'
                    : 'Subscription Mode is off: the key is passed through to agents, and usage may be billed to the API.'}
                </p>
              </Notice>
            ) : null}

            {needsLogin ? (
              <Notice tone="active" title="Sign in with the Claude Code CLI">
                Run the official login in a terminal, then press Refresh:
                <CodeBlock className="mt-2">claude auth login</CodeBlock>
              </Notice>
            ) : null}

            {status.state === 'runtime_unavailable' || status.state === 'sdk_error' ? (
              <Notice tone="danger" title="Claude cannot be started">
                Check that Claude Code is installed (or set an executable path under Settings, Claude), then press Refresh.
              </Notice>
            ) : null}
          </>
        ) : null}

        <Panel title="Subscription Mode">
          <Toggle
            checked={settings?.claude.subscriptionMode ?? false}
            disabled={!settings || updateSettings.isPending}
            onChange={setSubscriptionMode}
            label="Use my Claude subscription (Subscription Mode)"
            description={
              <>
                Removes <InlineCode>ANTHROPIC_API_KEY</InlineCode> and <InlineCode>ANTHROPIC_AUTH_TOKEN</InlineCode> from every agent
                environment so sessions use your signed-in Claude subscription rather than API billing.
              </>
            }
            data-testid="subscription-toggle"
          />
        </Panel>

        <Panel title="How login works">
          <div className="flex flex-col gap-2 text-text-secondary">
            <p className="m-0">
              NEXUS never sees or stores your credentials. Sign-in is handled entirely by the official Claude Code login flow:
              run <InlineCode>claude auth login</InlineCode> in a terminal. NEXUS only asks the Claude runtime what it reports.
            </p>
            <p className="m-0">
              How subscription usage is metered and which plans include Claude Code is decided by Anthropic and may change.
              NEXUS can report what the runtime tells it, but it cannot guarantee how a given run is billed.
            </p>
          </div>
        </Panel>
      </div>
      </div>
    </div>
  )
}
