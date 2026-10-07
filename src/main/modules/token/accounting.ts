import { estimateTokens, weakestBasis, type ComponentTokens, type RequestComponent, type TokenBasis } from '@shared/token'
import type { ContextPack } from '@shared/v2'
import type { RuntimeContextUsage } from '@main/modules/agent-runtime/types'

export type { RuntimeContextUsage }

/**
 * Request component accounting: what a session's context was made of.
 *
 * Two sources are combined and never confused:
 *  - the runtime's own breakdown (system prompt, tool definitions, memory files, and the conversation split
 *    into tool calls, tool results, assistant and user text). In `full` detail the runtime counted each
 *    category (`exact`); in `summary` detail it answered from local estimates (`estimated`);
 *  - NEXUS's estimate (characters / 4) of the parts of its own text: the role prompt inside the system
 *    prompt, and the sections of the context pack inside the user messages (`estimated`).
 */

/** Which component each section of a context pack belongs to. A section that is not listed is OTHER. */
const SECTION_COMPONENT: Record<string, RequestComponent> = {
  Task: 'TASK',
  'Resuming task': 'TASK',
  'Acceptance criteria': 'ACCEPTANCE_CRITERIA',
  'Results of dependency tasks': 'DEPENDENCY_HANDOFF',
  'Handoff from previous session': 'DEPENDENCY_HANDOFF',
  'Relevant decisions': 'PROJECT_FACTS',
  'Repository intelligence': 'PROJECT_FACTS',
  'Project knowledge': 'CONTEXT_GRAPH',
  'Project memory': 'MEMORY',
  'Review findings to address': 'REVIEW_FINDINGS',
  'Messages from other agents': 'MESSAGES',
  'User instructions': 'MESSAGES',
  'Repository state': 'REPOSITORY_CONTEXT',
  Attempt: 'DYNAMIC_RUNTIME_STATE',
  'Failure to address': 'DYNAMIC_RUNTIME_STATE',
}

export function componentOfSection(section: string): RequestComponent {
  return SECTION_COMPONENT[section] ?? 'OTHER'
}

/** The pack's included entries, as estimated tokens per component. */
export function packComponents(pack: Pick<ContextPack, 'entries'> | null): ComponentTokens[] {
  if (!pack) return []
  const sums = new Map<RequestComponent, { chars: number; entries: number }>()
  for (const e of pack.entries) {
    if (!e.included) continue
    const c = componentOfSection(e.section)
    const cur = sums.get(c) ?? { chars: 0, entries: 0 }
    cur.chars += e.chars
    cur.entries++
    sums.set(c, cur)
  }
  return [...sums.entries()].map(([component, s]) => ({ component, tokens: Math.ceil(s.chars / 4), basis: 'estimated' as const, detail: `${s.entries} context pack ${s.entries === 1 ? 'entry' : 'entries'}` }))
}

export interface BreakdownInput {
  usage: RuntimeContextUsage | null
  pack: Pick<ContextPack, 'entries'> | null
  /** The role prompt NEXUS appended to the system prompt. */
  roleText: string
  /** The first user message, when no runtime breakdown exists. */
  promptText?: string
}

export interface Breakdown {
  components: ComponentTokens[]
  totalTokens: number
  maxTokens: number | null
  basis: TokenBasis
  model: string | null
}

const add = (out: ComponentTokens[], component: RequestComponent, tokens: number, basis: TokenBasis, detail: string): void => {
  if (tokens > 0) out.push({ component, tokens: Math.round(tokens), basis, detail })
}

/**
 * Decompose a session's context. With a runtime breakdown the total is the runtime's and every component
 * sums to it: NEXUS's estimates only split a runtime figure into parts, and what they cannot explain stays
 * in the runtime's own category. Without one, everything is an estimate of NEXUS's own text.
 */
