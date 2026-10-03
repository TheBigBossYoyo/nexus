import { useState } from 'react'
import { PRESETS, RUN_MODES, type Preset, type Project, type RunMode } from '@shared/domain'
import { presetMaxAgents } from '@shared/settings'
import type { PlanningMode, ReviewMode } from '@shared/v2'
import { useCreateRun, usePlanningRecommendation, useSettings } from '../../lib/queries'
import { useDebounced } from '../../lib/useDebounced'
import { useUiStore } from '../../store/ui'
import { Button, Field, NumberField, Notice, Panel, Select, Textarea, Toggle } from '../../components/ui'
import {
  buildCreateRunInput,
  DIRTY_REPO_WARNING,
  MAXIMUM_PRESET_WARNING,
  MODE_INFO,
  PLANNING_MODE_INFO,
  PRESET_INFO,
  REVIEW_MODE_INFO,
  validateMission,
  type MissionDraft,
} from './mission'

const MODE_OPTIONS = RUN_MODES.map((m) => ({ value: m, label: m.toUpperCase() }))
const PLANNING_OPTIONS: { value: PlanningMode; label: string }[] = [
  { value: 'single', label: 'SINGLE' },
  { value: 'consensus', label: 'CONSENSUS' },
]
const REVIEW_OPTIONS: { value: ReviewMode; label: string }[] = [
  { value: 'auto', label: 'AUTO' },
  { value: 'standard', label: 'STANDARD' },
  { value: 'dual', label: 'DUAL' },
]
const PRESET_OPTIONS = PRESETS.map((p) => ({ value: p, label: p.toUpperCase() }))

export function MissionComposer({ project }: { project: Project }) {
  const settings = useSettings().data
  const create = useCreateRun()
  const openRun = useUiStore((s) => s.openRun)

  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<RunMode>('build')
  const [presetChoice, setPresetChoice] = useState<Preset | null>(null)
  const [maxAgentsChoice, setMaxAgentsChoice] = useState<number | null>(null)
  const [approvalChoice, setApprovalChoice] = useState<boolean | null>(null)
  const [iterationsChoice, setIterationsChoice] = useState<number | null>(null)
  const [planningMode, setPlanningMode] = useState<PlanningMode>('single')
  const [reviewMode, setReviewMode] = useState<ReviewMode>('auto')
  const [submitted, setSubmitted] = useState(false)
  const debouncedPrompt = useDebounced(prompt.trim(), 600)
  const recommendation = usePlanningRecommendation(project.id, mode === 'ask' ? '' : debouncedPrompt)

  const preset = presetChoice ?? settings?.execution.defaultPreset ?? 'balanced'
  const presetAgents = settings ? presetMaxAgents(preset, settings) : null
  const maxAgents = maxAgentsChoice ?? presetAgents
  const requirePlanApproval = approvalChoice ?? settings?.execution.requirePlanApproval ?? true
  const maxIterations = iterationsChoice ?? settings?.execution.maxIterations ?? 3

  const draft: MissionDraft = {
    projectId: project.id,
    prompt,
    mode,
    preset,
    maxAgents: maxAgentsChoice,
    requirePlanApproval,
    maxIterations,
    planningMode,
    reviewMode,
  }
  const problem = validateMission(draft)
  const dirty = project.profile?.dirty === true

  const submit = async () => {
    setSubmitted(true)
    if (problem || !settings) return
    try {
      const run = await create.mutateAsync(buildCreateRunInput(draft))
      setPrompt('')
      setSubmitted(false)
      openRun(run.id, run.projectId)
    } catch {
      // Surfaced as a toast by the mutation cache.
    }
  }

  return (
    <Panel title="New mission" data-testid="mission-composer">
      <div className="flex flex-col gap-3">
        {project.profile && !project.profile.isGitRepo ? (
          <Notice tone="danger" title="Not a Git repository">
            NEXUS needs a Git repository to create isolated worktrees. Creating a run is likely to fail.
          </Notice>
        ) : null}
        {dirty ? (
          <Notice tone="warning" title="Uncommitted changes" data-testid="dirty-warning">
            {DIRTY_REPO_WARNING}
          </Notice>
        ) : null}

        <Field label="Mission" error={submitted ? (problem ?? undefined) : undefined}>
          {(id) => (
            <Textarea
              id={id}
              rows={5}
              value={prompt}
              maxLength={20_000}
              placeholder="Describe the outcome you want. Be specific about scope, constraints and how to verify it."
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
              data-testid="mission-prompt"
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Mode" hint={MODE_INFO[mode]}>
            {(id) => <Select id={id} value={mode} onChange={setMode} options={MODE_OPTIONS} data-testid="mode-select" />}
          </Field>
          <Field label="Preset" hint={PRESET_INFO[preset]}>
            {(id) => (
              <Select id={id} value={preset} onChange={setPresetChoice} options={PRESET_OPTIONS} data-testid="preset-select" />
            )}
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Planning" hint={PLANNING_MODE_INFO[planningMode]}>
            {(id) => (
              <Select id={id} value={planningMode} onChange={setPlanningMode} options={PLANNING_OPTIONS} data-testid="planning-mode-select" />
            )}
          </Field>
          <Field label="Review" hint={REVIEW_MODE_INFO[reviewMode]}>
            {(id) => <Select id={id} value={reviewMode} onChange={setReviewMode} options={REVIEW_OPTIONS} data-testid="review-mode-select" />}
          </Field>
        </div>

        {recommendation.data ? (
          <div className="flex flex-col gap-0.5 border-l-2 border-accent bg-surface-2 px-2.5 py-1.5" data-testid="planning-recommendation">
            <div className="flex items-center gap-2">
              <span className="text-fg-muted">Recommended planning mode:</span>
              <span className="font-mono">{recommendation.data.mode.toUpperCase()}</span>
              {recommendation.data.mode !== planningMode ? (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => setPlanningMode(recommendation.data.mode)}
                  data-testid="planning-use-recommended"
                >
                  Use it
                </button>
              ) : (
                <span className="text-fg-faint">selected</span>
              )}
            </div>
            {recommendation.data.reasons.length > 0 ? (
              <ul className="m-0 list-disc pl-5 text-fg-muted">
                {recommendation.data.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {preset === 'maximum' ? (
          <Notice tone="warning" title="Subscription usage" data-testid="maximum-warning">
            {MAXIMUM_PRESET_WARNING}
          </Notice>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Max agents in parallel" hint={maxAgentsChoice === null ? 'From the preset' : 'Overridden'}>
            {(id) => (
              <NumberField
                id={id}
                min={1}
                max={16}
                value={maxAgents ?? 1}
                disabled={!settings}
                onChange={setMaxAgentsChoice}
                data-testid="max-agents"
              />
            )}
          </Field>
          {mode === 'loop' ? (
            <Field label="Max loop iterations" hint="Upper bound on implement/check/repair cycles">
              {(id) => (
                <NumberField id={id} min={1} max={50} value={maxIterations} onChange={setIterationsChoice} data-testid="max-iterations" />
              )}
            </Field>
          ) : null}
        </div>

        <Toggle
          checked={requirePlanApproval}
          onChange={setApprovalChoice}
          label="Require plan approval"
          description="Pause after planning so you can review the task graph before any agent edits files."
          data-testid="plan-approval-toggle"
        />

        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <span className="text-[0.85rem] text-fg-faint">Ctrl+Enter to start</span>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!settings || (submitted && !!problem)}
            onClick={() => void submit()}
            data-testid="create-run"
          >
            Start {mode.toUpperCase()} run
          </Button>
        </div>
      </div>
    </Panel>
  )
}
