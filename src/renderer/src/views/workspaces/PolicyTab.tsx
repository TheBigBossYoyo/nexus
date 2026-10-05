import { useEffect, useState } from 'react'
import type { WorkspaceDetail, WorkspacePolicy } from '@shared/workspace'
import { useSetWorkspacePolicy } from '../../lib/queries-v5'
import { Button, ErrorNote, Field, Input, Select, Toggle } from '../../components/ui'
import { Check } from '../projects/OvernightPanel'
import {
  buildPolicy,
  policyEquals,
  policyToForm,
  validatePolicyForm,
  type PolicyField,
  type PolicyForm,
} from './workspaceForm'
import { PRESET_LABEL, REVIEW_MODE_LABEL, toggleAllowed } from './workspacesModel'

const REVIEW_OPTIONS = (Object.keys(REVIEW_MODE_LABEL) as WorkspacePolicy['reviewMode'][]).map(
  (v) => ({ value: v, label: REVIEW_MODE_LABEL[v] }),
)
const PRESET_OPTIONS = (Object.keys(PRESET_LABEL) as WorkspacePolicy['missionPreset'][]).map(
  (v) => ({ value: v, label: PRESET_LABEL[v] }),
)
const STRATEGY_OPTIONS: { value: WorkspacePolicy['missionStrategy']; label: string }[] = [
  { value: 'SINGLE', label: 'Single' },
  { value: 'BUILD', label: 'Build' },
  { value: 'SWARM', label: 'Swarm' },
  { value: 'CONSENSUS', label: 'Consensus' },
  { value: 'SPECULATIVE', label: 'Speculative' },
  { value: 'ADAPTIVE', label: 'Adaptive' },
]

export function PolicyTab({ detail }: { detail: WorkspaceDetail }) {
  const save = useSetWorkspacePolicy()
  const policy = detail.workspace.policy
  const [form, setForm] = useState<PolicyForm>(() => policyToForm(policy))
  const [saved, setSaved] = useState(false)
  // A policy changed elsewhere (the Overview checkboxes, another window) replaces the form only while it is untouched.
  const [baseline, setBaseline] = useState(policy)
  useEffect(() => {
    if (policyEquals(baseline, policy)) return
    setForm((f) => {
      const built = buildPolicy(f)
      return built && policyEquals(built, baseline) ? policyToForm(policy) : f
    })
    setBaseline(policy)
  }, [policy, baseline])

  const check = validatePolicyForm(form)
  const next = buildPolicy(form)
  const dirty = next ? !policyEquals(next, policy) : true
  const patch = (p: Partial<PolicyForm>) => {
    setSaved(false)
    setForm((f) => ({ ...f, ...p }))
  }
  const numberField = (
    field: PolicyField & keyof PolicyForm,
    label: string,
    hint: string,
    testId: string,
  ) => (
    <Field label={label} hint={hint} error={check.errors[field]}>
      {(id) => (
        <Input
          id={id}
          inputMode="numeric"
          value={String(form[field])}
          onChange={(e) => patch({ [field]: e.target.value } as Partial<PolicyForm>)}
          aria-invalid={!!check.errors[field]}
          className="max-w-32 font-mono tnum"
          data-testid={testId}
        />
      )}
    </Field>
  )
  return (
    <form
      className="flex max-w-3xl flex-col gap-5"
      data-testid="workspace-policy"
      onSubmit={(e) => {
        e.preventDefault()
        if (!next) return
        save.mutate(
          { workspaceId: detail.workspace.id, policy: next },
          { onSuccess: () => setSaved(true) },
        )
      }}
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-heading font-semibold">Allowed repositories</legend>
        <p className="m-0 text-small text-text-secondary">
          A mission may only change allowed repositories. With none allowed, no mission can run.
        </p>
        {detail.repositories.length === 0 ? (
          <p className="m-0 text-small text-text-muted">No repositories enrolled.</p>
        ) : (
          <div className="flex flex-wrap gap-x-6 gap-y-1.5">
            {detail.repositories.map((r) => (
              <Check
                key={r.id}
                checked={form.allowedRepositories.includes(r.key)}
                onChange={(on) =>
                  patch({ allowedRepositories: toggleAllowed(form.allowedRepositories, r.key, on) })
                }
                label={<span className="font-mono">{r.key}</span>}
                testId={`policy-allowed-${r.key}`}
              />
            ))}
          </div>
        )}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Protected branches"
          hint="Comma-separated. Recorded with the workspace for your release process. NEXUS writes only to its own nexus/ branches in any case."
          error={check.errors.protectedBranches}
          className="md:col-span-2"
        >
          {(id) => (
            <Input
              id={id}
              value={form.protectedBranches}
              onChange={(e) => patch({ protectedBranches: e.target.value })}
              aria-invalid={!!check.errors.protectedBranches}
              className="font-mono"
              data-testid="policy-protected"
            />
          )}
        </Field>
        {numberField(
          'maxRepositoriesPerMission',
          'Max repositories per mission',
          '1 to 20',
          'policy-max-repos',
        )}
        {numberField('maxTasksPerMission', 'Max tasks per mission', '1 to 40', 'policy-max-tasks')}
        {numberField(
          'maxParallelRepositories',
          'Max parallel repositories',
          '1 to 4. Repositories with no dependency between them may run at the same time.',
          'policy-max-parallel',
        )}
        <Field label="Review mode">
          {(id) => (
            <Select
              id={id}
              value={form.reviewMode}
              options={REVIEW_OPTIONS}
              onChange={(reviewMode) => patch({ reviewMode })}
              data-testid="policy-review"
            />
          )}
        </Field>
        <Field label="Mission strategy">
          {(id) => (
            <Select
              id={id}
              value={form.missionStrategy}
              options={STRATEGY_OPTIONS}
              onChange={(missionStrategy) => patch({ missionStrategy })}
              data-testid="policy-strategy"
            />
          )}
        </Field>
        <Field label="Preset">
          {(id) => (
            <Select
              id={id}
              value={form.missionPreset}
              options={PRESET_OPTIONS}
              onChange={(missionPreset) => patch({ missionPreset })}
              data-testid="policy-preset"
            />
          )}
        </Field>
      </div>

      <Toggle
        checked={form.requireConsumerUpdateOnBreakingChange}
        onChange={(v) => patch({ requireConsumerUpdateOnBreakingChange: v })}
        label="Require consumer update on breaking change"
        description="A breaking contract change needs every consumer to be updated in the same mission."
        data-testid="policy-consumer-update"
      />

      <p
        className="m-0 rounded-md border bg-surface-muted px-3 py-2 text-small"
        data-testid="policy-publishing"
      >
        <span className="text-text-muted">Publishing: </span>
        <span className="font-medium">never</span> (NEXUS prepares releases and does not publish
        them)
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          disabled={!check.ok || !dirty}
          loading={save.isPending}
          data-testid="workspace-policy-save"
        >
          Save policy
        </Button>
        {saved && !dirty ? (
          <span
            className="text-small text-success"
            role="status"
            data-testid="workspace-policy-saved"
          >
            Saved.
          </span>
        ) : !check.ok ? (
          <span className="text-small text-warning" role="status">
            {check.reason}
          </span>
        ) : null}
      </div>
      {save.isError ? <ErrorNote error={save.error} /> : null}
    </form>
  )
}
