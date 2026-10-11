import { useState } from 'react'
import { useUiStore } from '../store/ui'
import { useUsageEndWait, useUsageOverview, useUsageResumeNow } from '../lib/queries'
import { useNow } from '../lib/useNow'
import { quotaBanner } from '../lib/usageModel'
import { Button, ClockIcon, ConfirmDialog, SourceLabel } from '../components/ui'

/**
 * The single surface for a Claude usage-limit wait. Every time is derived from timestamps the service reported:
 * a reset time carries an Exact label, NEXUS's own schedule an Estimated one, and unknown values are said to be unknown.
 * Static: no pulsing, no animation.
 */
export function QuotaBanner() {
  const overview = useUsageOverview().data ?? null
  const now = useNow(overview !== null, 1000)
  const openSettings = useUiStore((s) => s.openSettings)
  const resumeNow = useUsageResumeNow()
  const endWait = useUsageEndWait()
  const [confirmEnd, setConfirmEnd] = useState(false)
  const model = quotaBanner(overview, now)
  if (!model || !overview) return null
  const auto = overview.autoResume.enabled
  return (
    <section
      aria-label="Claude usage limit"
      data-testid="quota-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-warning-subtle px-5 py-2"
    >
      <ClockIcon size={16} className="shrink-0 text-warning" />
      <div className="min-w-0 flex-1 basis-80" role="status">
        <div className="font-semibold text-text-primary">
          {model.headline} <span className="font-normal text-text-secondary">Finished tasks are kept; unfinished work resumes from its last checkpoint.</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-text-secondary">
          {model.checking ? <span>Checking availability…</span> : null}
          {!model.checking && !auto ? (
            <span>Automatic resume is off. Resume the paused runs yourself when Claude is available.</span>
          ) : null}
          {model.resetText ? (
            <span className="inline-flex items-center gap-1.5">
              Limit resets{' '}
              <span data-testid="quota-reset" className="tnum font-medium text-text-primary">
                {model.resetText}
              </span>
              <SourceLabel confidence="EXACT" source="RUNTIME" />
            </span>
          ) : (
            <span>
              Claude gave no reset time. NEXUS checks again every 5 to 30 minutes until Claude is available or you end the wait.
            </span>
          )}
          {!model.checking && auto && model.resumeAtText ? (
            <span className="inline-flex items-center gap-1.5">
              Next availability check{' '}
              <span data-testid="quota-resume-at" className="tnum font-medium text-text-primary">
                {model.resumeAtText}
              </span>
              <SourceLabel confidence="ESTIMATED" source="LOCAL_AGGREGATION" />
              {model.countdown ? <span aria-hidden="true" className="tnum text-text-muted">(in {model.countdown})</span> : null}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className="rounded-sm text-small text-accent hover:underline"
          onClick={() => openSettings('usage')}
          data-testid="quota-settings"
        >
          Resume settings
        </button>
        <Button size="sm" loading={endWait.isPending} onClick={() => setConfirmEnd(true)} data-testid="quota-end-wait">
          End wait
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={resumeNow.isPending}
          onClick={() => resumeNow.mutate({})}
          data-testid="quota-check-now"
        >
          Check now
        </Button>
      </div>
      <ConfirmDialog
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        onConfirm={() => {
          endWait.mutate({})
          setConfirmEnd(false)
        }}
        title="End the wait?"
        confirmLabel="End wait"
        danger
      >
        Paused missions stay paused until you resume them yourself. No work is lost.
      </ConfirmDialog>
    </section>
  )
}
