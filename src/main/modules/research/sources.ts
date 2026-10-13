import type { FreshnessPolicy, SourceAuthority, SourceType } from '@shared/research'

/**
 * 0.8: what kind of source a URL is. Decided from the address alone, by rules. A page that says "official
 * documentation" about itself is not thereby official; the host it is served from is what is judged.
 */

export interface SourceClass {
  sourceType: SourceType
  authority: SourceAuthority
  publisher: string
  freshness: FreshnessPolicy
}

/** Two-part public suffixes that occur in practice, so that `bbc.co.uk` is not read as `co.uk`. Not the full list. */
const TWO_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz', 'co.in', 'com.br', 'com.cn', 'co.kr', 'com.mx', 'co.za', 'github.io', 'gitlab.io', 'readthedocs.io', 'pages.dev', 'vercel.app', 'netlify.app', 'web.app', 'azurewebsites.net', 'blogspot.com', 'herokuapp.com'])

/** The registrable domain of a host: the part someone had to register. An IP address is its own publisher. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const lastTwo = labels.slice(-2).join('.')
  return TWO_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo
}

/** Hosts where the maintainer of the thing documents the thing. Exact host or a subdomain of it. */
const OFFICIAL_DOCS = [
  'learn.microsoft.com', 'devblogs.microsoft.com', 'developer.mozilla.org', 'nodejs.org', 'docs.python.org', 'playwright.dev', 'electronjs.org', 'react.dev', 'typescriptlang.org',
  'rust-lang.org', 'doc.rust-lang.org', 'docs.rs', 'go.dev', 'pkg.go.dev', 'docs.oracle.com', 'kotlinlang.org', 'developer.android.com', 'developer.apple.com', 'docs.anthropic.com', 'platform.claude.com',
  'code.claude.com', 'platform.openai.com', 'developers.openai.com', 'docs.github.com', 'git-scm.com', 'sqlite.org', 'postgresql.org', 'vite.dev', 'vitejs.dev', 'vitest.dev', 'eslint.org', 'tailwindcss.com',
  'pnpm.io', 'docs.npmjs.com', 'yarnpkg.com', 'webpack.js.org', 'esbuild.github.io', 'zod.dev', 'tanstack.com', 'chromium.org', 'chromedevtools.github.io', 'web.dev', 'developer.chrome.com', 'v8.dev',
  'docs.docker.com', 'kubernetes.io', 'cmake.org', 'llvm.org', 'gcc.gnu.org', 'docs.aws.amazon.com', 'cloud.google.com', 'modelcontextprotocol.io', 'owasp.org', 'cheatsheetseries.owasp.org',
]
const STANDARDS = ['w3.org', 'whatwg.org', 'rfc-editor.org', 'ietf.org', 'datatracker.ietf.org', 'ecma-international.org', 'tc39.es', 'iso.org', 'unicode.org', 'iana.org', 'nist.gov', 'csrc.nist.gov', 'semver.org', 'json-schema.org', 'spec.commonmark.org']
const REGISTRIES = ['npmjs.com', 'www.npmjs.com', 'registry.npmjs.org', 'pypi.org', 'crates.io', 'nuget.org', 'www.nuget.org', 'rubygems.org', 'mvnrepository.com', 'central.sonatype.com', 'packagist.org', 'hub.docker.com']
const COMMUNITY = ['stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'reddit.com', 'news.ycombinator.com', 'medium.com', 'dev.to', 'hashnode.dev', 'quora.com', 'discourse.org', 'geeksforgeeks.org', 'w3schools.com', 'tutorialspoint.com', 'baeldung.com', 'freecodecamp.org', 'substack.com', 'blogspot.com', 'wordpress.com', 'hackernoon.com', 'dzone.com', 'codeproject.com']
const CODE_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'chromium.googlesource.com', 'raw.githubusercontent.com', 'gist.github.com']

const under = (host: string, list: readonly string[]): boolean => list.some((d) => host === d || host.endsWith(`.${d}`))

