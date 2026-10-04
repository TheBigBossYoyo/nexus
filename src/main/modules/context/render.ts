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
  messages: {
    id: string
    direction: 'sent' | 'received'
    type: string
    from: string
    to: string
    subject: string
    at: string
    /** Bounded excerpt of the body, for messages the task SENT only (agent-written). */
    body?: string
  }[]
  /** 'task' (default) or 'run' (mission verifier). */
  scope?: 'task' | 'run'
  /** What the implementing agent(s) reported as the result (agent-written). Raw text, capped by the builder. */
  results?: { task: string; text: string; omittedChars: number }[]
  /** Top-level tasks whose result was left out of `results` (mission scope). */
  omittedResults?: number
  /** Message records left out because of the cap (mission level). */
  omittedMessages?: number
  /** Messages received that were left out because of the cap. */
  omittedReceived?: number
  /** `text` is the decision and its rationale as the agent recorded them (agent-written, bounded). */
  decisions: { id: string; title: string; at: string; text?: string }[]
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
    /** Findings the reviewer raised, by severity. Titles are deliberately not carried: a raw review can hold rejected findings. */
    raised: { severity: string; count: number }[]
    raisedTotal: number
    /** Set on an arbiter row: the findings that stand after arbitration, by severity, and how many were rejected. */
    arbitration: { standing: { severity: string; count: number }[]; standingTotal: number; rejected: number } | null
    /** A raw reviewer row of an attempt that an arbiter row settled: its raw findings are not authoritative. */
    arbitrated: boolean
  }[]
  repairs?: { key: string; state: string; trigger: string; at: string }[]
  repairCycles?: number
  revisions?: { id: string; version: number; reason: string; at: string; relation: 'added' | 'changed' | 'referenced' }[]
  contextPacks?: { id: string; purpose: string; at: string }[]
  /** Items dropped by the builder's caps, per section. */
  omitted?: Partial<Record<'artifacts' | 'changedFiles' | 'commits' | 'checks' | 'handoffs' | 'reviews' | 'repairs' | 'revisions' | 'contextPacks' | 'decisions' | 'proposals', number>>
}

/** Characters of the quoted result block (an excerpt of what the agent reported). */
export const RESULT_BLOCK_CHARS = 6_000
/** Longest agent-written field in an evidence line. */
export const EVIDENCE_FIELD_CHARS = 120

/**
 * One line, no control or format characters, bounded: agent-written text can never start a record of its
 * own. Double quotes become single quotes so text inside a quoted span cannot close it and forge fields.
 */
export function oneLine(text: string, max = EVIDENCE_FIELD_CHARS): string {
  // Format characters (zero-width, bidi controls) vanish; control characters and every kind of whitespace
  // (newlines, tabs, line separators) become one space.
  const flat = text.replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').replace(/"/g, "'").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Multi-line agent text as a quoted block: every line starts with `> ` (so no line can look like a NEXUS
 * record), control and format characters are gone, and the length is bounded with an explicit count of
 * what was left out. `alreadyOmitted` counts characters the caller dropped before handing the text over.
 */
export function quoteBlock(text: string, max: number, indent = '', alreadyOmitted = 0): string {
  const clean = text
    .replace(/\r\n?|[\p{Zl}\p{Zp}\x85]/gu, '\n')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const shown = clean.slice(0, max)
  const omitted = clean.length - shown.length + alreadyOmitted
  const lines = shown.split('\n').map((l) => `${indent}> ${l.trimEnd()}`.trimEnd())
  if (omitted > 0) lines.push(`${indent}[... ${omitted} more characters omitted ...]`)
  return lines.join('\n')
}

/** Characters one group may use; a group never silently drops anything, it says how many items it left out. */
const GROUP_BUDGET = 4_000

function evidenceGroup(title: string, items: string[], alreadyOmitted = 0, budget = GROUP_BUDGET): string {
  if (items.length === 0 && alreadyOmitted === 0) return `${title}: none recorded.`
  const shown: string[] = []
  let used = 0
  for (const item of items) {
    if (shown.length > 0 && used + item.length + 1 > budget) break
    shown.push(item)
    used += item.length + 1
  }
  const omitted = items.length - shown.length + alreadyOmitted
  const more = omitted > 0 ? `\n[... ${omitted} more omitted ...]` : ''
  return `${title}:\n${shown.join('\n')}${more}`
}

const shortId = (id: string): string => oneLine(id, 12)

