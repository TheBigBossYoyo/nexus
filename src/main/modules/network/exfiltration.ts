/**
 * 0.9: what a URL an agent chose may carry out. An agent that read hostile text can be talked into asking for
 * `https://somewhere/?d=<what it has read>`; the request itself is the leak. This looks at the URL the agent
 * gave, before anything is asked of the network, and refuses the shapes that carry data rather than name a page.
 *
 * It is a damping measure and says so: a patient sender can still move a few hundred characters per request in
 * plain words. What bounds that is the budget of a mission, counted per registrable domain (see below), and the
 * rule that a research session holds no credential.
 *
 * Applied to URLs an agent names (research_read, research_download), not to the redirects and subresources of
 * a page: those are chosen by the server, and carry long tokens as a matter of course.
 */

export const MAX_QUERY_CHARS = 512
export const MAX_QUERY_PARAMETERS = 20
/** A run of base64 or hex characters this long in a query is data, not a parameter. */
export const MAX_QUERY_TOKEN_RUN = 40
/** In a path, commit hashes (40) and content hashes (64) are ordinary; longer is not. */
export const MAX_PATH_TOKEN_RUN = 72

export type OutboundVerdict = { allowed: true } | { allowed: false; rule: 'QUERY_LENGTH' | 'QUERY_PARAMETERS' | 'TOKEN_RUN' | 'CREDENTIAL_SHAPE' | 'KNOWN_SECRET' | 'URL_INVALID'; reason: string }

const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer(?:\s|%20|\+)+[A-Za-z0-9._~-]{16,}/i,
  /-----BEGIN[ A-Z]*PRIVATE KEY/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
]

function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

function longestRun(text: string): number {
  let longest = 0
  for (const run of text.match(/[A-Za-z0-9+/=_-]+/g) ?? []) {
    // Words and slugs are letters with separators; data is a run that mixes digits and letters, or is all hex.
    const digits = (run.match(/[0-9]/g) ?? []).length
    const letters = (run.match(/[A-Za-z]/g) ?? []).length
    const separators = (run.match(/[-_]/g) ?? []).length
    const looksLikeData = (digits >= 4 && letters >= 4 && separators <= run.length / 12) || /^[0-9a-f]+$/i.test(run) || /[+/=]/.test(run)
    if (looksLikeData && run.length > longest) longest = run.length
  }
  return longest
}

/**
 * Judges a URL an agent named. `secrets` are values this process knows to be credentials (of the environment
 * and of NEXUS); a URL that contains one, as it is or percent-encoded or in base64, is refused whatever its shape.
 */
export function screenOutboundUrl(raw: string, secrets: readonly string[] = []): OutboundVerdict {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { allowed: false, rule: 'URL_INVALID', reason: 'The URL cannot be read.' }
  }
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search
  const tail = `${url.pathname}?${query}${url.hash}`
  const plain = decoded(tail)
  for (const secret of secrets) {
    if (secret.length < 12) continue
    const forms = [secret, encodeURIComponent(secret), Buffer.from(secret, 'utf8').toString('base64').replace(/=+$/, ''), Buffer.from(secret, 'utf8').toString('base64url'), Buffer.from(secret, 'utf8').toString('hex')]
    if (forms.some((form) => tail.includes(form) || plain.includes(form)) || url.hostname.includes(secret.toLowerCase())) return { allowed: false, rule: 'KNOWN_SECRET', reason: 'The URL contains a credential of this machine. It is not opened.' }
  }
  for (const shape of CREDENTIAL_SHAPES) if (shape.test(tail) || shape.test(plain) || shape.test(url.hostname)) return { allowed: false, rule: 'CREDENTIAL_SHAPE', reason: 'The URL contains what looks like a credential. It is not opened.' }
  if (query.length > MAX_QUERY_CHARS) return { allowed: false, rule: 'QUERY_LENGTH', reason: `The query of a URL an agent names is at most ${MAX_QUERY_CHARS} characters; this one carries ${query.length}. Name the page, not data.` }
  if (query !== '' && query.split('&').length > MAX_QUERY_PARAMETERS) return { allowed: false, rule: 'QUERY_PARAMETERS', reason: `A URL an agent names has at most ${MAX_QUERY_PARAMETERS} parameters.` }
  if (longestRun(decoded(query)) >= MAX_QUERY_TOKEN_RUN) return { allowed: false, rule: 'TOKEN_RUN', reason: `The query carries a run of ${MAX_QUERY_TOKEN_RUN} or more characters of encoded data. Name the page, not data.` }
  if (Math.max(0, ...decoded(url.pathname).split('/').map((segment) => longestRun(segment))) > MAX_PATH_TOKEN_RUN) return { allowed: false, rule: 'TOKEN_RUN', reason: 'The path carries a long run of encoded data. Name the page, not data.' }
  // A host made of data: `<what was read>.collector.example`. Labels are words; a long label of mixed digits and letters is not.
  for (const label of url.hostname.split('.')) if (label.length >= 32 && longestRun(label) >= 32) return { allowed: false, rule: 'TOKEN_RUN', reason: 'The host name carries a run of encoded data.' }
  return { allowed: true }
}

/** Second-level names under which the public registers names (the common ones; a full list is not carried). */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'gouv', 'nom', 'or', 'ne', 'go', 'mil', 'sch', 'info', 'ind', 'fin', 'ens', 'rnu', 'rns', 'rnrt', 'tourism', 'intl', 'perso', 'mincom'])
/** Hosts where each name below belongs to a different party: one budget per name there, not one for all. */
const SHARED_HOSTING = ['github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app', 'web.app', 'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'wordpress.com', 'readthedocs.io', 'cloudfront.net', 'azurewebsites.net', 'amazonaws.com', 'workers.dev', 'nip.io', 'sslip.io']

/**
 * The name a budget is counted under: the registrable domain, so that `a.collector.example`,
 * `b.collector.example` and every other name its owner can make are one account. Without the public suffix
 * list this is an approximation that errs towards the larger group, which only makes a budget run out sooner.
 */
export function budgetDomain(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (host === '' || /^[0-9.]+$/.test(host) || host.includes(':')) return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  for (const shared of SHARED_HOSTING) {
    if (host === shared || host.endsWith(`.${shared}`)) {
      const depth = shared.split('.').length + 1
      return labels.slice(-Math.min(labels.length, depth)).join('.')
    }
  }
  const tld = labels.at(-1) as string
  const second = labels.at(-2) as string
  if (tld.length === 2 && SECOND_LEVEL.has(second)) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}
