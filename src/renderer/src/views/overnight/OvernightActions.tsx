import { useState } from 'react'
import type { OvernightStatus } from '@shared/overnight'
import { Button, ConfirmDialog } from '../../components/ui'
import { useCancelOvernightMission, useCancelPower } from '../../lib/queries'
import { ChangeEndActionDialog, ExtendDialog, ReportDialog } from '../run/OvernightBanner'
import { bannerEnablement } from '../run/overnightModel'
import { cancelCopy, workloadNoun } from './workloadModel'

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
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="danger"
          disabled={!can.canCancelPower}
          loading={cancelPower.isPending}
          onClick={() => cancelPower.mutate({ runId: status.runId })}
          data-testid={`${prefix}-cancel-shutdown`}
        >
          Cancel shutdown
        </Button>
        <Button
          size="sm"
          disabled={!can.canChangeEndAction}
          onClick={() => setDialog('end')}
          data-testid={`${prefix}-change-end-action`}
        >
          Change end action
        </Button>
        <Button
          size="sm"
          disabled={!can.canExtend}
          onClick={() => setDialog('extend')}
          data-testid={`${prefix}-extend`}
        >
          {campaign ? 'Extend' : 'Extend mission'}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={!can.canCancelMission}
          loading={cancelWorkload.isPending}
          onClick={() => setDialog('cancel')}
          data-testid={`${prefix}-cancel`}
        >
          {copy.confirmLabel}
        </Button>
        {status.hasReport ? (
          <Button size="sm" onClick={() => setDialog('report')} data-testid={`${prefix}-report`}>
            {campaign ? 'View report' : 'Final report'}
          </Button>
        ) : null}
      </div>

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
