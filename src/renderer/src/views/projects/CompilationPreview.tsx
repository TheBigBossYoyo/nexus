import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  COMPILATION_MODES,
  type CompilationMode,
  type CompiledTaskSpec,
} from '@shared/intelligence'
import { api } from '../../lib/bridge'
import { Button, ErrorNote, Field, Notice, Select } from '../../components/ui'

/** The composer controls the admission mode and saved specification. */
export function CompilationPreview({
  projectId,
  raw,
  mode,
  onModeChange,
  spec,
  onSpec,
}: {
  projectId: string
  raw: string
  mode: CompilationMode
  onModeChange: (mode: CompilationMode) => void
  spec: CompiledTaskSpec | null
  onSpec: (spec: CompiledTaskSpec) => void
}) {
  const [tab, setTab] = useState<'original' | 'compiled' | 'evidence'>('compiled')
  const preview = useMutation({
    mutationFn: () => api.invoke('compilation.preview', { projectId, raw, mode }),
    onSuccess: onSpec,
  })
  const stale =
    spec && (spec.rawIntent !== raw || spec.requestedMode !== mode || spec.projectId !== projectId)
  return (
    <details
      className="rounded-md border bg-surface p-3"
      data-testid="compilation-preview"
      open={spec?.status !== 'READY' && spec !== null ? true : undefined}
    >
      <summary className="cursor-pointer font-medium">Task compilation preview</summary>
      <p className="text-small text-text-muted">
        AUTO develops the request before work starts. EXACT preserves the supplied request with
        deterministic policy wrappers. Added recommendations keep their provenance; consequential
        ambiguity blocks admission until the request is clarified.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Compilation depth">
          {(id) => (
            <Select
              id={id}
              value={mode}
              onChange={onModeChange}
              data-testid="compilation-mode"
              options={COMPILATION_MODES.map((value) => ({ value, label: value }))}
            />
          )}
        </Field>
        <Button onClick={() => preview.mutate()} disabled={!raw.trim()} loading={preview.isPending}>
          Preview specification
        </Button>
      </div>
      {preview.isPending ? (
        <p role="status">Retrieving context and developing specification…</p>
      ) : null}
      {preview.isError ? <ErrorNote error={preview.error} /> : null}
      {spec ? (
        <div className="mt-3 space-y-3">
          <Notice
            tone={spec.status === 'READY' && !stale ? 'neutral' : 'warning'}
            title={
              stale
                ? 'Request changed — preview again'
                : spec.status === 'WAITING_FOR_PROVIDER'
                  ? 'Waiting for a configured provider'
                  : spec.status === 'USER_DECISION_REQUIRED'
                    ? 'A user decision is required'
                    : 'Specification preview ready'
            }
          >
            {spec.mode} · {spec.reasons.join(' · ')}
            {spec.status === 'USER_DECISION_REQUIRED' ? (
              <p>
                Clarify the original request and preview again before starting. Generated
                recommendations are not treated as confirmed user requirements.
              </p>
            ) : null}
            {spec.waitUntil ? (
              <p>
                A later explicit request may probe after {new Date(spec.waitUntil).toLocaleString()}
                . Availability is not guaranteed.
              </p>
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
                    {r.kind} · {r.provenance}
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
