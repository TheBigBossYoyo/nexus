import type { CheckCommands, CommandResult, Handoff, Task } from '@shared/domain'

export interface PackSection {
  name: string
  chars: number
}

/** Per-section character budgets. Truncation is always marked in the text. */
export const SECTION_LIMITS = {
  task: 8_000,
  criteria: 4_000,
  decisions: 6_000,
  dependencies: 8_000,
  dependencyItem: 2_500,
  memory: 6_000,
  messages: 6_000,
  repo: 2_000,
  handoff: 6_000,
  failure: 10_000,
  instructions: 3_000,
  patch: 60_000,
  diffStat: 4_000,
  checks: 8_000,
  checkItem: 3_000,
  profile: 3_000,
  plan: 12_000,
  findings: 12_000,
  feedback: 6_000,
} as const

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const omitted = text.length - max
  return `${text.slice(0, max)}\n[... truncated: ${omitted} more characters omitted ...]`
}

/** Keeps the end of the text (command output matters most at the tail). */
export function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text
  const omitted = text.length - max
  return `[... truncated: ${omitted} earlier characters omitted ...]\n${text.slice(text.length - max)}`
}

export function bullets(items: readonly string[]): string {
  return items.map((i) => `- ${i}`).join('\n')
}

/** Joins entries within a budget; entries that do not fit are dropped with an explicit count. */
export function boundedList(entries: string[], max: number, noun: string): string {
  const kept: string[] = []
  let used = 0
  for (const e of entries) {
    if (used + e.length > max && kept.length > 0) break
    kept.push(e.length > max ? truncate(e, max) : e)
    used += e.length + 2
  }
  const dropped = entries.length - kept.length
  const body = kept.join('\n\n')
  return dropped > 0 ? `${body}\n\n[... ${dropped} more ${noun} omitted ...]` : body
}

export interface RawSection {
  name: string
  body: string | null | undefined
}

/** Renders non-empty sections as markdown; empty ones are omitted entirely. */
export function assemble(sections: RawSection[]): { prompt: string; sections: PackSection[] } {
  const present = sections.filter((s): s is { name: string; body: string } => {
    return typeof s.body === 'string' && s.body.trim().length > 0
  })
  return {
    prompt: present.map((s) => `## ${s.name}\n${s.body}`).join('\n\n'),
    sections: present.map((s) => ({ name: s.name, chars: s.body.length })),
  }
}

function renderCommandResult(r: CommandResult): string {
  const status = r.timedOut
    ? 'TIMED OUT'
    : r.exitCode === 0
      ? 'PASSED'
      : `FAILED (exit ${r.exitCode ?? 'none'})`
  return `### ${r.name}: ${status}\n$ ${r.command}\n${truncateHead(r.output.trim(), SECTION_LIMITS.checkItem)}`
}

export function renderChecks(results: readonly CommandResult[]): string | null {
  if (results.length === 0) return null
  return boundedList(results.map(renderCommandResult), SECTION_LIMITS.checks, 'check results')
}

export function renderCheckCommands(c: CheckCommands): string {
  return (['build', 'test', 'lint', 'typecheck'] as const)
    .map((k) => `${k}: ${c[k] ?? '(none)'}`)
    .join('\n')
}

export function renderTaskSpec(
  task: Pick<Task, 'key' | 'title' | 'description' | 'suggestedFiles'>,
): string {
  const parts = [`Task ${task.key}: ${task.title}`, '', task.description]
  if (task.suggestedFiles.length > 0) {
    parts.push('', 'Expected files (a hint, not a limit):', bullets(task.suggestedFiles))
  }
  return truncate(parts.join('\n'), SECTION_LIMITS.task)
}

export function criteriaSection(
  task: Pick<Task, 'acceptanceCriteria'>,
  mission: readonly string[],
): string | null {
  const parts: string[] = []
  if (task.acceptanceCriteria.length > 0) {
    parts.push('Task criteria:', bullets(task.acceptanceCriteria))
  }
  if (mission.length > 0) {
    if (parts.length > 0) parts.push('')
    parts.push('Mission criteria:', bullets(mission))
  }
  return parts.length > 0 ? truncate(parts.join('\n'), SECTION_LIMITS.criteria) : null
}

export function renderHandoff(h: Handoff): string | null {
  const groups: [string, string[]][] = [
    ['Completed work', h.completedWork],
    ['Commits', h.commits],
    ['Files changed', h.filesChanged],
    ['Unresolved issues', h.unresolvedIssues],
    ['Important findings', h.importantFindings],
    ['Next steps', h.nextSteps],
  ]
  const parts = groups.filter(([, v]) => v.length > 0).map(([k, v]) => `${k}:\n${bullets(v)}`)
  return parts.length > 0 ? truncate(parts.join('\n\n'), SECTION_LIMITS.handoff) : null
}
