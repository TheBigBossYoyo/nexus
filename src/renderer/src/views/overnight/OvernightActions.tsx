import { useState } from 'react'
import type { OvernightStatus } from '@shared/overnight'
import { Button, ConfirmDialog } from '../../components/ui'
import { useCancelOvernightMission, useCancelPower } from '../../lib/queries'
import { ChangeEndActionDialog, ExtendDialog, ReportDialog } from '../run/OvernightBanner'
import { bannerEnablement } from '../run/overnightModel'
import { actionHint, cancelCopy, workloadNoun } from './workloadModel'

/**
 * The overnight controls for one record, worded for its workload. Works with the record's `runId` on
 * every channel, which is the campaign id for an Arena campaign. `prefix` namespaces the test ids.
 */
export function OvernightActions({ status, prefix }: { status: OvernightStatus; prefix: string }) {
  const cancelPower = useCancelPower()
  const cancelWorkload = useCancelOvernightMission()
  const [dialog, setDialog] = useState<'end' | 'extend' | 'report' | 'cancel' | null>(null)
  const noun = workloadNoun(status)
  const can = bannerEnablement(status)
  const copy = cancelCopy(noun)
  const close = () => setDialog(null)
  const campaign = noun === 'campaign'
  const hint = actionHint(noun, can, status.hasReport)
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {can.canCancelPower ? (
          <Button
            size="sm"
            variant="danger"
            loading={cancelPower.isPending}
            onClick={() => cancelPower.mutate({ runId: status.runId })}
            data-testid={`${prefix}-cancel-shutdown`}
          >
            Cancel shutdown
          </Button>
        ) : null}
        {can.canChangeEndAction ? (
          <Button
            size="sm"
            onClick={() => setDialog('end')}
            data-testid={`${prefix}-change-end-action`}
          >
            Change end action
          </Button>
        ) : null}
        {can.canExtend ? (
          <Button
            size="sm"
            onClick={() => setDialog('extend')}
            data-testid={`${prefix}-extend`}
          >
            {campaign ? 'Extend' : 'Extend mission'}
          </Button>
        ) : null}
        {can.canCancelMission ? (
          <Button
            size="sm"
            variant="danger"
            loading={cancelWorkload.isPending}
            onClick={() => setDialog('cancel')}
            data-testid={`${prefix}-cancel`}
          >
            {copy.confirmLabel}
          </Button>
        ) : null}
        {status.hasReport ? (
          <Button size="sm" onClick={() => setDialog('report')} data-testid={`${prefix}-report`}>
            {campaign ? 'View report' : 'Final report'}
          </Button>
        ) : null}
      </div>
      {hint ? (
        <p className="m-0 mt-2 text-small text-text-muted" data-testid={`${prefix}-action-hint`}>
          {hint}
        </p>
      ) : null}

      {dialog === 'end' ? <ChangeEndActionDialog status={status} open onClose={close} /> : null}
      {dialog === 'extend' ? (
        <ExtendDialog runId={status.runId} noun={noun} open onClose={close} />
      ) : null}
      {dialog === 'report' ? (
        <ReportDialog runId={status.runId} noun={noun} open onClose={close} />
      ) : null}
      <ConfirmDialog
        open={dialog === 'cancel'}
        onClose={close}
        onConfirm={() => {
          cancelWorkload.mutate({ runId: status.runId })
          close()
        }}
        title={copy.title}
        confirmLabel={copy.confirmLabel}
        danger
      >
        {copy.body}
      </ConfirmDialog>
    </>
  )
}
