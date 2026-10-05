import { useEffect, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import type {
  ControlLimits,
  ControlPlaneOverview,
  GlobalWorkItem,
  Priority,
  Schedule,
} from '@shared/control-plane'
import { api } from '../../lib/bridge'
import { useRead, useWrite } from '../../lib/queries'
import { qkControl, qkRuntime, useControlOverview, useItemDecisions } from '../../lib/queries-v7'
import { RuntimeDiagnostics } from './RuntimeDiagnostics'
import { SecurityDecisions } from '../security/SecurityDecisions'
import { useNow } from '../../lib/useNow'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  ErrorNote,
  Field,
  Input,
  KeyValue,
  Notice,
  PageHeader,
  Select,
  StatusDot,
  TimeAgo,
  Toggle,
} from '../../components/ui'
import {
  actionLine,
  AUDIT_KIND_OPTIONS,
  cancelConfirmation,
  cancelLabel,
  capacityLine,
  COMPONENT_LABEL,
  EMPTY_SCHEDULE_FORM,
  HEALTH_LABEL,
  HOLD_LABEL,
  inspectorOf,
  itemActions,
  itemLine,
  itemPresentation,
  loadState,
  PRIORITY_OPTIONS,
  queueAnnouncement,
  RELEASE_LABEL,
  SCHEDULE_ACTION_OPTIONS,
  scheduleDeleteConfirmation,
  scheduleInput,
  scheduleLine,
  validateScheduleForm,
  type ControlItem,
  type Confirmation,
  type Emphasis,
  type ScheduleForm,
  AGING_HINT,
  AGING_OPTIONS,
  claudeLine,
  describeDecision,
  dispatchView,
  RUNTIME_LEVEL_LABEL,
  visibleRows,
  workersLine,
} from './controlModel'

const refresh = (qc: {
  invalidateQueries(options: { queryKey: readonly unknown[] }): unknown
}): void => void qc.invalidateQueries({ queryKey: qkControl.root() })
const HEALTH_TONE = {
  HEALTHY: 'success',
  RECOVERING: 'waiting',
  DEGRADED: 'warning',
  BLOCKED: 'danger',
} as const
const AGENT_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 16].map((n) => ({
  value: String(n),
  label: String(n),
}))
const ITEM_OPTIONS = [1, 2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: String(n) }))
const DAY_OPTIONS = (
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
).map((d) => ({ value: d, label: `${d[0]?.toUpperCase()}${d.slice(1)}` }))

/** Distinct treatment for work that needs a person: a bar, a tint and a label, never colour alone. */
const ROW_STYLE: Record<Emphasis, string> = {
  normal: 'border bg-surface',
  attention: 'border border-warning/40 border-l-4 border-l-warning bg-warning-subtle',
  failure: 'border border-danger/40 border-l-4 border-l-danger bg-danger-subtle',
}

