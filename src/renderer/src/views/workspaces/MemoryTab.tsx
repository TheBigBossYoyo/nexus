import { useState } from 'react'
import {
  WORKSPACE_MEMORY_KINDS,
  type WorkspaceDetail,
  type WorkspaceMemoryKind,
} from '@shared/workspace'
import { useAddWorkspaceMemory } from '../../lib/queries-v5'
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  PlusIcon,
  Select,
  Textarea,
  TimeAgo,
} from '../../components/ui'
import { Check } from '../projects/OvernightPanel'
import { Empty } from '../programs/programsUi'
import {
  buildMemoryInput,
  emptyMemoryForm,
  MEMORY_REPOSITORIES_HINT,
  validateMemoryForm,
  type MemoryField,
  type MemoryForm,
} from './workspaceForm'
import { decisionKindLabel, MEMORY_KIND_LABEL, sortDecisions } from './workspacesModel'
import { H3, Mono } from './workspacesUi'

const KIND_OPTIONS = WORKSPACE_MEMORY_KINDS.map((k) => ({ value: k, label: MEMORY_KIND_LABEL[k] }))
const SOURCE_LABEL = {
  verification: 'From a verification',
  user: 'Added by you',
  engine: 'Recorded by NEXUS',
} as const

function AddMemory({ detail }: { detail: WorkspaceDetail }) {
  const add = useAddWorkspaceMemory()
  const [form, setForm] = useState<MemoryForm>(emptyMemoryForm)
  const [touched, setTouched] = useState<ReadonlySet<MemoryField>>(new Set())
  const check = validateMemoryForm(form)
  const err = (f: MemoryField) => (touched.has(f) ? check.errors[f] : undefined)
  const touch = (f: MemoryField) => setTouched((t) => new Set(t).add(f))
  const patch = (p: Partial<MemoryForm>) => setForm((f) => ({ ...f, ...p }))
  return (
    <Card
      title="Add a workspace memory"
      description="Cross-repository knowledge only."
      data-testid="memory-add"
    >
      {detail.repositories.length < 2 ? (
        <p className="m-0 text-small text-text-muted">
          Enroll at least two repositories first: workspace memory is about how repositories fit
          together.
        </p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!check.ok) {
              setTouched(new Set<MemoryField>(['title', 'content', 'evidence', 'repositories']))
              return
            }
            add.mutate(buildMemoryInput(detail.workspace.id, form), {
              onSuccess: () => {
                setForm(emptyMemoryForm())
                setTouched(new Set())
              },
            })
          }}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
            <Field label="Kind">
              {(id) => (
                <Select
                  id={id}
                  value={form.kind}
                  options={KIND_OPTIONS}
                  onChange={(kind: WorkspaceMemoryKind) => patch({ kind })}
                  data-testid="memory-kind"
                />
              )}
            </Field>
            <Field label="Title" error={err('title')}>
              {(id) => (
                <Input
                  id={id}
                  value={form.title}
                  onChange={(e) => patch({ title: e.target.value })}
                  onBlur={() => touch('title')}
                  aria-invalid={!!err('title')}
                  data-testid="memory-title"
                />
              )}
            </Field>
          </div>
          <Field label="What is true" error={err('content')}>
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={form.content}
                onChange={(e) => patch({ content: e.target.value })}
                onBlur={() => touch('content')}
                aria-invalid={!!err('content')}
                data-testid="memory-content"
              />
            )}
          </Field>
          <Field label="Evidence" hint="Where this can be checked." error={err('evidence')}>
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={form.evidence}
                onChange={(e) => patch({ evidence: e.target.value })}
                onBlur={() => touch('evidence')}
                aria-invalid={!!err('evidence')}
                data-testid="memory-evidence"
              />
            )}
          </Field>
          <fieldset
            className="m-0 flex flex-col gap-1.5 border-0 p-0"
            aria-describedby="memory-repos-hint"
          >
            <legend className="mb-1 p-0 text-small font-medium text-text-secondary">
              Repositories it is about
            </legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {detail.repositories.map((r) => (
                <Check
                  key={r.id}
                  checked={form.repositories.includes(r.key)}
                  onChange={(on) => {
                    patch({
                      repositories: on
                        ? [...form.repositories, r.key]
                        : form.repositories.filter((k) => k !== r.key),
                    })
                    touch('repositories')
                  }}
                  label={<span className="font-mono">{r.key}</span>}
                  testId={`memory-repo-${r.key}`}
                />
              ))}
            </div>
            <div
              id="memory-repos-hint"
              className={
                err('repositories') ? 'text-small text-danger' : 'text-small text-text-muted'
              }
              role={err('repositories') ? 'alert' : undefined}
            >
              {err('repositories') ?? MEMORY_REPOSITORIES_HINT}
            </div>
          </fieldset>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={<PlusIcon size={12} />}
              loading={add.isPending}
              data-testid="memory-submit"
            >
              Add memory
            </Button>
          </div>
          {add.isError ? <ErrorNote error={add.error} /> : null}
        </form>
      )}
    </Card>
  )
}

export function MemoryTab({ detail }: { detail: WorkspaceDetail }) {
  const decisions = sortDecisions(detail.decisions)
  const memory = [...detail.memory].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <div className="flex flex-col gap-5" data-testid="workspace-memory">
      <section className="flex flex-col gap-2" aria-label="Workspace memory">
        <h3 className="m-0 text-heading font-semibold">Workspace memory</h3>
        {memory.length === 0 ? (
          <Empty testId="workspace-memory-empty">
            Nothing remembered yet. Verifications add what they learn about how the repositories fit
            together, and you can add your own below.
          </Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="workspace-memory-list">
            {memory.map((m) => (
              <li
                key={m.id}
                className="rounded-lg border bg-surface px-4 py-3"
                data-testid={`memory-entry-${m.id}`}
                data-kind={m.kind}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{MEMORY_KIND_LABEL[m.kind]}</Badge>
                  <span className="font-medium">{m.title}</span>
                  <span className="ml-auto text-small text-text-muted">
                    {SOURCE_LABEL[m.source.kind]} · <TimeAgo iso={m.createdAt} />
                  </span>
                </div>
                <p className="m-0 mt-1 whitespace-pre-wrap">{m.content}</p>
                <p className="m-0 mt-1 whitespace-pre-wrap text-small text-text-secondary">
                  <span className="text-text-muted">Evidence: </span>
                  {m.evidence}
                </p>
                <p className="m-0 mt-1 flex flex-wrap items-center gap-1 text-small text-text-muted">
                  About
                  {m.repositories.map((k) => (
                    <Mono key={k}>{k}</Mono>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AddMemory detail={detail} />

      <section className="flex flex-col gap-2" aria-label="Decision trail">
        <h3 className="m-0 text-heading font-semibold">Decision trail</h3>
        <p className="m-0 text-small text-text-secondary">
          What NEXUS decided and why, newest first.
        </p>
        {decisions.length === 0 ? (
          <Empty testId="workspace-decisions-empty">No decisions yet.</Empty>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="workspace-decisions">
            {decisions.map((d) => (
              <li
                key={d.id}
                className="rounded-md border bg-surface px-3 py-2"
                data-testid={`decision-${d.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <H3>{decisionKindLabel(d.kind)}</H3>
                  <span className="ml-auto text-small text-text-muted">
                    <TimeAgo iso={d.createdAt} />
                  </span>
                </div>
                <p className="m-0 mt-0.5">{d.summary}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
