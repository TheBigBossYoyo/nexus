import type { AgentPurpose, Decision, MemoryEntry, Message, ReviewFinding, Run, Task } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import type { ContextPack, ContextPackEntry, ContextSourceKind, RepositoryFact } from '@shared/v2'
import { selectFactsForTask } from '@main/modules/intelligence'
import { buildContextPack, type ContextPackInput } from './context-builder'

/** Excluded candidates recorded per pack. Excluded entries explain the selection; they are never an inventory. */
export const MAX_EXCLUDED_ENTRIES = 30
/** Repository facts rendered into one prompt. */
export const FACT_LIMIT = 8

type Draft = Omit<ContextPackEntry, 'id' | 'packId'>

const COMMON_WORDS: ReadonlySet<string> = new Set(['that', 'this', 'with', 'from', 'into', 'will', 'should', 'must', 'each', 'have', 'also', 'then', 'when', 'than', 'they', 'them', 'there', 'their', 'what', 'which', 'your'])

function terms(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 4 && !COMMON_WORDS.has(t)) out.add(t)
  return out
}

/**
 * Full-text search ORs every word, so a stop word alone matches half the memory. An entry counts as relevant
 * when it names one of the task's files or shares a meaningful term with the task.
 */
function memoryRelevance(m: MemoryEntry, task: Task): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')
  const files = new Set(task.suggestedFiles.map(norm))
  const shared = m.filePaths.map(norm).find((f) => files.has(f))
  if (shared) return `Approved memory about the task's file ${shared}.`
  const own = terms(`${task.title} ${task.description} ${task.suggestedFiles.join(' ')}`)
  const common = [...terms(`${m.title} ${m.content} ${m.tags.join(' ')} ${m.filePaths.join(' ')}`)].filter((t) => own.has(t)).sort()
  return common.length > 0 ? `Approved memory sharing terms with the task: ${common.slice(0, 5).join(', ')}.` : null
}

const SIGNIFICANT: ReadonlySet<string> = new Set(['critical', 'high'])
const REVIEW_PURPOSES: ReadonlySet<AgentPurpose> = new Set<AgentPurpose>(['implement', 'diagnose'])

export interface ComposeContextInput {
  run: Run
  task: Task
  purpose: AgentPurpose
  /** The agent the pack is for, when it already exists. */
  agentId?: string | null
  missionCriteria: string[]
  /** Tasks this task depends on. */
  dependencies: Task[]
  /** Every task of the run (decisions are classified by the task that recorded them). */
  tasks: Task[]
  /** Every decision recorded in the run. */
  decisions: Decision[]
  /** Every fact of the project, stale ones included (they are recorded as excluded). */
  facts: RepositoryFact[]
  /** Approved memory the relevance search selected. */
  memorySelected: MemoryEntry[]
  /** Approved memory in scope that the search did not select. */
  memoryExcluded: MemoryEntry[]
  messages: Message[]
  repo: ContextPackInput['repo']
  /** Findings of the task's latest review that asked for changes (accepted ones only in a dual review). */
  priorReview: { reviewId: string; findings: ReviewFinding[] } | null
  extra?: ContextPackInput['extra']
  factLimit?: number
  /**
   * v0.7.1 (Context Engine V3): what the Context Graph adds. Given the ids of the facts and memory entries this
   * pack already shows, so that nothing is sent twice. Null leaves the pack exactly as V2 built it.
   */
  graph?: (shown: { factIds: ReadonlySet<string>; memoryIds: ReadonlySet<string> }) => { text: string; entries: { nodeId: string; title: string; reason: string; chars: number; included: boolean }[] } | null
}

export interface ComposedContext {
  prompt: string
  pack: ContextPack
}

const included = (section: string, sourceKind: ContextSourceKind, sourceId: string | null, title: string, reason: string, chars: number): Draft => ({
  section,
  sourceKind,
  sourceId,
  title,
  reason,
  included: true,
  chars,
})

const excluded = (section: string, sourceKind: ContextSourceKind, sourceId: string | null, title: string, reason: string, chars: number): Draft => ({
  section,
  sourceKind,
  sourceId,
  title,
  reason,
  included: false,
  chars,
})

function finishPack(
  drafts: Draft[],
  meta: { run: Run; task: Task | null; purpose: AgentPurpose; agentId: string | null; totalChars: number },
): ContextPack {
  const packId = newId()
  const kept = drafts.filter((d) => d.included)
  const dropped = drafts.filter((d) => !d.included).slice(0, MAX_EXCLUDED_ENTRIES)
  return {
    id: packId,
    runId: meta.run.id,
    taskId: meta.task?.id ?? null,
    agentId: meta.agentId,
    purpose: meta.purpose,
    totalChars: meta.totalChars,
    createdAt: nowIso(),
    entries: [...kept, ...dropped].map((d) => ({ ...d, id: newId(), packId })),
  }
}

