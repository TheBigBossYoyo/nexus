import { useState } from 'react'
import { REPOSITORY_ROLES, type RepositoryRole, type WorkspaceDetail, type WorkspaceRepository, type RepositoryHealth, type Service } from '@shared/workspace'
import {
  useAddService,
  useEnrollRepository,
  useRefreshRepository,
  useSetRepositoryRole,
  useSetWorkspacePolicy,
  useUnenrollRepository,
} from '../../lib/queries-v5'
import { Badge, BranchIcon, Button, ConfirmDialog, ErrorNote, Field, Input, PlusIcon, RefreshIcon, Select, TimeAgo } from '../../components/ui'
import { Check } from '../projects/OvernightPanel'
import { Empty } from '../programs/programsUi'
import { buildServiceInput, validateServiceForm, type ServiceForm } from './workspaceForm'
import { commandRows, healthInfo, ROLE_LABEL, toggleAllowed, workspaceHealth } from './workspacesModel'
import { Mono } from './workspacesUi'

const ROLE_OPTIONS = REPOSITORY_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))

function ServiceAdd({ repo }: { repo: WorkspaceRepository }) {
  const add = useAddService()
  const [form, setForm] = useState<ServiceForm>({ name: '', description: '' })
  const [touched, setTouched] = useState(false)
  const check = validateServiceForm(form)
  const submit = () => {
    if (!check.ok) {
      setTouched(true)
      return
    }
    add.mutate(buildServiceInput(repo.id, form), {
      onSuccess: () => {
        setForm({ name: '', description: '' })
        setTouched(false)
      },
    })
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label={`Add a service to ${repo.key}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Field label="Service name" error={touched ? check.errors.name : undefined} className="min-w-36 flex-1">
        {(id) => <Input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-testid={`service-name-${repo.key}`} aria-invalid={touched && !!check.errors.name} />}
      </Field>
      <Field label="What it is" error={touched ? check.errors.description : undefined} className="min-w-44 flex-[2]">
        {(id) => <Input id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} data-testid={`service-description-${repo.key}`} />}
      </Field>
      <Button size="sm" type="submit" icon={<PlusIcon size={12} />} loading={add.isPending} data-testid={`service-add-${repo.key}`}>
        Add service
      </Button>
      {add.isError ? <ErrorNote error={add.error} className="w-full" /> : null}
    </form>
  )
}

function ServiceList({ repo, services }: { repo: WorkspaceRepository; services: readonly Service[] }) {
  return (
    <div className="flex flex-col gap-2" data-testid={`repo-services-${repo.key}`}>
      <h4 className="m-0 text-caption font-medium text-text-muted">Services</h4>
      {services.length === 0 ? (
        <p className="m-0 text-small text-text-muted">No services recorded for this repository.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {services.map((s) => (
            <li key={s.id} className="text-small">
              <span className="font-medium">{s.name}</span>
              {s.description ? <span className="text-text-secondary"> — {s.description}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <ServiceAdd repo={repo} />
    </div>
  )
}

function RepositoryCard({ detail, repo, health, onRemove }: { detail: WorkspaceDetail; repo: WorkspaceRepository; health: RepositoryHealth; onRemove: (r: WorkspaceRepository) => void }) {
  const setRole = useSetRepositoryRole()
  const refresh = useRefreshRepository()
  const setPolicy = useSetWorkspacePolicy()
  const policy = detail.workspace.policy
  const allowed = policy.allowedRepositories.includes(repo.key)
  const info = healthInfo(health)
  const stack = [...repo.languages, ...repo.frameworks]
  const commands = commandRows(repo.commands)
  const services = detail.services.filter((s) => s.repositoryId === repo.id)
  const err = setRole.error ?? refresh.error ?? setPolicy.error
  return (
    <li className="list-none">
      <article className="flex flex-col gap-3 rounded-lg border bg-surface p-4" data-testid={`repo-${repo.key}`} data-health={health.level} data-allowed={allowed}>
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="m-0 flex flex-wrap items-center gap-2 text-heading font-semibold">
              <span className="font-mono">{repo.key}</span>
              <Badge tone={info.tone} data-testid={`repo-health-${repo.key}`}>
                {info.label}
              </Badge>
            </h3>
            <p className="m-0 mt-0.5 text-small text-text-secondary" data-testid={`repo-health-reason-${repo.key}`}>
              {health.reason}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" icon={<RefreshIcon size={12} />} loading={refresh.isPending} onClick={() => refresh.mutate({ repositoryId: repo.id })} aria-label={`Refresh ${repo.key}`} data-testid={`repo-refresh-${repo.key}`}>
              Refresh
            </Button>
            <Button size="sm" variant="danger" onClick={() => onRemove(repo)} aria-label={`Remove ${repo.key} from the workspace`} data-testid={`repo-remove-${repo.key}`}>
              Remove
            </Button>
          </div>
        </header>

        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 text-small sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-text-muted">
              <label htmlFor={`repo-role-${repo.key}`}>Role</label>
            </dt>
            <dd className="m-0">
              <Select
                id={`repo-role-${repo.key}`}
                value={repo.role}
                options={ROLE_OPTIONS}
                disabled={setRole.isPending}
                onChange={(role: RepositoryRole) => setRole.mutate({ repositoryId: repo.id, role })}
                data-testid={`repo-role-${repo.key}`}
                className="max-w-52"
              />
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-text-muted">Branch</dt>
            <dd className="m-0 flex items-center gap-1.5" data-testid={`repo-branch-${repo.key}`}>
              <BranchIcon size={12} className="text-text-muted" />
              {repo.branch ? <Mono>{repo.branch}</Mono> : <span className="text-text-muted">Unknown</span>}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
            <dt className="text-text-muted">Path</dt>
            <dd className="m-0 break-all font-mono text-code" data-testid={`repo-path-${repo.key}`}>
              {repo.rootPath}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
            <dt className="text-text-muted">Remote</dt>
            <dd className="m-0 break-all font-mono text-code" data-testid={`repo-remote-${repo.key}`}>
              {repo.remote ?? <span className="font-sans text-text-muted">No remote</span>}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-text-muted">Languages and frameworks</dt>
            <dd className="m-0" data-testid={`repo-stack-${repo.key}`}>
              {stack.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {stack.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </span>
              ) : (
                <span className="text-text-muted">None detected</span>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-text-muted">Package</dt>
            <dd className="m-0" data-testid={`repo-package-${repo.key}`}>
              {repo.packageName ? (
                <span>
                  <Mono>{repo.packageName}</Mono> <span className="tnum text-text-secondary">{repo.packageVersion ?? 'no version'}</span>
                </span>
              ) : (
                <span className="text-text-muted">No package manifest</span>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-text-muted">Check commands</dt>
            <dd className="m-0 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5" data-testid={`repo-commands-${repo.key}`}>
              {commands.map((c) => (
                <div key={c.label} className="contents">
                  <span className="text-text-secondary">{c.label}</span>
                  {c.value ? <Mono className="break-all">{c.value}</Mono> : <span className="text-text-muted">Not set</span>}
                </div>
              ))}
            </dd>
          </div>
        </dl>

        <div className="rounded-md border bg-surface-muted px-3 py-2">
          <Check
            checked={allowed}
            disabled={setPolicy.isPending}
            onChange={(on) => setPolicy.mutate({ workspaceId: detail.workspace.id, policy: { ...policy, allowedRepositories: toggleAllowed(policy.allowedRepositories, repo.key, on) } })}
            label={<span data-testid={`repo-allowed-label-${repo.key}`}>Missions may change {repo.key}</span>}
            hint="A mission may only change repositories allowed here."
            testId={`repo-allowed-${repo.key}`}
          />
        </div>

        <ServiceList repo={repo} services={services} />
        <p className="m-0 text-caption text-text-muted">
          Enrolled <TimeAgo iso={repo.enrolledAt} /> · refreshed <TimeAgo iso={repo.refreshedAt} />
        </p>
        {err ? <ErrorNote error={err} /> : null}
      </article>
    </li>
  )
}

export function OverviewTab({ detail }: { detail: WorkspaceDetail }) {
  const enroll = useEnrollRepository()
  const unenroll = useUnenrollRepository()
  const [removing, setRemoving] = useState<WorkspaceRepository | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const health = workspaceHealth(detail)
  const healthTone = health.level === 'ok' ? 'success' : health.level === 'attention' ? 'warning' : 'neutral'
  const healthLabel = health.level === 'ok' ? 'Healthy' : health.level === 'attention' ? 'Needs attention' : 'Unknown'
  return (
    <div className="flex flex-col gap-4" data-testid="workspace-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-text-secondary" data-testid="workspace-health" data-level={health.level} role="status">
          <Badge tone={healthTone}>{healthLabel}</Badge>
          <span>{health.text}</span>
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<PlusIcon size={12} />}
            loading={enroll.isPending}
            onClick={() => {
              setCancelled(false)
              enroll.mutate({ workspaceId: detail.workspace.id }, { onSuccess: (r) => setCancelled(r === null) })
            }}
            data-testid="workspace-enroll"
          >
            Enroll repository
          </Button>
        </div>
      </div>
      <p className="m-0 text-small text-text-secondary" data-testid="workspace-allowed-note">
        A mission may only change allowed repositories. Tick Missions may change on a repository to allow it; nothing runs in a repository that is not allowed.
      </p>
      {enroll.isError ? <ErrorNote error={enroll.error} /> : null}
      {cancelled ? (
        <p className="m-0 text-small text-text-muted" role="status" data-testid="workspace-enroll-cancelled">
          No folder was chosen, so nothing was enrolled.
        </p>
      ) : null}
      {unenroll.isError ? <ErrorNote error={unenroll.error} /> : null}

      {detail.repositories.length === 0 ? (
        <Empty testId="workspace-repos-empty">No repositories yet. Enroll the first one: you pick a Git repository folder and NEXUS reads its manifest, branch, remote and check commands.</Empty>
      ) : (
        <ul className="m-0 grid grid-cols-1 gap-3 p-0 xl:grid-cols-2" aria-label="Repositories" data-testid="workspace-repos">
          {detail.repositories.map((r) => (
            <RepositoryCard key={r.id} detail={detail} repo={r} health={r.health} onRemove={setRemoving} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.key ?? 'repository'} from the workspace?`}
        confirmLabel="Remove repository"
        danger
        loading={unenroll.isPending}
        testId="repo-remove-dialog"
        onConfirm={() => {
          if (removing) unenroll.mutate({ repositoryId: removing.id }, { onSuccess: () => setRemoving(null) })
        }}
      >
        Its dependency edges, services and contract roles in this workspace are forgotten. The repository folder is not touched.
      </ConfirmDialog>
    </div>
  )
}
