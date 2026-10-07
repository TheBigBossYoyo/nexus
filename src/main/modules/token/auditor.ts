import { estimateTokens, type CacheMissCause, type CacheResult, type PromptCacheability } from '@shared/token'
import type { PrefixParts } from './registry'

/**
 * Deterministic checks on prompts and on cache behaviour. Nothing here removes or rewrites context: a
 * finding is a report. In particular, two passages that merely look alike are never treated as duplicates;
 * only identical text is.
 */

// ───────────────────────────── prompt audit ─────────────────────────────

export interface AuditBlock {
  /** What the block is, e.g. "role prompt", "Repository intelligence". */
  name: string
  text: string
  cacheability: PromptCacheability
  /** Where it is sent. */
  scope: 'system' | 'tools' | 'user'
}

export type AuditFindingKind = 'duplicate_paragraph' | 'dynamic_in_stable' | 'stable_after_volatile' | 'passing_output_spam' | 'repeated_file' | 'unused_tool_schema' | 'oversized_block'

export interface AuditFinding {
  kind: AuditFindingKind
  block: string
  detail: string
  /** Tokens the finding concerns. An estimate; never added up across findings (they can overlap). */
  tokenEstimate: number
}

export interface PromptAudit {
  totalTokens: number
  byScope: Record<AuditBlock['scope'], number>
  blocks: { name: string; scope: AuditBlock['scope']; cacheability: PromptCacheability; tokens: number; share: number }[]
  /** Tokens of the leading stable blocks of the system scope: the most that can be a shared prefix. */
  cacheablePrefixTokens: number
  findings: AuditFinding[]
}

