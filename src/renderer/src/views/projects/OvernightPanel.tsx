import type { ReactNode } from 'react'
import { END_ACTIONS, OVERNIGHT_CONFIRMATION_TEXT, type EndAction } from '@shared/overnight'
import {
  Button,
  Dialog,
  Field,
  Notice,
  NumberField,
  Select,
  type SelectOption,
} from '../../components/ui'
import {
  CONDITION_KEYS,
  CONDITION_LABEL,
  CONDITION_TESTID,
  END_ACTION_LABEL,
  FAILSAFE_TIMER_NOTE,
  FORCED_SHUTDOWN_NOTE,
  NORMAL_SHUTDOWN_NOTE,
  TOOL_APPROVALS_NOTE,
  defaultFailsafeMinutes,
  effectiveFailsafeMinutes,
  joinMinutes,
  resolvePlanning,
  splitMinutes,
  type OvernightForm,
  type OvernightPlanning,
  type OvernightValidation,
} from './overnight'

const END_OPTIONS: SelectOption<EndAction>[] = END_ACTIONS.map((a) => ({
  value: a,
  label: END_ACTION_LABEL[a],
}))
const PLANNING_OPTIONS: SelectOption<OvernightPlanning>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'single', label: 'Single' },
  { value: 'consensus', label: 'Consensus' },
]
const QUOTA_OPTIONS: SelectOption<OvernightForm['quotaPolicy']>[] = [
  { value: 'WAIT_AND_RETRY', label: 'Wait and retry' },
  { value: 'END_RUN', label: 'End run' },
]

export function Check({
  checked,
  onChange,
  label,
  hint,
  disabled,
  testId,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
  testId?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        className="mt-1 size-3.5 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      <span className="min-w-0">
        <span className="leading-5">{label}</span>
        {hint ? <span className="block text-small text-text-muted">{hint}</span> : null}
      </span>
    </label>
  )
}

function Group({
  title,
  children,
  testId,
}: {
  title: string
  children: ReactNode
  testId?: string
}) {
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-3 rounded-lg border bg-surface p-3"
      data-testid={testId}
    >
      <legend className="px-1 text-small font-semibold text-text-secondary">{title}</legend>
      {children}
    </fieldset>
  )
}

type PolicyFieldsProps = {
  form: OvernightForm
  onChange: (patch: Partial<OvernightForm>) => void
  errors: OvernightValidation['errors']
}

/** Max duration as hours and minutes. Rendered inside a two-column grid by the caller. */
export function DurationFields({ form, onChange, errors }: PolicyFieldsProps) {
  const duration = splitMinutes(form.maxDurationMinutes)
  const setDuration = (hours: number, minutes: number) =>
    onChange({ maxDurationMinutes: joinMinutes(hours, minutes) })
  return (
    <>
      <Field label="Max duration (hours)" error={errors.duration}>
        {(id) => (
          <NumberField
            id={id}
            min={0}
            max={24}
            value={duration.hours}
            onChange={(h) => setDuration(h, duration.minutes)}
            data-testid="overnight-max-duration-hours"
          />
        )}
      </Field>
      <Field label="Max duration (minutes)">
        {(id) => (
          <NumberField
            id={id}
            min={0}
            max={59}
            value={duration.minutes}
            onChange={(m) => setDuration(duration.hours, m)}
            data-testid="overnight-max-duration-minutes"
          />
        )}
      </Field>
    </>
  )
}

/** The end action and the conditions it applies to. Shared by the mission and Arena overnight forms. */
export function EndOfRunGroup({ form, onChange }: PolicyFieldsProps) {
  return (
    <Group title="End of run">
      <Field label="End action">
        {(id) => (
          <Select
            id={id}
            value={form.endAction}
            onChange={(endAction) => onChange({ endAction })}
            options={END_OPTIONS}
            data-testid="overnight-end-action"
          />
        )}
      </Field>
      <div role="group" aria-label="Apply the end action when" className="flex flex-col gap-1">
        <span className="text-small font-medium text-text-secondary">Apply the end action on</span>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {CONDITION_KEYS.map((k) => (
            <Check
              key={k}
              checked={form.shutdownOn[k]}
              disabled={form.endAction === 'NONE'}
              onChange={(v) => onChange({ shutdownOn: { ...form.shutdownOn, [k]: v } })}
              label={CONDITION_LABEL[k]}
              testId={CONDITION_TESTID[k]}
            />
          ))}
        </div>
      </div>
    </Group>
  )
}

