import type { ContextNode, ContextSpace } from '@shared/context-graph'
import { renderDetail, renderGraphSection, retrieve, type DetailExpansion } from '@main/modules/context-graph'
import type { BenchCase, BenchWorld } from './retrieval-benchmark'

/**
 * The navigation benchmark: how many `context_open` round trips a session needs before it holds the whole
 * text of every record its task cannot be done well without. The retrieval benchmark asks whether the right
 * records are selected; this one asks what reaching the rest costs, because in the one real graph-backed
 * mission of 0.7.1 the cost was not tokens of context but turns: six opens to walk from the root to one note.
 *
 * The reader is an oracle walker: it knows where each required record is and never opens a wrong branch. It
 * opens one path per call, from what its prompt already names down to the record, and stops as soon as the
 * record's text is in front of it. A real agent does at least this much (the real one also opened two empty
 * branches), so the figures are a lower bound for a tree walk, the same reader in every variant.
 *
 * Two sessions:
 *  - `planner`: has no task and no files. Before: the tools and nothing else. After: the map and what was
 *    retrieved for the request's text.
 *  - `task`: a worker with its context pack (the map, the selection for the task and its files). Retrieval is
 *    the same before and after; what changes is what an open returns.
 * Two tool behaviours: `level` (an open lists one level, as 0.7.1 did) and `batched` (an open returns the
 * branch with what is under it).
 */

export type NavSession = 'planner' | 'task'
export type NavVariant = 'before' | 'after'

export interface NavResult {
  case: string
  /** `context_open` calls until every required record's text is held. */
  calls: number
  /** Required records already whole in the prompt. */
  held: number
  required: number
  /** Selected records that rest on files the prompt does not name: each cost an open to learn them. */
  fileLookups: number
  /** Estimated tokens of the Context Graph section of the prompt (characters / 4); 0 when there is none. */
  sectionTokens: number
  /** Estimated tokens of the tool results the walk read. */
  resultTokens: number
}

const norm = (t: string): string => t.replace(/^\s*>\s?/gm, '').replace(/"/g, "'").replace(/\s+/g, ' ').trim()

function nodeOf(w: BenchWorld, ref: string): ContextNode {
  const key = w.pathOf.get(ref)
  if (!key) throw new Error(`benchmark reference does not resolve: ${ref}`)
  const at = key.indexOf(':')
  const kind = key.slice(0, at)
  const space = w.spaces.find((s) => s.kind === kind) as ContextSpace
  const node = w.h.repos.contextGraph.nodes.byPath(space, key.slice(at + 1))
  if (!node) throw new Error(`no node at ${key}`)
  return node
}

export function navigate(w: BenchWorld, c: BenchCase, session: NavSession, variant: NavVariant): NavResult {
  const { h } = w
  const stores = h.repos.contextGraph
  const primary: ContextSpace = { kind: 'project', id: h.project.id }
  const programId = c.program ? w.programId : null
  const visible = (n: ContextNode): boolean => !n.programId || n.programId === programId
  const text = `${c.title}\n${c.description}`

  // What the prompt holds before any tool call.
  let section = ''
  let selected: ContextNode[] = []
  const hasSection = session === 'task' || variant === 'after'
  if (hasSection) {
    const result = retrieve(stores, { spaces: w.spaces, programId, text, files: session === 'task' ? c.files : [], role: session === 'task' ? 'worker' : 'planner', risk: session === 'task' ? c.risk : 'medium', tokenBudget: 2_000 })
    section = renderGraphSection(stores, primary, result, { tools: true, programId }).text
    selected = result.nodes.map((r) => r.node)
  }
  // Before, a pack line named no file: learning what a selected record rests on took an open of it.
  const withFiles = selected.filter((n) => stores.sources.ofNode(n.id).some((s) => s.kind === 'file'))
  const fileLookups = variant === 'before' ? withFiles.length : withFiles.filter((n) => stores.sources.ofNode(n.id).filter((s) => s.kind === 'file').length > 6).length

  let seen = norm(section)
  const whole = (n: ContextNode): boolean => seen.includes(norm(n.summary).slice(0, 600))
  const opened = new Set<string>()
  let calls = 0
  let resultChars = 0
  const expansion: DetailExpansion = {
    childrenOf: (n) => {
      const under = h.graph.getChildren(n.id, w.spaces, { limit: 16 })
      return { children: under.children.filter(visible), total: under.total }
    },
    textOf: (n) => (visible(n) ? h.graph.originText(n) : null),
  }
  const open = (n: ContextNode): void => {
    if (opened.has(n.id)) return
    opened.add(n.id)
    calls++
    const detail = h.graph.detail(n.id, w.spaces)
    const out = renderDetail({ ...detail, children: detail.children.filter(visible), outgoing: detail.outgoing.filter((r) => visible(r.node)), incoming: detail.incoming.filter((r) => visible(r.node)) }, primary, variant === 'after' ? { expansion } : {})
    resultChars += out.length
    seen += ` ${norm(out)}`
  }

  const required = c.required.map((ref) => nodeOf(w, ref))
  const held = required.filter(whole).length
  for (const target of required) {
    if (whole(target)) continue
    const chain = [...h.graph.getPath(target.id, w.spaces), target]
    // A prompt with the map names the branches of the project: the walk starts below the root. Another space
    // (a workspace) is not on the map, and a session without a section has no map at all.
    const mapped = hasSection && target.spaceKind === primary.kind && target.spaceId === primary.id
    for (const step of mapped ? chain.slice(1) : chain) {
      if (whole(target)) break
      open(step)
    }
  }
  return { case: c.key, calls, held, required: required.length, fileLookups, sectionTokens: Math.ceil(section.length / 4), resultTokens: Math.ceil(resultChars / 4) }
}

export interface NavSummary {
  session: NavSession
  variant: NavVariant
  cases: number
  calls: number
  meanCalls: number
  maxCalls: number
  /** Cases that need no open at all. */
  noCall: number
  /** Share of required records whole in the prompt before any call. */
  heldShare: number
  fileLookups: number
  meanSectionTokens: number
  meanResultTokens: number
}

export function summarizeNavigation(w: BenchWorld, cases: readonly BenchCase[], session: NavSession, variant: NavVariant): NavSummary {
  const rows = cases.map((c) => navigate(w, c, session, variant))
  const sum = (f: (r: NavResult) => number): number => rows.reduce((n, r) => n + f(r), 0)
  return {
    session,
    variant,
    cases: rows.length,
    calls: sum((r) => r.calls),
    meanCalls: sum((r) => r.calls) / Math.max(1, rows.length),
    maxCalls: Math.max(0, ...rows.map((r) => r.calls)),
    noCall: rows.filter((r) => r.calls === 0).length,
    heldShare: sum((r) => r.held) / Math.max(1, sum((r) => r.required)),
    fileLookups: sum((r) => r.fileLookups),
    meanSectionTokens: Math.round(sum((r) => r.sectionTokens) / Math.max(1, rows.length)),
    meanResultTokens: Math.round(sum((r) => r.resultTokens) / Math.max(1, rows.length)),
  }
}