/** Text that changes on every request. In a stable block any of these makes the whole block, and all after it, uncacheable. */
const VOLATILE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'an ISO timestamp', pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/ },
  { name: 'a UUID', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
  { name: 'an epoch time', pattern: /\b1[6-9]\d{11}\b/ },
  { name: 'an absolute Windows path', pattern: /\b[A-Za-z]:\\(?:Users|Temp|Windows)\\[^\s"']+/ },
  { name: 'a temporary directory', pattern: /(?:\/tmp\/|\\Temp\\|AppData\\Local\\Temp)[^\s"']+/ },
]

/** A paragraph shorter than this is too common ("Rules:") to report as a duplicate. */
const MIN_DUPLICATE_CHARS = 120
const PASS_LINE = /^\s*(?:✓|✔|√|ok\b|PASS\b|passed\b|\.{3,}|·+)\s*\S/i

export function auditPrompt(blocks: readonly AuditBlock[], options: { toolsUsed?: readonly string[]; toolSchemas?: readonly { name: string; tokens: number }[]; injectedFiles?: readonly string[] } = {}): PromptAudit {
  const findings: AuditFinding[] = []
  const byScope: PromptAudit['byScope'] = { system: 0, tools: 0, user: 0 }
  const sized = blocks.map((b) => ({ ...b, tokens: estimateTokens(b.text) }))
  const total = sized.reduce((n, b) => n + b.tokens, 0)
  for (const b of sized) byScope[b.scope] += b.tokens

  // Identical paragraphs in more than one place.
  const seen = new Map<string, string>()
  for (const b of sized) {
    for (const paragraph of b.text.split(/\n{2,}/)) {
      const p = paragraph.trim()
      if (p.length < MIN_DUPLICATE_CHARS) continue
      const first = seen.get(p)
      if (first === undefined) seen.set(p, b.name)
      else findings.push({ kind: 'duplicate_paragraph', block: b.name, detail: `The same ${p.length}-character paragraph is also in "${first}": "${p.slice(0, 80).replace(/\s+/g, ' ')}…"`, tokenEstimate: estimateTokens(p) })
    }
  }

  // Volatile text inside a block declared stable.
  for (const b of sized) {
    if (b.cacheability !== 'stable') continue
    for (const { name, pattern } of VOLATILE_PATTERNS) {
      const m = pattern.exec(b.text)
      if (m) findings.push({ kind: 'dynamic_in_stable', block: b.name, detail: `Declared stable but contains ${name} ("${m[0].slice(0, 60)}"): every request would have a different prefix.`, tokenEstimate: b.tokens })
    }
  }

  // A stable block that follows a volatile one in the same scope can never be in a shared prefix.
  let cacheablePrefixTokens = 0
  for (const scope of ['system', 'user'] as const) {
    let volatileSeen: string | null = null
    let leading = true
    for (const b of sized.filter((x) => x.scope === scope)) {
      if (b.cacheability === 'stable') {
        if (volatileSeen) findings.push({ kind: 'stable_after_volatile', block: b.name, detail: `Stable, but comes after "${volatileSeen}", which changes between requests.`, tokenEstimate: b.tokens })
        else if (leading && scope === 'system') cacheablePrefixTokens += b.tokens
      } else {
        volatileSeen ??= b.name
        leading = false
      }
    }
  }

  // Passing-test lines flooding a block.
  for (const b of sized) {
    const lines = b.text.split('\n')
    const passing = lines.filter((l) => PASS_LINE.test(l))
    if (passing.length >= 20 && passing.length / lines.length > 0.5) {
      findings.push({ kind: 'passing_output_spam', block: b.name, detail: `${passing.length} of ${lines.length} lines report a passing test.`, tokenEstimate: estimateTokens(passing.join('\n')) })
    }
    if (b.tokens > 12_000) findings.push({ kind: 'oversized_block', block: b.name, detail: `One block of about ${b.tokens} tokens.`, tokenEstimate: b.tokens })
  }

  // The same file injected more than once.
  const fileCounts = new Map<string, number>()
  for (const f of options.injectedFiles ?? []) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
  for (const [file, n] of fileCounts) if (n > 1) findings.push({ kind: 'repeated_file', block: file, detail: `${file} was put into context ${n} times.`, tokenEstimate: 0 })

  // Tool schemas that cost tokens and were never called.
  if (options.toolSchemas && options.toolsUsed) {
    const used = new Set(options.toolsUsed)
    for (const t of options.toolSchemas) if (!used.has(t.name) && t.tokens >= 200) findings.push({ kind: 'unused_tool_schema', block: t.name, detail: `The definition of ${t.name} was loaded and the tool was not called.`, tokenEstimate: t.tokens })
  }

  return {
    totalTokens: total,
    byScope,
    blocks: sized.map((b) => ({ name: b.name, scope: b.scope, cacheability: b.cacheability, tokens: b.tokens, share: total > 0 ? b.tokens / total : 0 })),
    cacheablePrefixTokens,
    findings,
  }
}

// ───────────────────────────── cache behaviour ─────────────────────────────

/** How a session's first request used the cache, from the three figures the runtime reports. */
export function classifyCacheResult(usage: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): CacheResult {
  const { cacheReadTokens: read, cacheWriteTokens: write } = usage
  if (read === 0 && write === 0) return 'none'
  if (read === 0) return 'write'
  // A small tail is always written (the first message); "read" means the prefix came from cache.
  if (read >= write * 2) return 'read'
  return 'partial'
}

/** How long a prefix is assumed to stay warm when the runtime does not say. The subscription default is one hour; five minutes is the floor every account has. */
export const ASSUMED_WARM_MS = 5 * 60_000

export interface CacheDiagnosisInput {
  result: CacheResult
  /** The parts of this session's prefix. */
  current: PrefixParts
  /** The last use of the very same prefix hash by another session, when there was one. */
  sameHash: { at: string; result: CacheResult } | null
  /** The prefix the same role used most recently, when it differs from this one. */
  previousForRole: PrefixParts | null
  at: string
  warmMs?: number
}

export interface CacheDiagnosis {
  expectedWarm: boolean
  cause: CacheMissCause | null
  /** Always `local_inference`: derived from NEXUS's own prefix hashes. The runtime gives a host no cache diagnosis. */
  causeBasis: 'local_inference' | null
  reuseDistanceMs: number | null
  explanation: string
}

/**
 * Why a session's first request wrote its prefix instead of reading it. A local inference from prefix hashes
 * and timing: the token figures are the runtime's, the reason is NEXUS's.
 */
export function diagnoseCache(input: CacheDiagnosisInput): CacheDiagnosis {
  const warmMs = input.warmMs ?? ASSUMED_WARM_MS
  const distance = input.sameHash ? Date.parse(input.at) - Date.parse(input.sameHash.at) : null
  const expectedWarm = distance !== null && distance >= 0 && distance <= warmMs
  if (input.result === 'read') return { expectedWarm, cause: null, causeBasis: null, reuseDistanceMs: distance, explanation: 'The prefix was read from cache.' }
  if (input.result === 'none') return { expectedWarm, cause: null, causeBasis: null, reuseDistanceMs: distance, explanation: 'The runtime reported no cache figures.' }

  if (input.sameHash) {
    if (distance !== null && distance > warmMs) {
      return { expectedWarm: false, cause: 'EXPIRED', causeBasis: 'local_inference', reuseDistanceMs: distance, explanation: `The same prefix was last used ${Math.round(distance / 60_000)} minutes ago, longer than the assumed cache lifetime.` }
    }
    // Same hash, recent, and still written: something NEXUS does not hash differs, i.e. the runtime's own dynamic sections.
    if (input.current.dynamic !== '') {
      return { expectedWarm: true, cause: 'DYNAMIC_PREFIX_CONTAMINATION', causeBasis: 'local_inference', reuseDistanceMs: distance, explanation: 'The prefix NEXUS controls is unchanged, but the system prompt holds per-session text (the working directory), so no other session can share it.' }
    }
    return { expectedWarm: true, cause: 'UNKNOWN', causeBasis: 'local_inference', reuseDistanceMs: distance, explanation: 'The prefix NEXUS controls is unchanged and was used recently, yet it was written again.' }
  }

  const prev = input.previousForRole
  if (!prev) return { expectedWarm: false, cause: 'FIRST_USE', causeBasis: 'local_inference', reuseDistanceMs: null, explanation: 'First session with this prefix.' }
  const changed = (['tools', 'model', 'effort', 'flags', 'system', 'dynamic'] as const).filter((k) => prev[k] !== input.current[k])
  const first = changed[0]
  const map: Record<(typeof changed)[number], { cause: CacheMissCause; text: string }> = {
    tools: { cause: 'TOOLS_CHANGED', text: 'The tool set differs from the one this role used last.' },
    model: { cause: 'MODEL_CHANGED', text: 'The model differs from the one this role used last; caches are per model.' },
    effort: { cause: 'EFFORT_CHANGED', text: 'The effort level differs from the one this role used last.' },
    flags: { cause: 'SYSTEM_CHANGED', text: 'A runtime option that changes the rendered prefix differs.' },
    system: { cause: 'SYSTEM_CHANGED', text: 'The role prompt differs from the one this role used last.' },
    dynamic: { cause: 'DYNAMIC_PREFIX_CONTAMINATION', text: 'The system prompt holds per-session text (the working directory), which differs for every task.' },
  }
  if (!first) return { expectedWarm: false, cause: 'UNKNOWN', causeBasis: 'local_inference', reuseDistanceMs: null, explanation: 'No difference was found in the parts NEXUS hashes.' }
  return { expectedWarm: false, cause: map[first].cause, causeBasis: 'local_inference', reuseDistanceMs: null, explanation: `${map[first].text}${changed.length > 1 ? ` Also changed: ${changed.slice(1).join(', ')}.` : ''}` }
}

/** The stored form of prefix parts (one string per part), and back. */
export function partsToList(p: PrefixParts): string[] {
  return [`model=${p.model}`, `effort=${p.effort}`, `system=${p.system}`, `tools=${p.tools}`, `flags=${p.flags}`, `dynamic=${p.dynamic}`]
}

export function partsFromList(hash: string, list: readonly string[]): PrefixParts | null {
  const get = (key: string): string | null => {
    const item = list.find((x) => x.startsWith(`${key}=`))
    return item === undefined ? null : item.slice(key.length + 1)
  }
  const model = get('model')
  const effort = get('effort')
  const system = get('system')
  const tools = get('tools')
  const flags = get('flags')
  const dynamic = get('dynamic')
  if (model === null || effort === null || system === null || tools === null || flags === null || dynamic === null) return null
  return { hash, model, effort, system, tools, flags, dynamic }
}

// ───────────────────────────── cache-rate change ─────────────────────────────

export interface CacheRateSample {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export function cacheHitRate(s: CacheRateSample): number {
  const total = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens
  return total > 0 ? s.cacheReadTokens / total : 0
}

/** A drop in the share of input served from cache between two windows, large enough to say so. */
export function cacheRateDrop(before: CacheRateSample, after: CacheRateSample, minimumTokens = 20_000): { from: number; to: number } | null {
  const b = before.inputTokens + before.cacheReadTokens + before.cacheWriteTokens
  const a = after.inputTokens + after.cacheReadTokens + after.cacheWriteTokens
  if (b < minimumTokens || a < minimumTokens) return null
  const from = cacheHitRate(before)
  const to = cacheHitRate(after)
  return from - to >= 0.25 ? { from, to } : null
}
