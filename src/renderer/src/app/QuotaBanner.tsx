import { useUiStore } from '../store/ui'
import { useUsageEndWait, useUsageOverview, useUsageResumeNow } from '../lib/queries'
import { useNow } from '../lib/useNow'
import { quotaBanner } from '../lib/usageModel'
import { Button, ClockIcon } from '../components/ui'

/**
 * Global notice while Claude's usage limit holds work back. All times are derived from timestamps the service
 * reported; unknown values are said to be unknown. Static: no pulsing, no animation.
 */
export function QuotaBanner() {
  const overview = useUsageOverview().data ?? null
  const now = useNow(overview !== null, 1000)
  const openSettings = useUiStore((s) => s.openSettings)
  const resumeNow = useUsageResumeNow()
  const endWait = useUsageEndWait()
  const model = quotaBanner(overview, now)
  if (!model || !overview) return null
  return (
    <section
      aria-label="Claude usage limit"
      data-testid="quota-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-warning-subtle px-5 py-2.5"
    >
      <ClockIcon size={16} className="shrink-0 text-warning" />
      <div className="min-w-0 flex-1 basis-80" role="status">
        <div className="font-semibold text-text-primary">
          {model.headline}{' '}
          <span className="font-normal text-text-secondary">No work has been lost.</span>
        </div>
        <div className="text-text-secondary">
          {model.resumeSegments.map((seg, i) =>
            seg.mark ? (
              <span
                key={i}
                data-testid={seg.mark === 'reset' ? 'quota-reset' : 'quota-resume-at'}
                className="tnum font-medium text-text-primary"
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
          {model.countdown ? <span className="tnum"> · in {model.countdown}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" onClick={() => openSettings('usage')} data-testid="quota-settings">
          Resume settings
        </Button>
        <Button
          size="sm"
          loading={resumeNow.isPending}
          onClick={() => resumeNow.mutate({})}
          data-testid="quota-check-now"
        >
          Check now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={endWait.isPending}
          onClick={() => endWait.mutate({})}
          data-testid="quota-end-wait"
        >
          End wait
        </Button>
      </div>
    </section>
  )
}
