import type { ReactNode } from 'react'
import type { PlanDiff, PlannedMilestone, Program } from '@shared/program'
import { cn } from '../../lib/cn'
import { TONE_CLASSES } from '../../lib/status'
import { Badge, EditIcon, MinusIcon, PauseIcon, PlusIcon, StatusBadge, SwapIcon } from '../../components/ui'
import {
  healthInfo,
  planDiffRows,
  programStateInfo,
  type DiffGlyph,
  type HealthLevel,
} from './programsModel'

/** Small presentational pieces shared by the Programs list, page, Home and the plan views. */

export function ProgramStateBadge({
  program,
  className,
  testId,
}: {
  program: Pick<Program, 'state' | 'pauseReason'>
  className?: string
  testId?: string
}) {
  const info = programStateInfo(program.state, program.pauseReason)
  return (
    <span data-testid={testId} data-state={program.state} className="inline-flex">
      <StatusBadge status={info} {...(className ? { className } : {})} pulse={program.state === 'PLANNING' || program.state === 'REPLANNING'} />
    </span>
  )
}

export function HealthBadge({ level }: { level: HealthLevel }) {
  const info = healthInfo(level)
  return <Badge tone={info.tone}>{info.label}</Badge>
}

const GLYPHS: Record<DiffGlyph, ReactNode> = {
  plus: <PlusIcon size={12} />,
  minus: <MinusIcon size={12} />,
  pause: <PauseIcon size={12} />,
  edit: <EditIcon size={12} />,
  swap: <SwapIcon size={12} />,
}

/** A numbered, stable summary line: "Label: value". */
export function Meta({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <dt className="text-small text-text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** The visual diff of a plan revision. Each change carries an icon and a text label. */
export function PlanDiffList({
  diff,
  titleOf,
  testId,
}: {
  diff: PlanDiff
  titleOf: (key: string) => string | null
  testId?: string
}) {
  const rows = planDiffRows(diff, titleOf)
  if (rows.length === 0)
    return (
      <p className="m-0 text-small text-text-secondary" data-testid={testId}>
        No change to the remaining plan.
      </p>
    )
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Changes to the remaining plan" data-testid={testId}>
      {rows.map((r, i) => (
        <li
          key={`${r.kind}-${r.key ?? i}`}
          data-diff={r.kind}
          className="flex items-start gap-2 rounded-md border bg-surface px-2.5 py-1.5"
        >
          <span
            className={cn('mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm', TONE_CLASSES[r.tone].soft, TONE_CLASSES[r.tone].text)}
          >
            {GLYPHS[r.glyph]}
          </span>
          <span className={cn('w-[4.5rem] shrink-0 font-medium', TONE_CLASSES[r.tone].text)}>{r.label}</span>
          <span className="min-w-0 flex-1">
            {r.key ? (
              <span className="block">
                <span className="font-medium">{r.title ?? r.key}</span>{' '}
                <span className="font-mono text-code text-text-muted">{r.key}</span>
              </span>
            ) : null}
            {r.detail ? <span className="block text-small text-text-secondary">{r.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Compact list of proposed milestones: title, objective, criteria, dependencies. */
export function ProposedMilestones({ milestones, deferred }: { milestones: readonly PlannedMilestone[]; deferred?: readonly string[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Proposed milestones">
      {milestones.map((m, i) => (
        <li key={m.key} className="rounded-md border bg-surface px-3 py-2" data-testid={`proposed-${m.key}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum text-small text-text-muted">{i + 1}.</span>
            <span className="font-medium">{m.title}</span>
            <Badge tone="neutral">{m.complexity}</Badge>
            <Badge tone={m.risk === 'high' ? 'warning' : 'neutral'}>{m.risk} risk</Badge>
            {deferred?.includes(m.key) ? <Badge tone="waiting">Deferred</Badge> : null}
          </div>
          <p className="m-0 mt-1 text-text-secondary">{m.objective}</p>
          <ul className="m-0 mt-1 list-disc pl-5 text-small text-text-secondary">
            {m.acceptanceCriteria.map((c, j) => (
              <li key={j}>{c}</li>
            ))}
          </ul>
          {m.dependsOn.length > 0 ? (
            <p className="m-0 mt-1 text-small text-text-muted">
              Depends on <span className="font-mono text-code">{m.dependsOn.join(', ')}</span>
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

/** Block for a section heading inside a tab. */
export function SectionNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="m-0 text-small text-text-secondary" data-testid={testId}>
      {children}
    </p>
  )
}

export function Empty({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="m-0 rounded-lg border border-dashed px-4 py-6 text-center text-text-muted" data-testid={testId}>
      {children}
    </p>
  )
}
