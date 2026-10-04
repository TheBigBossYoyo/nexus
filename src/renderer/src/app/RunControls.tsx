import { useState } from 'react'
import { Button, CheckIcon, ConfirmDialog, PauseIcon, PlayIcon, StopIcon } from '../components/ui'
import { useRunControls } from './useRunControls'

/** Approve plan / pause / resume / cancel for the selected run. Shown in the Mission header. */
export function RunControls() {
  const c = useRunControls()
  const [confirmCancel, setConfirmCancel] = useState(false)
  if (!c.run) return null
  return (
    <div className="flex items-center gap-1.5">
      {c.canApprovePlan ? (
        <Button
          size="sm"
          variant="primary"
          icon={<CheckIcon size={12} />}
          onClick={c.approvePlan}
          disabled={c.busy}
          data-testid="topbar-approve-plan"
        >
          Approve plan
        </Button>
      ) : null}
      {c.canPause ? (
        <Button
          size="sm"
          icon={<PauseIcon size={12} />}
          onClick={c.pause}
          disabled={c.busy}
          data-testid="run-pause"
        >
          Pause
        </Button>
      ) : null}
      {c.canResume ? (
        <Button
          size="sm"
          icon={<PlayIcon size={12} />}
          onClick={c.resume}
          disabled={c.busy}
          data-testid="run-resume"
        >
          Resume
        </Button>
      ) : null}
      {c.canCancel ? (
        <Button
          size="sm"
          variant="danger"
          icon={<StopIcon size={12} />}
          onClick={() => setConfirmCancel(true)}
          disabled={c.busy}
          data-testid="run-cancel"
        >
          Cancel
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          c.cancel()
          setConfirmCancel(false)
        }}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        danger
      >
        Running agents are stopped and no further tasks are scheduled. Worktrees and branches are
        kept.
      </ConfirmDialog>
    </div>
  )
}
