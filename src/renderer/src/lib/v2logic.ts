import type { ApprovalRequest, Review, Run, Task, TaskState } from '@shared/domain'
import type {
  ContextPack,
  ContextPackEntry,
  FactKind,
  GraphRevision,
  GraphSnapshot,
  GraphSnapshotTask,
  PerformanceStat,
  RepositoryFact,
} from '@shared/v2'
import type { Tone } from './status'

// ───────────────────────────── plan version and revisions ─────────────────────────────

/** Latest graph revision by version, or null when the run has none (v0.1 runs and runs before approval). */
export function latestRevision(revisions: readonly GraphRevision[]): GraphRevision | null {
  let best: GraphRevision | null = null
  for (const r of revisions) if (!best || r.version > best.version) best = r
  return best
}

/** The plan version shown in the header: "v1" when no revision exists. */
export function planVersion(revisions: readonly GraphRevision[]): number {
  return latestRevision(revisions)?.version ?? 1
}

export function sortRevisions(revisions: readonly GraphRevision[]): GraphRevision[] {
  return [...revisions].sort((a, b) => a.version - b.version)
}

/**
 * Task id → the version of the revision that introduced it. Version 1 is the approved plan, so its tasks get no marker;
 * repair tasks are created by the pipeline rather than by a plan change and are excluded.
 */
export function addedInRevision(revisions: readonly GraphRevision[]): Map<string, number> {
  const out = new Map<string, number>()
  const sorted = sortRevisions(revisions)
  const known = new Set<string>()
  for (const rev of sorted) {
    for (const t of rev.snapshot.tasks) {
      if (known.has(t.id)) continue
      known.add(t.id)
      if (rev.version > 1 && t.kind !== 'repair') out.set(t.id, rev.version)
    }
  }
  return out
}

/** Task id → version of the revision whose snapshot first shows it cancelled (it was not cancelled in the previous one). */
export function cancelledInRevision(revisions: readonly GraphRevision[]): Map<string, number> {
  const out = new Map<string, number>()
  const sorted = sortRevisions(revisions)
  const prevState = new Map<string, TaskState>()
  for (const rev of sorted) {
    for (const t of rev.snapshot.tasks) {
      const before = prevState.get(t.id)
      if (t.state === 'cancelled' && before !== undefined && before !== 'cancelled' && !out.has(t.id)) out.set(t.id, rev.version)
      prevState.set(t.id, t.state)
    }
  }
  return out
}

export interface TaskChange {
  taskId: string
  key: string
  /** Human-readable "field: before → after" lines. */
  changes: string[]
}

export interface DependencyChange {
  /** The task that waits. */
  taskKey: string
  /** The prerequisite. */
  dependsOnKey: string
}

export interface RevisionDiff {
  addedTasks: GraphSnapshotTask[]
  removedTasks: GraphSnapshotTask[]
  changedTasks: TaskChange[]
  addedDependencies: DependencyChange[]
  removedDependencies: DependencyChange[]
}

export function isEmptyDiff(d: RevisionDiff): boolean {
  return (
    d.addedTasks.length === 0 &&
    d.removedTasks.length === 0 &&
    d.changedTasks.length === 0 &&
    d.addedDependencies.length === 0 &&
    d.removedDependencies.length === 0
  )
}

/** Difference between two snapshots, matched by task id. Dependencies are reported with task keys. */
export function diffSnapshots(from: GraphSnapshot, to: GraphSnapshot): RevisionDiff {
  const fromById = new Map(from.tasks.map((t) => [t.id, t]))
  const toById = new Map(to.tasks.map((t) => [t.id, t]))
  const keyOf = (id: string) => toById.get(id)?.key ?? fromById.get(id)?.key ?? id

  const addedTasks = to.tasks.filter((t) => !fromById.has(t.id)).sort(byKey)
  const removedTasks = from.tasks.filter((t) => !toById.has(t.id)).sort(byKey)

  const changedTasks: TaskChange[] = []
  for (const after of to.tasks) {
    const before = fromById.get(after.id)
    if (!before) continue
    const changes: string[] = []
    if (before.state !== after.state) changes.push(`state: ${before.state} → ${after.state}`)
    if (before.priority !== after.priority) changes.push(`priority: ${before.priority} → ${after.priority}`)
    if (before.title !== after.title) changes.push(`title: ${before.title} → ${after.title}`)
    if (before.role !== after.role) changes.push(`role: ${before.role} → ${after.role}`)
    if (changes.length > 0) changedTasks.push({ taskId: after.id, key: after.key, changes })
  }
  changedTasks.sort((a, b) => a.key.localeCompare(b.key))

  const pair = (d: { taskId: string; dependsOnTaskId: string }) => `${d.taskId}\u0000${d.dependsOnTaskId}`
  const fromDeps = new Map(from.dependencies.map((d) => [pair(d), d]))
  const toDeps = new Map(to.dependencies.map((d) => [pair(d), d]))
  const toChange = (d: { taskId: string; dependsOnTaskId: string }): DependencyChange => ({
    taskKey: keyOf(d.taskId),
    dependsOnKey: keyOf(d.dependsOnTaskId),
  })
  const byDep = (a: DependencyChange, b: DependencyChange) =>
    a.taskKey.localeCompare(b.taskKey) || a.dependsOnKey.localeCompare(b.dependsOnKey)
  const addedDependencies = [...toDeps].filter(([k]) => !fromDeps.has(k)).map(([, d]) => toChange(d)).sort(byDep)
  const removedDependencies = [...fromDeps].filter(([k]) => !toDeps.has(k)).map(([, d]) => toChange(d)).sort(byDep)

  return { addedTasks, removedTasks, changedTasks, addedDependencies, removedDependencies }
}

