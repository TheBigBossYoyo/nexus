import type {
  CompatibilityResult,
  ContractKind,
  CrossRepoDependency,
  CrossRepoTaskState,
  DependencyKind,
  ReleaseStep,
  RepositoryHealth,
  RepositoryRole,
  SurfaceChange,
  WorkspaceDecision,
  WorkspaceDetail,
  WorkspaceMemoryKind,
  WorkspaceMission,
  WorkspaceMissionState,
  WorkspaceSummary,
} from '@shared/workspace'
import { TERMINAL_WORKSPACE_MISSION_STATES } from '@shared/workspace'
import type { StatusInfo, Tone } from '../../lib/status'

/** Pure presentation rules for the Workspaces pages. No DOM, no clock. */

// ───────────────────────────── labels ─────────────────────────────

export const ROLE_LABEL: Record<RepositoryRole, string> = {
  library: 'Library',
  service: 'Service',
  application: 'Application',
  website: 'Website',
  documentation: 'Documentation',
  infrastructure: 'Infrastructure',
  other: 'Other',
}

export const DEPENDENCY_KIND_LABEL: Record<DependencyKind, string> = {
  imports: 'Imports',
  package_dependency: 'Package dependency',
  api_provider_consumer: 'API provider / consumer',
  schema: 'Schema',
  generated_client: 'Generated client',
  deployment: 'Deployment',
  documentation: 'Documentation',
}

export const CONTRACT_KIND_LABEL: Record<ContractKind, string> = {
  openapi: 'OpenAPI',
  json_schema: 'JSON Schema',
  typescript_api: 'TypeScript API',
  protobuf: 'Protobuf',
  database_schema: 'Database schema',
  event_schema: 'Event schema',
}

export const PROVENANCE_LABEL = { manifest: 'Manifest', contract: 'Contract', user: 'Added by you' } as const

export const MEMORY_KIND_LABEL: Record<WorkspaceMemoryKind, string> = {
  architecture: 'Architecture',
  contract: 'Contract',
  release_convention: 'Release convention',
  shared_decision: 'Shared decision',
  integration_hazard: 'Integration hazard',
}

export const REVIEW_MODE_LABEL = { standard: 'Standard review', dual: 'Dual review', auto: 'Automatic review' } as const
export const PRESET_LABEL = { eco: 'Eco', balanced: 'Balanced', maximum: 'Maximum' } as const

const humanize = (s: string) => {
  const t = s.replace(/[._]+/g, ' ').trim()
  return t.length === 0 ? s : t[0]!.toUpperCase() + t.slice(1)
}
export const decisionKindLabel = (kind: string): string => humanize(kind)

export const shortCommit = (commit: string | null | undefined): string => (commit ? commit.slice(0, 8) : '—')
export const shortHash = (hash: string | null | undefined): string => (hash ? hash.slice(0, 10) : '—')

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// ───────────────────────────── repositories ─────────────────────────────

export function healthInfo(h: RepositoryHealth): StatusInfo {
  switch (h.level) {
    case 'ok':
      return { label: 'Healthy', tone: 'success' }
    case 'attention':
      return { label: 'Needs attention', tone: 'warning' }
    default:
      return { label: 'Unknown', tone: 'neutral' }
  }
}

/** Overall health line of a workspace from its repositories. */
export function workspaceHealth(detail: Pick<WorkspaceDetail, 'repositories' | 'order'>): { level: 'ok' | 'attention' | 'unknown'; text: string } {
  const repos = detail.repositories
  if (repos.length === 0) return { level: 'unknown', text: 'No repositories are enrolled yet.' }
  const attention = repos.filter((r) => r.health.level === 'attention')
  const unknown = repos.filter((r) => r.health.level === 'unknown')
  if (!detail.order.ok) return { level: 'attention', text: `The repositories depend on each other in a cycle (${detail.order.cycle.join(', ')}).` }
  if (attention.length > 0) return { level: 'attention', text: `${attention.length} of ${plural(repos.length, 'repository', 'repositories')} need attention: ${attention.map((r) => r.key).join(', ')}.` }
  if (unknown.length > 0) return { level: 'unknown', text: `${unknown.length} of ${plural(repos.length, 'repository', 'repositories')} have no health information yet.` }
  return { level: 'ok', text: `All ${plural(repos.length, 'repository', 'repositories')} are healthy.` }
}

