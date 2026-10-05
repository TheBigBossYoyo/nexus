import { useMemo } from 'react'
import { BACKLOG_STATUSES, type ProgramDetail } from '@shared/program'
import { useExpertise, useSetBacklogStatus } from '../../lib/queries-v4'
import { formatDateTime } from '../../lib/format'
import { useUiStore } from '../../store/ui'
import { Badge, Button, DataTable, Select, StatusBadge, TimeAgo, type Column } from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import {
  BACKLOG_STATUS_LABEL,
  categoryLabel,
  decisionLabel,
  expertiseLabel,
  memoryKindLabel,
  missionOutcomeInfo,
  provenanceText,
  revisionStatusInfo,
  revisionTriggerText,
  severityTone,
  diffSummary,
} from './programsModel'
import { Empty, PlanDiffList, SectionNote } from './programsUi'

type Mission = ProgramDetail['missions'][number]

export function MissionsSection({ detail }: { detail: ProgramDetail }) {
  const openRun = useUiStore((s) => s.openRun)
  const titles = useMemo(() => new Map(detail.roadmap.map((m) => [m.id, m.title])), [detail.roadmap])
  const rows = [...detail.missions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const columns: Column<Mission>[] = [
    { key: 'milestone', header: 'Milestone', render: (m) => <span className="block max-w-64 truncate font-medium">{titles.get(m.milestoneId) ?? '—'}</span> },
    { key: 'attempt', header: 'Attempt', numeric: true, render: (m) => m.attempt },
    { key: 'strategy', header: 'Strategy', render: (m) => (m.strategy ? m.strategy.charAt(0) + m.strategy.slice(1).toLowerCase() : '—') },
    { key: 'outcome', header: 'Outcome', render: (m) => <StatusBadge status={missionOutcomeInfo(m.outcome)} /> },
    { key: 'started', header: 'Started', render: (m) => <TimeAgo iso={m.createdAt} className="text-text-secondary" /> },
    {
      key: 'open',
      header: <span className="sr-only">Open</span>,
      align: 'right',
      render: (m) => (
        <Button size="sm" variant="ghost" onClick={() => openRun(m.runId, detail.program.projectId)} data-testid={`program-mission-open-${m.id}`}>
          Open mission
        </Button>
      ),
    },
  ]
  return (
    <div className="flex flex-col gap-2" data-testid="program-missions">
      {rows.length === 0 ? (
        <Empty testId="program-missions-empty">No mission has run yet. Each milestone is worked on by one or more missions.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-surface">
          <DataTable columns={columns} rows={rows} rowKey={(m) => m.id} caption="Missions of this program" rowTestId={(m) => `program-mission-${m.id}`} />
        </div>
      )}
    </div>
  )
}

export function RevisionsSection({ detail }: { detail: ProgramDetail }) {
  const titles = useMemo(() => {
    const map = new Map<string, string>(detail.roadmap.map((m) => [m.key, m.title]))
    for (const r of detail.revisions) for (const m of r.milestones) map.set(m.key, m.title)
    return map
  }, [detail.roadmap, detail.revisions])
  const rows = [...detail.revisions].sort((a, b) => b.version - a.version)
  if (rows.length === 0) return <Empty testId="program-revisions">No plan has been proposed yet.</Empty>
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Plan versions, newest first" data-testid="program-revisions">
      {rows.map((r) => (
        <li key={r.id} className="rounded-lg border bg-surface px-4 py-3" data-testid={`program-revision-${r.version}`} data-status={r.status}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">Version {r.version}</span>
            <StatusBadge status={revisionStatusInfo(r.status)} />
            <span className="text-small text-text-muted">{revisionTriggerText(r.trigger)}</span>
            <span className="ml-auto text-small text-text-muted">{formatDateTime(r.createdAt)}</span>
          </div>
          <p className="m-0 mt-1.5 text-text-secondary">{r.reason}</p>
          {r.strategyNote ? <p className="m-0 mt-1 text-small text-text-muted">Approach: {r.strategyNote}</p> : null}
          <p className="m-0 mb-1.5 mt-2 text-caption font-medium text-text-muted">{diffSummary(r.diff)}</p>
          <PlanDiffList diff={r.diff} titleOf={(k) => titles.get(k) ?? null} />
        </li>
      ))}
    </ol>
  )
}

