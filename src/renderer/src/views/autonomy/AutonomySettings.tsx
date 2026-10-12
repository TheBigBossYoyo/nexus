import { useEffect, useMemo, useState } from 'react'
import {
  AUTONOMY_CAPABILITIES,
  type AutonomyOverview,
  type AutonomyProfile,
} from '@shared/autonomy'
import { useProjects } from '../../lib/queries'
import {
  useAutonomyOverview,
  useEnrollProject,
  useIsolationStatus,
  useRevokeGrant,
  useUnenrollProject,
} from '../../lib/queries-autonomy'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../store/ui'
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorNote,
  Field,
  Loading,
  Notice,
  Select,
  TimeAgo,
  type Column,
} from '../../components/ui'
import { projectCodeLine } from './isolationModel'
import {
  BOUNDARY_REQUEST_DEFINITION,
  NEVER_POSSIBLE_LINE,
  PROFILE_LABEL,
  PROFILE_ORDER,
  PROFILE_SENTENCE,
  SCOPE_WORDS,
  UNATTENDED_ANSWER_LINE,
  UNATTENDED_HEADINGS,
  UNATTENDED_LEAD,
  UNATTENDED_TITLE,
  boundaryCountLabel,
  grantEndedWords,
  resolveErrorText,
  severityTone,
  severityWords,
  unattendedSummary,
} from './autonomyModel'

type Grant = AutonomyOverview['grants'][number]

