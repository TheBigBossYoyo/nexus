import { useState } from 'react'
import type {
  ControlLimits,
  ControlPlaneOverview,
  GlobalWorkItem,
  Priority,
} from '@shared/control-plane'
import { useRead, useWrite } from '../../lib/queries'
import { qkControl, useControlOverview } from '../../lib/queries-v7'
import { useNow } from '../../lib/useNow'
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  StatusDot,
  TimeAgo,
  Toggle,
} from '../../components/ui'
import {
  actionLine,
  capacityLine,
  COMPONENT_LABEL,
  EMPTY_SCHEDULE_FORM,
  HEALTH_LABEL,
  itemActions,
  itemLine,
  PRIORITY_OPTIONS,
  scheduleInput,
  scheduleLine,
  STATE_LABEL,
  validateScheduleForm,
  type ScheduleForm,
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

function ItemRow({
  item,
  reason,
  first,
  last,
}: {
  item: GlobalWorkItem & { activeAgents?: number; allowance?: number }
  reason?: string
  first?: boolean
  last?: boolean
}) {
  const setPriority = useWrite('control.setPriority', refresh)
  const move = useWrite('control.move', refresh)
  const pause = useWrite('control.pause', refresh)
  const resume = useWrite('control.resume', refresh)
  const cancel = useWrite('control.cancel', refresh)
  const actions = itemActions(item)
  const state = STATE_LABEL[item.state]
  const busy = pause.isPending || resume.isPending || cancel.isPending
  const error = pause.error ?? resume.error ?? cancel.error ?? setPriority.error ?? move.error
  return (
    <li
      className="flex flex-col gap-1 rounded-md border bg-surface px-3 py-2"
      data-testid={`work-item-${item.id}`}
      data-state={item.state}
      data-type={item.type}
      data-ref={item.refId ?? ''}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={state.tone}>
          {item.heldByUser && item.state !== 'RUNNING' ? 'Held' : state.label}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-medium" title={item.title}>
          {item.title}
        </span>
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
            data-testid={`work-item-pause-${item.id}`}
          >
            {item.state === 'RUNNING' || item.state === 'QUOTA_WAIT' ? 'Pause' : 'Hold'}
          </Button>
        ) : null}
        {actions.resume ? (
          <Button
            size="sm"
            variant="primary"
            loading={resume.isPending}
            disabled={busy}
            onClick={() => resume.mutate({ itemId: item.id })}
            data-testid={`work-item-resume-${item.id}`}
          >
            {item.state === 'PAUSED' && !item.heldByUser ? 'Resume' : 'Release'}
          </Button>
        ) : null}
        {actions.cancel ? (
          <Button
            size="sm"
            variant="danger"
            loading={cancel.isPending}
            disabled={busy}
            onClick={() => cancel.mutate({ itemId: item.id })}
            data-testid={`work-item-cancel-${item.id}`}
          >
            {item.startedAt ? 'Cancel' : 'Remove'}
          </Button>
        ) : null}
      </div>
      <p className="m-0 text-small text-text-secondary" data-testid={`work-item-line-${item.id}`}>
        {itemLine(item)}
        {reason ? ` · ${reason}` : item.detail ? ` · ${item.detail}` : ''}
      </p>
      {error ? <ErrorNote error={error} /> : null}
    </li>
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

function SchedulesCard({ overview, now }: { overview: ControlPlaneOverview; now: number }) {
  const programs = useRead(['programs', 'control-options'], 'program.list', { limit: 100 })
  const create = useWrite('control.createSchedule', refresh)
  const setEnabled = useWrite('control.setScheduleEnabled', refresh)
  const remove = useWrite('control.removeSchedule', refresh)
  const [form, setForm] = useState<ScheduleForm>(EMPTY_SCHEDULE_FORM)
  const [touched, setTouched] = useState(false)
  const check = validateScheduleForm(form)
  const nameOf = (id: string): string | null =>
    programs.data?.programs.find((p) => p.program.id === id)?.program.name ?? null
  const options = (programs.data?.programs ?? [])
    .filter((p) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(p.program.state))
    .map((p) => ({ value: p.program.id, label: p.program.name }))
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
                      program: s.action.type === 'program' ? nameOf(s.action.programId) : null,
                    })}{' '}
                    · {scheduleLine(s, new Date(now))}
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
                  loading={remove.isPending && remove.variables?.scheduleId === s.id}
                  onClick={() => remove.mutate({ scheduleId: s.id })}
                  data-testid={`schedule-remove-${s.id}`}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
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
          <Field
            label="Program"
            error={touched ? check.errors.programId : undefined}
            className="lg:col-span-2"
          >
            {(id) => (
              <Select
                id={id}
                value={form.programId}
                options={[{ value: '', label: 'Choose a program' }, ...options]}
                onChange={(programId) => setForm((f) => ({ ...f, programId }))}
                data-testid="schedule-program"
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
    </Card>
  )
}

/** Control Center: runtime health, the global queue, capacity, schedules and recent incidents. */
export function ControlView() {
  const overview = useControlOverview()
  const now = useNow(true, 30_000)
  const o = overview.data ?? null
  const health = o ? HEALTH_LABEL[o.health.level] : null
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
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-6 py-5">
          {overview.error ? <ErrorNote error={overview.error} /> : null}
          {!o ? (
            <p className="m-0 text-text-muted" role="status">
              Loading the queue…
            </p>
          ) : (
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
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {o.active.map((i) => (
                      <ItemRow key={i.id} item={i} />
                    ))}
                  </ul>
                )}
              </Card>
              <Card
                title="Waiting"
                description="In the order they will start: priority first, then the order you set."
                data-testid="control-waiting"
              >
                <div className="flex flex-col gap-3">
                  {o.waiting.length === 0 ? (
                    <p
                      className="m-0 text-small text-text-muted"
                      data-testid="control-waiting-empty"
                    >
                      The queue is empty.
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {o.waiting.map((i, index) => (
                        <ItemRow
                          key={i.id}
                          item={i}
                          reason={i.reason}
                          first={index === 0}
                          last={index === o.waiting.length - 1}
                        />
                      ))}
                    </ul>
                  )}
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
                        <li
                          key={i.id}
                          className="flex items-center gap-2 text-small"
                          data-testid={`finished-${i.id}`}
                          data-state={i.state}
                        >
                          <Badge tone={STATE_LABEL[i.state].tone}>
                            {STATE_LABEL[i.state].label}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate">{i.title}</span>
                          <span className="text-text-muted">
                            <TimeAgo iso={i.finishedAt} />
                          </span>
                        </li>
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
