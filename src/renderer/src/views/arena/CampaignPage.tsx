import { useMemo, useState } from 'react'
import {
  useArenaCampaign,
  useCancelCampaign,
  usePauseCampaign,
  useResumeCampaign,
  useStartCampaign,
} from '../../lib/queries-v3'
import { useNow } from '../../lib/useNow'
import { formatDateTime, formatTokens } from '../../lib/format'
import {
  Button,
  ConfirmDialog,
  ErrorNote,
  Notice,
  PageHeader,
  PlayIcon,
  PauseIcon,
  Stat,
  Tabs,
  ChevronLeftIcon,
} from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import { clockText } from '../../lib/usageModel'
import { campaignDuration, CampaignStateBadge, ProgressCounts, ProgressStrip } from './CampaignList'
import { Matrix } from './Matrix'
import { ResultsPanel } from './ResultsPanel'
import { TrialsTable } from './TrialsTable'
import { TrialDrawer } from './TrialDrawer'
import {
  campaignProgress,
  campaignStateInfo,
  canCancel,
  canPause,
  canResume,
  canStart,
  strategyName,
} from './arenaModel'

type Tab = 'matrix' | 'results' | 'trials'

function startedText(iso: string, now: number): string {
  const clock = clockText(iso, now)
  return /^d{1,2}:d{2}$/.test(clock) ? `Today ${clock}` : formatDateTime(iso)
}

export function CampaignPage({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  const q = useArenaCampaign(campaignId)
  const start = useStartCampaign()
  const pause = usePauseCampaign()
  const resume = useResumeCampaign()
  const cancel = useCancelCampaign()
  const [tab, setTab] = useState<Tab>('matrix')
  const [trialId, setTrialId] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const d = q.data
  const live = d?.campaign.state === 'running'
  const now = useNow(!!live, 5_000)
  const caseNames = useMemo(
    () => new Map((d?.cases ?? []).map((c) => [c.case.id, c.case.name])),
    [d?.cases],
  )

  const back = (
    <Button
      size="sm"
      variant="ghost"
      icon={<ChevronLeftIcon size={13} />}
      onClick={onBack}
      data-testid="arena-back"
    >
      All campaigns
    </Button>
  )

  if (!d) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="arena-campaign">
        <PageHeader title="Campaign" context="Arena" actions={back} />
        <div className="min-h-0 flex-1 overflow-auto p-6">
          {q.isPending ? (
            <BlockSkeleton rows={5} />
          ) : q.isError ? (
            <ReadError
              error={q.error}
              calm="This campaign is not available yet."
              onRetry={() => void q.refetch()}
            />
          ) : null}
        </div>
      </div>
    )
  }

  const c = d.campaign
  const info = campaignStateInfo(c.state, c.pauseReason)
  const progress = campaignProgress(d.counts, d.total)
  const run = (m: typeof start) => m.mutate({ campaignId })

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="arena-campaign">
      <PageHeader
        title={c.name}
        context="Arena"
        actions={
          <>
            <CampaignStateBadge c={c} />
            {canStart(c.state) ? (
              <Button
                size="sm"
                variant="primary"
                icon={<PlayIcon size={12} />}
                loading={start.isPending}
                onClick={() => run(start)}
                data-testid="arena-start"
              >
                Start
              </Button>
            ) : null}
            {canPause(c.state) ? (
              <Button
                size="sm"
                icon={<PauseIcon size={12} />}
                loading={pause.isPending}
                onClick={() => run(pause)}
                data-testid="arena-pause"
              >
                Pause
              </Button>
            ) : null}
            {canResume(c.state) ? (
              <Button
                size="sm"
                variant="primary"
                icon={<PlayIcon size={12} />}
                loading={resume.isPending}
                onClick={() => run(resume)}
                data-testid="arena-resume"
              >
                Resume
              </Button>
            ) : null}
            {canCancel(c.state) ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirmCancel(true)}
                data-testid="arena-cancel"
              >
                Cancel
              </Button>
            ) : null}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-6 py-5">
          {info.note ? (
            <Notice tone="warning" data-testid="arena-paused-note">
              {info.note}
            </Notice>
          ) : null}
          {c.error ? <ErrorNote error={c.error} /> : null}

          <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border bg-surface px-4 py-3 sm:grid-cols-3 xl:grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,1.6fr)]">
            <Stat
              label="Strategies"
              value={
                <span className="text-body font-medium">
                  {c.strategies.map(strategyName).join(', ')}
                </span>
              }
            />
            <Stat label="Cases × repetitions" value={`${d.cases.length} × ${c.repetitions}`} />
            <Stat
              label="Started"
              value={
                <span className="text-body font-medium">
                  {c.startedAt ? startedText(c.startedAt, now) : 'Not started'}
                </span>
              }
            />
            <Stat label="Duration" value={campaignDuration(c, now)} />
            <Stat
              label="Observed tokens"
              source={{ confidence: 'OBSERVED', source: 'LOCAL_AGGREGATION' }}
              value={formatTokens(d.usage.inputTokens + d.usage.outputTokens)}
              hint={`${d.usage.sessions} sessions`}
            />
            <div className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-3 xl:col-span-1">
              <div className="text-small text-text-muted">
                Progress · {progress.finished} of {progress.total} finished
              </div>
              <ProgressStrip p={progress} className="mt-1.5" />
              <ProgressCounts p={progress} />
            </div>
          </div>

          <Tabs
            label="Campaign sections"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'matrix', label: 'Matrix', testId: 'arena-tab-matrix' },
              { id: 'results', label: 'Results', testId: 'arena-tab-results' },
              {
                id: 'trials',
                label: 'Trials',
                badge: <span className="tnum text-text-muted">{d.total}</span>,
                testId: 'arena-tab-trials',
              },
            ]}
          />
          {tab === 'matrix' ? (
            <Matrix
              cases={d.cases}
              strategies={c.strategies}
              matrix={d.matrix}
              onOpenTrial={setTrialId}
              selectedTrial={trialId}
            />
          ) : tab === 'results' ? (
            <ResultsPanel campaignId={campaignId} />
          ) : (
            <TrialsTable
              campaignId={campaignId}
              caseNames={caseNames}
              onOpen={setTrialId}
              selected={trialId}
            />
          )}
        </div>
      </div>
      <TrialDrawer trialId={trialId} onClose={() => setTrialId(null)} />
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this campaign?"
        confirmLabel="Cancel campaign"
        danger
        loading={cancel.isPending}
        onConfirm={() =>
          cancel.mutate({ campaignId }, { onSuccess: () => setConfirmCancel(false) })
        }
      >
        Running trials stop and queued trials will not run. Finished trials and their results are
        kept.
      </ConfirmDialog>
    </div>
  )
}
