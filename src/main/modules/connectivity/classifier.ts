import type { ConnectivityEvidence, ConnectivitySnapshot, ConnectivityState, ProbeResult, WlanInterfaceEvidence } from '@shared/connectivity'

/** What the probes found, before anyone decides what it means. The classifier is the only place that decides. */
export interface RawProbes {
  at: number
  /** One entry per Wi-Fi interface; empty when the machine has none or the WLAN service is down. */
  wlan: WlanInterfaceEvidence[]
  wiredLinkUp: boolean
  /** Null when no link existed, so nothing was asked. */
  dns: ProbeResult | null
  /** Connects to two independent well-known endpoints by name. */
  endpoints: ProbeResult[]
  /** Connects by literal address, which needs no DNS. */
  addresses: ProbeResult[]
  /** One entry per provider endpoint that matters (host name of the model API). */
  providers: Record<string, ProbeResult>
  /** The usage service's view: true when the provider is reachable but this account is out of capacity until `resetAt`. */
  quota: { limited: boolean; resetAt: number | null } | null
}

export function evidenceOf(raw: RawProbes): ConnectivityEvidence {
  const associated = raw.wlan.find((i) => i.state === 'connected') ?? null
  const shown = associated ?? raw.wlan[0] ?? null
  return {
    at: raw.at,
    wlanInterfaces: raw.wlan.length,
    wlanAssociated: associated !== null,
    profileName: associated?.profileName ?? null,
    wlanState: shown?.state ?? null,
    lastReasonCode: raw.wlan.map((i) => i.lastReasonCode).find((c) => c !== null) ?? null,
    wiredLinkUp: raw.wiredLinkUp,
    dns: raw.dns,
    endpoints: raw.endpoints,
    addresses: raw.addresses,
    providers: raw.providers,
    quota: raw.quota,
  }
}

/**
 * Exactly one state from the raw probes. The order is the order of the layers: a link, then names, then the
 * Internet, then the provider, then the account's capacity. A layer is only blamed when everything below it
 * answered, so "the provider is unreachable" is never said about a machine that has no link.
 */
export function classifyConnectivity(raw: RawProbes): ConnectivitySnapshot {
  const evidence = evidenceOf(raw)
  const state = decide(raw, evidence)
  return { state, since: raw.at, evidence }
}

function decide(raw: RawProbes, evidence: ConnectivityEvidence): ConnectivityState {
  // A wired link with Internet is ONLINE with Wi-Fi off: the verdict comes from what is reachable, not from Wi-Fi.
  const link = evidence.wlanAssociated || raw.wiredLinkUp
  const internet = raw.endpoints.some((p) => p.ok)
  const anyProvider = Object.values(raw.providers)
  const providerUp = anyProvider.some((p) => p.ok)

  if (!link && !internet) return 'WLAN_DISCONNECTED'

  if (!internet) {
    const byAddress = raw.addresses.some((p) => p.ok)
    // Names fail but addresses answer: the link is fine and name resolution is what broke.
    if (byAddress && (raw.dns === null || !raw.dns.ok)) return 'DNS_FAILURE'
    // Names resolve and the provider answers while the general endpoints do not: only research-type traffic is missing.
    if (providerUp) return 'RESEARCH_ONLY_UNAVAILABLE'
    if (raw.dns === null || !raw.dns.ok) return 'WLAN_ASSOCIATED_NO_INTERNET'
    // A name resolved (possibly from a cache) but nothing could be connected to.
    return byAddress ? 'RESEARCH_ONLY_UNAVAILABLE' : 'INTERNET_UNREACHABLE'
  }

  if (anyProvider.length > 0 && !providerUp) return 'PROVIDER_UNREACHABLE'
  if (raw.quota?.limited === true) return 'PROVIDER_QUOTA_WAIT'
  return 'ONLINE'
}

// ---------------------------------------------------------------------------------------------------------------
// Errors from a provider call or a transport, as the orchestrator meets them.

export type TransportErrorKind = 'NETWORK' | 'PROVIDER_OUTAGE' | 'QUOTA' | 'AUTH' | 'OTHER'