export function commandRows(c: { build: string | null; test: string | null; lint: string | null; typecheck: string | null }): { label: string; value: string | null }[] {
  return [
    { label: 'Build', value: c.build },
    { label: 'Test', value: c.test },
    { label: 'Lint', value: c.lint },
    { label: 'Typecheck', value: c.typecheck },
  ]
}

export function isAllowed(allowed: readonly string[], key: string): boolean {
  return allowed.includes(key)
}

/** The allowed list with one repository switched on or off. Order is kept stable (sorted). */
export function toggleAllowed(allowed: readonly string[], key: string, on: boolean): string[] {
  const set = new Set(allowed)
  if (on) set.add(key)
  else set.delete(key)
  return [...set].sort()
}

// ───────────────────────────── the graph ─────────────────────────────

export interface EdgeRow {
  id: string
  from: string
  to: string
  kind: string
  source: 'manifest' | 'contract' | 'user'
  sourceLabel: string
  detail: string
  file: string
  removable: boolean
}

/** One row per edge, repository ids replaced by keys. An edge to an unknown repository keeps its id. */
export function edgeRows(detail: Pick<WorkspaceDetail, 'repositories' | 'dependencies'>): EdgeRow[] {
  const keyOf = new Map(detail.repositories.map((r) => [r.id, r.key]))
  return detail.dependencies
    .map((d: CrossRepoDependency): EdgeRow => ({
      id: d.id,
      from: keyOf.get(d.fromRepositoryId) ?? d.fromRepositoryId,
      to: keyOf.get(d.toRepositoryId) ?? d.toRepositoryId,
      kind: DEPENDENCY_KIND_LABEL[d.kind],
      source: d.provenance.source,
      sourceLabel: PROVENANCE_LABEL[d.provenance.source],
      detail: d.provenance.detail,
      file: d.provenance.file ?? '—',
      removable: d.provenance.source === 'user',
    }))
    .sort((a, b) => (a.from + '\u0000' + a.to).localeCompare(b.from + '\u0000' + b.to))
}

export const NODE_W = 160
export const NODE_H = 44
export const COL_GAP = 96
export const ROW_GAP = 18
export const PAD = 12

export interface GraphNode {
  key: string
  level: number
  x: number
  y: number
}
export interface GraphLine {
  from: string
  to: string
  /** Start (the dependent's left side) and end (the provider's right side). */
  x1: number
  y1: number
  x2: number
  y2: number
  source: EdgeRow['source']
}
export type GraphLayout =
  | { ok: true; width: number; height: number; levels: number; nodes: GraphNode[]; lines: GraphLine[] }
  | { ok: false; cycle: string[] }

/**
 * Providers (level 0) on the left, their consumers to the right. Levels come from `order.levels`, so the
 * layout is exactly the dependency order the engine computed. A line runs from the dependent's left side to the
 * provider's right side, with the arrow head at the provider ("depends on"). A cycle has no layout.
 */
