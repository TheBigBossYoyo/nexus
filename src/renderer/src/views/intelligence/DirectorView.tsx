import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DirectorInvocation } from '@shared/intelligence'
import { api } from '../../lib/bridge'
import { useProjects } from '../../lib/queries'
import { useUiStore } from '../../store/ui'
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Notice,
  PageHeader,
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
          title={r.state.replaceAll('_', ' ')}
        >
          {r.message ??
            'Request was admitted. If the runtime restarted, its outcome is unknown; review before retrying.'}
        </Notice>
        {r.memo ? (
          <>
            <p className="whitespace-pre-wrap break-words font-medium">{r.memo.recommendation}</p>
            <p className="text-text-muted">
              Confidence: {r.memo.confidence} · {r.provider ?? 'Unknown provider'} ·{' '}
              {r.model ?? 'Unknown model'}
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
            <h3 className="font-medium">Independent technical challenge</h3>
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
  const invoke = useMutation({
    mutationFn: (input: {
      projectId: string
      objective: string
      level: DirectorInvocation['level']
    }) => api.invoke('director.invoke', input),
    onSettled: () => client.invalidateQueries({ queryKey: ['director-history'] }),
  })
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="director-page">
      <PageHeader title="Director" context="Intelligence" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1120px] space-y-5 p-6">
          <Notice tone="neutral" title="Develop direction before execution">
            Directors propose strategy and challenge assumptions. Their advice cannot authorize work
            or override project policy. The technical Director adapter and council validation are
            deferred in this development build, independently of Claude worker availability.
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
                    disabled={invoke.isPending}
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
                    disabled={invoke.isPending}
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
                    disabled={invoke.isPending}
                  />
                )}
              </Field>
              <Button
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
              {invoke.isPending ? <p role="status">Developing advisory material…</p> : null}
              {invoke.error ? <ErrorNote error={invoke.error} /> : null}
            </div>
          </Card>
          <h2 className="text-lg font-semibold">Saved advisory history</h2>
          {history.error ? <ErrorNote error={history.error} /> : null}
          {history.isLoading ? (
            <p role="status">Loading history…</p>
          ) : !history.data?.length ? (
            <p className="text-text-muted">
              {projectId
                ? 'No advice saved for this project yet.'
                : 'Select a project to see its advice.'}
            </p>
          ) : (
            history.data.map((r) => <Material key={r.id} invocation={r} />)
          )}
          <div className="flex gap-2">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
              Newer
            </Button>
            <Button disabled={history.data?.length !== 50} onClick={() => setOffset(offset + 50)}>
              Older
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
