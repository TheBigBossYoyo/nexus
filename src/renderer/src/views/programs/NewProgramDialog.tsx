import { useEffect, useState } from 'react'
import { PROGRAM_POLICY_PRESETS, PROGRAM_PRESETS, type ProgramPreset } from '@shared/program'
import { useProjects } from '../../lib/queries'
import { useCreateProgram, useProgramPresets } from '../../lib/queries-v4'
import { useCurrentProject } from '../../app/useCurrent'
import { Button, Dialog, Field, Input, Select, SegmentedControl, Textarea } from '../../components/ui'
import { Check } from '../projects/OvernightPanel'
import {
  buildCreateInput,
  defaultProgramForm,
  LIMITS,
  validateProgramForm,
  windowDescription,
  type FormField,
  type ProgramForm,
} from './programForm'
import { PRESET_LABEL, presetSummary, WEEKDAY_LABELS } from './programsModel'

const PRESET_HINT: Record<ProgramPreset, string> = {
  conservative: 'You stay in control',
  balanced: 'Sensible defaults',
  autonomous: 'Runs without asking',
}

export function NewProgramDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (programId: string) => void
}) {
  const projects = useProjects()
  const current = useCurrentProject()
  const presets = useProgramPresets()
  const create = useCreateProgram()
  const [form, setForm] = useState<ProgramForm>(() => defaultProgramForm(current?.id ?? null))
  const [touched, setTouched] = useState<ReadonlySet<FormField>>(new Set())

  // A project that becomes known (or changes) after the dialog was first rendered is the default.
  useEffect(() => {
    if (open) setForm((f) => (f.projectId ? f : { ...f, projectId: current?.id ?? null }))
  }, [open, current?.id])

  const patch = (p: Partial<ProgramForm>) => setForm((f) => ({ ...f, ...p }))
  const touch = (f: FormField) => setTouched((t) => new Set(t).add(f))
  const check = validateProgramForm(form)
  const err = (f: FormField) => (touched.has(f) ? check.errors[f] : undefined)
  const policy = (presets.data ?? PROGRAM_POLICY_PRESETS)[form.preset]
  const description = form.windowEnabled ? windowDescription(form.start, form.end) : null
  const projectList = projects.data ?? []

  const submit = (start: boolean) => {
    if (!check.ok) {
      setTouched(new Set<FormField>(['project', 'name', 'goal', 'successCriteria', 'constraints', 'days', 'start', 'end']))
      return
    }
    create.mutate(buildCreateInput(form, start), {
      onSuccess: (p) => {
        setForm(defaultProgramForm(form.projectId))
        setTouched(new Set())
        onClose()
        onCreated(p.id)
      },
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New program"
      width={680}
      testId="program-dialog"
      footer={
        <>
          <div className="mr-auto flex min-w-0 items-center" role="status" data-testid="program-validation-hint">
            {check.reason ? <span className="text-small text-warning">{check.reason}</span> : null}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={!check.ok} loading={create.isPending} onClick={() => submit(false)} data-testid="program-create">
            Create
          </Button>
          <Button variant="primary" disabled={!check.ok} loading={create.isPending} onClick={() => submit(true)} data-testid="program-create-start">
            Create and start
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-text-secondary">
          A program pursues one engineering goal across several milestones. NEXUS plans the milestones, runs a mission for each, verifies the result and
          reassesses the plan as it goes. The work accumulates on a program branch; your working tree is never touched.
        </p>

        <Field label="Project" error={err('project')}>
          {(id) => (
            <Select
              id={id}
              value={form.projectId ?? ''}
              onChange={(projectId) => patch({ projectId: projectId || null })}
              options={[
                ...(form.projectId ? [] : [{ value: '', label: 'Choose a project' }]),
                ...projectList.map((p) => ({ value: p.id, label: p.name })),
              ]}
              data-testid="program-project"
            />
          )}
        </Field>

        <Field label="Name" error={err('name')}>
          {(id) => (
            <Input
              id={id}
              value={form.name}
              maxLength={LIMITS.name + 20}
              onChange={(e) => patch({ name: e.target.value })}
              onBlur={() => touch('name')}
              placeholder="Migrate the API to the new auth model"
              data-testid="program-name"
              aria-invalid={!!err('name')}
            />
          )}
        </Field>

        <Field label="Goal" hint="What should be true when the program is done. A few sentences." error={err('goal')}>
          {(id) => (
            <Textarea
              id={id}
              rows={4}
              value={form.goal}
              onChange={(e) => patch({ goal: e.target.value })}
              onBlur={() => touch('goal')}
              data-testid="program-goal"
              aria-invalid={!!err('goal')}
            />
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Success criteria (optional)" hint="One per line." error={err('successCriteria')}>
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={form.successCriteria}
                onChange={(e) => patch({ successCriteria: e.target.value })}
                onBlur={() => touch('successCriteria')}
                data-testid="program-criteria"
              />
            )}
          </Field>
          <Field label="Constraints (optional)" hint="One per line. For example: no new dependencies." error={err('constraints')}>
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={form.constraints}
                onChange={(e) => patch({ constraints: e.target.value })}
                onBlur={() => touch('constraints')}
                data-testid="program-constraints"
              />
            )}
          </Field>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-text-secondary">Policy</span>
          <SegmentedControl
            label="Policy preset"
            value={form.preset}
            onChange={(preset) => patch({ preset })}
            className="self-start"
            options={PROGRAM_PRESETS.map((p) => ({ value: p, label: PRESET_LABEL[p], testId: `program-preset-${p}` }))}
          />
          <p className="m-0 text-small text-text-muted">{PRESET_HINT[form.preset]}</p>
          <dl
            className="m-0 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border bg-surface-muted px-3 py-2 text-small"
            aria-label={`What the ${PRESET_LABEL[form.preset]} preset means`}
            data-testid="program-preset-summary"
          >
            {presetSummary(policy).map((l) => (
              <div key={l.label} className="contents">
                <dt className="text-text-muted">{l.label}</dt>
                <dd className="m-0 text-text-secondary">{l.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <section className="flex flex-col gap-3 rounded-lg border bg-surface-muted p-3" aria-label="Work window">
          <Check
            checked={form.windowEnabled}
            onChange={(windowEnabled) => patch({ windowEnabled })}
            label={<span className="font-medium">Only work inside a time window</span>}
            hint="Outside the window the program pauses by itself and continues when the window opens. Without a window it works whenever it can."
            testId="program-window-enabled"
          />
          {form.windowEnabled ? (
            <div className="flex flex-col gap-3" data-testid="program-window-form">
              <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
                <legend className="mb-1 p-0 text-small font-medium text-text-secondary">Days the window starts on</legend>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {WEEKDAY_LABELS.map((label, day) => (
                    <label key={label} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--color-accent)]"
                        checked={form.days.includes(day)}
                        onChange={(e) => patch({ days: e.target.checked ? [...form.days, day] : form.days.filter((d) => d !== day) })}
                        data-testid={`program-window-day-${day}`}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {check.errors.days ? (
                  <div role="alert" className="text-small text-danger">
                    {check.errors.days}
                  </div>
                ) : null}
              </fieldset>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start (24 h)" error={check.errors.start}>
                  {(id) => (
                    <Input
                      id={id}
                      value={form.start}
                      onChange={(e) => patch({ start: e.target.value.trim() })}
                      placeholder="22:00"
                      inputMode="numeric"
                      maxLength={5}
                      className="font-mono tnum"
                      data-testid="program-window-start"
                      aria-invalid={!!check.errors.start}
                    />
                  )}
                </Field>
                <Field label="End (24 h)" error={check.errors.end}>
                  {(id) => (
                    <Input
                      id={id}
                      value={form.end}
                      onChange={(e) => patch({ end: e.target.value.trim() })}
                      placeholder="07:00"
                      inputMode="numeric"
                      maxLength={5}
                      className="font-mono tnum"
                      data-testid="program-window-end"
                      aria-invalid={!!check.errors.end}
                    />
                  )}
                </Field>
              </div>
              {description ? (
                <p className="m-0 text-small text-text-secondary" role="status" data-testid="program-window-description">
                  {description} Times are in this computer&apos;s time zone.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </Dialog>
  )
}
