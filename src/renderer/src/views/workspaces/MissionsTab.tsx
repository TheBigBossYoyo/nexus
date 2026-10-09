import { useState } from 'react'
import type { CompilationMode, CompiledTaskSpec, CompilationSelection } from '@shared/intelligence'
import { CompilationPreview } from '../projects/CompilationPreview'
import { AdmissionInspector } from '../projects/CompiledTaskInspector'
import type {
  CrossRepoTask,
  WorkspaceDetail,
  WorkspaceMission,
  WorkspacePlan,
} from '@shared/workspace'
import {
  useCancelWorkspaceMission,
  useCreateWorkspaceMission,
  useDecideWorkspacePlan,
  usePauseWorkspaceMission,
  usePrepareRelease,
  useResumeWorkspaceMission,
  useStartWorkspaceMission,
  useWorkspaceMission,
} from '../../lib/queries-v5'
import { useUiStore } from '../../store/ui'
import {
  ArrowRightIcon,
  Badge,
  Button,
  Card,
  ChevronLeftIcon,
  ConfirmDialog,
  Dialog,
  ErrorNote,
  Field,
  Notice,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  StatusBadge,
  Textarea,
  TimeAgo,
} from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import { Empty } from '../programs/programsUi'
import { LIMITS, validateGoal } from './workspaceForm'
import {
  goalPreview,
  inSyncLabel,
  missionActions,
  missionNotice,
  shortCommit,
  sortMissions,
  taskStateInfo,
  acceptConsequence,
} from './workspacesModel'
import { CompatibilityPanel } from './ContractsTab'
import { H3, MissionStateBadge, Mono, PassBadge } from './workspacesUi'

function NewMissionDialog({
  open,
  onClose,
  workspaceId,
  projectId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  workspaceId: string
  projectId: string | undefined
  onCreated: (missionId: string) => void
}) {
  const create = useCreateWorkspaceMission()
  const [goal, setGoal] = useState('')
  const [touched, setTouched] = useState(false)
  const [compilationMode, setCompilationMode] = useState<CompilationMode>('AUTO')
  const [spec, setSpec] = useState<CompiledTaskSpec | null>(null)
  const check = validateGoal(goal)
  const submit = (start: boolean) => {
    if (!check.ok) {
      setTouched(true)
      return
    }
    create.mutate(
      { workspaceId, goal, start, compilationMode, ...(spec ? { compiledSpecId: spec.id } : {}) },
      {
        onSuccess: (m) => {
          setGoal('')
          setTouched(false)
          setSpec(null)
          onClose()
          onCreated(m.id)
        },
      },
    )
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New workspace mission"
      width={600}
      testId="workspace-mission-dialog"
      footer={
        <>
          <div className="mr-auto flex min-w-0 items-center" role="status">
            {touched && check.reason ? (
              <span className="text-small text-warning">{check.reason}</span>
            ) : null}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            disabled={!check.ok}
            loading={create.isPending && create.variables?.start === false}
            onClick={() => submit(false)}
            data-testid="workspace-mission-create"
          >
            Create
          </Button>
          <Button
            variant="primary"
            disabled={!check.ok}
            loading={create.isPending && create.variables?.start === true}
            onClick={() => submit(true)}
            data-testid="workspace-mission-start"
          >
            Create and start
          </Button>
        </>
      }
    >
      <fieldset
        disabled={create.isPending}
        className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
      >
        <p className="m-0 text-small text-text-secondary">
          Describe one goal. NEXUS plans which repositories change and in what order, then waits for
          your approval before anything runs. Only repositories allowed by the workspace policy can
          be changed.
        </p>
        <Field
          label="Goal"
          hint="What should be true when it is done, across the repositories."
          error={touched ? (check.reason ?? undefined) : undefined}
        >
          {(id) => (
            <Textarea
              id={id}
              rows={6}
              value={goal}
              maxLength={LIMITS.goal + 100}
              onChange={(e) => {
                setSpec(null)
                setGoal(e.target.value)
              }}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && !check.ok}
              data-testid="workspace-mission-goal"
            />
          )}
        </Field>
        {create.isError ? <ErrorNote error={create.error} /> : null}
        {projectId ? (
          <CompilationPreview
            projectId={projectId}
            workspaceId={workspaceId}
            raw={goal}
            mode={compilationMode}
            onModeChange={(mode) => {
              setCompilationMode(mode)
              setSpec(null)
            }}
            spec={spec}
            onSpec={setSpec}
            metadata={{
              entryPoint: 'WORKSPACE_MISSION',
              goals: [goal],
              constraints: [],
              acceptanceCriteria: [],
            }}
          />
        ) : null}
      </fieldset>
    </Dialog>
  )
}

