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
  facts: 5_000,
  evidence: 14_000,
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

/** Facts about a task's orchestration that the repository cannot show, read from durable NEXUS state. */
export interface OrchestrationEvidence {
  /**
   * Messages sent by the task's agents (repair children included) and messages routed to the task.
   * For the mission verifier: every message of the run, most recent first, direction 'sent'.
   */
  messages: { id: string; direction: 'sent' | 'received'; type: string; from: string; to: string; subject: string; at: string }[]
  /** Message records left out because of the cap (mission level). */
  omittedMessages?: number
  /** Messages received that were left out because of the cap. */
  omittedReceived?: number
  decisions: { id: string; title: string; at: string }[]
  proposals: { id: string; type: string; status: string; title: string; at: string }[]
  /** Everything below is optional: the canonical TaskEvidenceBuilder fills it, a section with no data is not rendered. */
  artifacts?: { id: string; kind: string; title: string; task: string }[]
  changedFiles?: { status: string; path: string; additions: number; deletions: number }[]
  commits?: { commit: string; branch: string; message: string; at: string; kind: 'created' | 'merged' }[]
  /** Latest check run of the task (NEXUS-executed commands; exit codes are authoritative). */
  checks?: { id: string; attempt: number; passed: boolean; at: string; commands: { name: string; command: string; exitCode: number | null; timedOut: boolean }[] }[]
  /** Result summaries of dependency tasks (agent-written) and handoff-type messages. */
  handoffs?: { kind: 'dependency_result' | 'handoff_message'; id: string; from: string; text: string }[]
  reviews?: {
    id: string
    attempt: number
    verdict: string
    at: string
    findings: { severity: string; title: string }[]
    omittedFindings: number
    arbitration: { accepted: number; rejected: number } | null
  }[]
  repairs?: { key: string; state: string; trigger: string; at: string }[]
  repairCycles?: number
  revisions?: { id: string; version: number; reason: string; at: string; relation: 'added' | 'changed' | 'referenced' }[]
  contextPacks?: { id: string; purpose: string; at: string }[]
  /** Items dropped by the builder's caps, per section. */
  omitted?: Partial<Record<'artifacts' | 'changedFiles' | 'commits' | 'checks' | 'handoffs' | 'reviews' | 'repairs' | 'revisions' | 'contextPacks' | 'decisions' | 'proposals', number>>
}

const EVIDENCE_ITEMS = 25
/** Longest agent-written field in an evidence line. */
export const EVIDENCE_FIELD_CHARS = 120

