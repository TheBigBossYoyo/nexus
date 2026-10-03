import { TERMINAL_RUN_STATES, type Run } from '@shared/domain'
import { useApprovePlan, useCancelRun, usePauseRun, useResumeRun } from '../lib/queries'
import { useSelectedRun } from './useCurrent'

export interface RunControls {
  run: Run | null
  canPause: boolean
  canResume: boolean
  canCancel: boolean
  canApprovePlan: boolean
  pause: () => void
  resume: () => void
  cancel: () => void
  approvePlan: () => void
  busy: boolean
}

/** Pause/resume/cancel/approve-plan for the selected run, wired to the mutations. */
export function useRunControls(): RunControls {
  const { detail } = useSelectedRun()
  const run = detail?.run ?? null
  const pauseM = usePauseRun()
  const resumeM = useResumeRun()
  const cancelM = useCancelRun()
  const approveM = useApprovePlan()

  const terminal = run ? TERMINAL_RUN_STATES.includes(run.state) : true
  const runId = run?.id
  return {
    run,
    canPause: !!run && !terminal && run.state !== 'paused' && run.state !== 'awaiting_approval',
    canResume: run?.state === 'paused',
    canCancel: !!run && !terminal,
    canApprovePlan: run?.state === 'awaiting_approval',
    pause: () => runId && pauseM.mutate({ runId }),
    resume: () => runId && resumeM.mutate({ runId }),
    cancel: () => runId && cancelM.mutate({ runId }),
    approvePlan: () => runId && approveM.mutate({ runId }),
    busy: pauseM.isPending || resumeM.isPending || cancelM.isPending || approveM.isPending,
  }
}