function PlanTasks({ plan }: { plan: WorkspacePlan }) {
  return (
    <ol
      className="m-0 flex list-none flex-col gap-2 p-0"
      aria-label="Planned tasks in order"
      data-testid="mission-plan-tasks"
    >
      {plan.tasks.map((t, i) => (
        <li
          key={t.key}
          className="rounded-md border bg-surface px-3 py-2"
          data-testid={`plan-task-${t.key}`}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum text-small text-text-muted">{i + 1}.</span>
            <span className="font-medium">{t.title}</span>
            <Badge tone="neutral" mono>
              {t.repository}
            </Badge>
          </div>
          <p className="m-0 mt-1 text-text-secondary">{t.objective}</p>
          <ul className="m-0 mt-1 list-disc pl-5 text-small text-text-secondary">
            {t.acceptanceCriteria.map((c, j) => (
              <li key={j}>{c}</li>
            ))}
          </ul>
          <p className="m-0 mt-1 text-small text-text-muted">
            Depends on: {t.dependsOn.length > 0 ? <Mono>{t.dependsOn.join(', ')}</Mono> : 'nothing'}{' '}
            · Contracts: {t.contracts.length > 0 ? <Mono>{t.contracts.join(', ')}</Mono> : 'none'}
          </p>
        </li>
      ))}
    </ol>
  )
}