/** One line, no control characters, bounded: agent-written text can never start a record of its own. */
export function oneLine(text: string, max = EVIDENCE_FIELD_CHARS): string {
  // Control characters and every kind of whitespace (newlines, tabs, line separators) become one space.
  const flat = text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function evidenceGroup(title: string, items: string[], alreadyOmitted = 0): string {
  if (items.length === 0) return `${title}: none recorded.`
  const shown = items.slice(0, EVIDENCE_ITEMS)
  const omitted = items.length - shown.length + alreadyOmitted
  const more = omitted > 0 ? `\n[... ${omitted} more omitted ...]` : ''
  return `${title}:\n${shown.join('\n')}${more}`
}

const shortId = (id: string): string => oneLine(id, 12)

const messageRecord = (m: OrchestrationEvidence['messages'][number]): string =>
  `- record message ${shortId(m.id)}: [${oneLine(m.type, 40)}] from ${oneLine(m.from, 60)} to ${oneLine(m.to, 60)} at ${oneLine(m.at, 40)}, subject "${oneLine(m.subject)}"`

/** A group that is left out entirely when it has nothing to show. */
function optionalGroup(title: string, items: string[], alreadyOmitted = 0): string | null {
  return items.length === 0 && alreadyOmitted === 0 ? null : evidenceGroup(title, items, alreadyOmitted)
}

function renderDetailGroups(e: OrchestrationEvidence): (string | null)[] {
  const o = e.omitted ?? {}
  return [
    optionalGroup(
      'Task artifacts (kind and title only; titles are agent-written)',
      (e.artifacts ?? []).map((a) => `- record artifact ${shortId(a.id)}: [${oneLine(a.kind, 40)}] of task ${oneLine(a.task, 60)}, title "${oneLine(a.title)}"`),
      o.artifacts,
    ),
    optionalGroup(
      'Files changed (from the task branch diff)',
      (e.changedFiles ?? []).map((f) => `- ${oneLine(f.status, 12)} ${oneLine(f.path, 200)} (+${f.additions} -${f.deletions})`),
      o.changedFiles,
    ),
    optionalGroup(
      'Commits (recorded by NEXUS; messages are agent-written)',
      (e.commits ?? []).map((c) => `- record commit ${oneLine(c.commit, 12)} ${c.kind} on ${oneLine(c.branch, 80)} at ${oneLine(c.at, 40)}, message "${oneLine(c.message)}"`),
      o.commits,
    ),
    optionalGroup(
      'Check results (commands run by NEXUS; exit codes are authoritative)',
      (e.checks ?? []).map((c) => {
        const cmds = c.commands
          .map((m) => `${oneLine(m.name, 40)} \`${oneLine(m.command, 100)}\` ${m.timedOut ? 'timed out' : `exit ${m.exitCode ?? 'none'}`}`)
          .join('; ')
        return `- record checks ${shortId(c.id)}: attempt ${c.attempt} ${c.passed ? 'passed' : 'failed'} at ${oneLine(c.at, 40)}: ${cmds || '(no commands)'}`
      }),
      o.checks,
    ),
    optionalGroup(
      'Dependency handoffs (the quoted text is written by agents)',
      (e.handoffs ?? []).map((h) =>
        h.kind === 'handoff_message'
          ? `- record handoff message ${shortId(h.id)}: from ${oneLine(h.from, 60)}, subject "${oneLine(h.text)}"`
          : `- record dependency result ${shortId(h.id)}: task ${oneLine(h.from, 60)} reported "${oneLine(h.text, 240)}"`,
      ),
      o.handoffs,
    ),
    optionalGroup(
      'Reviews of this task (counts of findings raised; the findings that stand are listed separately)',
      (e.reviews ?? []).map((r) => {
        const arb = r.arbitration ? `, arbitration accepted ${r.arbitration.accepted} and rejected ${r.arbitration.rejected} findings` : ''
        // Counts only: a raw review can hold findings the arbiter (or the fail-safe rule) rejected, and naming
        // them here would hand rejected findings to the debugger and the verifier as if they stood.
        const bySeverity = new Map<string, number>()
        for (const f of r.findings) bySeverity.set(oneLine(f.severity, 20), (bySeverity.get(oneLine(f.severity, 20)) ?? 0) + 1)
        const counts = [...bySeverity].map(([severity, n]) => `${n} ${severity}`).join(', ')
        const more = r.omittedFindings > 0 ? ` (+${r.omittedFindings} more)` : ''
        return `- record review ${shortId(r.id)}: attempt ${r.attempt} ${oneLine(r.verdict, 30)} at ${oneLine(r.at, 40)}${arb}${counts ? `, findings raised: ${counts}${more}` : ', no findings'}`
      }),
      o.reviews,
    ),
    e.repairs && (e.repairs.length > 0 || (e.repairCycles ?? 0) > 0)
      ? evidenceGroup(
          `Repair history (${e.repairCycles ?? 0} repair cycles)`,
          e.repairs.map((r) => `- record repair task ${oneLine(r.key, 80)}: ${oneLine(r.state, 30)} at ${oneLine(r.at, 40)}, triggered by ${oneLine(r.trigger, 120)}`),
          o.repairs,
        )
      : null,
    optionalGroup(
      'Graph revisions touching this task',
      (e.revisions ?? []).map((r) => `- record revision ${shortId(r.id)}: version ${r.version} (${r.relation}) at ${oneLine(r.at, 40)}, reason "${oneLine(r.reason)}"`),
      o.revisions,
    ),
    optionalGroup(
      'Context packs built for this task',
      (e.contextPacks ?? []).map((p) => `- record context pack ${shortId(p.id)}: ${oneLine(p.purpose, 40)} at ${oneLine(p.at, 40)}`),
      o.contextPacks,
    ),
  ]
}

/**
 * Orchestration evidence section: one record per line, `- record <kind> <id>: ...`. The verifier cannot
 * see messages, decisions or graph proposals in the repository. Decision bodies and proposal reasons are
 * left out on purpose: they are the agents' own claims.
 */
export function renderOrchestrationEvidence(e: OrchestrationEvidence): string {
  return truncate(
    [
      'These lines are records from the NEXUS database. The existence of a record, its sender, recipient, type and time are authoritative. The quoted text is written by the agents themselves and is not evidence that anything in it is true. Criteria about code and files must still be verified in the repository.',
      evidenceGroup('Messages sent', e.messages.filter((m) => m.direction === 'sent').map(messageRecord), e.omittedMessages),
      evidenceGroup('Messages received', e.messages.filter((m) => m.direction === 'received').map(messageRecord), e.omittedReceived),
      evidenceGroup(
        'Decisions recorded',
        e.decisions.map((d) => `- record decision ${shortId(d.id)}: at ${oneLine(d.at, 40)}, title "${oneLine(d.title)}"`),
        e.omitted?.decisions,
      ),
      evidenceGroup(
        'Graph proposals made',
        e.proposals.map((p) => `- record proposal ${shortId(p.id)}: ${oneLine(p.type, 40)} (${oneLine(p.status, 40)}) at ${oneLine(p.at, 40)}, title "${oneLine(p.title)}"`),
        e.omitted?.proposals,
      ),
      ...renderDetailGroups(e),
    ]
      .filter((g): g is string => g !== null)
      .join('\n\n'),
    SECTION_LIMITS.evidence,
  )
}

/** The reviewer gets only what was sent, never why: subjects without bodies or reasoning. */
export function renderSentMessages(messages: OrchestrationEvidence['messages']): string | null {
  if (!messages.some((m) => m.direction === 'sent')) return null
  const lines = messages
    .filter((m) => m.direction === 'sent')
    .slice(0, EVIDENCE_ITEMS)
    .map((m) => `- record message ${shortId(m.id)}: [${oneLine(m.type, 40)}] to ${oneLine(m.to, 60)}, subject "${oneLine(m.subject)}"`)
  return truncate(
    `Messages this task's agents sent through NEXUS (recorded by NEXUS, not visible in the diff; the quoted subjects are agent-written and not evidence that anything in them is true):\n${lines.join('\n')}`,
    SECTION_LIMITS.evidence,
  )
}
