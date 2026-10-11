import { z } from 'zod'

/**
 * 0.8 Internet research. What NEXUS reads on the public web becomes a ResearchArtifact: a record of where a
 * text came from, when, what it was, and how far to trust the place it came from. An artifact is evidence for
 * an agent to read and to cite. It is never an instruction, and nothing in it can give anyone a capability.
 */

/** How NEXUS got hold of a source. Which of these exist in a given session is found out at run time, not assumed. */
export const RESEARCH_BACKENDS = ['PROVIDER_NATIVE_SEARCH', 'PROVIDER_NATIVE_FETCH', 'NEXUS_HTTP_FETCH', 'NEXUS_HTML_SEARCH', 'NEXUS_RESEARCH_BROWSER'] as const
export type ResearchBackend = (typeof RESEARCH_BACKENDS)[number]

/** What kind of place a source is. Decided from its address by rules, never from what the page says about itself. */
export const SOURCE_TYPES = ['OFFICIAL_DOCS', 'SOURCE_REPOSITORY', 'RELEASE_NOTES', 'STANDARD', 'ISSUE_TRACKER', 'PACKAGE_REGISTRY', 'COMMUNITY', 'UNKNOWN'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** PRIMARY: the maintainer's own word. COMMUNITY: useful for behaviour seen in the field, not for what the contract is. */
export const SOURCE_AUTHORITIES = ['PRIMARY', 'LIKELY_PRIMARY', 'COMMUNITY', 'UNKNOWN'] as const
export type SourceAuthority = (typeof SOURCE_AUTHORITIES)[number]

/** How long a fetched text stands for the page: a standard barely moves, an issue thread moves daily. */
export const FRESHNESS_POLICIES = ['STABLE', 'VERSIONED', 'VOLATILE'] as const
export type FreshnessPolicy = (typeof FRESHNESS_POLICIES)[number]

export const FRESHNESS_DAYS: Record<FreshnessPolicy, number> = { STABLE: 30, VERSIONED: 7, VOLATILE: 1 }

export interface ResearchScreening {
  status: 'clean' | 'flagged' | 'not_run'
  layers: string[]
  /** How many instruction-like spans were taken out of the text, by pattern. */
  quarantined: Record<string, number>
  /** Characters of text hidden by the page's own markup, which were left out. */
  hiddenChars: number
  /** Invisible and direction-control characters removed. */
  strippedCharacters: number
}

export interface ResearchArtifact {
  id: string
  projectId: string
  runId: string | null
  taskId: string | null
  /** The URL that was asked for. */
  url: string
  /** The URL the text came from, after redirects, without fragment and without tracking parameters. */
  canonicalUrl: string
  /** Every URL visited to get there. */
  redirectChain: string[]
  title: string | null
  retrievedAt: string
  /** sha256 of the body as received. */
  contentHash: string
  contentType: string | null
  bytes: number
  backend: ResearchBackend
  sourceType: SourceType
  authority: SourceAuthority
  /** The registrable domain, e.g. `microsoft.com`. */
  publisher: string
  freshness: FreshnessPolicy
  /** After this the artifact is stale and is fetched again when it is needed. */
  staleAfter: string
  /** Always UNTRUSTED_WEB_CONTENT. Stored so that no reader has to remember. */
  trust: 'UNTRUSTED_WEB_CONTENT'
  screening: ResearchScreening
  /** The first lines of the visible text, at most 600 characters: enough to recognise the source. */
  summary: string
  /** Characters of extracted text kept in the artifact file. */
  textChars: number
  truncated: boolean
  /** What the research was for, as the caller put it. */
  query: string | null
  /** Where the full extracted text is kept, relative to the research directory. Null when nothing was kept. */
  textPath: string | null
}

/** One passage handed to a model, with the place it came from. */
export interface ResearchCitation {
  id: string
  url: string
  title: string | null
  /** The quoted passage, at most 300 characters. */
  quote: string
}

/**
 * What a research tool returns. Everything a model reads from the web arrives in this shape: the source and
 * how it is trusted, apart from the content. `content` is data. A sentence in it that reads as an instruction
 * is a finding about the source.
 */
export interface ResearchEnvelope {
  envelope: 'nexus.untrusted/1'
  source: {
    kind: 'web' | 'search'
    url: string
    requestedUrl: string
    title: string | null
    fetchedAt: string
    contentType: string | null
    sha256: string
    sourceType: SourceType
    authority: SourceAuthority
    publisher: string
    fromMemory: boolean
  }
  trust: 'UNTRUSTED_WEB_CONTENT'
  screening: ResearchScreening
  citations: ResearchCitation[]
  /** The passages most relevant to the question, not the page. The rest stays in the artifact. */
  content: string
  /** How to read more: the artifact, the size of its text, and how much of it `content` holds. */
  artifact: { id: string; textChars: number; shownChars: number }
}

export interface SearchHit {
  url: string
  title: string
  snippet: string
  sourceType: SourceType
  authority: SourceAuthority
  publisher: string
}

/** What a research session may spend. Enforced by NEXUS; a hijacked reader cannot crawl without bound. */
export interface ResearchBudget {
  maxFetches: number
  maxFetchesPerHost: number
  maxSearches: number
  maxBytes: number
}

export const DEFAULT_RESEARCH_BUDGET: ResearchBudget = { maxFetches: 40, maxFetchesPerHost: 12, maxSearches: 15, maxBytes: 40 * 1024 * 1024 }

export const ResearchListInputSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    runId: z.string().min(1).max(128).optional(),
    taskId: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict()

/** The backends a session can use, as found when it started. */
export interface ResearchCapabilities {
  backends: ResearchBackend[]
  /** Why a backend is absent, for the capability matrix the user can read. */
  unavailable: { backend: ResearchBackend; reason: string }[]
}
