import type { ReactNode } from 'react'
import type { CompatibilityResult, WorkspaceMissionState } from '@shared/workspace'
import { AlertIcon, Badge, CheckIcon, InfoIcon, StatusBadge, XIcon } from '../../components/ui'
import { cn } from '../../lib/cn'
import { compatibilityInfo, missionStateInfo, type CompatIcon } from './workspacesModel'

/** Small presentational pieces shared by the Workspaces pages. State always carries text and an icon or dot. */

export function MissionStateBadge({
  state,
  testId,
}: {
  state: WorkspaceMissionState
  testId?: string
}) {
  return (
    <span data-testid={testId} data-state={state} className="inline-flex">
      <StatusBadge
        status={missionStateInfo(state)}
        pulse={state === 'PLANNING' || state === 'ACTIVE' || state === 'VERIFYING'}
      />
    </span>
  )
}

const COMPAT_ICON: Record<CompatIcon, ReactNode> = {
  check: <CheckIcon size={11} />,
  info: <InfoIcon size={11} />,
  alert: <AlertIcon size={11} />,
  help: (
    <span aria-hidden="true" className="text-[11px] font-bold leading-none">
      ?
    </span>
  ),
}

/** Level badge of a compatibility result: icon and text, never colour alone. */
export function CompatBadge({
  level,
  testId,
}: {
  level: CompatibilityResult['level']
  testId?: string
}) {
  const info = compatibilityInfo(level)
  return (
    <span data-testid={testId} data-level={level} className="inline-flex">
      <Badge tone={info.tone}>
        {COMPAT_ICON[info.icon]}
        {info.label}
      </Badge>
    </span>
  )
}

export function PassBadge({
  passed,
  passedLabel = 'Passed',
  failedLabel = 'Failed',
}: {
  passed: boolean
  passedLabel?: string
  failedLabel?: string
}) {
  return (
    <Badge tone={passed ? 'success' : 'danger'}>
      {passed ? <CheckIcon size={11} /> : <XIcon size={11} />}
      {passed ? passedLabel : failedLabel}
    </Badge>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cn('rounded-sm bg-surface-hover px-1 py-px font-mono text-code', className)}>
      {children}
    </code>
  )
}

/** A labelled heading inside a tab. */
export function H3({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="m-0 text-caption font-medium uppercase tracking-wide text-text-muted">
      {children}
    </h3>
  )
}

/** Plain styled table frame. Real table, scoped headers. */
export function Table({
  caption,
  children,
  testId,
}: {
  caption: string
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-surface" data-testid={testId}>
      <table className="w-full min-w-[640px] border-collapse text-left text-small">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  )
}
export const Th = ({ children }: { children: ReactNode }) => (
  <th
    scope="col"
    className="border-b bg-surface-muted px-3 py-1.5 text-caption font-medium text-text-muted"
  >
    {children}
  </th>
)
export const Td = ({ children, className }: { children: ReactNode; className?: string }) => (
  <td className={cn('border-b px-3 py-1.5 align-top', className)}>{children}</td>
)