export function graphLayout(detail: Pick<WorkspaceDetail, 'repositories' | 'dependencies' | 'order'>): GraphLayout {
  const order = detail.order
  if (!order.ok) return { ok: false, cycle: order.cycle }
  const known = new Set(detail.repositories.map((r) => r.key))
  // Keys the engine did not place (a stale order) go in a last level rather than disappearing.
  const placed = new Set(order.levels.flat())
  const extra = [...known].filter((k) => !placed.has(k)).sort()
  const levels = [...order.levels.map((l) => l.filter((k) => known.has(k))), ...(extra.length > 0 ? [extra] : [])].filter((l) => l.length > 0)
  const tallest = Math.max(1, ...levels.map((l) => l.length))
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP
  const nodes: GraphNode[] = []
  levels.forEach((level, li) => {
    const colHeight = level.length * NODE_H + (level.length - 1) * ROW_GAP
    const top = PAD + (height - PAD * 2 - colHeight) / 2
    level.forEach((key, ri) => nodes.push({ key, level: li, x: PAD + li * (NODE_W + COL_GAP), y: top + ri * (NODE_H + ROW_GAP) }))
  })
  const at = new Map(nodes.map((n) => [n.key, n]))
  const keyOf = new Map(detail.repositories.map((r) => [r.id, r.key]))
  const lines: GraphLine[] = []
  for (const d of detail.dependencies) {
    const f = at.get(keyOf.get(d.fromRepositoryId) ?? '')
    const t = at.get(keyOf.get(d.toRepositoryId) ?? '')
    if (!f || !t || f.key === t.key) continue
    lines.push({ from: f.key, to: t.key, x1: f.x, y1: f.y + NODE_H / 2, x2: t.x + NODE_W, y2: t.y + NODE_H / 2, source: d.provenance.source })
  }
  return { ok: true, width: PAD * 2 + levels.length * NODE_W + (levels.length - 1) * COL_GAP, height, levels: levels.length, nodes, lines }
}

/** Cubic path between the ends of a line: leaves horizontally, arrives horizontally. */
export function linePath(l: Pick<GraphLine, 'x1' | 'y1' | 'x2' | 'y2'>): string {
  const dx = Math.max(24, Math.abs(l.x1 - l.x2) / 2)
  return `M ${l.x1} ${l.y1} C ${l.x1 - dx} ${l.y1}, ${l.x2 + dx} ${l.y2}, ${l.x2} ${l.y2}`
}

/** Text alternative of the picture, one sentence per level. */
export function graphSummary(detail: Pick<WorkspaceDetail, 'order'>): string {
  const o = detail.order
  if (!o.ok) return `Dependency cycle between ${o.cycle.join(', ')}; there is no dependency order.`
  if (o.levels.length === 0) return 'No repositories.'
  return o.levels.map((l, i) => `Level ${i + 1}${i === 0 ? ' (providers)' : ''}: ${l.join(', ')}`).join('. ') + '.'
}

// ───────────────────────────── contracts ─────────────────────────────

export type CompatIcon = 'check' | 'info' | 'alert' | 'help'
export function compatibilityInfo(level: CompatibilityResult['level']): { label: string; tone: Tone; icon: CompatIcon; meaning: string } {
  switch (level) {
    case 'identical':
      return { label: 'Identical', tone: 'success', icon: 'check', meaning: 'Nothing changed.' }
    case 'compatible':
      return { label: 'Compatible', tone: 'active', icon: 'info', meaning: 'Existing consumers keep working.' }
    case 'breaking':
      return { label: 'Breaking', tone: 'danger', icon: 'alert', meaning: 'Existing consumers can break.' }
    default:
      return { label: 'Unknown', tone: 'warning', icon: 'help', meaning: 'The contract could not be read, so compatibility is not known.' }
  }
}

const CHANGE_LABEL: Record<SurfaceChange['change'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  now_required: 'Now required',
  now_optional: 'Now optional',
}

export interface ChangeRow {
  path: string
  change: string
  beforeAfter: string
  breaking: boolean
  breakingLabel: 'Breaking' | 'Not breaking'
  why: string
}

export function changeRows(changes: readonly SurfaceChange[]): ChangeRow[] {
  return changes.map((c) => ({
    path: c.path,
    change: CHANGE_LABEL[c.change],
    beforeAfter: `${c.before ?? '(none)'} → ${c.after ?? '(none)'}`,
    breaking: c.breaking,
    breakingLabel: c.breaking ? 'Breaking' : 'Not breaking',
    why: c.why,
  }))
}

export interface VersionRow {
  id: string
  version: number
  hash: string
  commit: string
  elements: number
  parseError: string | null
  capturedAt: string
}