/**
 * Compose the context an agent starts with. Every candidate source is considered; each gets an entry
 * saying why it was included or left out, and the included ones are rendered by the v0.1 builder.
 * Pure: it reads only what it is given.
 */
export function composeContext(input: ComposeContextInput): ComposedContext {
  const { task, purpose, run } = input
  const drafts: Draft[] = []
  const upstreamIds = new Set(input.dependencies.map((t) => t.id))
  const taskById = new Map(input.tasks.map((t) => [t.id, t]))

  drafts.push(included('Task', 'task', task.id, `${task.key}: ${task.title}`, `The task this ${purpose} session works on.`, task.description.length))
  const criteriaChars = [...task.acceptanceCriteria, ...input.missionCriteria].join('\n').length
  if (criteriaChars > 0) {
    drafts.push(
      included(
        'Acceptance criteria',
        'criteria',
        task.id,
        `${task.acceptanceCriteria.length} task and ${input.missionCriteria.length} mission criteria`,
        'What the task is judged against.',
        criteriaChars,
      ),
    )
  }

  // Dependency outputs.
  const dependencyOutputs: ContextPackInput['dependencyOutputs'] = []
  for (const dep of input.dependencies) {
    const title = `${dep.key}: ${dep.title}`
    if (dep.state === 'completed' && dep.resultSummary) {
      dependencyOutputs.push({ key: dep.key, title: dep.title, summary: dep.resultSummary })
      drafts.push(included('Results of dependency tasks', 'dependency_output', dep.id, title, 'Completed dependency: its result is input to this task.', dep.resultSummary.length))
    } else {
      drafts.push(
        excluded(
          'Results of dependency tasks',
          'dependency_output',
          dep.id,
          title,
          dep.state === 'completed' ? 'Completed dependency with no result summary.' : `Dependency is ${dep.state}; there is no result to hand over yet.`,
          0,
        ),
      )
    }
  }

  // Decisions: those of upstream tasks, of architects and run-level ones.
  const decisions: Decision[] = []
  for (const d of input.decisions) {
    const author = d.taskId ? taskById.get(d.taskId) : undefined
    const text = `${d.title}: ${d.decision} (why: ${d.rationale})`
    if (d.taskId === null) {
      decisions.push(d)
      drafts.push(included('Relevant decisions', 'decision', d.id, d.title, 'Run-level decision.', text.length))
    } else if (upstreamIds.has(d.taskId)) {
      decisions.push(d)
      drafts.push(included('Relevant decisions', 'decision', d.id, d.title, `Recorded by ${author?.key ?? 'a'} dependency of this task.`, text.length))
    } else if (author?.role === 'architect') {
      decisions.push(d)
      drafts.push(included('Relevant decisions', 'decision', d.id, d.title, `Design decision by architect task ${author.key}.`, text.length))
    } else {
      drafts.push(
        excluded('Relevant decisions', 'decision', d.id, d.title, `Recorded by ${author?.key ?? 'another task'}, which this task does not depend on and which is not an architect task.`, text.length),
      )
    }
  }

  // Repository facts: relevant by files and terms, within the budget; stale ones are never used.
  const live = input.facts.filter((f) => !f.stale)
  const ranked = selectFactsForTask(live, task, live.length)
  const limit = input.factLimit ?? FACT_LIMIT
  const rankedIds = new Set(ranked.map((s) => s.fact.id))
  const facts: RepositoryFact[] = []
  ranked.forEach(({ fact, reason }, index) => {
    const chars = fact.statement.length + fact.subject.length
    if (index < limit) {
      facts.push(fact)
      drafts.push(included('Repository intelligence', 'repository_fact', fact.id, `${fact.kind}: ${fact.subject}`, reason, chars))
    } else {
      drafts.push(excluded('Repository intelligence', 'repository_fact', fact.id, `${fact.kind}: ${fact.subject}`, `Relevant (${reason}) but over the section budget of ${limit} facts.`, chars))
    }
  })
  for (const fact of input.facts) {
    const title = `${fact.kind}: ${fact.subject}`
    const chars = fact.statement.length + fact.subject.length
    if (fact.stale) {
      drafts.push(excluded('Repository intelligence', 'repository_fact', fact.id, title, 'Stale: a supporting file changed since the fact was verified.', chars))
    } else if (!rankedIds.has(fact.id)) {
      drafts.push(excluded('Repository intelligence', 'repository_fact', fact.id, title, "Not relevant to this task's files or terms.", chars))
    }
  }

  // Project memory.
  const memory: MemoryEntry[] = []
  for (const m of input.memorySelected) {
    const why = memoryRelevance(m, task)
    if (why) {
      memory.push(m)
      drafts.push(included('Project memory', 'memory', m.id, m.title, why, m.content.length))
    } else {
      drafts.push(excluded('Project memory', 'memory', m.id, m.title, 'Matched the search only on common words: it shares no file or meaningful term with the task.', m.content.length))
    }
  }
  for (const m of input.memoryExcluded) {
    drafts.push(excluded('Project memory', 'memory', m.id, m.title, "Approved memory that does not match the task's title, description or files.", m.content.length))
  }

  // Context Graph (V3): the map, what is related to the task in any store, and how to read further.
  const graph = input.graph?.({ factIds: new Set(facts.map((f) => f.id)), memoryIds: new Set(memory.map((m) => m.id)) }) ?? null
  if (graph) {
    for (const e of graph.entries) drafts.push((e.included ? included : excluded)('Project knowledge', 'context_node', e.nodeId, e.title, e.reason, e.chars))
  }

  // Routed messages and the user's instructions.
  const peerMessages = input.messages.filter((m) => m.type !== 'user_instruction')
  for (const m of input.messages) {
    const instruction = m.type === 'user_instruction'
    drafts.push(
      included(
        instruction ? 'User instructions' : 'Messages from other agents',
        instruction ? 'user_instruction' : 'message',
        m.id,
        m.subject,
        instruction ? 'Instruction from the user, not yet delivered.' : `Routed to this task by ${m.fromLabel} and not yet delivered.`,
        m.body.length,
      ),
    )
  }

  drafts.push(
    included('Repository state', 'worktree', null, input.repo.branch || input.repo.worktreePath, 'Where the agent works and which checks apply.', input.repo.worktreePath.length + input.repo.branch.length),
  )

  // Findings of an earlier review of this task: only a new implementation or a diagnosis acts on them.
  const reviewFindings: ReviewFinding[] = []
  if (input.priorReview) {
    const { reviewId, findings } = input.priorReview
    for (const f of findings) {
      const title = `[${f.severity}] ${f.title}`
      const chars = f.description.length + f.evidence.length
      if (!REVIEW_PURPOSES.has(purpose)) {
        drafts.push(excluded('Review findings to address', 'review_finding', reviewId, title, `Not used by a ${purpose} session.`, chars))
      } else if (!SIGNIFICANT.has(f.severity)) {
        drafts.push(excluded('Review findings to address', 'review_finding', reviewId, title, 'Below high severity: not a blocking finding.', chars))
      } else {
        reviewFindings.push(f)
        drafts.push(included('Review findings to address', 'review_finding', reviewId, title, "Significant finding of the task's latest review, which requested changes.", chars))
      }
    }
  }

  const extra = input.extra
  if (extra?.failure) {
    drafts.push(included('Failure to address', 'failure', null, extra.failure.summary.slice(0, 120), 'The previous attempt failed; the cause must be diagnosed first.', extra.failure.details.length + extra.failure.summary.length))
  }
  if (extra?.handoff) {
    drafts.push(included('Handoff from previous session', 'handoff', null, 'Structured handoff', 'The previous session of this task was rotated.', JSON.stringify(extra.handoff).length))
  }

  const { prompt } = buildContextPack({
    run,
    task,
    purpose,
    missionCriteria: input.missionCriteria,
    dependencyOutputs,
    decisions,
    memory,
    facts,
    graphText: graph?.text ?? null,
    reviewFindings,
    messages: peerMessages,
    repo: input.repo,
    ...(extra ? { extra } : {}),
  })
  return { prompt, pack: finishPack(drafts, { run, task, purpose, agentId: input.agentId ?? null, totalChars: prompt.length }) }
}