export function buildBreakdown(input: BreakdownInput): Breakdown {
  const out: ComponentTokens[] = []
  const role = estimateTokens(input.roleText)
  const pack = packComponents(input.pack)
  const u = input.usage
  if (!u) {
    add(out, 'ROLE', role, 'estimated', 'Role prompt appended to the system prompt')
    out.push(...pack)
    const packTotal = pack.reduce((n, c) => n + c.tokens, 0)
    const prompt = input.promptText ? estimateTokens(input.promptText) : 0
    if (prompt > packTotal) add(out, 'OTHER', prompt - packTotal, 'estimated', 'First message outside the context pack sections')
    return { components: out, totalTokens: out.reduce((n, c) => n + c.tokens, 0), maxTokens: null, basis: 'estimated', model: null }
  }

  // `full` is counted by the runtime per category. `summary` is the runtime's own local estimate: on the real
  // runtime it reported 24.9k tokens for a request that processed 15.9k, so it is labelled an estimate.
  const basis: TokenBasis = u.detail === 'full' ? 'exact' : 'estimated'
  const sum = (xs: readonly { tokens: number }[]): number => xs.reduce((n, x) => n + x.tokens, 0)
  const used = u.categories.filter((c) => c.kind === 'used')
  const usedTotal = sum(used)

  // The structured lists say what each row is without reading its display name. A summary breakdown leaves
  // them empty; then the runtime's own rows are the only source and their names are read.
  const row = (...words: string[]): number => sum(used.filter((c) => words.every((w) => c.name.toLowerCase().includes(w))))
  const system = sum(u.systemPromptSections) || row('system', 'prompt')
  const tools = sum(u.systemTools) + sum(u.mcpTools.filter((t) => t.isLoaded !== false)) || row('tools')
  const memory = sum(u.memoryFiles) || row('memory')
  const messages = row('messages')
  // A message split that claims more than the window holds is not a split of this conversation: it is dropped.
  const split = u.messageBreakdown
  const splitTotal = split ? split.toolCallTokens + split.toolResultTokens + split.attachmentTokens + split.assistantMessageTokens + split.userMessageTokens : 0
  const mb = split && system + tools + memory + splitTotal <= Math.max(u.totalTokens, usedTotal) ? split : null
  const roleShare = Math.min(role, system)
  add(out, 'SYSTEM_CORE', system - roleShare, basis, "The runtime's system prompt")
  add(out, 'ROLE', roleShare, 'estimated', 'Role prompt appended to the system prompt (part of the system prompt figure)')
  add(out, 'TOOL_DEFINITIONS', tools, basis, `${u.systemTools.length} built-in and ${u.mcpTools.filter((t) => t.isLoaded !== false).length} loaded MCP tool definitions`)
  add(out, 'MEMORY', memory, basis, `${u.memoryFiles.length} memory files loaded by the runtime`)

  let attributed = system + tools + memory
  if (mb) {
    add(out, 'TOOL_RESULTS', mb.toolResultTokens, basis, 'Tool results in the conversation')
    add(out, 'HISTORY', mb.toolCallTokens + mb.assistantMessageTokens, basis, 'Assistant text and tool calls in the conversation')
    add(out, 'OTHER', mb.attachmentTokens, basis, 'Attachments')
    // The user messages hold the context pack; its sections are NEXUS's estimate inside the runtime's figure.
    let userLeft = mb.userMessageTokens
    for (const c of pack) {
      const share = Math.min(c.tokens, userLeft)
      if (share > 0) out.push({ ...c, tokens: share, detail: `${c.detail} (part of the user-message figure)` })
      userLeft -= share
    }
    add(out, 'MESSAGES', userLeft, basis, 'User messages outside the context pack sections')
    attributed += mb.toolResultTokens + mb.toolCallTokens + mb.assistantMessageTokens + mb.attachmentTokens + mb.userMessageTokens
  } else if (messages > 0) {
    // No usable split: the conversation is one figure. The pack's sections are estimated inside it.
    let left = messages
    for (const c of pack) {
      const share = Math.min(c.tokens, left)
      if (share > 0) out.push({ ...c, tokens: share, detail: `${c.detail} (part of the messages figure)` })
      left -= share
    }
    add(out, 'HISTORY', left, basis, 'Conversation, not split by the runtime')
    attributed += messages
  }
  // Whatever the runtime counted as used and the lists above did not name (skills, agents, a message figure without a split).
  const total = Math.max(u.totalTokens, usedTotal)
  add(out, 'OTHER', Math.max(0, total - attributed), basis, 'Counted by the runtime and not split further')
  // Merge duplicate components (MEMORY can come from the runtime and from the pack; OTHER from several places).
  const merged = new Map<string, ComponentTokens>()
  for (const c of out) {
    const key = `${c.component}\0${c.basis}`
    const prior = merged.get(key)
    if (prior) merged.set(key, { ...prior, tokens: prior.tokens + c.tokens, detail: `${prior.detail}; ${c.detail}` })
    else merged.set(key, c)
  }
  let components = [...merged.values()]
  // The runtime's lists can claim more than its total (a tool counted in two lists). Then no part is exact:
  // every part is scaled to the total and labelled an estimate.
  const claimed = components.reduce((n, c) => n + c.tokens, 0)
  if (claimed > total + components.length && total > 0) {
    components = components.map((c) => ({ ...c, tokens: Math.floor((c.tokens * total) / claimed), basis: 'estimated' as const, detail: `${c.detail}; scaled: the runtime's parts exceeded its total` })).filter((c) => c.tokens > 0)
  }
  // Rounding drift goes to the largest part, so the parts add up to the total exactly.
  const drift = total - components.reduce((n, c) => n + c.tokens, 0)
  const largest = components.reduce<ComponentTokens | null>((a, c) => (a === null || c.tokens > a.tokens ? c : a), null)
  if (drift !== 0 && largest && largest.tokens + drift > 0) largest.tokens += drift
  return { components, totalTokens: total, maxTokens: u.maxTokens, basis: weakestBasis(components.map((c) => c.basis)), model: u.model }
}

/** Shares for the composition chart: whole percentages that sum to 100, largest first. No decimal places: the inputs do not support them. */
export function composition(components: readonly ComponentTokens[]): { component: RequestComponent; tokens: number; percent: number }[] {
  const totals = new Map<RequestComponent, number>()
  for (const c of components) totals.set(c.component, (totals.get(c.component) ?? 0) + c.tokens)
  const total = [...totals.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const rows = [...totals.entries()].map(([component, tokens]) => ({ component, tokens, exact: (tokens / total) * 100 })).sort((a, b) => b.tokens - a.tokens)
  // Largest remainder, so the whole percentages add up to exactly 100.
  const floored = rows.map((r) => ({ ...r, percent: Math.floor(r.exact) }))
  let left = 100 - floored.reduce((n, r) => n + r.percent, 0)
  for (const r of [...floored].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))) {
    if (left <= 0) break
    r.percent++
    left--
  }
  return floored.map(({ component, tokens, percent }) => ({ component, tokens, percent }))
}
