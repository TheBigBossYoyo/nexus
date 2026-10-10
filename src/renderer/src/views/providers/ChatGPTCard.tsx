import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChatGPTStatus } from '@shared/chatgpt'
import { api } from '../../lib/bridge'
import { Button, Card, ErrorNote, Field, Notice, Select, Toggle } from '../../components/ui'

const labels: Record<ChatGPTStatus['state'], string> = {
  SIGNED_OUT: 'Not connected',
  CONNECTING: 'Complete sign-in in your browser',
  SIGNED_IN_NO_PLAN_USAGE: 'Connected · plan usage not granted',
  SIGNED_IN_PLAN_USAGE: 'Connected · plan usage granted',
  AUTH_REQUIRES_RECONNECT: 'Reconnect required',
  STORAGE_UNAVAILABLE: 'Protected storage unavailable',
}

export function ChatGPTCard() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['chatgpt-status'],
    queryFn: () => api.invoke('chatgpt.status', {}),
    refetchInterval: 3000,
  })
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSettled: () => client.invalidateQueries({ queryKey: ['chatgpt-status'] }),
  })
  const status = query.data
  const blocked =
    action.isPending || status?.state === 'CONNECTING' || status?.state === 'STORAGE_UNAVAILABLE'
  const run = (fn: () => Promise<unknown>) => action.mutate(fn)
  return (
    <Card
      title="ChatGPT strategy"
      description="Connect through the official ChatGPT sign-in flow. Strategic previews are advisory and cannot execute tools."
      data-testid="chatgpt-card"
    >
      <div className="space-y-4">
        <p role="status">{status ? labels[status.state] : 'Loading connection…'}</p>
        {query.error ? <ErrorNote error={query.error} /> : null}
        {action.error ? <ErrorNote error={action.error} /> : null}
        {status?.error ? (
          <Notice tone="warning" title="Connection notice">
            {status.error}
          </Notice>
        ) : null}
        {status?.capacity ? (
          <Notice
            tone={
              ['AVAILABLE', 'USAGE_UNKNOWN'].includes(status.capacity.state) ? 'neutral' : 'warning'
            }
            title={`Plan capacity · ${status.capacity.state.replaceAll('_', ' ').toLowerCase()}`}
          >
            Allowance and reset time are unknown. This evidence applies to this ChatGPT app
            registration; no shared Codex pool has been established.
            {status.capacity.nextProbeAt ? (
              <p>
                Backoff ends {new Date(status.capacity.nextProbeAt).toLocaleString()}. A later
                explicit advisory request may probe availability; this time does not guarantee a
                reset.
              </p>
            ) : null}
          </Notice>
        ) : null}
        {status && status.profiles.length > 0 ? (
          <Field label="ChatGPT connection">
            {(id) => (
              <Select
                id={id}
                value={status.activeProfile ?? ''}
                options={status.profiles.map((p) => ({ value: p.id, label: p.label }))}
                disabled={blocked}
                onChange={(profileId) => run(() => api.invoke('chatgpt.select', { profileId }))}
              />
            )}
          </Field>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={blocked || !status}
            onClick={() => run(() => api.invoke('chatgpt.connect', {}))}
          >
            Connect an account
          </Button>
          {status?.activeProfile ? (
            <>
              <Button
                disabled={blocked}
                onClick={() =>
                  run(() => api.invoke('chatgpt.connect', { profileId: status.activeProfile! }))
                }
              >
                Reconnect
              </Button>
              <Button
                disabled={blocked}
                onClick={() => run(() => api.invoke('chatgpt.disconnect', {}))}
              >
                Disconnect
              </Button>
            </>
          ) : null}
          <Button
            onClick={() => run(() => api.invoke('chatgpt.manageUsage', {}))}
            disabled={action.isPending}
          >
            Manage ChatGPT usage
          </Button>
        </div>
        {status?.state === 'SIGNED_IN_PLAN_USAGE' ? (
          <>
            <Button disabled={blocked} onClick={() => run(() => api.invoke('chatgpt.models', {}))}>
              Refresh available models
            </Button>
            {status.models.length ? (
              <Field label="Strategic model">
                {(id) => (
                  <Select
                    id={id}
                    value={status.model ?? ''}
                    disabled={blocked}
                    options={[
                      { value: '', label: 'Choose a model', disabled: true },
                      ...status.models.map((m) => ({ value: m.slug, label: m.display_name })),
                    ]}
                    onChange={(model) =>
                      run(() =>
                        api.invoke('chatgpt.configure', {
                          model,
                          includedOnlyConfirmed: status.includedOnlyConfirmed,
                        }),
                      )
                    }
                  />
                )}
              </Field>
            ) : (
              <p className="text-small text-text-muted">
                {status.model ? `Saved model: ${status.model}. ` : ''}Refresh the catalog to choose
                a model. Catalog visibility does not guarantee plan access.
              </p>
            )}
            <Toggle
              checked={status.includedOnlyConfirmed}
              disabled={
                blocked || !status.model || (!status.includedOnlyConfirmed && !status.models.length)
              }
              label="I have disabled paid credits in ChatGPT Usage settings"
              description="This switch is also what lets NEXUS send anything to OpenAI: while it is off, nothing is sent, and you stay signed in. ChatGPT controls the paid-credit setting; NEXUS cannot verify it or enforce a spending cap."
              onChange={(includedOnlyConfirmed) =>
                run(() =>
                  api.invoke('chatgpt.configure', { model: status.model!, includedOnlyConfirmed }),
                )
              }
            />
          </>
        ) : null}
        <div className="text-small text-text-secondary" data-testid="chatgpt-data-notice">
          <p className="font-medium text-text-primary">What is sent to OpenAI</p>
          <p>
            {status?.state === 'SIGNED_IN_PLAN_USAGE'
              ? 'Only while the switch above is on, and only when you ask for it:'
              : 'Connecting sends nothing. After you connect and choose a model, a switch on this card turns sending on; nothing is sent before you turn it on. Then, only when you ask for it:'}{' '}
            developing a request with ChatGPT (the compilation depths Automatic, Standard, Technical and Council),
            or asking the Strategic Director or the Council.
          </p>
          <ul className="list-disc pl-4">
            <li>your request as you wrote it, with its goals, constraints and criteria;</li>
            <li>earlier instructions, task titles and the program or workspace goals of the same work;</li>
            <li>the names of the project&apos;s check commands;</li>
            <li>
              up to twelve entries of the project&apos;s knowledge that match the request, without notes written
              by agents and with text that looks like a credential removed.
            </li>
          </ul>
          <p>
            File contents are not sent. With Technical, Council and a Director council, OpenAI&apos;s answer is
            also given to Claude and Claude&apos;s answer to OpenAI. Exact wording and Light send nothing to
            OpenAI.
          </p>
        </div>
        <p className="text-small text-text-muted">
          This connection is separate from the Codex CLI account. Quota and reset time remain
          unknown until supported provider evidence is available. Disconnecting removes local tokens
          and attempts remote revocation.
        </p>
      </div>
    </Card>
  )
}