/** One block of a prompt that was not composed by the engine (repair, resume): what it is and why it is there. */
export interface PromptBlock {
  section: string
  sourceKind: ContextSourceKind
  sourceId?: string | null
  title: string
  reason: string
  /** Characters of the block as rendered into the prompt. */
  chars: number
}

/** The pack of a prompt built elsewhere: every block is an included entry, so the prompt stays explainable. */
export function packForPrompt(input: {
  run: Run
  task: Task | null
  purpose: AgentPurpose
  agentId?: string | null
  prompt: string
  blocks: PromptBlock[]
}): ContextPack {
  const drafts = input.blocks.map((b) => included(b.section, b.sourceKind, b.sourceId ?? null, b.title, b.reason, b.chars))
  return finishPack(drafts, { run: input.run, task: input.task, purpose: input.purpose, agentId: input.agentId ?? null, totalChars: input.prompt.length })
}

/** The same pack with one more included block (a resume note prepended to a composed prompt). */
export function withBlock(composed: ComposedContext, block: PromptBlock, prompt: string): ComposedContext {
  const entry: ContextPackEntry = {
    id: newId(),
    packId: composed.pack.id,
    section: block.section,
    sourceKind: block.sourceKind,
    sourceId: block.sourceId ?? null,
    title: block.title,
    reason: block.reason,
    included: true,
    chars: block.chars,
  }
  return { prompt, pack: { ...composed.pack, totalChars: prompt.length, entries: [entry, ...composed.pack.entries] } }
}