function ConfirmBody({ confirmation, error }: { confirmation: Confirmation; error?: unknown }) {
  return (
    <div className="flex flex-col gap-3" data-testid="confirm-body">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {confirmation.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div>
        <p className="m-0 mb-1 text-small font-medium text-text-primary">What happens to the work</p>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5" data-testid="confirm-preserved">
          {confirmation.preserved.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      {error ? <ErrorNote error={error} /> : null}
    </div>
  )
}

function ItemRow({
  item,
  reason,
  first,
  last,
  now,
  onInspect,
}: {
  item: ControlItem
  reason?: string
  first?: boolean
  last?: boolean
  now: number
  onInspect: (id: string) => void
}) {
  const setPriority = useWrite('control.setPriority', refresh)
  const move = useWrite('control.move', refresh)
  const pause = useWrite('control.pause', refresh)
  const resume = useWrite('control.resume', refresh)
  const cancel = useWrite('control.cancel', refresh)
  const [confirming, setConfirming] = useState(false)
  const actions = itemActions(item)
  const shown: ControlItem = reason ? { ...item, reason } : item
  const view = itemPresentation(shown)
  const confirmation = cancelConfirmation(item)
  const busy = pause.isPending || resume.isPending || cancel.isPending
  const error = pause.error ?? resume.error ?? cancel.error ?? setPriority.error ?? move.error
  const runCancel = (): void =>
    cancel.mutate({ itemId: item.id }, { onSuccess: () => setConfirming(false) })
  return (
    <li
      className={`flex flex-col gap-1 rounded-md px-3 py-2 ${ROW_STYLE[view.emphasis]}`}
      data-testid={`work-item-${item.id}`}
      data-state={item.state}
      data-type={item.type}
      data-ref={item.refId ?? ''}
      data-emphasis={view.emphasis}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={view.tone} data-testid={`work-item-badge-${item.id}`}>
          {view.label}
        </Badge>
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded-sm bg-transparent p-0 text-left font-medium text-text-primary hover:underline"
          title={`${item.title} — open details`}
          aria-haspopup="dialog"
          onClick={() => onInspect(item.id)}
          data-testid={`work-item-open-${item.id}`}
        >
          {item.title}
        </button>
        <div className="w-36 shrink-0">
          <Select
            value={item.priority}
            options={PRIORITY_OPTIONS}
            disabled={!actions.cancel || setPriority.isPending}
            onChange={(priority: Priority) => setPriority.mutate({ itemId: item.id, priority })}
            aria-label={`Priority of ${item.title}`}
            data-testid={`work-item-priority-${item.id}`}
          />
        </div>
        {actions.reorder ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={first || move.isPending}
              onClick={() => move.mutate({ itemId: item.id, where: 'up' })}
              aria-label={`Move ${item.title} up`}
              data-testid={`work-item-up-${item.id}`}
            >
              Up
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={last || move.isPending}
              onClick={() => move.mutate({ itemId: item.id, where: 'down' })}
              aria-label={`Move ${item.title} down`}
              data-testid={`work-item-down-${item.id}`}
            >
              Down
            </Button>
          </>
        ) : null}
        {actions.pause ? (
          <Button
            size="sm"
            loading={pause.isPending}
            disabled={busy}
            onClick={() => pause.mutate({ itemId: item.id })}
            aria-label={`${HOLD_LABEL} ${item.title}`}
            data-testid={`work-item-pause-${item.id}`}
          >
            {HOLD_LABEL}
          </Button>
        ) : null}
        {actions.resume ? (
          <Button
            size="sm"
            variant="primary"
            loading={resume.isPending}
            disabled={busy}
            onClick={() => resume.mutate({ itemId: item.id })}
            aria-label={`${RELEASE_LABEL} ${item.title}`}
            data-testid={`work-item-resume-${item.id}`}
          >
            {RELEASE_LABEL}
          </Button>
        ) : null}
        {actions.cancel ? (
          <Button
            size="sm"
            variant="danger"
            loading={cancel.isPending && !confirming}
            disabled={busy}
            onClick={() => (confirmation ? (cancel.reset(), setConfirming(true)) : runCancel())}
            aria-label={`${cancelLabel(item)} ${item.title}`}
            data-testid={`work-item-cancel-${item.id}`}
          >
            {cancelLabel(item)}
          </Button>
        ) : null}
      </div>
      <p className="m-0 text-small text-text-secondary" data-testid={`work-item-line-${item.id}`}>
        {itemLine(item, now)}
        {view.reasonLabel ? '' : view.reasonText ? ` · ${view.reasonText}` : ''}
      </p>
      {view.reasonLabel ? (
        <p
          className="m-0 text-small text-text-primary"
          data-testid={`work-item-reason-${item.id}`}
        >
          <span className="font-semibold">{view.reasonLabel}:</span> {view.reasonText}
          {view.hint ? <span className="text-text-secondary"> {view.hint}</span> : null}
        </p>
      ) : null}
      {error && !confirming ? <ErrorNote error={error} /> : null}
      {confirmation ? (
        <ConfirmDialog
          open={confirming}
          onClose={() => {
            setConfirming(false)
            cancel.reset()
          }}
          onConfirm={runCancel}
          title={confirmation.title}
          confirmLabel={confirmation.confirmLabel}
          cancelLabel={confirmation.keepLabel}
          danger
          loading={cancel.isPending}
          testId={`cancel-dialog-${item.id}`}
        >
          <ConfirmBody confirmation={confirmation} error={cancel.error} />
        </ConfirmDialog>
      ) : null}
    </li>
  )
}

/** A finished item: a failed one is as visible as a blocked one and says why. */
function FinishedRow({ item, onInspect }: { item: GlobalWorkItem; onInspect: (id: string) => void }) {
  const view = itemPresentation(item)
  return (
    <li
      className={`flex flex-col gap-0.5 rounded-md px-2 py-1 text-small ${view.emphasis === 'failure' ? ROW_STYLE.failure : ''}`}
      data-testid={`finished-${item.id}`}
      data-state={item.state}
      data-emphasis={view.emphasis}
    >
      <div className="flex items-center gap-2">
        <Badge tone={view.tone}>{view.label}</Badge>
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded-sm bg-transparent p-0 text-left text-text-primary hover:underline"
          aria-haspopup="dialog"
          title={`${item.title} — open details`}
          onClick={() => onInspect(item.id)}
          data-testid={`finished-open-${item.id}`}
        >
          {item.title}
        </button>
        <span className="text-text-muted">
          <TimeAgo iso={item.finishedAt} />
        </span>
      </div>
      {view.reasonLabel ? (
        <p className="m-0 text-text-primary" data-testid={`finished-reason-${item.id}`}>
          <span className="font-semibold">{view.reasonLabel}:</span> {view.reasonText}
        </p>
      ) : null}
    </li>
  )
}

function Inspector({
  item,
  overview,
  onClose,
}: {
  item: ControlItem | null
  overview: ControlPlaneOverview
  onClose: () => void
}) {
  const info = item ? inspectorOf(item, overview) : null
  const decisions = useItemDecisions(item?.id ?? null)
  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      title={item ? item.title : 'Workload'}
      testId="work-item-inspector"
    >
      {item && info ? (
        <div className="flex flex-col gap-4 p-4" data-testid="inspector-body">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={info.presentation.tone} data-testid="inspector-state">
              {info.presentation.label}
            </Badge>
            <span className="text-small text-text-secondary">{info.type}</span>
          </div>
          {info.presentation.reasonLabel ? (
            <Notice
              tone={info.presentation.emphasis === 'failure' ? 'danger' : 'warning'}
              title={info.presentation.reasonLabel}
              data-testid="inspector-reason"
            >
              {info.presentation.reasonText} {info.presentation.hint}
            </Notice>
          ) : info.why ? (
            <div data-testid="inspector-why">
              <p className="m-0 text-small font-medium text-text-primary">Why is this waiting?</p>
              <p className="m-0 text-text-secondary">{info.why}</p>
            </div>
          ) : null}
          <KeyValue rows={info.facts} labelWidth="7rem" />
          <div data-testid="inspector-decisions">
            <h3 className="m-0 mb-1 text-heading font-semibold">Scheduler decisions</h3>
            {decisions.error ? <ErrorNote error={decisions.error} /> : null}
            {decisions.data && decisions.data.length === 0 ? (
              <p className="m-0 text-small text-text-muted">The scheduler has not decided anything about this item yet.</p>
            ) : null}
            {decisions.isPending && !decisions.error ? (
              <p className="m-0 text-small text-text-muted" role="status">Reading decisions…</p>
            ) : null}
            {decisions.data && decisions.data.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="inspector-decision-list">
                {decisions.data.slice(0, 25).map((d, i) => {
                  const line = describeDecision(d)
                  return (
                    <li key={`${d.at}-${i}`} className="text-small" data-testid="inspector-decision">
                      <span className="text-text-muted">
                        <TimeAgo iso={line.at} />
                      </span>{' '}
                      <span className="font-medium">{line.label}</span>: {line.reason}
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>
          <div>
            <h3 className="m-0 mb-1 text-heading font-semibold">Recent events</h3>
            {info.events.length === 0 ? (
              <p className="m-0 text-small text-text-muted" data-testid="inspector-no-events">
                No incident was recorded for this item.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="inspector-events">
                {info.events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="text-small">
                    <span className="text-text-muted">
                      <TimeAgo iso={e.at} />
                    </span>{' '}
                    {e.summary}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Drawer>
  )
}


function LimitsCard({ overview }: { overview: ControlPlaneOverview }) {
  const save = useWrite('control.setLimits', refresh)
  const limits = overview.limits
  const set = (patch: Partial<ControlLimits>): void =>
    save.mutate({ limits: { ...limits, ...patch } })
  return (
    <Card
      title="Capacity"
      description="One limit for everything that uses agents, however it was started. Running sessions are never stopped to enforce it."
      data-testid="control-capacity"
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 font-medium" data-testid="control-capacity-line">
          {capacityLine(overview)}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Agents at once" hint="Across every workload.">
            {(id) => (
              <Select
                id={id}
                value={String(limits.maxAgents)}
                options={
                  AGENT_OPTIONS.some((o) => o.value === String(limits.maxAgents))
                    ? AGENT_OPTIONS
                    : [
                        ...AGENT_OPTIONS,
                        { value: String(limits.maxAgents), label: String(limits.maxAgents) },
                      ]
                }
                disabled={save.isPending}
                onChange={(v) => set({ maxAgents: Number(v) })}
                data-testid="control-max-agents"
              />
            )}
          </Field>
          <Field label="Workloads at once" hint="The rest wait in the queue.">
            {(id) => (
              <Select
                id={id}
                value={String(limits.maxActiveItems)}
                options={
                  ITEM_OPTIONS.some((o) => o.value === String(limits.maxActiveItems))
                    ? ITEM_OPTIONS
                    : [
                        ...ITEM_OPTIONS,
                        {
                          value: String(limits.maxActiveItems),
                          label: String(limits.maxActiveItems),
                        },
                      ]
                }
                disabled={save.isPending}
                onChange={(v) => set({ maxActiveItems: Number(v) })}
                data-testid="control-max-items"
              />
            )}
          </Field>
          <Field label="Aging (minutes)" hint={AGING_HINT} className="sm:col-span-2">
            {(id) => (
              <Select
                id={id}
                value={String(limits.agingMinutes)}
                options={(AGING_OPTIONS.includes(limits.agingMinutes)
                  ? AGING_OPTIONS
                  : [...AGING_OPTIONS, limits.agingMinutes]
                ).map((n) => ({ value: String(n), label: n === 0 ? 'Off' : String(n) }))}
                disabled={save.isPending}
                onChange={(v) => set({ agingMinutes: Number(v) })}
                data-testid="control-aging"
              />
            )}
          </Field>
        </div>
        <Toggle
          checked={limits.resumeOnBoot === 'resume'}
          disabled={save.isPending}
          onChange={(on) => set({ resumeOnBoot: on ? 'resume' : 'hold' })}
          label="Resume missions after NEXUS restarts"
          description="Off: a mission that was running when NEXUS stopped stays paused until you resume it. Programs, workspace missions and Arena campaigns continue by their own recovery rules either way."
          data-testid="control-resume-on-boot"
        />
        {save.error ? <ErrorNote error={save.error} /> : null}
      </div>
    </Card>
  )
}

function QueueProgram() {
  const programs = useRead(['programs', 'control-options'], 'program.list', { limit: 100 })
  const enqueue = useWrite('control.enqueue', refresh)
  const [programId, setProgramId] = useState('')
  const [priority, setPriority] = useState<Priority>('P2')
  const options = (programs.data?.programs ?? [])
    .filter(
      (p) =>
        p.program.state === 'DRAFT' ||
        p.program.state === 'PAUSED' ||
        p.program.state === 'BLOCKED',
    )
    .map((p) => ({
      value: p.program.id,
      label: `${p.program.name} (${p.program.state.toLowerCase()})`,
    }))
  return (
    <div className="flex flex-col gap-2" data-testid="control-enqueue">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Put a program on the queue"
          hint={
            options.length === 0
              ? 'No draft, paused or blocked program exists. Create one on the Programs page.'
              : 'It starts when capacity allows, in priority order.'
          }
          className="min-w-64 flex-1"
        >
          {(id) => (
            <Select
              id={id}
              value={programId}
              options={[{ value: '', label: 'Choose a program' }, ...options]}
              onChange={setProgramId}
              data-testid="control-enqueue-program"
            />
          )}
        </Field>
        <div className="w-36 shrink-0">
          <Select
            value={priority}
            options={PRIORITY_OPTIONS}
            onChange={setPriority}
            aria-label="Priority"
            data-testid="control-enqueue-priority"
          />
        </div>
        <Button
          variant="primary"
          disabled={programId === ''}
          loading={enqueue.isPending}
          onClick={() =>
            enqueue.mutate(
              { item: { type: 'program', programId, priority } },
              { onSuccess: () => setProgramId('') },
            )
          }
          data-testid="control-enqueue-submit"
        >
          Add to queue
        </Button>
      </div>
      {enqueue.error ? <ErrorNote error={enqueue.error} /> : null}
    </div>
  )
}

type Option = { value: string; label: string }

/** What a schedule of the chosen kind can point at. Only the list for the chosen kind is read. */
function useScheduleTargets(actionType: ScheduleForm['actionType']): {
  options: Option[]
  nameOfProgram: (id: string) => string | null
} {
  const programs = useRead(['programs', 'control-options'], 'program.list', { limit: 100 })
  const campaigns = useRead(
    ['control', 'targets', 'arena'],
    'arena.campaigns',
    { limit: 100 },
    actionType === 'arena',
  )
  const projects = useRead(
    ['control', 'targets', 'projects'],
    'projects.list',
    {},
    actionType === 'scheduled_audit',
  )
  const workspaces = useRead(
    ['control', 'targets', 'workspaces'],
    'workspace.list',
    {},
    actionType === 'workspace_mission',
  )
  const details = useQueries({
    queries: (actionType === 'workspace_mission' ? (workspaces.data ?? []) : []).map((w) => ({
      queryKey: ['control', 'targets', 'workspace', w.workspace.id],
      queryFn: () => api.invoke('workspace.get', { workspaceId: w.workspace.id }),
    })),
  })
  const nameOfProgram = (id: string): string | null =>
    programs.data?.programs.find((p) => p.program.id === id)?.program.name ?? null
  let options: Option[]
  if (actionType === 'program')
    options = (programs.data?.programs ?? [])
      .filter((p) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(p.program.state))
      .map((p) => ({ value: p.program.id, label: p.program.name }))
  else if (actionType === 'arena')
    options = (campaigns.data?.campaigns ?? [])
      .filter((c) => !['completed', 'cancelled', 'failed'].includes(c.campaign.state))
      .map((c) => ({ value: c.campaign.id, label: c.campaign.name }))
  else if (actionType === 'scheduled_audit')
    options = (projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))
  else
    options = details.flatMap((d) =>
      (d.data?.missions ?? [])
        .filter((m) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(m.state))
        .map((m) => ({
          value: m.id,
          label: `${d.data?.workspace.name ?? 'Workspace'}: ${m.goal.replace(/\s+/g, ' ').slice(0, 60)}`,
        })),
    )
  return { options, nameOfProgram }
}

function SchedulesCard({ overview, now }: { overview: ControlPlaneOverview; now: number }) {
  const create = useWrite('control.createSchedule', refresh)
  const setEnabled = useWrite('control.setScheduleEnabled', refresh)
  const remove = useWrite('control.removeSchedule', refresh)
  const [form, setForm] = useState<ScheduleForm>(EMPTY_SCHEDULE_FORM)
  const [touched, setTouched] = useState(false)
  const [deleting, setDeleting] = useState<Schedule | null>(null)
  const check = validateScheduleForm(form)
  const { options, nameOfProgram } = useScheduleTargets(form.actionType)
  const targetLabel =
    SCHEDULE_ACTION_OPTIONS.find((o) => o.value === form.actionType)?.target ?? 'Target'
  const allItems: GlobalWorkItem[] = [
    ...overview.active,
    ...overview.waiting,
    ...overview.scheduled,
  ]
  const confirmation = deleting ? scheduleDeleteConfirmation(deleting, allItems) : null
  return (
    <Card
      title="Schedules"
      description="Stored on this computer. A schedule puts its work on the queue at its time; one that was missed while NEXUS was not running fires once when NEXUS is back."
      data-testid="control-schedules"
    >
      <div className="flex flex-col gap-3">
        {overview.schedules.length === 0 ? (
          <p className="m-0 text-small text-text-muted" data-testid="control-schedules-empty">
            No schedule yet.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {overview.schedules.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-surface px-3 py-2"
                data-testid={`schedule-${s.id}`}
                data-enabled={s.enabled}
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate font-medium">{s.name}</p>
                  <p className="m-0 text-small text-text-secondary">
                    {actionLine(s.action, {
                      program:
                        s.action.type === 'program' ? nameOfProgram(s.action.programId) : null,
                    })}{' '}
                    · {PRIORITY_OPTIONS.find((p) => p.value === s.priority)?.label ?? s.priority} ·{' '}
                    {scheduleLine(s, new Date(now))}
                  </p>
                  {s.lastResult ? (
                    <p className="m-0 text-small text-text-muted">Last time: {s.lastResult}</p>
                  ) : null}
                </div>
                <Toggle
                  checked={s.enabled}
                  disabled={setEnabled.isPending}
                  onChange={(enabled) => setEnabled.mutate({ scheduleId: s.id, enabled })}
                  aria-label={`Schedule ${s.name} enabled`}
                  data-testid={`schedule-enabled-${s.id}`}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => (remove.reset(), setDeleting(s))}
                  aria-label={`Delete schedule ${s.name}`}
                  data-testid={`schedule-remove-${s.id}`}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
        {setEnabled.error ? <ErrorNote error={setEnabled.error} /> : null}
        <form
          className="grid gap-3 border-t pt-3 sm:grid-cols-2 lg:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault()
            setTouched(true)
            if (!check.ok) return
            create.mutate(
              { schedule: scheduleInput(form) },
              { onSuccess: () => (setForm(EMPTY_SCHEDULE_FORM), setTouched(false)) },
            )
          }}
          data-testid="schedule-form"
        >
          <Field
            label="Name"
            error={touched ? check.errors.name : undefined}
            className="lg:col-span-2"
          >
            {(id) => (
              <Input
                id={id}
                value={form.name}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                data-testid="schedule-name"
              />
            )}
          </Field>
          <Field label="What it does" className="lg:col-span-2">
            {(id) => (
              <Select
                id={id}
                value={form.actionType}
                options={SCHEDULE_ACTION_OPTIONS}
                onChange={(actionType: ScheduleForm['actionType']) =>
                  setForm((f) => ({ ...f, actionType, targetId: '' }))
                }
                data-testid="schedule-action"
              />
            )}
          </Field>
          <Field
            label={targetLabel}
            error={touched ? check.errors.targetId : undefined}
            hint={options.length === 0 ? `No ${targetLabel.toLowerCase()} to choose from.` : undefined}
            className="lg:col-span-2"
          >
            {(id) => (
              <Select
                id={id}
                value={form.targetId}
                options={[{ value: '', label: `Choose ${targetLabel.toLowerCase()}` }, ...options]}
                onChange={(targetId) => setForm((f) => ({ ...f, targetId }))}
                data-testid="schedule-program"
              />
            )}
          </Field>
          {form.actionType === 'scheduled_audit' ? (
            <Field label="Analysis" className="lg:col-span-2">
              {(id) => (
                <Select
                  id={id}
                  value={form.auditKind}
                  options={AUDIT_KIND_OPTIONS}
                  onChange={(auditKind: ScheduleForm['auditKind']) =>
                    setForm((f) => ({ ...f, auditKind }))
                  }
                  data-testid="schedule-audit-kind"
                />
              )}
            </Field>
          ) : null}
          <Field label="Priority">
            {(id) => (
              <Select
                id={id}
                value={form.priority}
                options={PRIORITY_OPTIONS}
                onChange={(priority: Priority) => setForm((f) => ({ ...f, priority }))}
                data-testid="schedule-priority"
              />
            )}
          </Field>
          <Field label="Repeats">
            {(id) => (
              <Select
                id={id}
                value={form.kind}
                options={[
                  { value: 'daily', label: 'Every day' },
                  { value: 'weekly', label: 'Every week' },
                ]}
                onChange={(kind: ScheduleForm['kind']) => setForm((f) => ({ ...f, kind }))}
                data-testid="schedule-kind"
              />
            )}
          </Field>
          {form.kind === 'weekly' ? (
            <Field label="Day">
              {(id) => (
                <Select
                  id={id}
                  value={form.day}
                  options={DAY_OPTIONS}
                  onChange={(day: ScheduleForm['day']) => setForm((f) => ({ ...f, day }))}
                  data-testid="schedule-day"
                />
              )}
            </Field>
          ) : null}
          <Field
            label="Time"
            hint="Local time, HH:MM"
            error={touched ? check.errors.time : undefined}
          >
            {(id) => (
              <Input
                id={id}
                value={form.time}
                maxLength={5}
                onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                data-testid="schedule-time"
              />
            )}
          </Field>
          <div className="flex items-end">
            <Button
              type="submit"
              variant="primary"
              loading={create.isPending}
              data-testid="schedule-create"
            >
              Add schedule
            </Button>
          </div>
        </form>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </div>
      {confirmation && deleting ? (
        <ConfirmDialog
          open
          onClose={() => (setDeleting(null), remove.reset())}
          onConfirm={() =>
            remove.mutate({ scheduleId: deleting.id }, { onSuccess: () => setDeleting(null) })
          }
          title={confirmation.title}
          confirmLabel={confirmation.confirmLabel}
          cancelLabel={confirmation.keepLabel}
          danger
          loading={remove.isPending}
          testId="schedule-delete-dialog"
        >
          <ConfirmBody confirmation={confirmation} error={remove.error} />
        </ConfirmDialog>
      ) : null}
    </Card>
  )
}

/** The runtime at a glance, and the one control that stops new work from starting. */
function RuntimeStrip({ overview }: { overview: ControlPlaneOverview }) {
  const setPaused = useWrite('runtime.setDispatchPaused', (qc) => {
    void qc.invalidateQueries({ queryKey: qkControl.root() })
    void qc.invalidateQueries({ queryKey: qkRuntime.root() })
  })
  const dispatch = dispatchView(overview.dispatchPaused)
  const workers = workersLine(overview.workers)
  const level = overview.health.level
  const cell = (label: string, value: string, detail?: string, testId?: string) => (
    <div className="min-w-0" data-testid={testId}>
      <p className="m-0 text-caption text-text-muted">{label}</p>
      <p className="m-0 font-medium">{value}</p>
      {detail ? <p className="m-0 text-small text-text-muted">{detail}</p> : null}
    </div>
  )
  return (
    <div className="flex flex-col gap-3" data-testid="control-status">
      <div className="grid gap-x-6 gap-y-3 rounded-lg border bg-surface px-4 py-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
        <div className="min-w-0" data-testid="control-runtime">
          <p className="m-0 text-caption text-text-muted">Runtime</p>
          <p className="m-0 flex items-center gap-1.5 font-medium">
            <StatusDot tone={HEALTH_TONE[level]} />
            {RUNTIME_LEVEL_LABEL[level]}
          </p>
        </div>
        {cell('Workers', workers.value, workers.detail, 'control-workers')}
        {cell('Claude', claudeLine(overview.claudeAvailable), undefined, 'control-claude')}
        {cell('Dispatch', dispatch.state, undefined, 'control-dispatch')}
        <div className="flex items-center">
          <Button
            variant={overview.dispatchPaused ? 'primary' : 'default'}
            loading={setPaused.isPending}
            onClick={() => setPaused.mutate({ paused: dispatch.next })}
            data-testid="dispatch-toggle"
          >
            {dispatch.button}
          </Button>
        </div>
      </div>
      {setPaused.error ? <ErrorNote error={setPaused.error} /> : null}
      {dispatch.notice ? (
        <Notice tone="warning" title="Dispatch is paused" data-testid="control-dispatch-paused">
          {dispatch.notice}
        </Notice>
      ) : null}
    </div>
  )
}

/** Cuts a long list and says how many are hidden. */
function ShowMore({ hidden, onClick, testId }: { hidden: number; onClick: () => void; testId: string }) {
  if (hidden <= 0) return null
  return (
    <Button size="sm" onClick={onClick} data-testid={testId}>
      Show {hidden} more
    </Button>
  )
}

/** Control Center: runtime health, the global queue, capacity, schedules and recent incidents. */
export function ControlView() {
  const overview = useControlOverview()
  const now = useNow(true, 10_000)
  const o = overview.data ?? null
  const health = o ? HEALTH_LABEL[o.health.level] : null
  const state = loadState({
    hasData: o !== null,
    isError: overview.isError,
    error: overview.error,
  })
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const expand = (key: string) => () => setExpanded((e) => ({ ...e, [key]: true }))
  const seen = useRef<Map<string, GlobalWorkItem['state']> | null>(null)
  useEffect(() => {
    if (!o) return
    const items = [...o.active, ...o.waiting, ...o.scheduled, ...o.finished]
    setAnnouncement(queueAnnouncement(seen.current, items))
    seen.current = new Map(items.map((i) => [i.id, i.state]))
  }, [o])
  const all: ControlItem[] = o ? [...o.active, ...o.waiting, ...o.scheduled, ...o.finished] : []
  const inspected = inspectedId ? (all.find((i) => i.id === inspectedId) ?? null) : null
  const blocked = o?.waiting.filter((i) => i.state === 'BLOCKED') ?? []
  const waiting = o?.waiting.filter((i) => i.state !== 'BLOCKED') ?? []
  const activeRows = visibleRows(o?.active ?? [], expanded['active'] === true)
  const waitingRows = visibleRows(waiting, expanded['waiting'] === true)
  const blockedRows = visibleRows(blocked, expanded['blocked'] === true)
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="control-page">
      <PageHeader
        title="Control Center"
        context="System"
        actions={
          health ? (
            <Badge tone={health.tone} data-testid="control-health">
              {health.label}
            </Badge>
          ) : null
        }
      />
      <div className="sr-only" role="status" aria-live="polite" data-testid="control-announcer">
        {announcement}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-6 py-5">
          {state.kind === 'error' ? (
            <div
              className="flex flex-col items-start gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-4"
              role="alert"
              data-testid="control-load-error"
            >
              <div>
                <p className="m-0 font-semibold text-danger">The Control Center could not load.</p>
                <p className="m-0 text-text-primary" data-testid="control-load-error-text">
                  {state.message}
                </p>
              </div>
              <Button
                variant="primary"
                loading={overview.isFetching}
                onClick={() => void overview.refetch()}
                data-testid="control-retry"
              >
                Retry
              </Button>
            </div>
          ) : null}
          {state.kind === 'ready' && state.stale ? (
            <div
              className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2"
              role="alert"
              data-testid="control-stale"
            >
              <span className="min-w-0 flex-1 text-text-primary">
                The queue could not be refreshed, so this may be out of date: {state.stale}
              </span>
              <Button
                size="sm"
                loading={overview.isFetching}
                onClick={() => void overview.refetch()}
                data-testid="control-retry"
              >
                Retry
              </Button>
            </div>
          ) : null}
          {state.kind === 'loading' ? (
            <p className="m-0 text-text-muted" role="status" data-testid="control-loading">
              Loading the queue…
            </p>
          ) : null}
          {o ? (
            <>
              {!o.claudeAvailable ? (
                <Notice
                  tone="neutral"
                  title="Waiting for the Claude usage limit"
                  data-testid="control-quota-notice"
                >
                  Work that needs Claude is waiting and nothing new starts. It continues by itself
                  after the reset.
                </Notice>
              ) : null}
              <RuntimeStrip overview={o} />
              {blocked.length > 0 ? (
                <Card
                  title={`Needs attention (${blocked.length})`}
                  description="Blocked work does not start by itself. Each item says why."
                  data-testid="control-attention"
                >
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {blockedRows.rows.map((i) => (
                      <ItemRow
                        key={i.id}
                        item={i}
                        reason={i.reason}
                        now={now}
                        onInspect={setInspectedId}
                      />
                    ))}
                  </ul>
                  <ShowMore hidden={blockedRows.hidden} onClick={expand('blocked')} testId="blocked-show-more" />
                </Card>
              ) : null}
              <div className="grid gap-4 lg:grid-cols-2">
                <LimitsCard overview={o} />
                <Card
                  title="Runtime health"
                  description={`Started ${new Date(o.bootedAt).toLocaleString()}. The runtime is as healthy as its worst part.`}
                  data-testid="control-health-card"
                >
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {o.health.components.map((c) => (
                      <li
                        key={c.component}
                        className="flex items-start gap-2 text-small"
                        data-testid={`health-${c.component}`}
                        data-level={c.level}
                      >
                        <StatusDot tone={HEALTH_TONE[c.level]} className="mt-1.5" />
                        <span className="w-36 shrink-0 font-medium">
                          {COMPONENT_LABEL[c.component] ?? c.component}
                        </span>
                        <span className="min-w-0 flex-1 text-text-secondary">{c.detail}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
              <Card
                title="Active"
                description="Workloads that hold agent capacity now."
                data-testid="control-active"
              >
                {o.active.length === 0 ? (
                  <p className="m-0 text-small text-text-muted" data-testid="control-active-empty">
                    Nothing is running.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {activeRows.rows.map((i) => (
                        <ItemRow key={i.id} item={i} now={now} onInspect={setInspectedId} />
                      ))}
                    </ul>
                    <ShowMore hidden={activeRows.hidden} onClick={expand('active')} testId="active-show-more" />
                  </div>
                )}
              </Card>
              <Card
                title="Waiting"
                description="In the order they will start: priority first, then the order you set."
                data-testid="control-waiting"
              >
                <div className="flex flex-col gap-3">
                  {waiting.length === 0 ? (
                    <p
                      className="m-0 text-small text-text-muted"
                      data-testid="control-waiting-empty"
                    >
                      The queue is empty.
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {waitingRows.rows.map((i, index) => (
                        <ItemRow
                          key={i.id}
                          item={i}
                          reason={i.reason}
                          first={index === 0}
                          last={index === waiting.length - 1}
                          now={now}
                          onInspect={setInspectedId}
                        />
                      ))}
                    </ul>
                  )}
                  <ShowMore hidden={waitingRows.hidden} onClick={expand('waiting')} testId="waiting-show-more" />
                  {o.scheduled.length > 0 ? (
                    <div data-testid="control-scheduled">
                      <p className="m-0 mb-1 text-small font-medium text-text-primary">
                        Scheduled for later
                      </p>
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {o.scheduled.map((i) => (
                          <ItemRow key={i.id} item={i} now={now} onInspect={setInspectedId} />
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <QueueProgram />
                </div>
              </Card>
              <SchedulesCard overview={o} now={now} />
              <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Recently finished" data-testid="control-finished">
                  {o.finished.length === 0 ? (
                    <p className="m-0 text-small text-text-muted">Nothing has finished yet.</p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {o.finished.slice(0, 10).map((i) => (
                        <FinishedRow key={i.id} item={i} onInspect={setInspectedId} />
                      ))}
                    </ul>
                  )}
                </Card>
                <Card
                  title="Recent incidents"
                  description="Failures, blocks and restarts the control plane recorded."
                  data-testid="control-incidents"
                >
                  {o.incidents.length === 0 ? (
                    <p
                      className="m-0 text-small text-text-muted"
                      data-testid="control-incidents-empty"
                    >
                      None.
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {o.incidents.slice(0, 10).map((incident, index) => (
                        <li key={`${incident.at}-${index}`} className="text-small">
                          <span className="text-text-muted">
                            <TimeAgo iso={incident.at} />
                          </span>{' '}
                          {incident.summary}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
              {/* Why was this blocked? The decisions of the execution policy, newest first. */}
              <SecurityDecisions />
              <RuntimeDiagnostics />
              <Inspector item={inspected} overview={o} onClose={() => setInspectedId(null)} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