function byKey(a: GraphSnapshotTask, b: GraphSnapshotTask): number {
  return a.key.localeCompare(b.key)
}

/** Task ids a selected revision added, changed (state/priority/title/role) or removed relative to the one before it. */
export interface RevisionHighlight {
  added: ReadonlySet<string>
  changed: ReadonlySet<string>
  /** Present in the previous snapshot but not in this one. */
  removed: ReadonlySet<string>
}

export function highlightRevision(revisions: readonly GraphRevision[], version: number): RevisionHighlight {
  const sorted = sortRevisions(revisions)
  const idx = sorted.findIndex((r) => r.version === version)
  const current = sorted[idx]
  const empty: RevisionHighlight = { added: new Set(), changed: new Set(), removed: new Set() }
  if (!current) return empty
  const previous = sorted[idx - 1]
  if (!previous) return { ...empty, added: new Set(current.snapshot.tasks.map((t) => t.id)) }
  const d = diffSnapshots(previous.snapshot, current.snapshot)
  return {
    added: new Set(d.addedTasks.map((t) => t.id)),
    changed: new Set(d.changedTasks.map((t) => t.taskId)),
    removed: new Set(d.removedTasks.map((t) => t.id)),
  }
}

// ───────────────────────────── mission health ─────────────────────────────

export type HealthLevel = 'ok' | 'attention' | 'at_risk' | 'done' | 'stopped'

