import { useMemo, useState } from 'react'
import { ARENA_BUDGET_PRESETS, type ArenaBudgetPreset, type ConcreteStrategy } from '@shared/v3'
import type { ArenaCaseSummary } from '@shared/v3-read'
import type { Preset } from '@shared/domain'
import { useArenaCases, useCreateCampaign, useImportCase, useTrustCase } from '../../lib/queries-v3'
import {
  Badge,
  Button,
  CodeBlock,
  Dialog,
  Field,
  Input,
  NumberField,
  SegmentedControl,
  Select,
} from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import {
  ARENA_STRATEGIES,
  STRATEGY_HINT,
  budgetLine,
  checkCampaign,
  strategyName,
  trialCount,
} from './arenaModel'

const MODEL_PRESETS: { value: Preset; label: string }[] = [
  { value: 'eco', label: 'Economy: faster, cheaper models' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'maximum', label: 'Maximum: strongest models' },
]

const needsReview = (c: ArenaCaseSummary) => c.case.origin !== 'builtin' && !c.version.trusted

/** Every command NEXUS will run for a case, in the order it runs them. */
function commandsOf(c: ArenaCaseSummary): string[] {
  const d = c.version.definition
  return [
    ...d.setup.map((s) => `setup: ${s}`),
    ...Object.entries(d.checks)
      .filter(([, v]) => !!v)
      .map(([k, v]) => `${k}: ${v}`),
    `hidden evaluation: ${d.hiddenEvaluation.command}`,
  ]
}

function ReviewPane({
  item,
  extra,
  onBack,
}: {
  item: ArenaCaseSummary
  extra?: string[]
  onBack: () => void
}) {
  const trust = useTrustCase()
  const commands = extra && extra.length > 0 ? extra : commandsOf(item)
  return (
    <div className="flex flex-col gap-3" data-testid="arena-review-commands">
      <p className="m-0 text-text-secondary">
        <span className="font-medium text-text-primary">{item.case.name}</span> is an imported case.
        Trusting it allows NEXUS to run the commands below on this machine. Read them first.
      </p>
      <CodeBlock wrap maxHeight={240}>
        {commands.join('\n')}
      </CodeBlock>
      <div className="flex justify-end gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button
          variant="primary"
          loading={trust.isPending}
          data-testid="arena-trust-case"
          onClick={() => trust.mutate({ caseVersionId: item.version.id }, { onSuccess: onBack })}
        >
          Trust
        </Button>
      </div>
    </div>
  )
}