/** Newest first. */
export function versionRows(versions: readonly { id: string; version: number; hash: string; commit: string | null; surface: readonly unknown[]; parseError: string | null; capturedAt: string }[]): VersionRow[] {
  return [...versions]
    .sort((a, b) => b.version - a.version)
    .map((v) => ({ id: v.id, version: v.version, hash: shortHash(v.hash), commit: shortCommit(v.commit), elements: v.surface.length, parseError: v.parseError, capturedAt: v.capturedAt }))
}

/** One line for the outcome of a capture. */
export function captureText(created: boolean, version: number): string {
  return created ? `Captured version ${version}.` : `The file is the same as version ${version}; nothing new was recorded.`
}

// ───────────────────────────── missions ─────────────────────────────

export function missionStateInfo(state: WorkspaceMissionState): StatusInfo {
  switch (state) {
    case 'DRAFT':
      return { label: 'Draft', tone: 'neutral' }
    case 'PLANNING':
      return { label: 'Planning', tone: 'active' }
    case 'AWAITING_APPROVAL':
      return { label: 'Awaiting approval', tone: 'review' }
    case 'ACTIVE':
      return { label: 'Active', tone: 'active' }
    case 'VERIFYING':
      return { label: 'Verifying', tone: 'review' }
    case 'PAUSED':
      return { label: 'Paused', tone: 'waiting' }
    case 'WAITING_FOR_QUOTA':
      return { label: 'Waiting for usage limit', tone: 'waiting' }
    case 'BLOCKED':
      return { label: 'Blocked', tone: 'warning' }
    case 'COMPLETED':
      return { label: 'Completed', tone: 'success' }
    case 'FAILED':
      return { label: 'Failed', tone: 'danger' }
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'neutral' }
  }
}

export function taskStateInfo(state: CrossRepoTaskState): StatusInfo {
  switch (state) {
    case 'PLANNED':
      return { label: 'Planned', tone: 'neutral' }
    case 'READY':
      return { label: 'Ready', tone: 'neutral' }
    case 'RUNNING':
      return { label: 'Running', tone: 'active' }
    case 'COMPLETED':
      return { label: 'Completed', tone: 'success' }
    case 'FAILED':
      return { label: 'Failed', tone: 'danger' }
    case 'BLOCKED':
      return { label: 'Blocked', tone: 'warning' }
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'neutral' }
  }
}

export const isTerminalMission = (state: WorkspaceMissionState): boolean => TERMINAL_WORKSPACE_MISSION_STATES.includes(state)

/** A mission that is doing or about to do work. */
export const isActiveMission = (state: WorkspaceMissionState): boolean => !isTerminalMission(state) && state !== 'DRAFT'

export interface MissionActions {
  start: boolean
  pause: boolean
  resume: boolean
  cancel: boolean
  /** The plan waits for accept / reject. */
  decidePlan: boolean
  /** A completed mission can be prepared for release. */
  prepareRelease: boolean
}

export function missionActions(state: WorkspaceMissionState): MissionActions {
  return {
    start: state === 'DRAFT',
    pause: state === 'PLANNING' || state === 'ACTIVE' || state === 'VERIFYING',
    resume: state === 'PAUSED' || state === 'BLOCKED' || state === 'WAITING_FOR_QUOTA',
    cancel: !isTerminalMission(state),
    decidePlan: state === 'AWAITING_APPROVAL',
    prepareRelease: state === 'COMPLETED',
  }
}

export interface Notice {
  tone: 'warning' | 'danger' | 'active' | 'neutral' | 'success'
  title: string
  text: string
}

