import { planningWords, strategyWord } from '../../lib/wording'
import { useEffect, useState } from 'react'
import { PRESETS, RUN_MODES, type Preset, type Project, type RunMode } from '@shared/domain'
import { presetMaxAgents } from '@shared/settings'
import type { PlanningMode, ReviewMode } from '@shared/v2'
import type { Strategy } from '@shared/v3'
import { useCreateRun, usePlanningRecommendation, useSettings, useStartOvernight } from '../../lib/queries'
import { usePolicyPreview } from '../../lib/queries-run'
import { useDebounced } from '../../lib/useDebounced'
import { useUiStore } from '../../store/ui'
import { Button, Card, Field, NumberField, Notice, Select, Textarea, Toggle, type SelectOption } from '../../components/ui'
import { cn } from '../../lib/cn'
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
import {
  DEFAULT_STRATEGY,
  SPECULATIVE_USAGE_NOTE,
  STRATEGY_BY_VALUE,
  STRATEGY_OPTIONS,
  previewText,
  strategyApplies,
  strategyFields,
} from './strategy'
import { OvernightConfirmDialog, OvernightPanel } from './OvernightPanel'
import {
  OVERNIGHT_MODE,
  OVERNIGHT_MODE_INFO,
  buildOvernightStartInput,
  defaultOvernightForm,
  summarizeOvernight,
  validateOvernight,
  type OvernightForm,
} from './overnight'

type ComposerMode = RunMode | typeof OVERNIGHT_MODE
const MODE_OPTIONS: SelectOption<ComposerMode>[] = [
  ...RUN_MODES.map((m) => ({ value: m as ComposerMode, label: strategyWord(m) })),
  { value: OVERNIGHT_MODE, label: 'OVERNIGHT', testId: 'mode-overnight' },
]
const PLANNING_OPTIONS: { value: PlanningMode; label: string }[] = [
  { value: 'single', label: 'SINGLE' },
  { value: 'consensus', label: 'CONSENSUS' },
]
const REVIEW_OPTIONS: { value: ReviewMode; label: string }[] = [
  { value: 'auto', label: 'AUTO' },
  { value: 'standard', label: 'STANDARD' },
  { value: 'dual', label: 'DUAL' },
]
const STRATEGY_SELECT_OPTIONS: SelectOption<Strategy>[] = STRATEGY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))
const CANDIDATE_OPTIONS: SelectOption<'2' | '3'>[] = [
  { value: '2', label: '2 candidates' },
  { value: '3', label: '3 candidates' },
]
const PRESET_OPTIONS = PRESETS.map((p) => ({ value: p, label: strategyWord(p) }))