const messageRecord = (m: OrchestrationEvidence['messages'][number]): string => {
  const line = `- record message ${shortId(m.id)}: [${oneLine(m.type, 40)}] from ${oneLine(m.from, 60)} to ${oneLine(m.to, 60)} at ${oneLine(m.at, 40)}, subject "${oneLine(m.subject)}"`
  return m.body ? `${line}\n  body excerpt (agent-written):\n${quoteBlock(m.body, 700, '  ')}` : line
}

/** A group that is left out entirely when it has nothing to show. */
function optionalGroup(title: string, items: string[], alreadyOmitted = 0, budget = GROUP_BUDGET): string | null {
  return items.length === 0 && alreadyOmitted === 0 ? null : evidenceGroup(title, items, alreadyOmitted, budget)
}

const severityCounts = (c: { severity: string; count: number }[]): string => c.map((x) => `${x.count} ${oneLine(x.severity, 20)}`).join(', ')

/**
 * NEXUS-generated facts first (they are authoritative and short), then what the agent reported, then the
 * long agent-authored lists. Every group has its own budget, so a long list can never push a later group out.
 */
function factGroups(e: OrchestrationEvidence): (string | null)[] {
  const o = e.omitted ?? {}
  return [
    optionalGroup(
      'Check results (commands run by NEXUS; exit codes are authoritative)',
      (e.checks ?? []).map((c) => {
        const cmds = c.commands
          .map((m) => `${oneLine(m.name, 40)} \`${oneLine(m.command, 100)}\` ${m.timedOut ? 'timed out' : `exit ${m.exitCode ?? 'none'}`}`)
          .join('; ')
        return `- record checks ${shortId(c.id)}: attempt ${c.attempt} ${c.passed ? 'passed' : 'failed'} at ${oneLine(c.at, 40)}: ${cmds || '(no commands)'}`
      }),
      o.checks,
      3_000,
    ),
    optionalGroup(
      'Commits (recorded by NEXUS, newest first; messages are agent-written)',
      (e.commits ?? []).map((c) => `- record commit ${oneLine(c.commit, 12)} ${c.kind} on ${oneLine(c.branch, 80)} at ${oneLine(c.at, 40)}, message "${oneLine(c.message)}"`),
      o.commits,
      3_000,
    ),
    optionalGroup(
      'Files changed (from the task branch diff)',
      (e.changedFiles ?? []).map((f) => `- ${oneLine(f.status, 12)} ${oneLine(f.path, 200)} (+${f.additions} -${f.deletions})`),
      o.changedFiles,
      4_000,
    ),
    optionalGroup(
      'Reviews of this task (counts of findings; the findings that stand are listed separately)',
      (e.reviews ?? []).map((r) => {
        // Counts only: a raw review can hold findings the arbiter (or the fail-safe rule) rejected, and naming
        // them here would hand rejected findings to the debugger and the verifier as if they stood.
        const head = `- record review ${shortId(r.id)}: attempt ${r.attempt} ${oneLine(r.verdict, 30)} at ${oneLine(r.at, 40)}`
        if (r.arbitration) {
          const standing = r.arbitration.standingTotal > 0 ? severityCounts(r.arbitration.standing) : 'none'
          return `${head}, arbitrated: findings standing ${standing}; rejected ${r.arbitration.rejected}`
        }
        if (r.arbitrated) return `${head}, raised ${r.raisedTotal} (see arbitration)`
        return `${head}${r.raisedTotal > 0 ? `, findings raised: ${severityCounts(r.raised)}` : ', no findings'}`
      }),
      o.reviews,
      3_500,
    ),
    e.repairs && (e.repairs.length > 0 || (e.repairCycles ?? 0) > 0)
      ? evidenceGroup(
          `Repair history (${e.repairCycles ?? 0} repair cycles)`,
          e.repairs.map((r) => `- record repair task ${oneLine(r.key, 80)}: ${oneLine(r.state, 30)} at ${oneLine(r.at, 40)}, triggered by ${oneLine(r.trigger, 120)}`),
          o.repairs,
          2_500,
        )
      : null,
    optionalGroup(
      'Dependency handoffs (the quoted text is written by agents)',
      (e.handoffs ?? []).map((h) =>
        h.kind === 'handoff_message'
          ? `- record handoff message ${shortId(h.id)}: from ${oneLine(h.from, 60)}, subject "${oneLine(h.text)}"`
          : `- record dependency result ${shortId(h.id)}: task ${oneLine(h.from, 60)} reported "${oneLine(h.text, 240)}"`,
      ),
      o.handoffs,
      4_000,
    ),
    optionalGroup(
      'Graph revisions touching this task',
      (e.revisions ?? []).map((r) => `- record revision ${shortId(r.id)}: version ${r.version} (${r.relation}) at ${oneLine(r.at, 40)}, reason "${oneLine(r.reason)}"`),
      o.revisions,
      2_500,
    ),
    optionalGroup(
      'Context packs built for this task',
      (e.contextPacks ?? []).map((p) => `- record context pack ${shortId(p.id)}: ${oneLine(p.purpose, 40)} at ${oneLine(p.at, 40)}`),
      o.contextPacks,
      1_500,
    ),
    optionalGroup(
      'Task artifacts (kind and title only; titles are agent-written)',
      (e.artifacts ?? []).map((a) => `- record artifact ${shortId(a.id)}: [${oneLine(a.kind, 40)}] of task ${oneLine(a.task, 60)}, title "${oneLine(a.title)}"`),
      o.artifacts,
      2_500,
    ),
  ]
}