function PlanApproval({ mission, plan }: { mission: WorkspaceMission; plan: WorkspacePlan }) {
  const decide = useDecideWorkspacePlan()
  const answer = (accept: boolean) => decide.mutate({ missionId: mission.id, accept })
  return (
    <Card
      title="Plan awaiting your approval"
      className="border-tone-review/40 ring-1 ring-tone-review/20"
      data-testid="mission-plan-approval"
      actions={
        <>
          <Button
            size="sm"
            loading={decide.isPending && decide.variables?.accept === false}
            disabled={decide.isPending}
            onClick={() => answer(false)}
            data-testid="mission-plan-reject"
          >
            Reject
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={decide.isPending && decide.variables?.accept === true}
            disabled={decide.isPending}
            onClick={() => answer(true)}
            data-testid="mission-plan-accept"
          >
            Accept
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-small text-text-secondary" data-testid="mission-plan-consequence">
          {acceptConsequence(plan.tasks)}
        </p>
        <div>
          <H3>Summary</H3>
          <p className="m-0 mt-0.5" data-testid="mission-plan-summary">
            {plan.summary}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <H3>Tasks in order ({plan.tasks.length})</H3>
          <PlanTasks plan={plan} />
        </div>
        {plan.risks.length > 0 ? (
          <div>
            <H3>Risks</H3>
            <ul className="m-0 mt-0.5 list-disc pl-5 text-small text-text-secondary">
              {plan.risks.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {decide.isError ? <ErrorNote error={decide.error} /> : null}
      </div>
    </Card>
  )
}

function TaskList({ tasks }: { tasks: readonly CrossRepoTask[] }) {
  const openRun = useUiStore((s) => s.openRun)
  const ordered = [...tasks].sort((a, b) => a.ordinal - b.ordinal)
  if (ordered.length === 0)
    return (
      <Empty testId="mission-tasks-empty">No tasks yet. They appear when a plan is accepted.</Empty>
    )
  return (
    <ol
      className="m-0 flex list-none flex-col gap-2 p-0"
      aria-label="Cross-repository tasks in order"
      data-testid="mission-tasks"
    >
      {ordered.map((t) => (
        <li
          key={t.id}
          className="rounded-md border bg-surface px-3 py-2"
          data-testid={`mission-task-${t.key}`}
          data-state={t.state}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum text-small text-text-muted">{t.ordinal + 1}.</span>
            <span className="font-medium">{t.title}</span>
            <Badge tone="neutral" mono>
              {t.repository}
            </Badge>
            <StatusBadge status={taskStateInfo(t.state)} pulse={t.state === 'RUNNING'} />
            {t.runId ? (
              <Button
                size="sm"
                className="ml-auto"
                icon={<ArrowRightIcon size={12} />}
                onClick={() => openRun(t.runId ?? '')}
                aria-label={`Open mission for task ${t.title}`}
                data-testid={`mission-task-open-${t.key}`}
              >
                Open mission
              </Button>
            ) : null}
          </div>
          <dl className="m-0 mt-1.5 grid grid-cols-1 gap-x-6 gap-y-0.5 text-small sm:grid-cols-2">
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Depends on</dt>
              <dd className="m-0">
                {t.dependsOn.length > 0 ? <Mono>{t.dependsOn.join(', ')}</Mono> : 'nothing'}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Contracts</dt>
              <dd className="m-0">
                {t.contracts.length > 0 ? <Mono>{t.contracts.join(', ')}</Mono> : 'none'}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Result branch</dt>
              <dd className="m-0 break-all" data-testid={`mission-task-branch-${t.key}`}>
                {t.resultBranch ? (
                  <Mono>{t.resultBranch}</Mono>
                ) : (
                  <span className="text-text-muted">None yet</span>
                )}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Commit</dt>
              <dd className="m-0" data-testid={`mission-task-commit-${t.key}`}>
                {t.resultCommit ? (
                  <Mono>{shortCommit(t.resultCommit)}</Mono>
                ) : (
                  <span className="text-text-muted">None yet</span>
                )}
              </dd>
            </div>
          </dl>
          {t.summary ? (
            <p className="m-0 mt-1 text-small text-text-secondary">{t.summary}</p>
          ) : null}
          {t.error ? <p className="m-0 mt-1 text-small text-danger">{t.error}</p> : null}
        </li>
      ))}
    </ol>
  )
}

function Verification({ mission }: { mission: WorkspaceMission }) {
  const v = mission.verification
  if (!v) {
    return (
      <p className="m-0 text-small text-text-muted" data-testid="mission-verification-empty">
        The cross-repository verification runs after every task has finished.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3" data-testid="mission-verification" data-passed={v.passed}>
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="mission-verification-overall">
          <PassBadge
            passed={v.passed}
            passedLabel="Verification passed"
            failedLabel="Verification failed"
          />
        </span>
        <span className="text-small text-text-muted">
          <TimeAgo iso={v.createdAt} />
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Verification checks">
        {v.checks.map((c, i) => (
          <li
            key={`${c.name}-${c.repository ?? ''}-${i}`}
            className="flex flex-wrap items-start gap-x-2 gap-y-0.5 rounded-md border bg-surface px-3 py-1.5"
            data-testid={`mission-check-${i}`}
            data-passed={c.passed}
          >
            <PassBadge passed={c.passed} />
            <span className="font-medium">{c.name}</span>
            <span className="text-small text-text-secondary">
              {c.repository ? <Mono>{c.repository}</Mono> : 'Whole workspace'}
            </span>
            <span className="w-full text-small text-text-secondary">{c.detail}</span>
          </li>
        ))}
      </ul>
      {v.contracts.map((c) => (
        <section
          key={c.contract}
          className="flex flex-col gap-1.5"
          aria-label={`Contract ${c.contract}`}
          data-testid={`mission-contract-${c.contract}`}
        >
          <H3>
            Contract {c.contract} · {c.fromVersion === null ? 'new' : `version ${c.fromVersion}`} →
            version {c.toVersion}
          </H3>
          <CompatibilityPanel result={c.result} testId={`mission-contract-result-${c.contract}`} />
          <ul
            className="m-0 flex list-none flex-col gap-1 p-0"
            aria-label={`Consumers of ${c.contract}`}
          >
            {c.consumersInSync.map((s) => (
              <li
                key={s.repository}
                className="flex flex-wrap items-center gap-2 text-small"
                data-testid={`mission-consumer-${c.contract}-${s.repository}`}
                data-in-sync={s.inSync}
              >
                <PassBadge
                  passed={s.inSync}
                  passedLabel={inSyncLabel(true)}
                  failedLabel={inSyncLabel(false)}
                />
                <span className="font-mono font-medium">{s.repository}</span>
                <span className="text-text-secondary">{s.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export function MissionDetail({
  missionId,
  projectId,
  onBack,
  onOpenReleases,
}: {
  missionId: string
  projectId?: string
  onBack: () => void
  onOpenReleases: () => void
}) {
  const q = useWorkspaceMission(missionId)
  const start = useStartWorkspaceMission()
  const pause = usePauseWorkspaceMission()
  const resume = useResumeWorkspaceMission()
  const cancel = useCancelWorkspaceMission()
  const prepare = usePrepareRelease()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [selection, setSelection] = useState<CompilationSelection>({})
  const back = (
    <Button
      size="sm"
      variant="ghost"
      icon={<ChevronLeftIcon size={13} />}
      onClick={onBack}
      data-testid="mission-back"
    >
      All missions
    </Button>
  )
  if (!q.data) {
    return (
      <div className="flex flex-col gap-3" data-testid="mission-detail-loading">
        <div>{back}</div>
        <div data-testid={q.isError ? 'mission-detail-error' : 'mission-detail-loading-body'}>
          {q.isPending ? (
            <BlockSkeleton rows={4} />
          ) : q.isError ? (
            <ReadError
              error={q.error}
              calm="This mission is not available yet."
              onRetry={() => void q.refetch()}
            />
          ) : null}
        </div>
      </div>
    )
  }
  const { mission, tasks } = q.data
  const actions = missionActions(mission.state)
  const notice = missionNotice(mission)
  const busy = start.isPending || pause.isPending || resume.isPending || cancel.isPending
  const lastError = start.error ?? pause.error ?? resume.error ?? cancel.error ?? prepare.error
  return (
    <div className="flex flex-col gap-4" data-testid="mission-detail" data-state={mission.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap items-center gap-2">
          <MissionStateBadge state={mission.state} testId="mission-state" />
          {actions.start ? (
            <Button
              size="sm"
              variant="primary"
              icon={<PlayIcon size={12} />}
              loading={start.isPending}
              disabled={busy}
              onClick={() => start.mutate({ missionId, ...selection })}
              data-testid="mission-start"
            >
              Start
            </Button>
          ) : null}
          {actions.pause ? (
            <Button
              size="sm"
              icon={<PauseIcon size={12} />}
              loading={pause.isPending}
              disabled={busy}
              onClick={() => pause.mutate({ missionId })}
              data-testid="mission-pause"
            >
              Pause
            </Button>
          ) : null}
          {actions.resume ? (
            <Button
              size="sm"
              variant="primary"
              icon={<PlayIcon size={12} />}
              loading={resume.isPending}
              disabled={busy}
              onClick={() => resume.mutate({ missionId, ...selection })}
              data-testid="mission-resume"
            >
              Resume
            </Button>
          ) : null}
          {actions.prepareRelease ? (
            <Button
              size="sm"
              loading={prepare.isPending}
              onClick={() => prepare.mutate({ missionId }, { onSuccess: onOpenReleases })}
              data-testid="mission-prepare-release"
            >
              Prepare release train
            </Button>
          ) : null}
          {actions.cancel ? (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => setConfirmCancel(true)}
              data-testid="mission-cancel"
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      <Card title="Goal" data-testid="mission-goal-card">
        <p className="m-0 whitespace-pre-wrap" data-testid="mission-goal">
          {mission.goal}
        </p>
      </Card>

      {projectId ? (
        <AdmissionInspector
          kind={mission.programId ? 'WORKSPACE_PROGRAM' : 'WORKSPACE_MISSION'}
          entityId={mission.programId ?? mission.id}
          projectId={projectId}
          raw={mission.goal}
          workspaceId={mission.workspaceId}
          metadata={{
            entryPoint: 'WORKSPACE_MISSION',
            goals: [mission.goal],
            constraints: [],
            acceptanceCriteria: [],
          }}
          draft={['DRAFT', 'PAUSED', 'BLOCKED'].includes(mission.state) && !mission.programId}
          {...(mission.state !== 'DRAFT' ? { executionScope: { workspaceMissionId: mission.id } } : {})}
          onSelection={setSelection}
        />
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} data-testid="mission-state-notice">
          {notice.text}
        </Notice>
      ) : null}
      {mission.error && mission.state !== 'FAILED' ? <ErrorNote error={mission.error} /> : null}
      {lastError ? <ErrorNote error={lastError} /> : null}

      {actions.decidePlan && mission.plan ? (
        <PlanApproval mission={mission} plan={mission.plan} />
      ) : null}

      {mission.plan && !actions.decidePlan ? (
        <Card title="Plan" data-testid="mission-plan">
          <p className="m-0 text-text-secondary">{mission.plan.summary}</p>
        </Card>
      ) : null}

      <section className="flex flex-col gap-2" aria-label="Tasks">
        <h3 className="m-0 text-heading font-semibold">Tasks</h3>
        <TaskList tasks={tasks} />
      </section>

      <section className="flex flex-col gap-2" aria-label="Verification">
        <h3 className="m-0 text-heading font-semibold">Verification across repositories</h3>
        <Verification mission={mission} />
      </section>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this mission?"
        confirmLabel="Cancel mission"
        danger
        loading={cancel.isPending}
        testId="mission-cancel-dialog"
        onConfirm={() => cancel.mutate({ missionId }, { onSuccess: () => setConfirmCancel(false) })}
      >
        Running tasks stop and no further task starts. Completed tasks and their result branches are
        kept. A cancelled mission cannot be resumed.
      </ConfirmDialog>
    </div>
  )
}

export function MissionsTab({
  detail,
  onOpenReleases,
}: {
  detail: WorkspaceDetail
  onOpenReleases: () => void
}) {
  const [missionId, setMissionId] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)
  const missions = sortMissions(detail.missions)
  if (missionId)
    return (
      <MissionDetail
        missionId={missionId}
        projectId={[...detail.repositories].sort((a, b) => a.id.localeCompare(b.id))[0]?.projectId}
        onBack={() => setMissionId(null)}
        onOpenReleases={onOpenReleases}
      />
    )
  return (
    <div className="flex flex-col gap-3" data-testid="workspace-missions">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 max-w-prose text-small text-text-secondary">
          A workspace mission changes several repositories for one goal, in dependency order, and
          verifies them together.
        </p>
        <Button
          size="sm"
          variant="primary"
          icon={<PlusIcon size={12} />}
          onClick={() => setDialog(true)}
          data-testid="workspace-mission-new"
        >
          New mission
        </Button>
      </div>
      {detail.workspace.policy.allowedRepositories.length === 0 ? (
        <Notice
          tone="warning"
          title="No repository is allowed"
          data-testid="workspace-missions-blocked"
        >
          Missions may only change allowed repositories, and none is allowed yet, so nothing would
          run. Allow repositories on the Overview or Policy tab.
        </Notice>
      ) : null}
      {missions.length === 0 ? (
        <Empty testId="workspace-missions-empty">
          No missions yet. Start one with New mission.
        </Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Missions">
          {missions.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setMissionId(m.id)}
                aria-label={`Open mission: ${goalPreview(m.goal, 80)}`}
                data-testid={`workspace-mission-${m.id}`}
                data-state={m.state}
                className="flex w-full items-start gap-3 rounded-lg border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-muted"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate font-medium">{goalPreview(m.goal)}</span>
                    <MissionStateBadge state={m.state} />
                  </div>
                  <p className="m-0 mt-0.5 text-small text-text-muted">
                    Created <TimeAgo iso={m.createdAt} />
                    {m.plan ? ` · ${m.plan.tasks.length} planned task(s)` : ''}
                  </p>
                </div>
                <ArrowRightIcon size={14} className="mt-1 shrink-0 text-text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <NewMissionDialog
        open={dialog}
        onClose={() => setDialog(false)}
        workspaceId={detail.workspace.id}
        projectId={[...detail.repositories].sort((a, b) => a.id.localeCompare(b.id))[0]?.projectId}
        onCreated={setMissionId}
      />
    </div>
  )
}
