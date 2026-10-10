import { createHash } from 'node:crypto'
import { nowIso } from '@shared/ids'
import { estimateTokens, type PromptCacheability, type PromptComponent, type PromptPrefix } from '@shared/token'
import type { Repositories } from '@main/modules/persistence/repositories'

/**
 * The prompt text NEXUS writes, as registered, hashed blocks.
 *
 * Prompt caching is a prefix match over bytes, so two things must hold for a prefix to be shared: the same
 * blocks in the same order, and nothing volatile inside them. The registry makes both checkable: a block
 * has a key and a hash, a new hash under a key is a new version, and a prefix is the ordered list of the
 * hashes that precede the first volatile block.
 */

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * JSON with object keys in sorted order at every depth. Arrays keep their order: it can carry meaning.
 * `undefined` members are dropped, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v)
    }
    return out
  }
  return value
}

/** Line endings and trailing spaces are normalized so that the same text always hashes the same. Nothing else changes. */
export function canonicalText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

export interface ComponentInput {
  key: string
  scope: PromptComponent['scope']
  priority: number
  text: string
  cacheability: PromptCacheability
}

export interface RegisteredComponent extends PromptComponent {
  text: string
}

/** What a store must offer to keep versions across restarts. The in-memory default is enough for one process and for tests. */
export interface ComponentPersistence {
  byKeyAndHash(key: string, hash: string): PromptComponent | null
  latestVersion(key: string): number
  insert(component: PromptComponent): PromptComponent
}

export class PromptComponentRegistry {
  private readonly cache = new Map<string, RegisteredComponent>()
  private readonly versions = new Map<string, number>()

  constructor(
    private readonly store: ComponentPersistence | null = null,
    private readonly now: () => string = nowIso,
  ) {}

  /** Register a block. The same key and text always return the same component; a changed text is the next version. */
  register(input: ComponentInput): RegisteredComponent {
    const text = canonicalText(input.text)
    const hash = sha(text)
    const cacheKey = `${input.key}\0${hash}`
    const hit = this.cache.get(cacheKey)
    if (hit) return hit
    let stored = this.store?.byKeyAndHash(input.key, hash) ?? null
    if (!stored) {
      const version = (this.store ? this.store.latestVersion(input.key) : (this.versions.get(input.key) ?? 0)) + 1
      this.versions.set(input.key, version)
      stored = {
        id: `${input.key}@${version}`,
        key: input.key,
        version,
        scope: input.scope,
        priority: input.priority,
        hash,
        chars: text.length,
        tokenEstimate: estimateTokens(text),
        cacheability: input.cacheability,
        createdAt: this.now(),
      }
      this.store?.insert(stored)
    }
    const component: RegisteredComponent = { ...stored, text }
    this.cache.set(cacheKey, component)
    return component
  }
}

export interface AssembledPrompt {
  text: string
  /** The blocks that are in the text, in order. */
  components: RegisteredComponent[]
  /** Blocks left out because an identical block was already in this request. */
  duplicates: RegisteredComponent[]
  /** Hash of the stable blocks that come before the first non-stable block: what can be a shared cache prefix. */
  stablePrefixHash: string
  stablePrefixTokens: number
  /** True when a stable block comes after a volatile one: it can never be part of a shared prefix where it is. */
  stableAfterVolatile: boolean
}

const ORDER: Record<PromptCacheability, number> = { stable: 0, session: 1, volatile: 2 }

/**
 * Join blocks into one text. Order: by `priority`, as given. The same immutable block is never emitted twice in
 * one request. Blocks are NOT reordered by cacheability: the order of instructions can carry meaning, so a
 * stable block that sits after a volatile one is reported, not moved.
 */
