import { useState } from 'react'
import { END_ACTIONS, type EndAction, type OvernightStatus } from '@shared/overnight'
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorNote,
  Field,
  Loading,
  Markdown,
  NumberField,
  Select,
  StatusDot,
  type SelectOption,
} from '../../components/ui'
import { useRunControls } from '../../app/useRunControls'
import { TONE_CLASSES } from '../../lib/status'
import {
  useCancelOvernightMission,
  useCancelPower,
  useChangeEndAction,
  useExtendMission,
  useOvernight,
  useOvernightReport,
} from '../../lib/queries'
import { END_ACTION_LABEL } from '../projects/overnight'
import { overnightWord } from '../../lib/wording'
import { bannerModel } from './overnightModel'
import { useNow } from './runContext'

const END_OPTIONS: SelectOption<EndAction>[] = END_ACTIONS.map((a) => ({
  value: a,
  label: END_ACTION_LABEL[a],
}))

export function ChangeEndActionDialog({
  status,
  open,
  onClose,
}: {
  status: OvernightStatus
  open: boolean
  onClose: () => void
}) {
  const change = useChangeEndAction()
  const [endAction, setEndAction] = useState<EndAction>(status.policy.endAction)
  const [force, setForce] = useState(status.policy.forceCloseApplications)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change end action"
      testId="overnight-change-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={change.isPending}
            onClick={() =>
              change.mutate(
                { runId: status.runId, endAction, forceCloseApplications: force },
                { onSuccess: onClose },
              )
            }
            data-testid="overnight-change-confirm"
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="End action">
          {(id) => (
            <Select
              id={id}
              value={endAction}
              onChange={setEndAction}
              options={END_OPTIONS}
              data-testid="overnight-change-select"
            />
          )}
        </Field>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          <span>
            Force close apps (Windows closes applications without waiting; unsaved work may be lost)
          </span>
        </label>
      </div>
    </Dialog>
  )
}

export function ExtendDialog({
  runId,
  open,
  onClose,
}: {
  runId: string
  open: boolean
  onClose: () => void
}) {
  const extend = useExtendMission()
  const [minutes, setMinutes] = useState(60)
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 24 * 60
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Extend mission"
      testId="overnight-extend-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={extend.isPending}
            onClick={() => extend.mutate({ runId, minutes }, { onSuccess: onClose })}
            data-testid="overnight-extend-confirm"
          >
            Extend
          </Button>
        </>
      }
    >
      <Field
        label="Extra minutes"
        hint="Moves the mission deadline and the failsafe by the same amount."
        error={valid ? undefined : 'Enter 1 to 1440 minutes.'}
      >
        {(id) => (
          <NumberField
            id={id}
            min={1}
            max={1440}
            value={minutes}
            onChange={setMinutes}
            data-testid="overnight-extend-minutes"
          />
        )}
      </Field>
    </Dialog>
  )
}

export function ReportDialog({
  runId,
  open,
  onClose,
}: {
  runId: string
  open: boolean
  onClose: () => void
}) {
  const report = useOvernightReport(runId, open)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Final report"
      width={760}
      testId="overnight-report-dialog"
    >
      {report.isPending ? <Loading label="Loading report" /> : null}
      {report.isError ? <ErrorNote error={report.error} /> : null}
      {report.data ? (
        <div className="flex flex-col gap-2">
          {report.data.path ? (
            <div
              className="font-mono text-small text-text-secondary"
              data-testid="overnight-report-path"
            >
              {report.data.path}
            </div>
          ) : (
            <div className="text-text-muted">Not saved into the project.</div>
          )}
          {report.data.text ? (
            <Markdown>{report.data.text}</Markdown>
          ) : (
            <div className="text-text-muted">No report text.</div>
          )}
        </div>
      ) : null}
    </Dialog>
  )
}

