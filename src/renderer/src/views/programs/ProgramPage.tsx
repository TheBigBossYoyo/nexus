import { useMemo, useState } from 'react'
import type { ProgramDetail, ProgramPlanRevision } from '@shared/program'
import {
  useCancelProgram,
  useDecidePlan,
  usePauseProgram,
  useProgram,
  useReplanProgram,
  useResumeProgram,
  useStartProgram,
} from '../../lib/queries-v4'
import { exactResetAt, clockText } from '../../lib/usageModel'
import { useNow } from '../../lib/useNow'
import { useUiStore } from '../../store/ui'
import { IndicatorGlyph, useUsageIndicator } from '../../app/UsagePopover'
import {
  BranchIcon,
  Button,
  Card,
  ChevronLeftIcon,
  ConfirmDialog,
  CopyIcon,
  Dialog,
  ErrorNote,
  Field,
  Notice,
  PageHeader,
  PauseIcon,
  PlayIcon,
  ProgressBar,
  RefreshIcon,
  Tabs,
  Textarea,
} from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import {
  activeTimeText,
  budgetText,
  currentMilestoneTitle,
  healthInfo,
  isOpenBacklog,
  programActions,
  progressText,
  replanBudgetText,
  revisionTriggerText,
  stateNotice,
  windowTextAt,
} from './programsModel'
import { HealthBadge, Meta, PlanDiffList, ProgramStateBadge, ProposedMilestones } from './programsUi'
import { Roadmap } from './Roadmap'
import { BacklogSection, DecisionsSection, ExpertiseSection, MemorySection, MissionsSection, RevisionsSection } from './ProgramSections'

type Tab = 'roadmap' | 'missions' | 'revisions' | 'decisions' | 'backlog' | 'memory' | 'expertise'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      icon={<CopyIcon size={12} />}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      data-testid="program-branch-copy"
      aria-label={`Copy branch name ${text}`}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function PlanApproval({ detail, revision }: { detail: ProgramDetail; revision: ProgramPlanRevision }) {
  const decide = useDecidePlan()
  const titles = useMemo(() => {
    const map = new Map<string, string>(detail.roadmap.map((m) => [m.key, m.title]))
    for (const m of revision.milestones) map.set(m.key, m.title)
    return map
  }, [detail.roadmap, revision.milestones])
  const answer = (accept: boolean) => decide.mutate({ programId: detail.program.id, revisionId: revision.id, accept })
  return (
    <Card
      title={revision.trigger === 'initial' ? 'Plan awaiting your approval' : `Plan revision ${revision.version} awaiting your approval`}
      description={`${revisionTriggerText(revision.trigger)} · version ${revision.version}`}
      className="border-review/40 ring-1 ring-review/20"
      data-testid="program-plan-approval"
      actions={
        <>
          <Button size="sm" loading={decide.isPending && decide.variables?.accept === false} disabled={decide.isPending} onClick={() => answer(false)} data-testid="program-plan-reject">
            Reject
          </Button>
          <Button size="sm" variant="primary" loading={decide.isPending && decide.variables?.accept === true} disabled={decide.isPending} onClick={() => answer(true)} data-testid="program-plan-accept">
            Accept
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="m-0 mb-0.5 text-caption font-medium text-text-muted">Reason</h3>
          <p className="m-0" data-testid="program-plan-reason">
            {revision.reason}
          </p>
          {revision.strategyNote ? <p className="m-0 mt-1 text-small text-text-secondary">Approach: {revision.strategyNote}</p> : null}
        </div>
        <div>
          <h3 className="m-0 mb-1 text-caption font-medium text-text-muted">What changes in the remaining roadmap</h3>
          <PlanDiffList diff={revision.diff} titleOf={(k) => titles.get(k) ?? null} testId="program-plan-diff" />
        </div>
        <div>
          <h3 className="m-0 mb-1 text-caption font-medium text-text-muted">Proposed milestones ({revision.milestones.length})</h3>
          <ProposedMilestones milestones={revision.milestones} deferred={revision.deferred} />
        </div>
        {decide.isError ? <ErrorNote error={decide.error} /> : null}
        <p className="m-0 text-small text-text-muted">Accepting makes this the plan. Rejecting keeps the current plan; completed milestones are never changed.</p>
      </div>
    </Card>
  )
}

function ReplanDialog({ open, onClose, programId }: { open: boolean; onClose: () => void; programId: string }) {
  const replan = useReplanProgram()
  const [note, setNote] = useState('')
  const trimmed = note.trim()
  const reason = trimmed.length === 0 ? 'Say what should be reconsidered.' : trimmed.length > 2000 ? 'At most 2000 characters.' : null
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reassess plan"
      width={520}
      testId="program-replan-dialog"
      footer={
        <>
          <div className="mr-auto flex items-center" role="status">
            {reason ? <span className="text-small text-warning">{reason}</span> : null}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!!reason}
            loading={replan.isPending}
            onClick={() =>
              replan.mutate(
                { programId, note: trimmed },
                {
                  onSuccess: () => {
                    setNote('')
                    onClose()
                  },
                },
              )
            }
            data-testid="program-replan-submit"
          >
            Reassess plan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-text-secondary">
          A read-only session reviews the remaining milestones in light of your note. It keeps the plan or proposes a revision; your approval policy decides whether you approve it. A reassessment counts against the
          reassessment budget.
        </p>
        <Field label="Note" hint="Treated as information for the planner, not as a command.">
          {(id) => <Textarea id={id} rows={4} value={note} onChange={(e) => setNote(e.target.value)} data-testid="program-replan-note" />}
        </Field>
        {replan.isError ? <ErrorNote error={replan.error} /> : null}
      </div>
    </Dialog>
  )
}