export interface ClassifiedTransportError {
  kind: TransportErrorKind
  /** The error code or HTTP status the verdict rests on. */
  basis: string
  /** From a Retry-After header, in milliseconds, when one was given and could be read. */
  retryAfterMs: number | null
  /** Set for a TLS failure, which can be a captive portal or a clock problem as well as a network fault. */
  detail: string | null
}

export interface TransportErrorInput {
  /** HTTP status, when a response was received. */
  status?: number | null
  /** The Retry-After header value: seconds or an HTTP date. */
  retryAfter?: string | number | null
  /** Anything that was thrown. `code` and `cause.code` are read; so is the message. */
  error?: unknown
  now?: number
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
])

const TLS_CERTIFICATE_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH'])

/** Walks `error`, `error.cause`, ... and returns every code and message found, outermost first. */
function errorFacts(error: unknown): { codes: string[]; messages: string[] } {
  const codes: string[] = []
  const messages: string[] = []
  let cur: unknown = error
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth++) {
    if (typeof cur === 'string') {
      messages.push(cur)
      break
    }
    if (typeof cur !== 'object') break
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
    if (typeof o.code === 'string') codes.push(o.code)
    if (typeof o.message === 'string') messages.push(o.message)
    // AggregateError (happy eyeballs connect failures) carries the real codes in `errors`.
    if (Array.isArray(o.errors)) for (const inner of o.errors.slice(0, 4)) codes.push(...errorFacts(inner).codes)
    cur = o.cause
  }
  return { codes, messages }
}

export function parseRetryAfterMs(value: string | number | null | undefined, now: number): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null
  const text = value.trim()
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/**
 * What a failed provider call or transport call means. A NETWORK error is a reason to look at the network
 * (the supervisor probes and the orchestrator waits if it is down), never by itself a failed task. OTHER is
 * what is left, and is the only kind that may count as the task's own failure.
 */
export function classifyTransportError(input: TransportErrorInput): ClassifiedTransportError {
  const retryAfterMs = parseRetryAfterMs(input.retryAfter, input.now ?? Date.now())
  const status = input.status ?? null
  if (status !== null) {
    if (status === 401 || status === 403) return { kind: 'AUTH', basis: `HTTP ${status}`, retryAfterMs: null, detail: null }
    // 429 is a limit with or without a Retry-After; the header only says how long.
    if (status === 429) return { kind: 'QUOTA', basis: 'HTTP 429', retryAfterMs, detail: null }
    // 529 is Anthropic's "overloaded"; 503 and the gateway errors are the provider or its front door being down.
    if (status === 529 || status === 503 || status === 502 || status === 504 || status === 500) return { kind: 'PROVIDER_OUTAGE', basis: `HTTP ${status}`, retryAfterMs, detail: null }
    if (status >= 400) return { kind: 'OTHER', basis: `HTTP ${status}`, retryAfterMs: null, detail: null }
  }
  const { codes, messages } = errorFacts(input.error)
  for (const code of codes) {
    if (NETWORK_CODES.has(code)) return { kind: 'NETWORK', basis: code, retryAfterMs: null, detail: null }
  }
  for (const code of codes) {
    if (TLS_CERTIFICATE_CODES.has(code)) return { kind: 'NETWORK', basis: code, retryAfterMs: null, detail: 'TLS_CERTIFICATE' }
    if (code.startsWith('ERR_SSL_') || code === 'EPROTO') return { kind: 'NETWORK', basis: code, retryAfterMs: null, detail: 'TLS_HANDSHAKE' }
  }
  const message = messages.join(' | ')
  if (/fetch failed/i.test(message)) return { kind: 'NETWORK', basis: 'fetch failed', retryAfterMs: null, detail: null }
  if (/socket disconnected before secure tls connection|ssl routines|tls handshake/i.test(message)) return { kind: 'NETWORK', basis: 'TLS', retryAfterMs: null, detail: 'TLS_HANDSHAKE' }
  if (/getaddrinfo|network (is )?(unreachable|down|changed)|socket hang up|connection (reset|terminated)/i.test(message)) return { kind: 'NETWORK', basis: 'message', retryAfterMs: null, detail: null }
  return { kind: 'OTHER', basis: codes[0] ?? 'unclassified', retryAfterMs: null, detail: null }
}
