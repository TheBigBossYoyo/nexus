import { COMPILATION_MODE_LABEL, kindLabel, provenanceLabel, sentence, stateLabel } from '../../lib/intelligenceLabels'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  CompiledTaskSpec,
  CompilationMode,
  CompilationSelection,
  UserIntentMetadata,
  CompilationExecutionScope,
} from '@shared/intelligence'
import { api } from '../../lib/bridge'
import { Button, ErrorNote, EmptyState } from '../../components/ui'
import { CompilationPreview } from './CompilationPreview'
import type { Run } from '@shared/domain'
import { defaultIntentMetadata } from '@shared/intelligence'
import { useResumeRun } from '../../lib/queries'

function SavedSpecification({ spec }: { spec: CompiledTaskSpec }) {
  return (
    <div className="space-y-3 text-small" data-testid="saved-specification">
      <p>
        {COMPILATION_MODE_LABEL[spec.mode]} · {stateLabel(spec.status)} ·{' '}
        {new Date(spec.createdAt).toLocaleString()}
      </p>
      <p className="break-all font-mono text-caption text-text-muted">
        Intent {spec.intentId ?? 'legacy snapshot'} · Specification {spec.id}
      </p>
      <pre className="whitespace-pre-wrap break-words">{spec.rawIntent}</pre>
      {spec.userMetadata ? (
        <dl className="space-y-2">
          {(
            [
              ['Explicit goals', spec.userMetadata.goals],
              ['Explicit constraints', spec.userMetadata.constraints],
              ['Explicit acceptance criteria', spec.userMetadata.acceptanceCriteria],
            ] as const
          ).map(([label, items]) => (
            <div key={label}>
              <dt className="font-medium">{label} · {provenanceLabel('USER_EXPLICIT')}</dt>
              <dd className="m-0 whitespace-pre-wrap break-words">
                {items.length ? items.join('\n') : 'None supplied'}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {spec.recommendations.map((r, i) => (
        <div key={i} className="border-t pt-2">
          <p className="whitespace-pre-wrap break-words">{r.text}</p>
          <p className="text-caption text-text-muted">
            {kindLabel(r.kind)} · {provenanceLabel(r.provenance)}
            {r.requiresDecision ? ' · Decision required' : ''}
          </p>
        </div>
      ))}
      {spec.ambiguities.length ? (
        <ul className="list-disc pl-5">
          {spec.ambiguities.map((a, i) => (
            <li key={i} className="break-words">
              {a}
            </li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary className="cursor-pointer">
          Canonical context references ({spec.dependencies.length})
        </summary>
        {spec.dependencies.map((r) => (
          <p key={r.id} className="break-all font-mono text-caption">
            {r.id} · {r.version}
          </p>
        ))}
      </details>
    </div>
  )
}

export function MissionAdmissionInspector({ run }: { run: Run }) {
  const [mode, setMode] = useState<CompilationMode>(run.config.compiledTaskSpec?.requestedMode ?? 'AUTO')
  const [preview, setPreview] = useState<CompiledTaskSpec | null>(null)
  const resume = useResumeRun()
  const raw = run.config.compiledTaskSpec?.rawIntent ?? run.prompt
  return <details className="max-h-[60vh] overflow-auto border-b bg-surface px-5 py-2 text-small" data-testid="mission-admission-inspector">
    <summary className="cursor-pointer font-medium">Specification of this mission</summary>
    {run.config.compiledTaskSpec ? <SavedSpecification spec={run.config.compiledTaskSpec} /> : <p>This mission needs a specification before it can resume.</p>}
    {run.state === 'paused' && !run.config.engineeringOwner ? <>
      <CompilationPreview projectId={run.projectId} raw={raw} mode={mode} spec={preview}
        metadata={run.config.compiledTaskSpec?.userMetadata ?? defaultIntentMetadata(raw)} executionScope={{ runId: run.id }}
        onModeChange={m => { setMode(m); setPreview(null) }} onSpec={setPreview} />
      <Button size="sm" disabled={preview?.status !== 'READY'} loading={resume.isPending}
        onClick={() => preview && resume.mutate({ runId: run.id, compilationMode: mode, compiledSpecId: preview.id })}>Resume with this specification</Button>
      {resume.error ? <ErrorNote error={resume.error} /> : null}
    </> : null}
    <CompilationHistory projectId={run.projectId} />
  </details>
}

/** Inspect the admitted root and explicitly preview a replacement for a stale or legacy draft. */
export function AdmissionInspector({
  kind,
  entityId,
  projectId,
  raw,
  metadata,
  workspaceId,
  executionScope,
  draft,
  onSelection,
}: {
  kind: 'PROGRAM' | 'WORKSPACE_MISSION' | 'WORKSPACE_PROGRAM'
  entityId: string
  projectId: string
  raw: string
  metadata: UserIntentMetadata
  workspaceId?: string
  executionScope?: CompilationExecutionScope
  draft: boolean
  onSelection: (selection: CompilationSelection) => void
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<CompilationMode>('AUTO')
  const [preview, setPreview] = useState<CompiledTaskSpec | null>(null)
  const saved = useQuery({
    queryKey: ['compilation', 'admission', kind, entityId],
    queryFn: () => api.invoke('compilation.admission', { kind, entityId }),
    enabled: open,
  })
  return (
    <details
      className="rounded-md border bg-surface p-3"
      onToggle={(e) => setOpen(e.currentTarget.open)}
      data-testid="admission-inspector"
    >
      <summary className="cursor-pointer font-medium">Specification of this mission</summary>
      {/* Always in the page, so that what appears in it is announced. */}
      <p role="status">{saved.isPending && open ? 'Loading saved specification…' : ''}</p>
      {saved.isError ? (
        <ErrorNote error={saved.error} />
      ) : saved.isPending ? null : saved.data ? (
        <SavedSpecification spec={saved.data} />
      ) : (
        <p>This draft needs a specification before it starts.</p>
      )}
      {draft ? (
        <CompilationPreview
          projectId={projectId}
          raw={raw}
          metadata={metadata}
          {...(workspaceId ? { workspaceId } : {})}
          {...(executionScope ? { executionScope } : {})}
          mode={mode}
          spec={preview}
          onModeChange={(next) => {
            setMode(next)
            setPreview(null)
            onSelection({ compilationMode: next })
          }}
          onSpec={(spec) => {
            setPreview(spec)
            onSelection({ compilationMode: mode, compiledSpecId: spec.id })
          }}
        />
      ) : null}
      <CompilationHistory projectId={projectId} />
    </details>
  )
}

export function CompilationHistory({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const history = useQuery({
    queryKey: ['compilation', 'history', projectId, offset],
    queryFn: () => api.invoke('compilation.history', { projectId, offset }),
    enabled: open,
  })
  return (
    <details className="mt-3 rounded-md border p-3" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">Specification history</summary>
      <p role="status">{history.isPending && open ? 'Loading history…' : ''}</p>
      {history.isError ? (
        <ErrorNote error={history.error} />
      ) : history.isPending ? null : history.data?.length ? (
        <div className="space-y-3">
          {history.data.map((spec) => (
            <details key={spec.id} className="rounded-md border p-3">
              <summary className="cursor-pointer break-words">
                {sentence(spec.userMetadata?.entryPoint ?? 'MISSION')} · {COMPILATION_MODE_LABEL[spec.mode]} ·{' '}
                {stateLabel(spec.status)} · {new Date(spec.createdAt).toLocaleString()}
              </summary>
              <SavedSpecification spec={spec} />
            </details>
          ))}
        </div>
      ) : (
        <EmptyState title="No saved specifications">A specification is saved each time a request is previewed or admitted.</EmptyState>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={offset === 0 || history.isFetching}
          onClick={() => setOffset((n) => Math.max(0, n - 50))}
        >
          Newer
        </Button>
        <Button
          size="sm"
          disabled={history.data?.length !== 50 || history.isFetching}
          onClick={() => setOffset((n) => n + 50)}
        >
          Older
        </Button>
        <Button size="sm" disabled={history.isFetching} onClick={() => void history.refetch()}>
          Refresh
        </Button>
      </div>
    </details>
  )
}