export function NewCampaignDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const cases = useArenaCases()
  const create = useCreateCampaign()
  const importCase = useImportCase()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [strategies, setStrategies] = useState<Set<ConcreteStrategy>>(new Set(['SINGLE', 'BUILD']))
  const [reps, setReps] = useState(3)
  const [model, setModel] = useState<Preset>('balanced')
  const [budget, setBudget] = useState<ArenaBudgetPreset>('balanced')
  const [reviewing, setReviewing] = useState<{
    item: ArenaCaseSummary
    commands?: string[]
  } | null>(null)

  const list = cases.data ?? []
  const review = reviewing?.item
  const check = checkCampaign({
    name,
    cases: picked.size,
    strategies: strategies.size,
    repetitions: reps,
    preset: budget,
  })
  const trials = trialCount(picked.size, strategies.size, reps)
  const line = budgetLine(budget)
  const toggle = <T,>(set: Set<T>, v: T): Set<T> => {
    const n = new Set(set)
    if (n.has(v)) n.delete(v)
    else n.add(v)
    return n
  }

  const submit = (start: boolean) =>
    create.mutate(
      {
        name: name.trim(),
        caseIds: [...picked],
        strategies: ARENA_STRATEGIES.filter((s) => strategies.has(s)),
        repetitions: reps,
        modelPreset: model,
        budgetPreset: budget,
        start,
      },
      {
        onSuccess: (c) => {
          setName('')
          setPicked(new Set())
          onClose()
          onCreated(c.id)
        },
      },
    )

  const options = useMemo(() => MODEL_PRESETS, [])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={review ? 'Review commands' : 'New Arena campaign'}
      width={640}
      testId="arena-campaign-dialog"
      footer={
        review ? undefined : (
          <>
            <div
              className="mr-auto flex min-w-0 flex-col justify-center"
              data-testid="arena-trial-summary"
              role="status"
            >
              {check.error && (name || picked.size > 0) ? (
                <span className="text-small text-text-muted">{check.error}</span>
              ) : (
                <>
                  <span className="font-medium">
                    <span className="tnum">{trials}</span> trial{trials === 1 ? '' : 's'}
                  </span>
                  <span className="tnum text-small text-text-muted">
                    {picked.size} case{picked.size === 1 ? '' : 's'} × {strategies.size} strateg
                    {strategies.size === 1 ? 'y' : 'ies'} × {reps} rep{reps === 1 ? '' : 's'}
                  </span>
                </>
              )}
            </div>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              disabled={!check.ok}
              loading={create.isPending}
              onClick={() => submit(false)}
              data-testid="arena-create"
            >
              Create
            </Button>
            <Button
              variant="primary"
              disabled={!check.ok}
              loading={create.isPending}
              onClick={() => submit(true)}
              data-testid="arena-create-start"
            >
              Create and start
            </Button>
          </>
        )
      }
    >
      {review ? (
        <ReviewPane
          item={review}
          {...(reviewing?.commands ? { extra: reviewing.commands } : {})}
          onBack={() => setReviewing(null)}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Swarm vs Build on bugfixes"
                data-testid="arena-campaign-name"
                maxLength={120}
              />
            )}
          </Field>

          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 flex w-full items-center justify-between p-0 text-small font-medium text-text-secondary">
              <span>Cases</span>
              <Button
                size="sm"
                variant="ghost"
                loading={importCase.isPending}
                data-testid="arena-import-case"
                onClick={() =>
                  importCase.mutate(
                    {},
                    {
                      onSuccess: (r) => {
                        if (r) setReviewing({ item: r.summary, commands: r.commands })
                      },
                    },
                  )
                }
              >
                Import case…
              </Button>
            </legend>
            {cases.isPending ? (
              <BlockSkeleton rows={3} />
            ) : cases.isError ? (
              <ReadError error={cases.error} calm="Arena cases are not available yet." />
            ) : list.length === 0 ? (
              <p className="m-0 rounded-md border px-3 py-3 text-text-muted">
                No cases yet. Import a case folder to begin.
              </p>
            ) : (
              <ul
                className="m-0 max-h-44 list-none overflow-auto rounded-md border p-0"
                data-testid="arena-case-list"
              >
                {list.map((c) => {
                  const blocked = needsReview(c)
                  return (
                    <li
                      key={c.case.id}
                      className="flex items-center gap-3 border-b px-3 py-1.5 last:border-b-0"
                    >
                      <input
                        id={`case-${c.case.id}`}
                        type="checkbox"
                        className="size-3.5 accent-accent"
                        checked={picked.has(c.case.id)}
                        disabled={blocked}
                        onChange={() => setPicked((s) => toggle(s, c.case.id))}
                        data-testid={`arena-case-${c.case.id}`}
                      />
                      <label
                        htmlFor={`case-${c.case.id}`}
                        className={`min-w-0 flex-1 ${blocked ? 'text-text-muted' : ''}`}
                      >
                        <span className="block truncate font-medium">{c.case.name}</span>
                        <span className="text-small text-text-muted">
                          {c.case.category} · {c.case.complexity} complexity · {c.case.risk} risk
                        </span>
                      </label>
                      {blocked ? (
                        <>
                          <Badge tone="warning">Untrusted</Badge>
                          <Button
                            size="sm"
                            onClick={() => setReviewing({ item: c })}
                            data-testid={`arena-review-${c.case.id}`}
                          >
                            Review commands
                          </Button>
                        </>
                      ) : c.case.origin !== 'builtin' ? (
                        <Badge tone="neutral">Imported</Badge>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </fieldset>

          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 p-0 text-small font-medium text-text-secondary">
              Strategies
            </legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {ARENA_STRATEGIES.map((s) => (
                <label key={s} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-accent"
                    checked={strategies.has(s)}
                    onChange={() => setStrategies((x) => toggle(x, s))}
                    data-testid={`arena-strategy-${s}`}
                  />
                  <span className="font-medium">{strategyName(s)}</span>
                  <span className="truncate text-small text-text-muted">{STRATEGY_HINT[s]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Repetitions per case and strategy"
              hint="More repetitions narrow the interval."
            >
              {(id) => (
                <NumberField
                  id={id}
                  value={reps}
                  onChange={setReps}
                  min={1}
                  max={20}
                  data-testid="arena-repetitions"
                />
              )}
            </Field>
            <Field label="Model preset" hint="The same models for every strategy.">
              {(id) => (
                <Select
                  id={id}
                  value={model}
                  onChange={setModel}
                  options={options}
                  data-testid="arena-model-preset"
                />
              )}
            </Field>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-small font-medium text-text-secondary">Budget</span>
            <SegmentedControl
              label="Budget preset"
              value={budget}
              onChange={setBudget}
              options={ARENA_BUDGET_PRESETS.map((p) => ({
                value: p,
                label: budgetLine(p).label,
                testId: `arena-budget-${p}`,
              }))}
              className="self-start"
            />
            <span className="text-small text-text-muted" data-testid="arena-budget-summary">
              {line.summary}
            </span>
          </div>

          <p
            className="m-0 rounded-md border bg-surface-muted px-3 py-2 text-small text-text-secondary"
            data-testid="arena-usage-note"
          >
            Each trial runs real Claude sessions and counts toward your Claude usage. A usage limit
            pauses the campaign, and it resumes by itself.
          </p>
          {check.warning ? (
            <p className="m-0 text-small text-warning" role="status">
              {check.warning}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  )
}
