import type { OvernightStatus } from '@shared/overnight'
import { useActiveOvernight, useRuns } from '../../lib/queries'
import { useArenaCampaign } from '../../lib/queries-v3'
import { useNow } from '../../lib/useNow'
import { useUiStore } from '../../store/ui'
import {
  Button,
  Card,
  ErrorNote,
  KeyValue,
  MoonIcon,
  PageHeader,
  Skeleton,
  StatusBadge,
} from '../../components/ui'
import { END_ACTION_LABEL } from '../projects/overnight'
import { OvernightActions } from './OvernightActions'
import { overnightPageModel } from './overnightPageModel'
import { deadlineLabel, isArenaWorkload, workloadKind, workloadNoun } from './workloadModel'

function OvernightRunCard({ status, label }: { status: OvernightStatus; label: string }) {
  const openRun = useUiStore((s) => s.openRun)
  const openCampaign = useUiStore((s) => s.openCampaign)
  const live = status.state === 'POWER_ACTION_SCHEDULED' || status.state === 'QUOTA_PAUSED'
  const now = useNow(live, 1000)
  const m = overnightPageModel(status, now)
  const arena = isArenaWorkload(status)
  const b = m.banner
  return (
    <Card data-testid={`overnight-card-${status.runId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2" role="status">
            <StatusBadge
              status={{ tone: b.tone, label: b.state.replace(/_/g, ' ') }}
              data-testid="overnight-page-state"
            />
            {b.countdown ? (
              <span
                className="tnum font-medium text-warning"
                role="timer"
                data-testid="overnight-page-countdown"
              >
                {b.countdown}
              </span>
            ) : null}
          </div>
          <p className="m-0 mt-1 text-text-secondary">{m.summary}</p>
          <p className="m-0 mt-1 truncate text-small text-text-muted" title={label}>
            {workloadKind(status)}: {label}
          </p>
        </div>
        {arena ? (
          <Button
            size="sm"
            onClick={() => openCampaign(status.runId)}
            data-testid="overnight-open-campaign"
          >
            Open campaign
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => openRun(status.runId, status.projectId)}
            data-testid="overnight-open-mission"
          >
            Open mission
          </Button>
        )}
      </div>

      {m.quota.length > 0 ? (
        <div
          className="mt-3 rounded-md border bg-warning-subtle px-3 py-2"
          data-testid="overnight-quota-wait"
        >
          <ul className="m-0 list-none space-y-0.5 p-0">
            {m.quota.map((l) => (
              <li
                key={l.key}
                className={l.key === 'paused' ? 'font-semibold' : 'text-text-secondary'}
              >
                {l.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 border-t pt-3">
        <KeyValue
          labelWidth="10rem"
          rows={[
            { label: deadlineLabel(workloadNoun(status)), value: b.deadline, mono: true },
            { label: 'Failsafe shutdown', value: b.failsafe, mono: true },
            { label: 'End action', value: END_ACTION_LABEL[status.policy.endAction] },
          ]}
        />
      </div>

      <div className="mt-4">
        <OvernightActions status={status} prefix="overnight-page" />
      </div>
    </Card>
  )
}

/** The campaign name for a campaign record. Never touches the run channels. */
function CampaignCard({ status }: { status: OvernightStatus }) {
  const campaign = useArenaCampaign(status.runId)
  return <OvernightRunCard status={status} label={campaign.data?.campaign.name ?? status.runId} />
}

const EXPLAINER = [
  {
    lead: 'Unattended',
    text: 'Runs one mission or Arena campaign without you, with a hard deadline and automatic waiting for Claude usage limits.',
  },
  {
    lead: 'Safe by default',
    text: 'Tool approvals are always denied while nobody is there, so it cannot do anything you did not already allow.',
  },
  {
    lead: 'Clean finish',
    text: 'An optional shutdown, sleep or hibernate you authorize in advance runs at the end, backed by a failsafe timer in Windows.',
  },
] as const

function Explainer() {
  return (
    <Card>
      <div className="flex flex-col items-center gap-1 pt-4 text-center">
        <MoonIcon size={20} className="mb-1 text-text-muted" />
        <h2 className="m-0 text-heading font-semibold">
          No overnight mission or campaign is running
        </h2>
        <p className="m-0 text-text-secondary">
          Overnight Mode is how NEXUS works while you are away.
        </p>
      </div>
      <ul className="m-0 mx-auto mt-5 mb-3 flex max-w-xl list-none flex-col gap-3 p-0">
        {EXPLAINER.map((e) => (
          <li key={e.lead} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3">
            <span className="font-medium text-text-primary">{e.lead}</span>
            <span className="text-text-secondary">{e.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function OvernightView() {
  const active = useActiveOvernight()
  const runs = useRuns(null)
  const setView = useUiStore((s) => s.setView)
  const setIntent = useUiStore((s) => s.setComposerIntent)
  const labels = new Map((runs.data ?? []).map((r) => [r.id, r.prompt]))
  const start = () => {
    setIntent('overnight')
    setView('projects')
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="overnight-view">
      <PageHeader
        title="Overnight"
        context="System"
        actions={
          <Button size="sm" variant="primary" onClick={start} data-testid="overnight-start-mission">
            Start an overnight mission
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
          {active.isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : active.isError ? (
            <ErrorNote error={active.error} />
          ) : active.data.length === 0 ? (
            <Explainer />
          ) : (
            active.data.map((s) =>
              isArenaWorkload(s) ? (
                <CampaignCard key={s.runId} status={s} />
              ) : (
                <OvernightRunCard key={s.runId} status={s} label={labels.get(s.runId) ?? s.runId} />
              ),
            )
          )}
        </div>
      </div>
    </div>
  )
}
