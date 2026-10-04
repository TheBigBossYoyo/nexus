import { useState } from 'react'
import { useUsageOverview, useUsageRefresh, useUsageResumeNow } from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import { Badge, Button, PageHeader, RefreshIcon, StatusDot } from '../../components/ui'
import { usageHeader } from './usageViewModel'
import { StatusSection } from './StatusSection'
import { RunSection } from './RunSection'
import { HistorySection } from './HistorySection'
import { LimitSection } from './LimitSection'
import { EfficiencySection } from './EfficiencySection'

/** Claude usage: what Claude reports, what NEXUS itself observed, and how limits were handled. */
export function UsageView() {
  const overview = useUsageOverview()
  const refresh = useUsageRefresh()
  const resumeNow = useUsageResumeNow()
  const now = useNow(true, 30_000)
  const [today] = useState(() => new Date())
  const o = overview.data ?? null
  const h = usageHeader(o)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="usage-view">
      <PageHeader
        title="Usage"
        context="Intelligence"
        actions={
          <>
            {o ? (
              <Badge tone={h.tone} data-testid="usage-header-status">
                <StatusDot tone={h.tone} />
                {h.statusLabel}
              </Badge>
            ) : null}
            {h.waiting ? (
              <Button
                size="sm"
                onClick={() => resumeNow.mutate({})}
                loading={resumeNow.isPending}
                data-testid="usage-check-now"
              >
                Check now
              </Button>
            ) : null}
            <Button
              size="sm"
              icon={<RefreshIcon size={13} />}
              onClick={() => refresh.mutate({})}
              loading={refresh.isPending}
              data-testid="usage-refresh"
            >
              Refresh
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-6 py-5">
          <StatusSection
            overview={o}
            pending={overview.isPending}
            error={overview.error}
            now={now}
          />
          <RunSection />
          <HistorySection today={today} />
          <LimitSection now={now} />
          <EfficiencySection />
        </div>
      </div>
    </div>
  )
}
