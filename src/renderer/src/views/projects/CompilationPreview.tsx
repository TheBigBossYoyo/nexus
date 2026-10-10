import { COMPILATION_MODE_LABEL, kindLabel, provenanceLabel } from '../../lib/intelligenceLabels'
import { useUiStore } from '../../store/ui'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  COMPILATION_MODES,
  type CompilationMode,
  type CompiledTaskSpec,
  type UserIntentMetadata,
  type CompilationExecutionScope,
  defaultIntentMetadata,
} from '@shared/intelligence'
import { api } from '../../lib/bridge'
import { Button, ErrorNote, Field, Notice, Select, Toggle } from '../../components/ui'

/** The composer controls the admission mode and saved specification. */
export function CompilationPreview({
  projectId,
  raw,
  mode,
  onModeChange,
  spec,
  onSpec,
  metadata,
  workspaceId,
  executionScope,
}: {
  projectId: string
  raw: string
  mode: CompilationMode
  onModeChange: (mode: CompilationMode) => void
  spec: CompiledTaskSpec | null
  onSpec: (spec: CompiledTaskSpec) => void
  metadata?: UserIntentMetadata
  workspaceId?: string
  executionScope?: CompilationExecutionScope
}) {
  const [tab, setTab] = useState<'original' | 'compiled' | 'evidence'>('compiled')
  // The project's own switch: off, nothing of this project is sent to OpenAI, whatever the connection allows.
  const client = useQueryClient()
  const sending = useQuery({ queryKey: ['project-sending', projectId], queryFn: () => api.invoke('compilation.projectSending', { projectId }) })
  const setSending = useMutation({
    mutationFn: (allowed: boolean) => api.invoke('compilation.setProjectSending', { projectId, allowed }),
    onSettled: () => client.invalidateQueries({ queryKey: ['project-sending', projectId] }),
  })
  const withheld = sending.data?.allowed === false
  // A project that sends nothing starts from the depth that needs no provider; the user can still choose another.
  useEffect(() => {
    if (withheld && mode === 'AUTO') onModeChange('EXACT')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withheld])
  const preview = useMutation({
    mutationFn: () =>
      api.invoke('compilation.preview', {
        projectId,
        raw,
        mode,
        ...(metadata ? { metadata } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(executionScope ? { executionScope } : {}),
      }),
    onSuccess: onSpec,
  })
  const setView = useUiStore((state) => state.setView)
  // The panel is the user's to open and close. It opens by itself for a result that needs them (a wait, a
  // decision); it never closes by itself, which used to hide a result that had just become ready.
  const [open, setOpen] = useState(false)
  const needsAttention = spec !== null && spec.status !== 'READY'
  useEffect(() => {
    if (needsAttention) setOpen(true)
  }, [needsAttention, spec?.id])
  const stale =
    spec &&
    (spec.rawIntent !== raw ||
      spec.requestedMode !== mode ||
      spec.projectId !== projectId ||
      JSON.stringify(spec.userMetadata) !==
        JSON.stringify(metadata ?? defaultIntentMetadata(raw)) ||
      spec.workspaceId !== workspaceId ||
      JSON.stringify(spec.executionScope) !== JSON.stringify(executionScope))
  return (
    <details
      className="rounded-md border bg-surface p-3"
      data-testid="compilation-preview"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium">Task compilation preview</summary>
      <p className="text-small text-text-muted">
        Before work starts, NEXUS can develop your request into a specification. Every depth but Exact wording
        and Light sends the request and matching project knowledge to OpenAI (Providers lists what is sent).
      </p>
      <Toggle
        className="my-2"
        checked={!withheld}
        disabled={sending.isLoading || setSending.isPending}
        label="This project may send requests to OpenAI"
        description="Off: nothing of this project is sent to OpenAI, even while the ChatGPT connection is on. Requests are then admitted with Exact wording or Light, and the Strategic Director and the Council are not available for it."
        data-testid="project-sending"
        onChange={(allowed) => setSending.mutate(allowed)}
      />
      {setSending.isError ? <ErrorNote error={setSending.error} /> : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Compilation depth">
          {(id) => (
            <Select
              id={id}
              value={mode}
              onChange={onModeChange}
              data-testid="compilation-mode"
              options={COMPILATION_MODES.map((value) => ({ value, label: COMPILATION_MODE_LABEL[value] }))}
            />
          )}
        </Field>
        <Button onClick={() => preview.mutate()} disabled={!raw.trim()} loading={preview.isPending}>
          Preview specification
        </Button>
      </div>
      {/* Always in the page, so that what appears in it is announced. */}
      <p role="status">{preview.isPending ? 'Retrieving context and developing specification…' : ''}</p>
      {preview.isError ? <ErrorNote error={preview.error} /> : null}
      {spec ? (
        <div className="mt-3 space-y-3">
          <Notice
            live
            tone={spec.status === 'READY' && !stale ? 'neutral' : 'warning'}
            title={
              stale
                ? 'Request changed — preview again'
                : spec.status === 'WAITING_FOR_PROVIDER'
                  ? 'Waiting for a provider'
                  : spec.status === 'USER_DECISION_REQUIRED'
                    ? 'A user decision is required'
                    : 'Specification preview ready'
            }
          >
            <p>Depth: {COMPILATION_MODE_LABEL[spec.mode]}</p>
            {spec.status === 'WAITING_FOR_PROVIDER' ? (
              spec.reasons.includes('PROJECT_DOES_NOT_SEND_TO_STRATEGIC_PROVIDER') ? (
                <p>
                  This depth needs ChatGPT, and this project is set not to send to OpenAI (the switch above). Choose
                  Exact wording or Light, or switch sending on for this project, then preview again.
                </p>
              ) : (
                <p>
                  This depth needs the ChatGPT connection, and it is not ready: connect it, choose a model and switch
                  sending on in Providers, then preview again. Exact wording and Light need no provider.
                </p>
              )
            ) : null}
            {spec.reasons.length ? (
              <details className="text-text-muted">
                <summary className="cursor-pointer">Details for support</summary>
                <p className="break-words font-mono text-caption">{spec.reasons.join(' · ')}</p>
              </details>
            ) : null}
            {spec.status === 'USER_DECISION_REQUIRED' ? (
              <p>
                Clarify the original request and preview again before starting. Generated
                recommendations are not treated as confirmed user requirements.
              </p>
            ) : null}
            {spec.waitUntil ? (
              <p>
                The provider asked to wait: previewing again is useful after{' '}
                {new Date(spec.waitUntil).toLocaleString()}. It may still be unavailable then.
              </p>
            ) : null}
            {spec.status === 'WAITING_FOR_PROVIDER' ? (
              <div className="mt-1.5">
                <Button size="sm" onClick={() => setView('providers')}>
                  Open Providers
                </Button>
              </div>
            ) : null}
          </Notice>
          <div className="flex gap-2" role="group" aria-label="Specification view">
            {(['original', 'compiled', 'evidence'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {value === 'original'
                  ? 'Original'
                  : value === 'compiled'
                    ? 'Compiled & provenance'
                    : 'Context & assumptions'}
              </Button>
            ))}
          </div>
          {tab === 'original' ? (
            <pre className="whitespace-pre-wrap break-words text-small">{spec.rawIntent}</pre>
          ) : tab === 'compiled' ? (
            <div className="space-y-2">
              <p className="whitespace-pre-wrap break-words">{spec.rawIntent}</p>
              {spec.recommendations.map((r, i) => (
                <div key={i} className="border-t pt-2">
                  <p className="m-0 break-words">{r.text}</p>
                  <p className="text-caption text-text-muted">
                    {kindLabel(r.kind)} · {provenanceLabel(r.provenance)}
                    {r.requiresDecision ? ' · Requires decision' : ''}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2 text-small">
              <p>
                {spec.dependencies.length} scoped context references. Repository evidence does not
                grant authority.
              </p>
              {spec.dependencies.map((ref) => (
                <p key={ref.id} className="break-all font-mono">
                  {ref.id} · {ref.version}
                </p>
              ))}
              {spec.ambiguities.map((a, i) => (
                <p key={i}>{a}</p>
              ))}
              {spec.driftCheck ? (
                <details>
                  <summary className="cursor-pointer">Intent comparison</summary>
                  <p>Structured flags: {spec.driftCheck.structuredFlags.join(', ') || 'None'}</p>
                  <p>
                    Semantic comparison:{' '}
                    {spec.driftCheck.semantic.changesIntent || spec.driftCheck.semantic.expandsScope
                      ? 'Change flagged'
                      : 'No change flagged'}
                    . This comparison is a model judgment, not a proof of equivalence.
                  </p>
                </details>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </details>
  )
}