export function DecisionsSection({ detail }: { detail: ProgramDetail }) {
  const rows = [...detail.decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (rows.length === 0) return <Empty testId="program-decisions">The decision trail is empty.</Empty>
  return (
    <div data-testid="program-decisions" className="flex flex-col gap-2">
      <SectionNote>What the program engine decided and why, newest first.</SectionNote>
      <ol className="m-0 list-none divide-y rounded-lg border bg-surface p-0" aria-label="Decisions, newest first">
        {rows.map((d) => (
          <li key={d.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2" data-kind={d.kind}>
            <time dateTime={d.createdAt} className="tnum w-36 shrink-0 text-small text-text-muted" title={d.createdAt}>
              {formatDateTime(d.createdAt)}
            </time>
            <span className="w-44 shrink-0 font-medium">{decisionLabel(d.kind)}</span>
            <span className="min-w-0 flex-1 text-text-secondary">{d.summary}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function BacklogSection({ detail }: { detail: ProgramDetail }) {
  const set = useSetBacklogStatus()
  const rows = [...detail.backlog].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <div className="flex flex-col gap-2" data-testid="program-backlog">
      <SectionNote testId="program-backlog-note">
        Backlog items are proposals. Nothing here runs by itself; the planner may plan a milestone for an item, and only you change its status.
      </SectionNote>
      {rows.length === 0 ? (
        <Empty testId="program-backlog-empty">No proposals yet. Verifiers, failed missions and background jobs add items here.</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((b) => (
            <li key={b.id} className="rounded-lg border bg-surface px-4 py-3" data-testid={`backlog-${b.id}`} data-status={b.status}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 font-medium">{b.title}</span>
                <Badge tone="neutral">{categoryLabel(b.category)}</Badge>
                <Badge tone={severityTone(b.severity)}>Severity: {b.severity}</Badge>
                <span className="inline-flex w-32 shrink-0">
                <Select
                  value={b.status}
                  disabled={set.isPending && set.variables?.itemId === b.id}
                  onChange={(status) => set.mutate({ itemId: b.id, status })}
                  options={BACKLOG_STATUSES.map((s) => ({ value: s, label: BACKLOG_STATUS_LABEL[s] }))}
                  aria-label={`Status of ${b.title}`}
                  className="w-full"
                  data-testid={`backlog-status-${b.id}`}
                />
                </span>
              </div>
              <p className="m-0 mt-1 text-text-secondary">{b.description}</p>
              <p className="m-0 mt-1.5 text-small text-text-secondary">
                <span className="text-text-muted">Evidence:</span> {b.evidence}
              </p>
              <p className="m-0 mt-1 text-small text-text-muted">
                {provenanceText(b.provenance)} · {b.complexity} · <TimeAgo iso={b.createdAt} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function MemorySection({ detail }: { detail: ProgramDetail }) {
  const rows = [...detail.memory].filter((m) => m.status === 'active').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (rows.length === 0)
    return <Empty testId="program-memory">No memory yet. Durable facts are recorded when a milestone is verified.</Empty>
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="program-memory">
      {rows.map((m) => (
        <li key={m.id} className="rounded-lg border bg-surface px-4 py-3" data-testid={`memory-${m.id}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone="review">{memoryKindLabel(m.kind)}</Badge>
            <span className="min-w-0 flex-1 font-medium">{m.title}</span>
            {m.milestoneKey ? <span className="font-mono text-code text-text-muted">{m.milestoneKey}</span> : null}
          </div>
          <p className="m-0 mt-1 text-text-secondary">{m.content}</p>
          <p className="m-0 mt-1 text-small text-text-secondary">
            <span className="text-text-muted">Evidence:</span> {m.evidence}
          </p>
        </li>
      ))}
    </ul>
  )
}

export function ExpertiseSection({ projectId }: { projectId: string }) {
  const q = useExpertise(projectId)
  return (
    <div className="flex flex-col gap-2" data-testid="program-expertise">
      <SectionNote>
        An expertise profile is a record of validated work in an area of this project. It is not a long-lived session; work always starts a normal session.
      </SectionNote>
      {q.isPending ? (
        <BlockSkeleton rows={3} />
      ) : q.isError ? (
        <ReadError error={q.error} calm="Expertise profiles are not available in this build yet." onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <Empty testId="program-expertise-empty">No expertise has been recorded for this project yet.</Empty>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2">
          {q.data.map((e) => (
            <li key={e.id} className="rounded-lg border bg-surface px-4 py-3" data-testid={`expertise-${e.area}`}>
              <div className="font-medium">{expertiseLabel(e.area)}</div>
              <div className="tnum mt-1 text-small text-text-secondary">
                {e.milestonesAccepted} accepted · {e.milestonesRejected} rejected · {e.missions} mission{e.missions === 1 ? '' : 's'}
              </div>
              {e.projectAreas.length > 0 ? (
                <div className="mt-1 break-words font-mono text-code text-text-muted">{e.projectAreas.join(', ')}</div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
