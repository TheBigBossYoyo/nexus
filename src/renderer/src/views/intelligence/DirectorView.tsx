import { COMPILATION_MODE_LABEL, stateLabel } from '../../lib/intelligenceLabels'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AdviceLearning, DirectorInvocation, StrategicEscalation } from '@shared/intelligence'
import { api } from '../../lib/bridge'
import { useProjects } from '../../lib/queries'
import { useUiStore } from '../../store/ui'
import {
  Button,
  Card,
  DataTable,
  ErrorNote,
  Field,
  Notice,
  PageHeader,
  EmptyState,
  Loading,
  Select,
  Textarea,
} from '../../components/ui'

const levels = [
  { value: '0', label: 'None · no model call' },
  { value: '1', label: 'Technical Director · Claude' },
  { value: '2', label: 'Strategic Director · ChatGPT' },
  { value: '3', label: 'Council · strategic, challenge, synthesis' },
]
function Claims({ groups }: { groups: [string, string[]][] }) {
  return (
    <>
      {groups.map(([label, values]) =>
        values.length ? (
          <section key={label}>
            <h4 className="font-medium">{label}</h4>
            <ul className="list-disc space-y-1 pl-5">
              {values.map((value, i) => (
                <li key={i} className="whitespace-pre-wrap break-words">
                  {value}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </>
  )
}
function Material({ invocation: r }: { invocation: DirectorInvocation }) {
  const [routingOpen, setRoutingOpen] = useState(false)
  const routing = useQuery({
    queryKey: ['director-routing', r.projectId, r.id],
    queryFn: () => api.invoke('director.routing', { projectId: r.projectId, operationId: r.id }),
    enabled: routingOpen,
  })
  return (
    <Card
      title={r.objective}
      description={`${levels[r.level]?.label} · ${new Date(r.createdAt).toLocaleString()}`}
    >
      <div className="space-y-3 text-small">
        <details>
          <summary className="cursor-pointer">Original objective</summary>
          <p className="whitespace-pre-wrap break-words">{r.objective}</p>
        </details>
        <Notice
          tone={r.state === 'COMPLETED' ? 'neutral' : 'warning'}
          title={stateLabel(r.state)}
        >
          {r.message ??
            'The request was accepted and has no result on record. If NEXUS restarted meanwhile, whether the provider answered is not known: read what is saved below, then request advice again if you still need it.'}
        </Notice>
        {r.memo ? (
          <>
            <p className="whitespace-pre-wrap break-words font-medium">{r.memo.recommendation}</p>
            <p className="text-text-muted">
              Confidence: {r.memo.confidence}
              {r.provider
                ? ` · ${r.provider} · ${r.model ?? 'Unknown model'}`
                : ' · Provider and model are recorded per stage below'}
            </p>
            {(
              [
                ['Rationale', r.memo.rationale],
                ['Alternatives', r.memo.alternatives],
                ['Risks', r.memo.risks],
                ['Unknowns', r.memo.unknowns],
                ['Requested experiments', r.memo.requestedExperiments],
                ['Memo evidence', r.memo.evidenceRefs],
              ] as const
            ).map(([label, values]) =>
              values.length ? (
                <section key={label}>
                  <h3 className="font-medium">{label}</h3>
                  <ul className="list-disc space-y-1 pl-5">
                    {values.map((value, i) => (
                      <li key={i} className="whitespace-pre-wrap break-words">
                        {value}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
          </>
        ) : null}
        {r.challenge ? (
          <section>
            <h3 className="font-medium">Technical challenge of the memo</h3>
            <p className="text-small text-text-muted">Written by the other provider after reading the memo above: it challenges that proposal and is not an assessment formed without it.</p>
            <Claims
              groups={[
                ['Agreements', r.challenge.agreements],
                ['Disagreements', r.challenge.disagreements],
                ['Missing evidence', r.challenge.missingEvidence],
                ['Proposed changes', r.challenge.proposedChanges],
                ['Challenge evidence', r.challenge.evidenceRefs],
              ]}
            />
          </section>
        ) : null}
        {r.synthesis ? (
          <section>
            <h3 className="font-medium">Synthesis</h3>
            <p className="whitespace-pre-wrap break-words">{r.synthesis.decision}</p>
            <Claims
              groups={[
                ['Accepted claims', r.synthesis.acceptedClaims],
                ['Rejected claims', r.synthesis.rejectedClaims],
                ['Unresolved unknowns', r.synthesis.unresolvedUnknowns],
                ['Next actions', r.synthesis.nextActions],
                ['Synthesis evidence', r.synthesis.evidenceRefs],
              ]}
            />
          </section>
        ) : null}
        {r.unresolvedDisagreements.length ? (
          <Notice tone="warning" title="Disagreement retained">
            {r.unresolvedDisagreements.join('\n')}
          </Notice>
        ) : null}
        <details>
          <summary className="cursor-pointer">Context references and invocation details</summary>
          <p>{r.reasons.join(' · ')}</p>
          <p className="break-all">Invocation {r.id}</p>
          {r.dependencies.map((d) => (
            <p key={d.id} className="break-all font-mono">
              {d.id} · {d.version}
            </p>
          ))}
        </details>
        <details onToggle={(e) => setRoutingOpen(e.currentTarget.open)}>
          <summary className="cursor-pointer">Provider routing and outcome</summary>
          <p>
            Advice cannot authorize execution. Interrupted requests are never replayed
            automatically.
          </p>
          {r.decisionId ? <p className="break-all">Decision {r.decisionId}</p> : null}
          {r.outcomeId ? <p className="break-all">Outcome {r.outcomeId}</p> : null}
          {routing.error ? <ErrorNote error={routing.error} /> : null}
          {routing.isLoading ? <p role="status">Loading routing…</p> : null}
          {routing.data?.map((route) => (
            <div key={route.id} className="my-2 rounded border border-border p-3 break-words">
              <p className="font-medium">
                {route.stage} · {stateLabel(route.state)}
              </p>
              <p>
                {route.provider ?? 'No admitted provider'} · {route.model ?? 'No admitted model'}
              </p>
              <p>{route.reasons.join(' · ')}</p>
              <p>
                Usage:{' '}
                {route.usage
                  ? `${route.usage.inputTokens ?? 'unknown'} input · ${route.usage.outputTokens ?? 'unknown'} output tokens`
                  : route.consumption === 'NOT_SENT'
                    ? 'No model request sent'
                    : 'Not reported'}
              </p>
              <p className="text-text-muted">
                {route.qualityEvidence.join(' · ') || 'No quality-safe admission evidence'}
              </p>
            </div>
          ))}
          {routing.data?.length === 0 ? (
            <p>Historical request has no per-stage routing records.</p>
          ) : null}
        </details>
      </div>
    </Card>
  )
}

export function DirectorView() {
  const projects = useProjects()
  const projectId = useUiStore((s) => s.projectId)
  const selectProject = useUiStore((s) => s.selectProject)
  const [objective, setObjective] = useState('')
  const [level, setLevel] = useState('2')
  const [offset, setOffset] = useState(0)
  const client = useQueryClient()
  const history = useQuery({
    queryKey: ['director-history', projectId, offset],
    queryFn: () => api.invoke('director.history', { projectId: projectId!, offset }),
    enabled: !!projectId,
    refetchInterval: 5000,
  })
  const learning = useQuery({
    queryKey: ['director-learning', projectId],
    queryFn: () => api.invoke('director.learning', { projectId: projectId! }),
    enabled: !!projectId,
    refetchInterval: 15000,
  })
  const records = useQuery({
    queryKey: ['director-records', projectId, offset],
    queryFn: () => api.invoke('director.records', { projectId: projectId!, offset }),
    enabled: !!projectId,
    refetchInterval: 5000,
  })
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['director-history'] }),
      client.invalidateQueries({ queryKey: ['director-records'] }),
      client.invalidateQueries({ queryKey: ['director-routing'] }),
    ])
  const invoke = useMutation({
    mutationFn: (input: {
      projectId: string
      objective: string
      level: DirectorInvocation['level']
      escalationId?: string
    }) => api.invoke('director.invoke', input),
    onSettled: refresh,
  })
  const escalate = useMutation({
    mutationFn: () =>
      api.invoke('director.escalate', {
        projectId: projectId!,
        objective,
        level: Number(level) as StrategicEscalation['level'],
        reasons: ['USER_REQUESTED_ESCALATION'],
      }),
    onSettled: refresh,
  })
  const dismiss = useMutation({
    mutationFn: (escalationId: string) =>
      api.invoke('director.dismissEscalation', { projectId: projectId!, escalationId }),
    onSettled: refresh,
  })
  const pending = invoke.isPending || escalate.isPending || dismiss.isPending
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="director-page">
      <PageHeader title="Director" context="Intelligence" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1120px] space-y-5 p-6">
          <Notice tone="neutral" title="Develop direction before execution">
            Directors propose strategy and challenge assumptions. Their advice cannot authorize work
            or override project policy. The Technical Director is Claude; the Strategic Director and
            the Council need the ChatGPT connection (Providers). A request waits, and spends nothing,
            while a provider it needs is not available.
          </Notice>
          <Card
            title="Request advice"
            description="Choose the project whose current context may be used. Original objectives are saved unchanged."
          >
            <div className="space-y-4">
              <Field label="Project">
                {(id) => (
                  <Select
                    id={id}
                    value={projectId ?? ''}
                    options={[
                      { value: '', label: 'Select a project', disabled: true },
                      ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    onChange={(id) => {
                      selectProject(id)
                      setOffset(0)
                    }}
                    disabled={pending}
                  />
                )}
              </Field>
              <Field label="Objective">
                {(id) => (
                  <Textarea
                    id={id}
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    rows={5}
                    maxLength={32000}
                    placeholder="What decision needs a clearer direction?"
                    disabled={pending}
                  />
                )}
              </Field>
              <Field label="Director level">
                {(id) => (
                  <Select
                    id={id}
                    value={level}
                    options={levels}
                    onChange={setLevel}
                    disabled={pending}
                  />
                )}
              </Field>
              <Button
                variant="primary"
                busy={pending}
                disabled={!projectId || !objective.trim()}
                loading={invoke.isPending}
                onClick={() => {
                  setOffset(0)
                  invoke.mutate({
                    projectId: projectId!,
                    objective,
                    level: Number(level) as DirectorInvocation['level'],
                  })
                }}
              >
                Request advice
              </Button>
              <Button
                busy={pending}
                disabled={!projectId || !objective.trim() || level === '0'}
                loading={escalate.isPending}
                onClick={() => escalate.mutate()}
              >
                Save escalation
              </Button>
              {!projectId || !objective.trim() ? (
                <p className="text-text-secondary">Choose a project and write the objective to continue.</p>
              ) : null}
              <p className="text-text-muted">
                Request advice sends the objective and matching project knowledge to the provider of the level you
                chose (Claude for the Technical Director; ChatGPT, and Claude for a Council, otherwise). The
                Providers page lists what is sent. Nothing starts work.
              </p>
              <p className="text-text-muted">
                Saving an escalation sends no model request. Review it below before requesting
                advice.
              </p>
              {/* Always in the page, so that what appears in it is announced. */}
              <p role="status">{invoke.isPending ? 'Developing advisory material…' : ''}</p>
              {invoke.error ? <ErrorNote error={invoke.error} /> : null}
              {escalate.error ? <ErrorNote error={escalate.error} /> : null}
            </div>
          </Card>
          <Card
            title="Strategic escalations and decisions"
            description="Saved requests and advisory outcomes for this project."
          >
            {records.error ? <ErrorNote error={records.error} /> : null}
            {dismiss.error ? <ErrorNote error={dismiss.error} /> : null}
            {records.isLoading ? (
              <Loading />
            ) : !records.data?.length ? (
              <EmptyState title="No escalations or decisions saved">An escalation you save, and the decision of a Council, appear here.</EmptyState>
            ) : (
              records.data.map((record) => (
                <details
                  key={record.id}
                  className="my-2 rounded border border-border p-3 text-small break-words"
                >
                  <summary className="cursor-pointer font-medium">
                    {record.kind === 'ESCALATION'
                      ? `Escalation · ${stateLabel(record.state)}`
                      : record.kind === 'DECISION'
                        ? 'Advisory decision'
                        : `Outcome · ${stateLabel(record.state)}`}
                  </summary>
                  {record.kind === 'ESCALATION' ? (
                    <div className="space-y-2">
                      <p className="whitespace-pre-wrap">{record.objective}</p>
                      <p>{record.reasons.join(' · ')}</p>
                      {record.state === 'REQUESTED' ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            busy={pending}
                            onClick={() =>
                              invoke.mutate({
                                projectId: record.projectId,
                                objective: record.objective,
                                level: record.level,
                                escalationId: record.id,
                              })
                            }
                          >
                            Request escalation advice
                          </Button>
                          <Button busy={pending} onClick={() => dismiss.mutate(record.id)}>
                            Dismiss
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : record.kind === 'DECISION' ? (
                    <>
                      <p className="whitespace-pre-wrap">{record.recommendation}</p>
                      <Claims
                        groups={[
                          ['Unresolved disagreement', record.unresolvedDisagreements],
                          ['Evidence', record.evidenceRefs],
                        ]}
                      />
                    </>
                  ) : (
                    <p>
                      Completed stages: {record.completedStages.join(' · ') || 'None'} ·
                      Consumption: {record.consumption.replaceAll('_', ' ').toLowerCase()} · No
                      automatic replay
                    </p>
                  )}
                  <p className="text-text-muted">
                    Advisory only. Execution requires the normal task and policy gates.
                  </p>
                </details>
              ))
            )}
          </Card>
          <Card
            title="What became of advised work"
            description="For each kind of advice a mission of this project was admitted with: how those missions ended. Counts of what NEXUS observed, written when a mission ends; they are also given to the Director as evidence for its next request."
            data-testid="director-learning"
          >
            {learning.error ? <ErrorNote error={learning.error} /> : null}
            {learning.isLoading ? (
              <Loading />
            ) : !learning.data?.total ? (
              <EmptyState title={projectId ? 'Nothing on record yet' : 'Select a project'}>
                A line appears here when a mission that was admitted with a specification, or asked about in an
                escalation, has ended.
              </EmptyState>
            ) : (
              <DataTable<AdviceLearning['groups'][number]>
                caption="How missions ended, by the advice they were admitted with"
                rows={learning.data.groups}
                rowKey={(g) => g.label}
                columns={[
                  { key: 'advice', header: 'Advice', render: (g) => (g.sourceKind === 'SPECIFICATION' && g.depth ? `Specification · ${COMPILATION_MODE_LABEL[g.depth]}` : g.label) },
                  { key: 'runs', header: 'Missions', numeric: true, render: (g) => g.runs },
                  { key: 'verified', header: 'Verified', numeric: true, render: (g) => g.verified },
                  { key: 'failed', header: 'Failed', numeric: true, render: (g) => g.failed },
                  { key: 'cancelled', header: 'Cancelled', numeric: true, render: (g) => g.cancelled },
                  { key: 'repairs', header: 'Repair attempts', numeric: true, render: (g) => g.repairs },
                  { key: 'tasksFailed', header: 'Failed tasks', numeric: true, render: (g) => g.tasksFailed },
                ]}
              />
            )}
          </Card>
          <h2 className="text-heading font-semibold">Saved advice</h2>
          {history.error ? <ErrorNote error={history.error} /> : null}
          {history.isLoading ? (
            <Loading />
          ) : !history.data?.length ? (
            <EmptyState title={projectId ? 'No advice saved for this project yet' : 'Select a project to see its advice'}>
              Every request for advice is saved with its answer, its provider and what it used.
            </EmptyState>
          ) : (
            history.data.map((r) => <Material key={r.id} invocation={r} />)
          )}
          <div className="flex gap-2">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
              Newer
            </Button>
            <Button
              disabled={history.data?.length !== 50 && records.data?.length !== 50}
              onClick={() => setOffset(offset + 50)}
            >
              Older
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