function ProfileChoice({
  value,
  current,
  onChange,
  disabled,
}: {
  value: AutonomyProfile
  current: AutonomyProfile | null
  onChange: (p: AutonomyProfile) => void
  disabled: boolean
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-testid="autonomy-profiles">
      <legend className="mb-1 p-0 text-small font-medium text-text-secondary">Profile</legend>
      {PROFILE_ORDER.map((p) => {
        const id = `autonomy-profile-${p}`
        return (
          <label
            key={p}
            htmlFor={id}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-md border p-3',
              value === p
                ? 'border-border-strong bg-accent-subtle'
                : 'bg-surface hover:bg-surface-hover',
            )}
          >
            <input
              id={id}
              type="radio"
              name="autonomy-profile"
              checked={value === p}
              disabled={disabled}
              onChange={() => onChange(p)}
              className="mt-1 accent-accent"
              data-testid={id}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-text-primary">
                {PROFILE_LABEL[p]}
                {current === p ? (
                  <span className="ml-2 text-small font-normal text-text-muted">(current)</span>
                ) : null}
              </span>
              <span className="text-text-secondary">{PROFILE_SENTENCE[p]}</span>
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

function SummaryLists({
  summary,
  heading,
}: {
  summary: NonNullable<AutonomyOverview['summary']>
  heading: string
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="autonomy-summary">
      <h3 className="m-0 text-body font-semibold">{heading}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="m-0 mb-1 text-small font-semibold text-text-secondary">
            NEXUS may, without asking
          </h4>
          <ul
            className="m-0 flex list-disc flex-col gap-0.5 pl-5"
            aria-label="NEXUS may, without asking"
            data-testid="autonomy-allowed"
          >
            {summary.allowed.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="m-0 mb-1 text-small font-semibold text-text-secondary">
            NEXUS will not, without another decision of yours
          </h4>
          <ul
            className="m-0 flex list-disc flex-col gap-0.5 pl-5"
            aria-label="NEXUS will not, without another decision of yours"
            data-testid="autonomy-withheld"
          >
            {summary.withheld.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="m-0 text-text-secondary" data-testid="autonomy-never">
        {NEVER_POSSIBLE_LINE}
      </p>
    </div>
  )
}

/** Opens by default when the project is enrolled: that is when what holds while nobody is there matters. */
function UnattendedLists({ policy, defaultOpen }: { policy: NonNullable<AutonomyOverview['unattended']>; defaultOpen: boolean }) {
  const list = (title: string, items: string[], testId: string) => (
    <div>
      <h4 className="m-0 mb-1 text-small font-semibold text-text-secondary">{title}</h4>
      <ul
        className="m-0 flex list-disc flex-col gap-0.5 pl-5"
        aria-label={title}
        data-testid={testId}
      >
        {items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </div>
  )
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby="autonomy-unattended-title"
      data-testid="autonomy-unattended"
    >
      <h3 id="autonomy-unattended-title" className="m-0 text-body font-semibold">
        {UNATTENDED_TITLE}
      </h3>
      <p className="m-0 text-text-secondary">{UNATTENDED_LEAD}</p>
      <details data-testid="autonomy-unattended-details" open={defaultOpen}>
        <summary className="cursor-pointer text-text-secondary">{unattendedSummary(policy)}</summary>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          {list(UNATTENDED_HEADINGS.proceeds, policy.proceeds, 'autonomy-unattended-proceeds')}
          {list(UNATTENDED_HEADINGS.waits, policy.waits, 'autonomy-unattended-waits')}
          {list(UNATTENDED_HEADINGS.never, policy.never, 'autonomy-unattended-never')}
          {list(UNATTENDED_HEADINGS.presence, policy.needsPresence, 'autonomy-unattended-presence')}
        </div>
      </details>
      <p className="m-0 text-text-secondary">{UNATTENDED_ANSWER_LINE}</p>
    </section>
  )
}

function GrantsTable({
  grants,
  onRevoke,
  revoking,
  error,
}: {
  grants: Grant[]
  onRevoke: (g: Grant) => void
  revoking: boolean
  error: unknown
}) {
  const rows = useMemo(
    () =>
      [...grants].sort(
        (a, b) => Number(b.active) - Number(a.active) || b.createdAt.localeCompare(a.createdAt),
      ),
    [grants],
  )
  const columns: Column<Grant>[] = [
    { key: 'capability', header: 'Capability', render: (g) => g.capabilityLabel },
    {
      key: 'resource',
      header: 'Resource',
      render: (g) => <span className="break-words">{g.resourceLabel}</span>,
    },
    { key: 'scope', header: 'Scope', render: (g) => SCOPE_WORDS[g.scope] },
    { key: 'when', header: 'Given', render: (g) => <TimeAgo iso={g.createdAt} /> },
    {
      key: 'state',
      header: 'State',
      render: (g) =>
        g.active ? (
          <Badge tone="success">Active</Badge>
        ) : (
          <Badge>{grantEndedWords(g, g.active)}</Badge>
        ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Action</span>,
      align: 'right',
      render: (g) =>
        g.active ? (
          <Button
            size="sm"
            busy={revoking}
            onClick={() => onRevoke(g)}
            aria-label={`Take back: ${g.capabilityLabel}, ${g.resourceLabel}`}
            data-testid="autonomy-take-back"
          >
            Take back
          </Button>
        ) : null,
    },
  ]
  return (
    <div className="flex flex-col gap-2">
      <DataTable
        caption="Grants you gave in this project"
        columns={columns}
        rows={rows}
        rowKey={(g) => g.id}
        rowTestId={(g) => `autonomy-grant-${g.id}`}
        empty="You have given no grant in this project."
      />
      <div
        role="status"
        data-testid="autonomy-revoke-error"
        className={cn('text-small', error ? 'text-danger' : 'sr-only')}
      >
        {error ? resolveErrorText(error) : ''}
      </div>
    </div>
  )
}

function Denials({ events }: { events: AutonomyOverview['recentDenials'] }) {
  if (events.length === 0)
    return (
      <EmptyState title="Nothing was blocked" className="py-6">
        No action has been refused by the policy in this project.
      </EmptyState>
    )
  return (
    <ul
      className="m-0 list-none rounded-lg border bg-surface p-0"
      aria-label="Recent policy denials"
      data-testid="autonomy-denials"
    >
      {events.map((e) => (
        <li key={e.id} className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={severityTone(e.severity)}>{severityWords(e.severity)}</Badge>
            {e.capability ? (
              <span className="text-small text-text-secondary">
                {AUTONOMY_CAPABILITIES[e.capability].label}
              </span>
            ) : null}
            <TimeAgo
              iso={e.timestamp}
              className="ml-auto whitespace-nowrap text-small text-text-muted"
            />
          </div>
          <pre className="m-0 whitespace-pre-wrap break-all font-mono text-code">
            <code>{e.action}</code>
          </pre>
          <p className="m-0 text-text-secondary">{e.reason}</p>
        </li>
      ))}
    </ul>
  )
}

/** Settings, Autonomy: the profile of one project, what it allows, the grants given, what was blocked. Changes apply at once. */
export function AutonomySettings() {
  const projects = useProjects().data ?? []
  const uiProject = useUiStore((s) => s.projectId)
  const setDrawer = useUiStore((s) => s.setDrawer)
  const [projectId, setProjectId] = useState<string | null>(uiProject)
  const [choice, setChoice] = useState<AutonomyProfile | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)

  // A project that exists: the one requested, else the first.
  const selected = projects.find((p) => p.id === projectId)?.id ?? projects[0]?.id ?? null
  useEffect(() => setChoice(null), [selected])

  const base = useAutonomyOverview(selected)
  const enrolled = base.data?.enrollment?.profile ?? null
  const effective: AutonomyProfile = choice ?? enrolled ?? 'BALANCED'
  const considering = effective !== enrolled ? effective : null
  const preview = useAutonomyOverview(considering ? selected : null, considering)
  const overview = base.data
  const summary = considering ? (preview.data?.summary ?? null) : (overview?.summary ?? null)
  const unattended = considering
    ? (preview.data?.unattended ?? null)
    : (overview?.unattended ?? null)

  const isolation = useIsolationStatus().data
  const enroll = useEnrollProject()
  const unenroll = useUnenrollProject()
  const revoke = useRevokeGrant()
  const project = projects.find((p) => p.id === selected)
  const busy = enroll.isPending || unenroll.isPending

  const doEnroll = (profile: AutonomyProfile) => {
    if (!selected || busy) return
    unenroll.reset()
    enroll.mutate({ projectId: selected, profile }, { onSuccess: () => setChoice(null) })
  }
  const actionError = enroll.error ?? unenroll.error

  if (projects.length === 0) {
    return (
      <EmptyState title="No project yet" data-testid="autonomy-no-project">
        Open a project first. Autonomy is set for one project at a time.
      </EmptyState>
    )
  }

  const pendingLabel = overview ? boundaryCountLabel(overview.pending.length) : null

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="autonomy-settings">
      <p className="m-0 text-text-secondary">
        {BOUNDARY_REQUEST_DEFINITION} Enroll a project once: what its profile allows runs without
        asking. Changes here apply at once and are not part of Save.
      </p>

      <Field label="Project">
        {(id) => (
          <Select
            id={id}
            value={selected ?? ''}
            onChange={setProjectId}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            className="max-w-sm"
            data-testid="autonomy-project"
          />
        )}
      </Field>

      {base.isPending ? (
        <Loading label="Loading autonomy" />
      ) : base.isError ? (
        <ErrorNote error={base.error} />
      ) : overview ? (
        <>
          <div className="flex flex-col gap-1" data-testid="autonomy-state">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{project?.name}</span>
              {overview.enrollment ? (
                <Badge tone="success">Enrolled: {PROFILE_LABEL[overview.enrollment.profile]}</Badge>
              ) : (
                <Badge>Not enrolled</Badge>
              )}
            </div>
            {overview.enrollment ? null : (
              <p className="m-0 text-text-secondary">
                NEXUS asks before sensitive actions in this project, one approval at a time.
              </p>
            )}
            {overview.enrollment && isolation ? (
              <div className="flex flex-col gap-0.5" data-testid="autonomy-code-runs">
                <p className="m-0 font-medium">{projectCodeLine(isolation).label}</p>
                <p className="m-0 text-text-secondary">{projectCodeLine(isolation).consequence}</p>
                <div>
                  <Button
                    size="sm"
                    onClick={() => document.getElementById('isolation-panel')?.scrollIntoView({ block: 'start' })}
                    data-testid="autonomy-to-isolation"
                  >
                    Go to Execution isolation
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {overview.enrollment && overview.policyChanged ? (
            <Notice
              tone="warning"
              title="The capability table changed since you enrolled"
              data-testid="autonomy-policy-changed"
            >
              <p className="m-0">
                Review the lists below, then confirm again so this project follows the current
                table.
              </p>
              <Button
                size="sm"
                className="mt-2"
                busy={busy}
                loading={enroll.isPending}
                onClick={() => doEnroll(overview.enrollment!.profile)}
                data-testid="autonomy-reconfirm"
              >
                Review and confirm again
              </Button>
            </Notice>
          ) : null}

          {pendingLabel ? (
            <Notice tone="warning" title={pendingLabel} data-testid="autonomy-pending">
              <Button
                size="sm"
                onClick={() => setDrawer('boundary')}
                data-testid="autonomy-open-inbox"
              >
                Open the boundary inbox
              </Button>
            </Notice>
          ) : null}

          <ProfileChoice
            value={effective}
            current={enrolled}
            onChange={setChoice}
            disabled={busy}
          />

          {summary ? (
            <SummaryLists
              summary={summary}
              heading={
                considering
                  ? `If you choose ${PROFILE_LABEL[effective]}`
                  : `${PROFILE_LABEL[effective]}, as enrolled`
              }
            />
          ) : considering && preview.isPending ? (
            <Loading label="Loading the summary" />
          ) : null}

          {unattended ? <UnattendedLists policy={unattended} defaultOpen={overview.enrollment !== null} /> : null}

          <div className="flex flex-wrap items-center gap-2">
            {overview.enrollment ? (
              <>
                <Button
                  variant="primary"
                  busy={busy}
                  loading={enroll.isPending}
                  disabled={!considering}
                  onClick={() => doEnroll(effective)}
                  data-testid="autonomy-change"
                >
                  Change profile
                </Button>
                <Button
                  variant="danger"
                  busy={busy}
                  onClick={() => setConfirmStop(true)}
                  data-testid="autonomy-stop"
                >
                  Stop autonomous work
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                busy={busy}
                loading={enroll.isPending}
                onClick={() => doEnroll(effective)}
                data-testid="autonomy-enable"
              >
                Enable autonomous work…
              </Button>
            )}
          </div>
          <div
            role="status"
            data-testid="autonomy-action-error"
            className={cn('-mt-4 text-small', actionError ? 'text-danger' : 'sr-only')}
          >
            {actionError ? resolveErrorText(actionError) : ''}
          </div>

          <section className="flex flex-col gap-2" aria-labelledby="autonomy-grants-title">
            <h3 id="autonomy-grants-title" className="m-0 text-body font-semibold">
              Grants you gave in this project
            </h3>
            <GrantsTable
              grants={overview.grants}
              onRevoke={(g) => revoke.mutate({ grantId: g.id })}
              revoking={revoke.isPending}
              error={revoke.error}
            />
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="autonomy-denials-title">
            <h3 id="autonomy-denials-title" className="m-0 text-body font-semibold">
              What was blocked
            </h3>
            <Denials events={overview.recentDenials} />
          </section>

          <ConfirmDialog
            open={confirmStop}
            onClose={() => setConfirmStop(false)}
            onConfirm={() => {
              if (!selected) return
              unenroll.mutate(
                { projectId: selected },
                { onSuccess: () => setConfirmStop(false), onError: () => setConfirmStop(false) },
              )
            }}
            loading={unenroll.isPending}
            title={`Stop autonomous work in ${project?.name ?? 'this project'}?`}
            confirmLabel="Stop autonomous work"
            danger
          >
            The project leaves its profile. Sensitive actions ask for approval one at a time again.
            Grants you gave are kept but not used while the project is not enrolled; the ones for the
            whole project apply again if you enroll it again. Requests waiting in the boundary inbox
            stay there until you answer them or their mission ends.
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  )
}