/** The Windows failsafe shutdown timer. */
export function FailsafeGroup({ form, onChange, errors }: PolicyFieldsProps) {
  const failsafe = effectiveFailsafeMinutes(form)
  return (
    <Group title="Failsafe">
      <Check
        checked={form.failsafeEnabled}
        onChange={(failsafeEnabled) => onChange({ failsafeEnabled })}
        label="Enabled"
        hint={
          form.endAction === 'NONE'
            ? 'Not armed while the end action is None: no power action of any kind is taken.'
            : 'A Windows shutdown timer armed at the start, so the PC still shuts down if NEXUS crashes.'
        }
        testId="overnight-failsafe-enabled"
      />
      <Field
        label="After (minutes)"
        hint={
          form.failsafeAfterMinutes === null
            ? `Follows the duration + ${failsafe - form.maxDurationMinutes} min`
            : 'Edited by hand'
        }
        error={form.failsafeEnabled ? errors.failsafe : undefined}
      >
        {(id) => (
          <div className="flex items-center gap-2">
            <NumberField
              id={id}
              min={2}
              max={2880}
              value={failsafe}
              disabled={!form.failsafeEnabled}
              onChange={(n) => onChange({ failsafeAfterMinutes: n })}
              data-testid="overnight-failsafe-minutes"
            />
            {form.failsafeAfterMinutes !== null ? (
              <Button
                size="sm"
                onClick={() => onChange({ failsafeAfterMinutes: null })}
                aria-label="Reset the failsafe to the duration plus 60 minutes"
              >
                Reset ({defaultFailsafeMinutes(form.maxDurationMinutes)})
              </Button>
            ) : null}
          </div>
        )}
      </Field>
    </Group>
  )
}

/** Final delay and force close. */
export function ShutdownGroup({ form, onChange, errors }: PolicyFieldsProps) {
  return (
    <Group title="Shutdown">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Delay (seconds)"
          hint="Time to cancel before the action runs"
          error={errors.finalDelay}
        >
          {(id) => (
            <NumberField
              id={id}
              min={10}
              max={3600}
              value={form.finalDelaySeconds}
              onChange={(n) => onChange({ finalDelaySeconds: n })}
              data-testid="overnight-final-delay"
            />
          )}
        </Field>
      </div>
      <Check
        checked={form.forceCloseApplications}
        onChange={(forceCloseApplications) => onChange({ forceCloseApplications })}
        label="Force close apps"
        hint={form.forceCloseApplications ? FORCED_SHUTDOWN_NOTE : NORMAL_SHUTDOWN_NOTE}
        testId="overnight-force-close"
      />
      <div className="text-small text-text-muted" data-testid="overnight-failsafe-note">
        {FAILSAFE_TIMER_NOTE}
      </div>
    </Group>
  )
}

export function QuotaPolicyField({ form, onChange }: Pick<PolicyFieldsProps, 'form' | 'onChange'>) {
  return (
    <Field
      label="When the Claude usage limit is reached"
      hint={
        form.quotaPolicy === 'WAIT_AND_RETRY'
          ? 'NEXUS waits for the reset and resumes the run automatically. No work is lost.'
          : 'The run ends at the limit and the report says what was left.'
      }
    >
      {(id) => (
        <Select
          id={id}
          value={form.quotaPolicy}
          onChange={(quotaPolicy) => onChange({ quotaPolicy })}
          options={QUOTA_OPTIONS}
          data-testid="overnight-quota-policy"
        />
      )}
    </Field>
  )
}

/** The explicit authorization sentence. The caller decides the test id. */
export function AuthorizeCheck({
  form,
  onChange,
  testId = 'overnight-authorize',
}: Pick<PolicyFieldsProps, 'form' | 'onChange'> & { testId?: string }) {
  return (
    <Check
      checked={form.authorized}
      onChange={(authorized) => onChange({ authorized })}
      label={OVERNIGHT_CONFIRMATION_TEXT}
      testId={testId}
    />
  )
}