export interface Health {
  level: HealthLevel
  label: string
  tone: Tone
  /** The durable facts behind the level, in plain words. Empty when everything is nominal. */
  reasons: string[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Health from durable counts only: no scores, no weighting. Worst applicable level wins. */
export function deriveHealth(
  run: Pick<Run, 'state' | 'pauseReason'>,
  tasks: readonly Pick<Task, 'state' | 'blockedReason'>[],
  pendingApprovals: readonly Pick<ApprovalRequest, 'id'>[],
): Health {
  if (run.state === 'completed') return { level: 'done', label: 'Completed', tone: 'success', reasons: [] }
  if (run.state === 'cancelled') return { level: 'stopped', label: 'Cancelled', tone: 'neutral', reasons: [] }
  const failed = tasks.filter((t) => t.state === 'failed').length
  const blocked = tasks.filter((t) => t.state === 'blocked' || t.blockedReason !== null).length
  const approvals = pendingApprovals.length
  const reasons: string[] = []
  if (run.state === 'failed') reasons.push('run failed')
  if (failed > 0) reasons.push(plural(failed, 'failed task'))
  if (blocked > 0) reasons.push(plural(blocked, 'blocked task'))
  if (approvals > 0) reasons.push(plural(approvals, 'pending approval'))
  if (run.state === 'paused') reasons.push(`paused${run.pauseReason ? ` (${run.pauseReason})` : ''}`)
  if (run.state === 'failed' || failed > 0) return { level: 'at_risk', label: 'At risk', tone: 'danger', reasons }
  if (reasons.length > 0) return { level: 'attention', label: 'Needs attention', tone: 'waiting', reasons }
  return { level: 'ok', label: 'On track', tone: 'success', reasons }
}

// ───────────────────────────── context packs ─────────────────────────────

export interface ContextSection {
  section: string
  entries: ContextPackEntry[]
  includedChars: number
  includedCount: number
  excludedCount: number
}

/** Entries grouped by prompt section, in first-seen order; within a section included entries come first. */
export function groupPackSections(pack: Pick<ContextPack, 'entries'>): ContextSection[] {
  const order: string[] = []
  const bySection = new Map<string, ContextPackEntry[]>()
  for (const e of pack.entries) {
    let list = bySection.get(e.section)
    if (!list) {
      list = []
      bySection.set(e.section, list)
      order.push(e.section)
    }
    list.push(e)
  }
  return order.map((section) => {
    const all = bySection.get(section) ?? []
    const entries = [...all.filter((e) => e.included), ...all.filter((e) => !e.included)]
    const included = entries.filter((e) => e.included)
    return {
      section,
      entries,
      includedChars: included.reduce((n, e) => n + e.chars, 0),
      includedCount: included.length,
      excludedCount: entries.length - included.length,
    }
  })
}

// ───────────────────────────── repository intelligence ─────────────────────────────

export const FACT_GROUPS = [
  { id: 'modules', label: 'Module map', kinds: ['module'] },
  { id: 'commands', label: 'Commands', kinds: ['command'] },
  { id: 'architecture', label: 'Architecture and boundaries', kinds: ['boundary', 'interface', 'import_relation', 'generated_path', 'test_mapping'] },
  { id: 'entry_points', label: 'Entry points', kinds: ['entry_point'] },
  { id: 'dependencies', label: 'Dependencies', kinds: ['dependency', 'language', 'framework'] },
  { id: 'hot_files', label: 'Hot files', kinds: ['hot_file'] },
  { id: 'hazards', label: 'Hazards and decisions', kinds: ['hazard', 'decision'] },
] as const satisfies readonly { id: string; label: string; kinds: readonly FactKind[] }[]

export type FactGroupId = (typeof FACT_GROUPS)[number]['id']

export interface FactGroup {
  id: FactGroupId
  label: string
  facts: RepositoryFact[]
}

/** Non-empty groups in display order. Within a group: fresh before stale, then by subject. */
export function groupFacts(facts: readonly RepositoryFact[]): FactGroup[] {
  const groups: FactGroup[] = []
  for (const g of FACT_GROUPS) {
    const kinds: readonly FactKind[] = g.kinds
    const members = facts
      .filter((f) => kinds.includes(f.kind))
      .sort((a, b) => Number(a.stale) - Number(b.stale) || a.subject.localeCompare(b.subject))
    if (members.length > 0) groups.push({ id: g.id, label: g.label, facts: members })
  }
  return groups
}

// ───────────────────────────── performance ─────────────────────────────

/** Whole-percent rate with its sample count, e.g. "67% (n=6)". Never more precision than a whole percent. */
export function formatRate(rate: number, samples: number): string {
  if (!Number.isFinite(rate)) return `— (n=${samples})`
  return `${Math.round(Math.min(1, Math.max(0, rate)) * 100)}% (n=${samples})`
}

export function insufficientLabel(stat: Pick<PerformanceStat, 'samples'>, minSamples: number): string {
  return `insufficient samples (n=${stat.samples} < ${minSamples})`
}

export function performanceRowKey(s: Pick<PerformanceStat, 'role' | 'model' | 'category'>): string {
  return `${s.role}|${s.model}|${s.category}`
}

// ───────────────────────────── review arbitration ─────────────────────────────

export interface ArbitrationDecisionView {
  findingIndex: number
  accepted: boolean
  reason: string
  /** Title of the finding at that index of the review, when it exists. */
  findingTitle: string | null
}

export interface ArbitrationView {
  summary: string
  decisions: ArbitrationDecisionView[]
  accepted: number
  rejected: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * The arbiter's result when the review row carries one (an `arbitration` field shaped like ArbiterOutput).
 * Returns null otherwise, so v0.1 reviews and reviews that skipped the arbiter render unchanged.
 */
export function readArbitration(review: Review): ArbitrationView | null {
  const raw: unknown = (review as unknown as Record<string, unknown>)['arbitration']
  if (!isRecord(raw) || !Array.isArray(raw['decisions'])) return null
  const decisions: ArbitrationDecisionView[] = []
  for (const d of raw['decisions'] as unknown[]) {
    if (!isRecord(d)) continue
    const idx = d['findingIndex']
    const accepted = d['accepted']
    const reason = d['reason']
    if (typeof idx !== 'number' || typeof accepted !== 'boolean' || typeof reason !== 'string') continue
    decisions.push({ findingIndex: idx, accepted, reason, findingTitle: review.findings[idx]?.title ?? null })
  }
  const summary = typeof raw['summary'] === 'string' ? raw['summary'] : ''
  const accepted = decisions.filter((d) => d.accepted).length
  return { summary, decisions, accepted, rejected: decisions.length - accepted }
}
