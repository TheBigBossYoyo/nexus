import type {
  PersistenceChange,
  PersistenceCoverage,
  PersistenceItem,
  PersistenceReport,
  PersistenceSnapshot,
  PersistenceSurface,
  PrivilegedCapability,
  PrivilegedOperationProposal,
} from '@shared/privilege'
import { redactText } from './policy'

/**
 * 0.9.1 (second review, L5): what an elevated operation leaves behind. Pure and deterministic: no I/O here, the
 * snapshots are taken elsewhere. A difference is what was seen between two snapshots, not proof the operation caused it.
 */

/** The capabilities that install, repair or uninstall: a snapshot is taken before and after each. */
export const PERSISTENCE_CAPABILITIES: ReadonlySet<PrivilegedCapability> = new Set<PrivilegedCapability>([
  'PROJECT_TOOLCHAIN_INSTALL',
  'KNOWN_DEPENDENCY_MACHINE_INSTALL',
  'PROJECT_TOOLCHAIN_REPAIR',
  'APP_INSTALL_TEST',
  'APP_UNINSTALL_TEST',
])

type Expected = PrivilegedOperationProposal['expected']

const SURFACE_ORDER: PersistenceSurface[] = ['SERVICE', 'SCHEDULED_TASK', 'RUN_KEY', 'STARTUP_FOLDER']
const SURFACE_LABEL: Record<PersistenceSurface, string> = {
  SERVICE: 'service',
  SCHEDULED_TASK: 'scheduled task',
  RUN_KEY: 'run value',
  STARTUP_FOLDER: 'startup file',
}
const ATTR_LABEL: Record<string, string> = { startType: 'start', binaryPath: 'binary', actions: 'actions', data: 'data' }
const MAX_LINES = 40

const key = (surface: PersistenceSurface, id: string): string => `${surface}\u0000${id.toLowerCase()}`
const state = (coverage: PersistenceCoverage, surface: PersistenceSurface) => coverage[surface]?.state ?? 'COMPLETE'

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k])
}

function index(items: PersistenceItem[]): Map<string, PersistenceItem> {
  const map = new Map<string, PersistenceItem>()
  for (const item of items) map.set(key(item.surface, item.id), item)
  return map
}

function normRegistry(value: string): string {
  return value
    .trim()
    .replace(/\//g, '\\')
    .replace(/^HKEY_LOCAL_MACHINE(?=\\|$)/i, 'HKLM')
    .toLowerCase()
}

/** Strict: the exact name or full path is declared (case-insensitive). A key or folder never covers what is under it. */
export function isExpected(change: Pick<PersistenceChange, 'surface' | 'id'>, expected: Expected): boolean {
  const id = change.id.toLowerCase()
  switch (change.surface) {
    case 'SERVICE':
    case 'SCHEDULED_TASK':
      return (expected.services ?? []).some((s) => s.toLowerCase() === id)
    case 'RUN_KEY': {
      const want = normRegistry(change.id)
      return (expected.registry ?? []).some((r) => normRegistry(r) === want)
    }
    case 'STARTUP_FOLDER':
      return (expected.files ?? []).some((f) => f.toLowerCase() === id)
  }
}

export function diffPersistence(before: PersistenceSnapshot, after: PersistenceSnapshot, expected: Expected): PersistenceReport {
  const b = index(before.items)
  const a = index(after.items)
  const changes: PersistenceChange[] = []
  const skipped: string[] = []

  for (const surface of SURFACE_ORDER) {
    const sb = state(before.coverage, surface)
    const sa = state(after.coverage, surface)
    if (sb === 'FAILED' || sb === 'TIMED_OUT' || sa === 'FAILED' || sa === 'TIMED_OUT') {
      skipped.push(surface)
      continue
    }
    if (sb === 'PARTIAL' || sa === 'PARTIAL') skipped.push(surface)
    const keys = new Set([...b.keys(), ...a.keys()].filter((k) => k.startsWith(`${surface}\u0000`)))
    for (const k of keys) {
      const x = b.get(k)
      const y = a.get(k)
      let change: PersistenceChange | null = null
      if (x && y) {
        if (!sameAttrs(x.attrs, y.attrs)) change = { surface, id: y.id, change: 'CHANGED', before: { ...x.attrs }, after: { ...y.attrs }, expected: false }
      } else if (y && sb !== 'PARTIAL') {
        change = { surface, id: y.id, change: 'ADDED', after: { ...y.attrs }, expected: false }
      } else if (x && sa !== 'PARTIAL') {
        change = { surface, id: x.id, change: 'REMOVED', before: { ...x.attrs }, expected: false }
      }
      if (change) {
        change.expected = isExpected(change, expected)
        changes.push(change)
      }
    }
  }

  changes.sort(
    (p, q) =>
      SURFACE_ORDER.indexOf(p.surface) - SURFACE_ORDER.indexOf(q.surface) ||
      (p.id.toLowerCase() < q.id.toLowerCase() ? -1 : p.id.toLowerCase() > q.id.toLowerCase() ? 1 : 0) ||
      p.change.localeCompare(q.change),
  )
  const unexpected = changes.filter((c) => !c.expected).length
  const note = [
    `${changes.length} difference(s) observed between two snapshots taken around the operation, ${unexpected} not declared in expected.`,
    'Differences are observed, not proven to be caused by the operation.',
    skipped.length ? `Coverage was not complete for: ${skipped.join(', ')}; absence there is not evidence of absence.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return { changes, coverageBefore: before.coverage, coverageAfter: after.coverage, unexpected, note }
}

function attrsText(attrs: Record<string, string> | undefined): string {
  return Object.keys(attrs ?? {})
    .sort()
    .map((k) => `${ATTR_LABEL[k] ?? k} ${attrs![k]}`)
    .join(', ')
}

export function persistenceObservedLines(report: PersistenceReport): string[] {
  const lines: string[] = []
  for (const c of report.changes) {
    const detail =
      c.change === 'ADDED' ? attrsText(c.after) : c.change === 'REMOVED' ? attrsText(c.before) : `${attrsText(c.before)} -> ${attrsText(c.after)}`
    const mark = c.expected ? 'expected (declared)' : 'UNEXPECTED (not declared)'
    lines.push(`Persistence (observed during the operation): ${SURFACE_LABEL[c.surface]} ${c.id} ${c.change}${detail ? ` (${detail})` : ''} — ${mark}`)
  }
  for (const surface of SURFACE_ORDER) {
    const sb = report.coverageBefore[surface]
    const sa = report.coverageAfter[surface]
    if ((sb && sb.state !== 'COMPLETE') || (sa && sa.state !== 'COMPLETE')) {
      const note = [sb?.note, sa?.note].filter(Boolean).join('; ')
      lines.push(
        `Persistence coverage (observed during the operation): ${SURFACE_LABEL[surface]} surface before ${sb?.state ?? 'COMPLETE'}, after ${sa?.state ?? 'COMPLETE'}${note ? ` (${note})` : ''} — no additions or removals inferred where incomplete`,
      )
    }
  }
  const redacted = lines.map(redactText)
  if (redacted.length <= MAX_LINES) return redacted
  return [...redacted.slice(0, MAX_LINES), `and ${redacted.length - MAX_LINES} more`]
}