export function OvernightPanel({
  form,
  onChange,
  validation,
  presetAgents,
  recommendation,
}: {
  form: OvernightForm
  onChange: (patch: Partial<OvernightForm>) => void
  validation: OvernightValidation
  presetAgents: number | null
  recommendation: 'single' | 'consensus' | null
}) {
  const { errors } = validation
  const planningHint =
    form.planning === 'auto'
      ? `Auto picks ${resolvePlanning({ planning: 'auto', recommendedPlanning: recommendation }).toUpperCase()}${recommendation ? ' from the mission text' : ' (no recommendation yet)'}.`
      : undefined

  return (
    <div className="flex flex-col gap-3" data-testid="overnight-panel">
      <Notice tone="warning" title="Overnight Mode">
        {TOOL_APPROVALS_NOTE} Nothing happens to Windows unless you tick the authorization below.
      </Notice>

      <Group title="Autonomy">
        <div className="grid grid-cols-2 gap-3">
          <DurationFields form={form} onChange={onChange} errors={errors} />
          <Field
            label="Max agents in parallel"
            hint={form.maxAgents === null ? 'From the preset' : 'Overridden'}
            error={errors.maxAgents}
          >
            {(id) => (
              <NumberField
                id={id}
                min={1}
                max={16}
                value={form.maxAgents ?? presetAgents ?? 1}
                onChange={(n) => onChange({ maxAgents: n })}
                data-testid="overnight-max-agents"
              />
            )}
          </Field>
          <Field label="Max repairs" hint="Bound on repair rounds" error={errors.maxRepairs}>
            {(id) => (
              <NumberField
                id={id}
                min={1}
                max={50}
                value={form.maxRepairs}
                onChange={(n) => onChange({ maxRepairs: n })}
                data-testid="overnight-max-repairs"
              />
            )}
          </Field>
          <Field label="Consensus" hint={planningHint}>
            {(id) => (
              <Select
                id={id}
                value={form.planning}
                onChange={(planning) => onChange({ planning })}
                options={PLANNING_OPTIONS}
                data-testid="overnight-planning"
              />
            )}
          </Field>
        </div>
        <Check
          checked={form.autoApprovePlanChanges}
          onChange={(autoApprovePlanChanges) => onChange({ autoApprovePlanChanges })}
          label="Approve planned risky tasks and graph changes automatically"
          hint={TOOL_APPROVALS_NOTE}
          testId="overnight-auto-approve"
        />
      </Group>

      <EndOfRunGroup form={form} onChange={onChange} errors={errors} />

      <FailsafeGroup form={form} onChange={onChange} errors={errors} />

      <ShutdownGroup form={form} onChange={onChange} errors={errors} />

      <Group title="Run policy">
        <QuotaPolicyField form={form} onChange={onChange} />
        <Check
          checked={form.saveFinalReport}
          onChange={(saveFinalReport) => onChange({ saveFinalReport })}
          label="Save final report into the project"
          testId="overnight-save-report"
        />
        <Check
          checked={form.commitCompletedWork}
          onChange={(commitCompletedWork) => onChange({ commitCompletedWork })}
          label="Commit unfinished work on task branches"
          testId="overnight-commit-work"
        />
      </Group>

      <AuthorizeCheck form={form} onChange={onChange} />
    </div>
  )
}

export function OvernightConfirmDialog({
  open,
  onClose,
  onConfirm,
  lines,
  loading,
  error,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  lines: readonly string[]
  loading: boolean
  error: string | null
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start overnight run?"
      width={560}
      testId="overnight-confirm-dialog"
      footer={
        <>
          <Button onClick={onClose} data-testid="overnight-confirm-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={loading}
            onClick={onConfirm}
            data-autofocus
            data-testid="overnight-confirm-start"
          >
            Confirm and start
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <ul
          className="m-0 flex list-disc flex-col gap-0.5 pl-5"
          data-testid="overnight-confirm-summary"
        >
          {lines.map((l, i) => (
            <li key={i} className={i === lines.length - 1 ? 'font-semibold' : undefined}>
              {l}
            </li>
          ))}
        </ul>
        {error ? (
          <Notice tone="danger" title="The run was not started" data-testid="overnight-error">
            {error}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  )
}