export function ProgramPage({ programId, onBack }: { programId: string; onBack: () => void }) {
  const q = useProgram(programId)
  const start = useStartProgram()
  const pause = usePauseProgram()
  const resume = useResumeProgram()
  const cancel = useCancelProgram()
  const openRun = useUiStore((s) => s.openRun)
  const usage = useUsageIndicator()
  const [tab, setTab] = useState<Tab>('roadmap')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [replanOpen, setReplanOpen] = useState(false)
  const d = q.data
  const live = !!d && ['PLANNING', 'ACTIVE', 'REPLANNING'].includes(d.program.state)
  const now = useNow(!!d && (live || !!d.program.schedule), 30_000)

  const back = (
    <Button size="sm" variant="ghost" icon={<ChevronLeftIcon size={13} />} onClick={onBack} data-testid="program-back">
      All programs
    </Button>
  )

  if (!d) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="program-page">
        <PageHeader title="Program" context="Programs" actions={back} />
        <div className="min-h-0 flex-1 overflow-auto p-6" data-testid={q.isError ? 'program-error' : 'program-loading'}>
          {q.isPending ? <BlockSkeleton rows={5} /> : q.isError ? <ReadError error={q.error} calm="This program is not available yet." onRetry={() => void q.refetch()} /> : null}
        </div>
      </div>
    )
  }

  const p = d.program
  const actions = programActions(p.state)
  const proposed = d.revisions.find((r) => r.status === 'proposed') ?? null
  const windowText = windowTextAt(p, now)
  const reset = usage.overview ? exactResetAt(usage.overview) : null
  const notice = stateNotice(p, {
    quotaResetText: reset ? `at ${clockText(reset, now)}` : null,
    windowText,
    planProposed: !!proposed,
  })
  const milestone = currentMilestoneTitle(p, d.roadmap) ?? d.milestones.active
  const health = d.health
  const openBacklog = d.backlog.filter((b) => isOpenBacklog(b.status)).length
  const mutating = start.isPending || pause.isPending || resume.isPending
  const lastError = start.error ?? pause.error ?? resume.error ?? cancel.error

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="program-page" data-state={p.state}>
      <PageHeader
        title={p.name}
        context="Programs"
        actions={
          <>
            {back}
            <ProgramStateBadge program={p} testId="program-state" />
            {actions.start ? (
              <Button size="sm" variant="primary" icon={<PlayIcon size={12} />} loading={start.isPending} disabled={mutating} onClick={() => start.mutate({ programId })} data-testid="program-start">
                Start
              </Button>
            ) : null}
            {actions.pause ? (
              <Button size="sm" icon={<PauseIcon size={12} />} loading={pause.isPending} disabled={mutating} onClick={() => pause.mutate({ programId })} data-testid="program-pause">
                Pause
              </Button>
            ) : null}
            {actions.resume ? (
              <Button size="sm" variant="primary" icon={<PlayIcon size={12} />} loading={resume.isPending} disabled={mutating} onClick={() => resume.mutate({ programId })} data-testid="program-resume">
                Resume
              </Button>
            ) : null}
            {actions.replan ? (
              <Button size="sm" icon={<RefreshIcon size={12} />} onClick={() => setReplanOpen(true)} data-testid="program-replan">
                Reassess plan
              </Button>
            ) : null}
            {actions.cancel ? (
              <Button size="sm" variant="danger" onClick={() => setConfirmCancel(true)} data-testid="program-cancel">
                Cancel
              </Button>
            ) : null}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-6 py-5">
          <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-text-secondary" data-testid="program-health" data-level={health.level} role="status">
            <HealthBadge level={health.level} />
            <span>
              <span className="sr-only">{healthInfo(health.level).label}: </span>
              {health.reason}
            </span>
          </p>

          {notice ? (
            <Notice tone={notice.tone} title={notice.title} data-testid="program-state-notice">
              {notice.text}
            </Notice>
          ) : null}
          {p.error && p.state !== 'FAILED' ? <ErrorNote error={p.error} /> : null}
          {lastError ? <ErrorNote error={lastError} /> : null}

          {proposed && p.state !== 'COMPLETED' && p.state !== 'CANCELLED' && p.state !== 'FAILED' ? <PlanApproval detail={d} revision={proposed} /> : null}

          <Card data-testid="program-summary">
            <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              <Meta label="Goal" className="sm:col-span-2 lg:col-span-3">
                <span data-testid="program-goal-text" className="whitespace-pre-wrap">
                  {p.goal.statement}
                </span>
              </Meta>
              <Meta label="Progress">
                <span className="flex flex-col gap-1" data-testid="program-progress">
                  <span className="tnum font-medium">{progressText(d.milestones)}</span>
                  <ProgressBar value={d.milestones.completed} max={Math.max(1, d.milestones.total)} label="Milestones completed" tone={p.state === 'COMPLETED' ? 'success' : 'accent'} />
                </span>
              </Meta>
              <Meta label="Current milestone">
                <span data-testid="program-current-milestone">{milestone ?? 'None'}</span>
              </Meta>
              <Meta label="Current mission">
                <span className="flex flex-wrap items-center gap-2" data-testid="program-current-mission">
                  {p.currentRunKind === 'mission' && p.currentRunId ? (
                    <Button size="sm" onClick={() => openRun(p.currentRunId ?? '', p.projectId)} data-testid="program-open-mission">
                      Open mission
                    </Button>
                  ) : p.currentRunKind ? (
                    <span>{{ planner: 'Planning session', verifier: 'Verification session', replanner: 'Reassessment session', mission: 'Mission' }[p.currentRunKind]} running</span>
                  ) : (
                    <span className="text-text-muted">None running</span>
                  )}
                </span>
              </Meta>
              <Meta label="Claude usage">
                <span className="inline-flex items-center gap-2" data-testid="program-usage">
                  <IndicatorGlyph model={usage.model} />
                  <span>{usage.model.label}</span>
                </span>
              </Meta>
              <Meta label="Next work window">
                <span data-testid="program-window">{windowText ?? 'No work window'}</span>
              </Meta>
              <Meta label="Active time">
                <span className="tnum" data-testid="program-active-time">
                  {activeTimeText(p, now)} of {Math.round(p.policy.maxDurationMinutes / 60)} h
                </span>
              </Meta>
              <Meta label="Missions used">
                <span className="tnum" data-testid="program-missions-used">
                  {budgetText(p.missions, p.policy.maxTotalMissions)}
                </span>
              </Meta>
              <Meta label="Reassessments used">
                <span className="tnum" data-testid="program-replans-used">
                  {replanBudgetText(p)}
                </span>
              </Meta>
              <Meta label="Open backlog">
                <span className="tnum">{openBacklog}</span>
              </Meta>
              <Meta label="Accepted work is on branch" className="sm:col-span-2 lg:col-span-3">
                {p.branch ? (
                  <span className="flex flex-wrap items-center gap-2" data-testid="program-branch">
                    <BranchIcon size={12} className="text-text-muted" />
                    <code className="rounded-sm bg-surface-hover px-1.5 py-0.5 font-mono text-code" data-testid="program-branch-name">
                      {p.branch}
                    </code>
                    <CopyButton text={p.branch} />
                    <span className="text-small text-text-muted">Never checked out in your working tree. Merge it yourself to use the result.</span>
                  </span>
                ) : (
                  <span className="text-text-muted" data-testid="program-branch">
                    Created when the program starts.
                  </span>
                )}
              </Meta>
            </dl>
          </Card>

          <Tabs
            label="Program sections"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'roadmap', label: 'Roadmap', badge: <span className="tnum text-text-muted">{d.roadmap.length}</span>, testId: 'program-tab-roadmap' },
              { id: 'missions', label: 'Missions', badge: <span className="tnum text-text-muted">{d.missions.length}</span>, testId: 'program-tab-missions' },
              { id: 'revisions', label: 'Plan history', badge: <span className="tnum text-text-muted">{d.revisions.length}</span>, testId: 'program-tab-revisions' },
              { id: 'decisions', label: 'Decisions', badge: <span className="tnum text-text-muted">{d.decisions.length}</span>, testId: 'program-tab-decisions' },
              { id: 'backlog', label: 'Backlog', badge: <span className="tnum text-text-muted">{d.backlog.length}</span>, testId: 'program-tab-backlog' },
              { id: 'memory', label: 'Memory', badge: <span className="tnum text-text-muted">{d.memory.length}</span>, testId: 'program-tab-memory' },
              { id: 'expertise', label: 'Expertise', testId: 'program-tab-expertise' },
            ]}
          />
          {tab === 'roadmap' ? (
            <div data-testid="program-roadmap">
              <Roadmap roadmap={d.roadmap} currentMilestoneId={p.currentMilestoneId} />
            </div>
          ) : tab === 'missions' ? (
            <MissionsSection detail={d} />
          ) : tab === 'revisions' ? (
            <RevisionsSection detail={d} />
          ) : tab === 'decisions' ? (
            <DecisionsSection detail={d} />
          ) : tab === 'backlog' ? (
            <BacklogSection detail={d} />
          ) : tab === 'memory' ? (
            <MemorySection detail={d} />
          ) : (
            <ExpertiseSection projectId={p.projectId} />
          )}
        </div>
      </div>
      <ReplanDialog open={replanOpen} onClose={() => setReplanOpen(false)} programId={programId} />
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this program?"
        confirmLabel="Cancel program"
        danger
        loading={cancel.isPending}
        testId="program-cancel-dialog"
        onConfirm={() => cancel.mutate({ programId }, { onSuccess: () => setConfirmCancel(false) })}
      >
        The running mission stops and no further milestone is worked on. Completed milestones and the program branch are kept. A cancelled program cannot be resumed.
      </ConfirmDialog>
    </div>
  )
}