function classifyCodeHost(host: string, path: string): Pick<SourceClass, 'sourceType' | 'authority' | 'freshness'> {
  if (host === 'gist.github.com') return { sourceType: 'COMMUNITY', authority: 'COMMUNITY', freshness: 'VERSIONED' }
  if (/\/(issues|pull|pulls|merge_requests|discussions)(\/|$)/.test(path)) return { sourceType: 'ISSUE_TRACKER', authority: 'PRIMARY', freshness: 'VOLATILE' }
  if (/\/(releases|tags)(\/|$)|\/(CHANGELOG|CHANGES|HISTORY|RELEASES?|NEWS)(\.[a-z]+)?$/i.test(path)) return { sourceType: 'RELEASE_NOTES', authority: 'PRIMARY', freshness: 'VERSIONED' }
  // A repository's own files are the maintainer's word about that repository. Whose repository it is, the reader still has to judge.
  return { sourceType: 'SOURCE_REPOSITORY', authority: 'PRIMARY', freshness: 'VERSIONED' }
}

export function classifySource(rawUrl: string): SourceClass {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { sourceType: 'UNKNOWN', authority: 'UNKNOWN', publisher: '', freshness: 'VOLATILE' }
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const publisher = registrableDomain(host)
  const path = url.pathname
  if (under(host, STANDARDS)) return { sourceType: 'STANDARD', authority: 'PRIMARY', publisher, freshness: 'STABLE' }
  if (under(host, CODE_HOSTS)) return { ...classifyCodeHost(host, path), publisher }
  if (under(host, REGISTRIES) || REGISTRIES.includes(url.hostname.toLowerCase())) return { sourceType: 'PACKAGE_REGISTRY', authority: 'PRIMARY', publisher, freshness: 'VERSIONED' }
  if (under(host, COMMUNITY)) return { sourceType: 'COMMUNITY', authority: 'COMMUNITY', publisher, freshness: 'VOLATILE' }
  if (under(host, OFFICIAL_DOCS)) {
    const notes = /release-?notes|changelog|whats-?new|\/releases?\//i.test(path)
    return { sourceType: notes ? 'RELEASE_NOTES' : 'OFFICIAL_DOCS', authority: 'PRIMARY', publisher, freshness: 'VERSIONED' }
  }
  // A project's own documentation site that is not on the list: its shape suggests it, nothing confirms it.
  if (/^(docs?|developer|developers|dev|api|reference|learn|manual|wiki)\./.test(host) || /(^|\.)readthedocs\.io$/.test(host) || /^\/(docs?|documentation|reference|api|manual|guide)(\/|$)/i.test(path)) {
    return { sourceType: 'OFFICIAL_DOCS', authority: 'LIKELY_PRIMARY', publisher, freshness: 'VERSIONED' }
  }
  return { sourceType: 'UNKNOWN', authority: 'UNKNOWN', publisher, freshness: 'VOLATILE' }
}

const AUTHORITY_RANK: Record<SourceAuthority, number> = { PRIMARY: 0, LIKELY_PRIMARY: 1, UNKNOWN: 2, COMMUNITY: 3 }
const TYPE_RANK: Record<SourceType, number> = { OFFICIAL_DOCS: 0, STANDARD: 0, RELEASE_NOTES: 1, SOURCE_REPOSITORY: 1, ISSUE_TRACKER: 2, PACKAGE_REGISTRY: 2, UNKNOWN: 3, COMMUNITY: 4 }

/**
 * Orders sources for a technical question: the maintainer's own documentation and the standard first, then
 * the repository and its release notes, then issues, then the rest; community pages last. The order among
 * equals is kept, so what the search engine thought more relevant stays ahead.
 */
export function rankSources<T extends { authority: SourceAuthority; sourceType: SourceType }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => AUTHORITY_RANK[a.item.authority] - AUTHORITY_RANK[b.item.authority] || TYPE_RANK[a.item.sourceType] - TYPE_RANK[b.item.sourceType] || a.index - b.index)
    .map((x) => x.item)
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref_src|ref_url|spm|igshid|_hsenc|_hsmi|vero_id|yclid)$/i

/** The address of a page as it is remembered: no fragment, no tracking parameters, the host in lower case. */
export function canonicalUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    for (const name of [...url.searchParams.keys()]) if (TRACKING.test(name)) url.searchParams.delete(name)
    url.searchParams.sort()
    url.hostname = url.hostname.toLowerCase()
    return url.href
  } catch {
    return rawUrl
  }
}