export function assemblePrompt(blocks: readonly RegisteredComponent[]): AssembledPrompt {
  const ordered = [...blocks].sort((a, b) => a.priority - b.priority)
  const seen = new Set<string>()
  const components: RegisteredComponent[] = []
  const duplicates: RegisteredComponent[] = []
  for (const b of ordered) {
    if (seen.has(b.hash)) duplicates.push(b)
    else {
      seen.add(b.hash)
      components.push(b)
    }
  }
  const prefix: RegisteredComponent[] = []
  for (const c of components) {
    if (c.cacheability !== 'stable') break
    prefix.push(c)
  }
  let worst = 0
  let stableAfterVolatile = false
  for (const c of components) {
    if (ORDER[c.cacheability] < worst && c.cacheability === 'stable') stableAfterVolatile = true
    worst = Math.max(worst, ORDER[c.cacheability])
  }
  return {
    text: components.map((c) => c.text).join('\n\n'),
    components,
    duplicates,
    stablePrefixHash: sha(prefix.map((c) => c.hash).join('\n')),
    stablePrefixTokens: prefix.reduce((n, c) => n + c.tokenEstimate, 0),
    stableAfterVolatile,
  }
}

/** Everything about a session that decides whether its first request can read another session's cached prefix. */
export interface PrefixIdentity {
  provider: string
  /** The model as requested (an alias or an id): caches are per model. */
  model: string | null
  role: string
  effort: string | null
  /** The system text NEXUS appends (the role prompt). */
  systemText: string
  /** Built-in tool names the session may see, plus the NEXUS and external MCP tool names. */
  tools: readonly string[]
  /** Runtime flags that change the rendered prefix. */
  flags: { stablePrefix: boolean; nexusToolsAlwaysLoaded: boolean; projectSettings: boolean; structuredOutput: boolean }
  /**
   * What the runtime puts into the system prompt that NEXUS cannot see but knows varies: the working directory.
   * Null when the stable prefix is on (the runtime then keeps it out of the system prompt).
   */
  dynamicSystem: string | null
}

export interface PrefixParts {
  hash: string
  model: string
  effort: string
  system: string
  tools: string
  flags: string
  dynamic: string
}

/** Tool order never matters to NEXUS, so names are sorted: a different order of the same tools is the same tool set. */
export function toolSetHash(tools: readonly string[]): string {
  return sha([...new Set(tools)].sort().join('\n')).slice(0, 16)
}

export function prefixParts(identity: PrefixIdentity): PrefixParts {
  const parts = {
    model: `${identity.provider}:${identity.model ?? 'default'}`,
    effort: identity.effort ?? 'default',
    system: sha(canonicalText(identity.systemText)).slice(0, 16),
    tools: toolSetHash(identity.tools),
    flags: canonicalJson(identity.flags),
    dynamic: identity.dynamicSystem === null ? '' : sha(identity.dynamicSystem).slice(0, 16),
  }
  return { ...parts, hash: sha(canonicalJson(parts)).slice(0, 32) }
}

/** Remembers the prefixes sessions used, and what the cache did the last time each was used. */
export class PromptPrefixRegistry {
  constructor(
    private readonly repos: Pick<Repositories, 'promptPrefixes'>,
    private readonly now: () => string = nowIso,
  ) {}

  /** Record one use of a prefix. Returns the stored row and whether the prefix was seen before. */
  use(identity: PrefixIdentity, components: readonly string[], tokenEstimate: number): { prefix: PromptPrefix; parts: PrefixParts; seenBefore: boolean } {
    const parts = prefixParts(identity)
    const at = this.now()
    const existing = this.repos.promptPrefixes.byHash(parts.hash)
    if (existing) {
      return { prefix: this.repos.promptPrefixes.update(existing.id, { uses: existing.uses + 1, lastSeenAt: at }), parts, seenBefore: true }
    }
    const prefix = this.repos.promptPrefixes.insert({
      id: parts.hash,
      hash: parts.hash,
      components: [...components],
      provider: identity.provider,
      model: identity.model,
      role: identity.role,
      toolSetHash: parts.tools,
      tokenEstimate,
      // A prefix that still contains per-session text cannot be shared between sessions.
      cacheable: identity.dynamicSystem === null,
      uses: 1,
      firstSeenAt: at,
      lastSeenAt: at,
      lastCacheResult: null,
      lastCacheReadTokens: null,
      lastCacheWriteTokens: null,
    })
    return { prefix, parts, seenBefore: false }
  }

  observe(hash: string, result: PromptPrefix['lastCacheResult'], read: number, write: number): void {
    const existing = this.repos.promptPrefixes.byHash(hash)
    if (existing) this.repos.promptPrefixes.update(existing.id, { lastCacheResult: result, lastCacheReadTokens: read, lastCacheWriteTokens: write })
  }
}
