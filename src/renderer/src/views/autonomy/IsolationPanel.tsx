import { useState } from 'react'
import type { ContainmentCheckView } from '@shared/isolation'
import { useIsolationStatus, useSandboxSetup } from '../../lib/queries-autonomy'
import { cn } from '../../lib/cn'
import { Badge, Button, ErrorNote, Loading, Notice, TimeAgo } from '../../components/ui'
import {
  CHECKED_PROFILES,
  EFFECTIVE_LABEL,
  EFFECTIVE_SENTENCE,
  PROTECTED_VISIBLE,
  SETUP_DONE_LINE,
  SETUP_REPAIR_LINE,
  SETUP_UNAVAILABLE_LINE,
  availabilityWords,
  effectiveLine,
  protectedSummary,
  setupRetryLine,
  setupState,
  unusableWarning,
} from './isolationModel'

function ProfileRow({
  profile,
  check,
}: {
  profile: (typeof CHECKED_PROFILES)[number]
  check: ContainmentCheckView | null
}) {
  return (
    <li
      className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0"
      data-testid={`isolation-${profile.toLowerCase()}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{EFFECTIVE_LABEL[profile]}</span>
        <Badge tone={check?.available ? 'success' : 'neutral'}>{availabilityWords(check)}</Badge>
        {check ? (
          <span className="ml-auto whitespace-nowrap text-small text-text-muted">
            Checked <TimeAgo iso={check.checkedAt} />
          </span>
        ) : null}
      </div>
      <p className="m-0 text-text-secondary">{EFFECTIVE_SENTENCE[profile]}</p>
      {check ? <p className="m-0">{check.detail}</p> : null}
    </li>
  )
}

function ProtectedPaths({ paths }: { paths: string[] }) {
  const list = (items: string[]) => (
    <ul
      className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0"
      aria-label="Protected from contained code"
      data-testid="isolation-protected"
    >
      {items.map((p) => (
        <li key={p} className="break-all font-mono text-code">
          {p}
        </li>
      ))}
    </ul>
  )
  if (paths.length === 0) return <p className="m-0 text-text-secondary">{protectedSummary(0)}</p>
  if (paths.length <= PROTECTED_VISIBLE) {
    return (
      <div>
        <p className="m-0 text-text-secondary">{protectedSummary(paths.length)}</p>
        {list(paths)}
      </div>
    )
  }
  return (
    <details data-testid="isolation-protected-details">
      <summary className="cursor-pointer text-text-secondary">
        {protectedSummary(paths.length)}
      </summary>
      {list(paths)}
    </details>
  )
}

/** Settings, Autonomy: which containment project code runs in, whether it held at this start, and the one-time setup of the isolated profile. */
export function IsolationPanel() {
  const status = useIsolationStatus()
  const setup = useSandboxSetup()
  const [outcome, setOutcome] = useState<{ ok: boolean; detail: string } | null>(null)

  const runSetup = () => {
    if (setup.isPending) return
    setOutcome(null)
    setup.mutate({}, { onSuccess: (o) => setOutcome({ ok: o.ok, detail: o.detail }) })
  }

  const s = status.data
  const state = s ? setupState(s) : null
  const warning = s ? unusableWarning(s, state === 'offer' || state === 'repair') : null
  const failed = setup.isError || (outcome !== null && !outcome.ok)
  const message = setup.isPending
    ? 'Setting up. Confirm in the NEXUS dialog, then in the Windows prompt.'
    : setup.error
      ? `Setup did not run. ${setup.error.message}`
      : outcome
        ? `${outcome.ok ? '' : 'Setup did not finish. '}${outcome.detail}${outcome.ok ? '' : ` ${setupRetryLine(outcome.detail)}`}`
        : ''

  return (
    <section
      className="flex max-w-3xl flex-col gap-3"
      aria-labelledby="isolation-title"
      data-testid="isolation-panel"
      id="isolation-panel"
    >
      <h3 id="isolation-title" className="m-0 text-body font-semibold">
        Execution isolation
      </h3>
      {status.isPending ? (
        <Loading label="Loading isolation status" />
      ) : status.isError ? (
        <ErrorNote error={status.error} />
      ) : s ? (
        <>
          <div className="flex flex-col gap-1" data-testid="isolation-effective">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">In effect</span>
              <Badge tone={s.usable ? 'success' : 'danger'}>
                {EFFECTIVE_LABEL[s.effective]}, {s.usable ? 'verified' : 'not verified'}
              </Badge>
            </div>
            <p className="m-0 text-text-secondary">{effectiveLine(s)}</p>
            <p className="m-0">{s.detail}</p>
          </div>

          {warning ? (
            <Notice
              tone="danger"
              title="Project code cannot run"
              live
              data-testid="isolation-unusable"
            >
              {warning}
            </Notice>
          ) : null}

          <ul
            className="m-0 list-none rounded-lg border bg-surface p-0"
            aria-label="Containment profiles"
          >
            {CHECKED_PROFILES.map((p) => (
              <ProfileRow
                key={p}
                profile={p}
                check={p === 'ISOLATED' ? s.isolated : s.restricted}
              />
            ))}
            <li className="flex flex-col gap-1 px-3 py-2" data-testid="isolation-standard">
              <span className="font-medium">{EFFECTIVE_LABEL.STANDARD}</span>
              <p className="m-0 text-text-secondary">{EFFECTIVE_SENTENCE.STANDARD}</p>
            </li>
          </ul>

          <div className="flex flex-col gap-2" data-testid="isolation-setup">
            {state === 'offer' || state === 'repair' ? (
              <>
                <p className="m-0 text-text-secondary">
                  {state === 'repair'
                    ? SETUP_REPAIR_LINE
                    : 'The isolated profile needs a sandbox account on this machine. Setting it up asks for your confirmation and then for administrator rights, and it can take a few minutes.'}
                </p>
                <div>
                  <Button
                    variant="primary"
                    busy={setup.isPending}
                    loading={setup.isPending}
                    onClick={runSetup}
                    data-testid="isolation-setup-button"
                  >
                    {state === 'repair' ? 'Run the setup again…' : 'Set up the isolated profile…'}
                  </Button>
                </div>
              </>
            ) : state === 'unavailable' ? (
              <p className="m-0 text-text-secondary">{SETUP_UNAVAILABLE_LINE}</p>
            ) : (
              <p className="m-0 text-text-secondary">{SETUP_DONE_LINE}</p>
            )}
            <div
              role="status"
              data-testid="isolation-setup-result"
              className={cn(
                'text-small',
                failed ? 'text-danger' : 'text-text-secondary',
                !message && 'sr-only',
              )}
            >
              {message}
            </div>
          </div>

          <div className="flex flex-col gap-1" data-testid="isolation-protected-block">
            <h4 className="m-0 text-small font-semibold text-text-secondary">
              Protected from contained code
            </h4>
            <ProtectedPaths paths={s.protectedPaths} />
          </div>
        </>
      ) : null}
    </section>
  )
}