export function MissionComposer({ project }: { project: Project }) {
  const settings = useSettings().data
  const create = useCreateRun()
  const openRun = useUiStore((s) => s.openRun)

  const [prompt, setPrompt] = useState('')
  const [composerMode, setComposerMode] = useState<ComposerMode>('build')
  const overnightMode = composerMode === OVERNIGHT_MODE
  // Overnight is a composer mode only: it creates an ordinary MISSION run through overnight.start.
  const mode: RunMode = overnightMode ? 'mission' : composerMode
  const startOvernight = useStartOvernight()
  const [overnight, setOvernight] = useState<OvernightForm>(defaultOvernightForm)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [overnightError, setOvernightError] = useState<string | null>(null)
  const setMode = (m: ComposerMode) => {
    setComposerMode(m)
    // The authorization belongs to one deliberate look at the panel; changing the mode withdraws it.
    setOvernight((f) => ({ ...f, authorized: false }))
    setConfirmOpen(false)
    setOvernightError(null)
  }
  // "Start Overnight" in the palette and on the Overnight page opens the composer already in Overnight mode.
  const composerIntent = useUiStore((s) => s.composerIntent)
  const setComposerIntent = useUiStore((s) => s.setComposerIntent)
  useEffect(() => {
    if (composerIntent !== 'overnight') return
    setMode(OVERNIGHT_MODE)
    setComposerIntent(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerIntent])
  const [presetChoice, setPresetChoice] = useState<Preset | null>(null)
  const [maxAgentsChoice, setMaxAgentsChoice] = useState<number | null>(null)
  const [approvalChoice, setApprovalChoice] = useState<boolean | null>(null)
  const [iterationsChoice, setIterationsChoice] = useState<number | null>(null)
  const [planningMode, setPlanningMode] = useState<PlanningMode>('single')
  const [reviewMode, setReviewMode] = useState<ReviewMode>('auto')
  const [submitted, setSubmitted] = useState(false)
  const [strategy, setStrategy] = useState<Strategy>(DEFAULT_STRATEGY)
  const [candidates, setCandidates] = useState<2 | 3>(2)
  const [advancedOpen, setAdvancedOpen] = useState(true)
  const showStrategy = !overnightMode && strategyApplies(mode)
  const debouncedPrompt = useDebounced(prompt.trim(), 600)
  const debouncedStrategyPrompt = useDebounced(prompt.trim(), 500)
  const preview = usePolicyPreview(project.id, showStrategy && strategy === 'ADAPTIVE' ? debouncedStrategyPrompt : '')
  const recommendation = usePlanningRecommendation(project.id, mode === 'ask' ? '' : debouncedPrompt)

  const preset = presetChoice ?? settings?.execution.defaultPreset ?? 'balanced'
  const presetAgents = settings ? presetMaxAgents(preset, settings) : null
  const maxAgents = maxAgentsChoice ?? presetAgents
  const requirePlanApproval = approvalChoice ?? settings?.execution.requirePlanApproval ?? true
  const maxIterations = iterationsChoice ?? settings?.execution.maxIterations ?? 3

  // A fresh composer never carries an authorization over from an earlier visit.
  useEffect(() => setOvernight((f) => ({ ...f, authorized: false })), [project.id])
  const overnightForm: OvernightForm = { ...overnight, preset, recommendedPlanning: recommendation.data?.mode ?? null }
  const overnightValidation = validateOvernight(overnightForm, prompt)

  const submitOvernight = async () => {
    setOvernightError(null)
    try {
      const out = await startOvernight.mutateAsync(buildOvernightStartInput(overnightForm, project.id, prompt))
      setPrompt('')
      setConfirmOpen(false)
      setOvernight((f) => ({ ...f, authorized: false }))
      openRun(out.run.id, out.run.projectId)
    } catch (e) {
      setOvernightError(e instanceof Error ? e.message : String(e))
    }
  }

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
    ...(showStrategy ? strategyFields(mode, strategy, candidates) : {}),
  }
  const problem = validateMission(draft)
  const dirty = project.profile?.dirty === true
  const noChecks =
    project.profile !== null && Object.values(project.profile.commands).every((c) => c === null || c === '')

  const submit = async () => {
    setSubmitted(true)
    if (overnightMode) return
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


  const previewView = previewText(preview.data)
  const strategyInfo = STRATEGY_BY_VALUE[strategy]

  return (
    <Card title="New mission" data-testid="mission-composer">
      <div className="flex flex-col gap-4">
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
        {noChecks && mode !== 'ask' ? (
          <p className="m-0 -mt-2 text-small text-text-muted" data-testid="no-check-commands">
            No check commands configured for this project (build, test, lint, typecheck). Missions run without
            automatic checks; set them up in the project's scripts and reprofile.
          </p>
        ) : null}

        <div className={cn('grid gap-3', showStrategy ? 'grid-cols-3' : 'grid-cols-2')}>
          <Field label="Mode" hint={overnightMode ? OVERNIGHT_MODE_INFO : MODE_INFO[mode]}>
            {(id) => <Select id={id} value={composerMode} onChange={setMode} options={MODE_OPTIONS} data-testid="mode-select" />}
          </Field>
          {showStrategy ? (
            <Field label="Strategy" hint={strategyInfo.description}>
              {(id) => (
                <Select
                  id={id}
                  value={strategy}
                  onChange={setStrategy}
                  options={STRATEGY_SELECT_OPTIONS}
                  data-testid="strategy-select"
                />
              )}
            </Field>
          ) : null}
          <Field label="Preset" hint={PRESET_INFO[preset]}>
            {(id) => (
              <Select id={id} value={preset} onChange={setPresetChoice} options={PRESET_OPTIONS} data-testid="preset-select" />
            )}
          </Field>
        </div>

        {showStrategy && strategy === 'ADAPTIVE' ? (
          <div className="rounded-md border bg-surface-muted px-3 py-2 text-small" data-testid="strategy-preview" role="status">
            <div className="font-medium text-text-primary">{previewView.headline}</div>
            {previewView.reason ? <div className="text-text-secondary">{previewView.reason}</div> : null}
            {previewView.evidence ? <div className="text-text-muted">{previewView.evidence}</div> : null}
          </div>
        ) : null}
        {showStrategy && strategy === 'SPECULATIVE' ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border bg-surface-muted px-3 py-2 text-small" data-testid="speculative-options">
            <Select
              aria-label="Speculative candidates"
              value={String(candidates) as '2' | '3'}
              onChange={(v) => setCandidates(v === '3' ? 3 : 2)}
              options={CANDIDATE_OPTIONS}
              className="w-40"
              data-testid="speculative-candidates"
            />
            <span className="text-text-secondary">{SPECULATIVE_USAGE_NOTE}</span>
          </div>
        ) : null}

        {overnightMode ? (
          <OvernightPanel
            form={overnightForm}
            onChange={(patch) => setOvernight((f) => ({ ...f, ...patch }))}
            validation={overnightValidation}
            presetAgents={presetAgents}
            recommendation={recommendation.data?.mode ?? null}
          />
        ) : null}

        {preset === 'maximum' ? (
          <Notice tone="warning" title="Subscription usage" data-testid="maximum-warning">
            {MAXIMUM_PRESET_WARNING}
          </Notice>
        ) : null}

        {!overnightMode ? (
          <div className="flex flex-col gap-3 border-t pt-3">
            <button
              type="button"
              className="inline-flex w-fit items-center gap-1.5 text-small font-medium text-text-secondary hover:text-text-primary"
              aria-expanded={advancedOpen}
              aria-controls="composer-advanced"
              onClick={() => setAdvancedOpen((v) => !v)}
              data-testid="advanced-toggle"
            >
              <span aria-hidden="true" className="inline-block w-3 text-center">
                {advancedOpen ? '▾' : '▸'}
              </span>
              Advanced
              <span className="font-normal text-text-muted">planning, review and limits</span>
            </button>
            <div id="composer-advanced" hidden={!advancedOpen} className="flex flex-col gap-3">
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
                <div className="flex flex-col gap-0.5 rounded-md border-l-2 border-accent bg-surface-muted px-3 py-2 text-small" data-testid="planning-recommendation">
                  <div className="flex items-center gap-2">
                    <span className="text-text-secondary">Recommended planning mode:</span>
                    <span className="font-medium">{strategyWord(recommendation.data.mode)}</span>
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
                      <span className="text-text-muted">selected</span>
                    )}
                  </div>
                  <div className="text-text-secondary" title={recommendation.data.reasons.join(' ')}>
                    {planningWords(recommendation.data.mode)}
                  </div>
                </div>
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
            </div>
          </div>
        ) : null}

        {overnightMode ? (
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <span className="text-small text-text-muted" role="status">
              {overnightValidation.canStart ? 'Ready. You will be asked to confirm.' : (overnightValidation.errors.authorization ?? Object.values(overnightValidation.errors)[0])}
            </span>
            <Button
              variant="primary"
              disabled={!settings || !overnightValidation.canStart}
              onClick={() => {
                setOvernightError(null)
                setConfirmOpen(true)
              }}
              data-testid="overnight-start"
            >
              START OVERNIGHT RUN
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <span className="text-small text-text-muted">Ctrl+Enter to start</span>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!settings || (submitted && !!problem)}
              onClick={() => void submit()}
              data-testid="create-run"
            >
              Start mission
            </Button>
          </div>
        )}
        <OvernightConfirmDialog
          open={confirmOpen && overnightMode}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => void submitOvernight()}
          lines={summarizeOvernight(overnightForm)}
          loading={startOvernight.isPending}
          error={overnightError}
        />
      </div>
    </Card>
  )
}