/** What the agent said it did: a claim to check, never evidence. */
function resultGroup(e: OrchestrationEvidence): string | null {
  const results = e.results ?? []
  if (results.length === 0 && !e.omittedResults) return null
  const title =
    e.scope === 'run'
      ? "Results reported by the top-level tasks' agents (agent-written; claims to check, not evidence that they are true)"
      : "Result reported by the task's agent (agent-written; a claim to check, not evidence that it is true)"
  const perTask = e.scope === 'run' ? 1_500 : RESULT_BLOCK_CHARS
  const blocks = results.map((r) => `Result of task ${oneLine(r.task, 80)}:\n${quoteBlock(r.text, perTask, '', r.omittedChars)}`)
  const omitted = e.omittedResults ? `\n[... ${e.omittedResults} more task results omitted ...]` : ''
  return `${title}:\n${blocks.join('\n\n')}${omitted}`
}

/** Longest list of message records the renderer will print (the builder caps lower, so nothing it selected is cut here). */
const MESSAGE_GROUP_BUDGET = 60_000

/**
 * Orchestration evidence section: one record per line, `- record <kind> <id>: ...`. The verifier cannot
 * see messages, decisions, graph proposals or the result an agent reported in the repository. Decision
 * bodies and proposal reasons are left out on purpose: they are the agents' own claims.
 */
export function renderOrchestrationEvidence(e: OrchestrationEvidence): string {
  return [
    'These lines are records from the NEXUS database. The existence of a record, its sender, recipient, type and time are authoritative. The quoted text is written by the agents themselves and is not evidence that anything in it is true. Criteria about code and files must still be verified in the repository.',
    ...factGroups(e),
    resultGroup(e),
    evidenceGroup('Messages sent', e.messages.filter((m) => m.direction === 'sent').map(messageRecord), e.omittedMessages, MESSAGE_GROUP_BUDGET),
    evidenceGroup('Messages received', e.messages.filter((m) => m.direction === 'received').map(messageRecord), e.omittedReceived, MESSAGE_GROUP_BUDGET),
    evidenceGroup(
      'Decisions recorded',
      // A criterion can be about what was decided, so the recorded text is shown (quoted: it is the agent's own).
      e.decisions.map((d) => {
        const line = `- record decision ${shortId(d.id)}: at ${oneLine(d.at, 40)}, title "${oneLine(d.title)}"`
        return d.text ? `${line}\n  decision text (agent-written):\n${quoteBlock(d.text, 1_200, '  ')}` : line
      }),
      e.omitted?.decisions,
      12_000,
    ),
    evidenceGroup(
      'Graph proposals made',
      e.proposals.map((p) => `- record proposal ${shortId(p.id)}: ${oneLine(p.type, 40)} (${oneLine(p.status, 40)}) at ${oneLine(p.at, 40)}, title "${oneLine(p.title)}"`),
      e.omitted?.proposals,
      5_000,
    ),
  ]
    .filter((g): g is string => g !== null)
    .join('\n\n')
}

/** The reviewer gets only what was sent, never why: subjects without bodies or reasoning. `omitted` is the builder's omittedMessages. */
export function renderSentMessages(messages: OrchestrationEvidence['messages'], omitted = 0): string | null {
  const sent = messages.filter((m) => m.direction === 'sent')
  if (sent.length === 0) return null
  const group = evidenceGroup(
    "Messages this task's agents sent through NEXUS (recorded by NEXUS, not visible in the diff; the quoted subjects are agent-written and not evidence that anything in them is true)",
    sent.map((m) => `- record message ${shortId(m.id)}: [${oneLine(m.type, 40)}] to ${oneLine(m.to, 60)}, subject "${oneLine(m.subject)}"`),
    omitted,
    MESSAGE_GROUP_BUDGET,
  )
  return group
}