/** Persistent Overnight Mode banner. Renders from overnight.get only, so it survives an app restart. */
export function OvernightBanner({ runId }: { runId: string }) {
  const query = useOvernight(runId)
  const status = query.data ?? null
  const controls = useRunControls()
  const cancelPower = useCancelPower()
  const cancelMission = useCancelOvernightMission()
  const [dialog, setDialog] = useState<'end' | 'extend' | 'report' | 'cancel' | null>(null)
  const pendingPower = status?.state === 'POWER_ACTION_SCHEDULED'
  const now = useNow(pendingPower || status?.state === 'QUOTA_PAUSED')

  if (!status) return null
  const m = bannerModel(status, now)
  const close = () => setDialog(null)

  return (
    <section
      aria-label="Overnight mode"
      className="flex shrink-0 flex-col gap-1.5 border-b border-l-2 border-tone-warning bg-tone-warning/10 px-4 py-2"
      data-testid="overnight-banner"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Badge tone="warning" mono>
          OVERNIGHT MODE
        </Badge>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={m.tone} pulse={m.live} />
          <span className={`font-semibold ${TONE_CLASSES[m.tone].text}`}>{overnightWord(m.state)}</span>
          <span className="sr-only" aria-hidden="true" data-testid="overnight-state" data-state={m.state}>
            {m.state}
          </span>
        </span>
        {m.detail ? <span className="text-text-secondary">{m.detail}</span> : null}
        <span className="font-mono text-small text-text-secondary">
          Failsafe shutdown: <span data-testid="overnight-failsafe">{m.failsafe}</span>
        </span>
        <span className="font-mono text-small text-text-secondary">
          Mission deadline: <span data-testid="overnight-deadline">{m.deadline}</span>
        </span>
        <span className="font-mono text-small text-text-secondary">
          End action: <span data-testid="overnight-end-action-label">{m.endAction}</span>
        </span>
        {m.countdown ? (
          <span
            className="font-mono font-semibold text-tone-warning"
            role="timer"
            data-testid="overnight-countdown"
          >
            {m.countdown}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="danger"
          disabled={!m.canCancelPower}
          loading={cancelPower.isPending}
          onClick={() => cancelPower.mutate({ runId })}
          data-testid="overnight-cancel-shutdown"
        >
          CANCEL SHUTDOWN
        </Button>
        <Button
          size="sm"
          disabled={!m.canChangeEndAction}
          onClick={() => setDialog('end')}
          data-testid="overnight-change-end-action"
        >
          CHANGE END ACTION
        </Button>
        <Button
          size="sm"
          disabled={!m.canExtend}
          onClick={() => setDialog('extend')}
          data-testid="overnight-extend"
        >
          EXTEND MISSION
        </Button>
        {controls.canResume ? (
          <Button
            size="sm"
            variant="primary"
            disabled={controls.busy}
            onClick={controls.resume}
            data-testid="overnight-pause"
          >
            RESUME MISSION
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!m.live || !controls.canPause || controls.busy}
            onClick={controls.pause}
            data-testid="overnight-pause"
          >
            PAUSE MISSION
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          disabled={!m.canCancelMission}
          loading={cancelMission.isPending}
          onClick={() => setDialog('cancel')}
          data-testid="overnight-cancel-mission"
        >
          CANCEL MISSION
        </Button>
        {m.hasReport ? (
          <Button size="sm" onClick={() => setDialog('report')} data-testid="overnight-report-open">
            Final report
          </Button>
        ) : null}
      </div>

      {dialog === 'end' ? <ChangeEndActionDialog status={status} open onClose={close} /> : null}
      {dialog === 'extend' ? <ExtendDialog runId={runId} open onClose={close} /> : null}
      {dialog === 'report' ? <ReportDialog runId={runId} open onClose={close} /> : null}
      <ConfirmDialog
        open={dialog === 'cancel'}
        onClose={close}
        onConfirm={() => {
          cancelMission.mutate({ runId })
          close()
        }}
        title="Cancel this mission?"
        confirmLabel="Cancel mission"
        danger
        testId="overnight-cancel-dialog"
      >
        Agents are stopped and the run ends. The end action runs only if cancellation is one of the
        conditions you selected.
      </ConfirmDialog>
    </section>
  )
}