export function missionNotice(m: Pick<WorkspaceMission, 'state' | 'blockedReason' | 'error' | 'resumeState'>): Notice | null {
  switch (m.state) {
    case 'DRAFT':
      return { tone: 'neutral', title: 'Not started', text: 'The mission exists but nothing has run. Start it to have NEXUS plan the work across the repositories.' }
    case 'PLANNING':
      return { tone: 'active', title: 'Planning', text: 'A read-only session is planning which repositories change and in what order. Nothing has been changed yet.' }
    case 'AWAITING_APPROVAL':
      return { tone: 'neutral', title: 'Plan awaiting your approval', text: 'Review the plan below. Nothing runs in any repository until you accept it.' }
    case 'ACTIVE':
      return { tone: 'active', title: 'Working', text: 'Tasks run in dependency order: a repository waits for the repositories it depends on.' }
    case 'VERIFYING':
      return { tone: 'active', title: 'Verifying across repositories', text: 'Every repository is checked, and each changed contract is compared against its consumers.' }
    case 'PAUSED':
      return { tone: 'neutral', title: 'Paused', text: 'No new task starts while the mission is paused. Resume continues where it stopped.' }
    case 'WAITING_FOR_QUOTA':
      return { tone: 'neutral', title: 'Waiting for the usage limit to reset', text: 'This is not a failure. The mission continues by itself when the limit resets; you can also resume it yourself.' }
    case 'BLOCKED':
      return {
        tone: 'warning',
        title: 'Blocked',
        text: `${m.blockedReason ?? 'The mission cannot continue.'} Resume checks again and continues from where it stopped${m.resumeState ? ` (${missionStateInfo(m.resumeState).label.toLowerCase()})` : ''}.`,
      }
    case 'COMPLETED':
      return { tone: 'success', title: 'Completed', text: 'Every task finished and the cross-repository verification ran. The work is on result branches; nothing was merged or published.' }
    case 'FAILED':
      return { tone: 'danger', title: 'Failed', text: m.error ?? 'The mission failed. Completed tasks and their branches are kept.' }
    case 'CANCELLED':
      return { tone: 'neutral', title: 'Cancelled', text: 'The mission was cancelled. Completed tasks and their branches are kept.' }
  }
}

export function activeMissions(missions: readonly WorkspaceMission[]): WorkspaceMission[] {
  return missions.filter((m) => isActiveMission(m.state))
}

/** Newest first. */
export function sortMissions(missions: readonly WorkspaceMission[]): WorkspaceMission[] {
  return [...missions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** First line of a goal, cut for a list. */
export function goalPreview(goal: string, max = 140): string {
  const line = goal.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function inSyncLabel(inSync: boolean): string {
  return inSync ? 'In step' : 'Behind'
}

// ───────────────────────────── releases ─────────────────────────────

export const RELEASE_STATEMENT = 'Prepared only. NEXUS does not publish; release the repositories yourself in this order.'

export function versionChange(step: Pick<ReleaseStep, 'currentVersion' | 'nextVersion' | 'bump'>): string {
  const cur = step.currentVersion ?? 'no version'
  if (step.bump === 'none') return `${cur} (no change)`
  return `${cur} → ${step.nextVersion ?? 'no version'}`
}

export function releaseStateInfo(state: 'PREPARED' | 'CANCELLED'): StatusInfo {
  return state === 'PREPARED' ? { label: 'Prepared, not published', tone: 'review' } : { label: 'Cancelled', tone: 'neutral' }
}

// ───────────────────────────── decisions ─────────────────────────────

/** Newest first. */
export function sortDecisions(decisions: readonly WorkspaceDecision[]): WorkspaceDecision[] {
  return [...decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ───────────────────────────── list and Home ─────────────────────────────

export function workspaceCountsText(s: Pick<WorkspaceSummary, 'repositories' | 'contracts' | 'activeMissions'>): string {
  return `${plural(s.repositories, 'repository', 'repositories')} · ${plural(s.contracts, 'contract')} · ${plural(s.activeMissions, 'active mission')}`
}

/** Workspaces with work in flight, most active first. */
export function workspacesWithActiveMissions(rows: readonly WorkspaceSummary[]): WorkspaceSummary[] {
  return rows.filter((r) => r.activeMissions > 0).sort((a, b) => b.activeMissions - a.activeMissions || a.workspace.name.localeCompare(b.workspace.name))
}
