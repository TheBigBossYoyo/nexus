import { classifyAddress, isLocalName, type AddressClass } from './address'

/**
 * 0.8: who may reach what over the network. A policy is data: a profile, the registered local endpoints of the
 * project, the registries, the hosts the user approved. It is evaluated twice for every connection: on the URL
 * (`checkUrl`, before anything is resolved) and on the address the socket will use (`checkConnect`). Research
 * traffic, package traffic and the traffic of an application under test are different policies; holding one
 * gives nothing of another.
 */

export const NETWORK_PROFILES = ['OFF', 'LOCAL_APP_ONLY', 'RESEARCH_WEB', 'PACKAGE_REGISTRIES', 'RESEARCH_AND_DEPS', 'APPROVED_HOSTS', 'FULL'] as const
export type NetworkProfile = (typeof NETWORK_PROFILES)[number]

/** What a browser session is for. The purpose fixes the profile; a session never changes purpose. */
export const BROWSER_SESSION_PURPOSES = ['PUBLIC_RESEARCH', 'LOCAL_APP_TEST', 'EXPLICIT_EXTERNAL_INTERACTION'] as const
export type BrowserSessionPurpose = (typeof BROWSER_SESSION_PURPOSES)[number]

/** A local server the project started and NEXUS registered. Only these are "the local app". */
export interface LocalEndpoint {
  host: '127.0.0.1' | '::1' | 'localhost'
  port: number
}

export interface NetworkPolicy {
  profile: NetworkProfile
  /** Registered endpoints of the application under test. Read by LOCAL_APP_ONLY, and by FULL for loopback. */
  localEndpoints: readonly LocalEndpoint[]
  /** Hosts of the approved package registries (exact names). Read by PACKAGE_REGISTRIES and RESEARCH_AND_DEPS. */
  registryHosts: readonly string[]
  /** Hosts the user approved for this project (exact names). Read by APPROVED_HOSTS, and added to every profile but OFF. */
  approvedHosts: readonly string[]
  /** Ports of NEXUS's own loopback services: never reachable, whatever else is allowed. */
  forbiddenLocalPorts: readonly number[]
}

export const DEFAULT_REGISTRY_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'api.nuget.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'rubygems.org',
  'nodejs.org',
  'codeload.github.com',
  'objects.githubusercontent.com',
]

export type NetworkDenial =
  | 'NETWORK_OFF'
  | 'SCHEME'
  | 'USERINFO'
  | 'URL_INVALID'
  | 'URL_TOO_LONG'
  | 'PORT'
  | 'LOCAL_NAME'
  | 'PRIVATE_ADDRESS'
  | 'NOT_REGISTERED_ENDPOINT'
  | 'NEXUS_ENDPOINT'
  | 'HOST_NOT_ALLOWED'
  | 'PUBLIC_NOT_ALLOWED'
  | 'RESOLUTION'

export type NetworkVerdict = { allowed: true } | { allowed: false; denial: NetworkDenial; reason: string }

const deny = (denial: NetworkDenial, reason: string): NetworkVerdict => ({ allowed: false, denial, reason })
const ALLOW: NetworkVerdict = { allowed: true }

export const MAX_URL_CHARS = 2048
const WEB_PORTS = new Set([80, 443])

/** `host` as a URL gives it: lower case, no brackets, no trailing dot. */
export function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
}

function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

function publicAllowed(policy: NetworkPolicy, host: string): NetworkVerdict {
  if (policy.approvedHosts.includes(host)) return ALLOW
  switch (policy.profile) {
    case 'FULL':
    case 'RESEARCH_WEB':
    case 'RESEARCH_AND_DEPS':
      return ALLOW
    case 'PACKAGE_REGISTRIES':
      return policy.registryHosts.includes(host) ? ALLOW : deny('HOST_NOT_ALLOWED', `${host} is not one of the approved package registries.`)
    case 'APPROVED_HOSTS':
      return deny('HOST_NOT_ALLOWED', `${host} is not a host approved for this project.`)
    case 'LOCAL_APP_ONLY':
      return deny('PUBLIC_NOT_ALLOWED', 'This session reaches the registered local endpoints of the project only.')
    case 'OFF':
      return deny('NETWORK_OFF', 'The network is off for this session.')
  }
}

function loopbackAllowed(policy: NetworkPolicy, host: string, port: number): NetworkVerdict {
  if (policy.forbiddenLocalPorts.includes(port)) return deny('NEXUS_ENDPOINT', "NEXUS's own local services are not reachable.")
  if (policy.profile !== 'LOCAL_APP_ONLY' && policy.profile !== 'FULL') return deny('PRIVATE_ADDRESS', 'This session reaches the public Internet only; local addresses are refused.')
  const names = host === 'localhost' ? ['localhost', '127.0.0.1', '::1'] : [host]
  if (policy.localEndpoints.some((e) => e.port === port && names.includes(e.host))) return ALLOW
  // "localhost" in a URL may have been registered by its address, and the other way round.
  if (policy.localEndpoints.some((e) => e.port === port && (e.host === 'localhost' || host === '127.0.0.1' || host === '::1'))) return ALLOW
  return deny('NOT_REGISTERED_ENDPOINT', `${host}:${port} is not a local endpoint registered for this project.`)
}

/**
 * The first check, on the text of a URL. It refuses what no resolution could make right (a scheme, credentials
 * in the URL, a local name for a public session) and lets the rest through to the check on the address.
 */
export function checkUrl(policy: NetworkPolicy, raw: string, options: { websocket?: boolean } = {}): NetworkVerdict & { url?: URL } {
  if (policy.profile === 'OFF') return deny('NETWORK_OFF', 'The network is off for this session.')
  if (raw.length > MAX_URL_CHARS) return deny('URL_TOO_LONG', `URLs longer than ${MAX_URL_CHARS} characters are refused.`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return deny('URL_INVALID', 'The URL cannot be read.')
  }
  const schemes = options.websocket ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:']
  if (!schemes.includes(url.protocol)) return deny('SCHEME', `Only http and https are opened, not ${url.protocol}`)
  if (url.username !== '' || url.password !== '') return deny('USERINFO', 'A URL that carries a user name or a password is refused.')
  const host = normalizeHost(url.hostname)
  if (host === '') return deny('URL_INVALID', 'The URL names no host.')
  const port = portOf(url)
  const cls = classifyAddress(host)
  const local = cls === 'LOOPBACK' || host === 'localhost' || host.endsWith('.localhost')
  if (local) {
    const verdict = loopbackAllowed(policy, host.endsWith('.localhost') ? 'localhost' : host, port)
    return verdict.allowed ? { allowed: true, url } : verdict
  }
  if (cls !== 'INVALID' && cls !== 'PUBLIC') return deny('PRIVATE_ADDRESS', `${host} is not a public address (${cls.toLowerCase().replace('_', ' ')}).`)
  if (cls === 'INVALID' && isLocalName(host)) return deny('LOCAL_NAME', `${host} is a name of the local network, not of the public Internet.`)
  const allowed = publicAllowed(policy, host)
  if (!allowed.allowed) return allowed
  // Research reads the web on its usual ports. Another port is a different service, which a project approves by host.
  if ((policy.profile === 'RESEARCH_WEB' || policy.profile === 'RESEARCH_AND_DEPS') && !WEB_PORTS.has(port) && !policy.approvedHosts.includes(host)) {
    return deny('PORT', `Port ${port} is not opened for research; only 80 and 443 are.`)
  }
  return { allowed: true, url }
}

/**
 * The check that counts, on the address a socket is about to use. `addresses` is every address the name
 * resolved to: one that is not acceptable refuses the connection, because a name that answers with a public
 * and a private address is how a rebinding attack looks.
 */
export function checkConnect(policy: NetworkPolicy, hostname: string, port: number, addresses: readonly string[]): NetworkVerdict {
  if (policy.profile === 'OFF') return deny('NETWORK_OFF', 'The network is off for this session.')
  const host = normalizeHost(hostname)
  if (addresses.length === 0) return deny('RESOLUTION', `${host} did not resolve to an address.`)
  const classes: AddressClass[] = addresses.map((a) => classifyAddress(a))
  if (classes.includes('INVALID')) return deny('RESOLUTION', `${host} resolved to something that is not an address.`)
  if (classes.every((c) => c === 'LOOPBACK')) {
    // Only a name that says it is local may resolve to the local host: a public name that does is a rebinding.
    const named = host === 'localhost' || host.endsWith('.localhost') || classifyAddress(host) === 'LOOPBACK'
    if (!named) return deny('PRIVATE_ADDRESS', `${host} resolved to the local host.`)
    return loopbackAllowed(policy, classifyAddress(host) === 'LOOPBACK' ? host : 'localhost', port)
  }
  const bad = classes.find((c) => c !== 'PUBLIC')
  if (bad !== undefined) return deny('PRIVATE_ADDRESS', `${host} resolved to an address that is not public (${bad.toLowerCase().replace('_', ' ')}).`)
  return publicAllowed(policy, host)
}

/** The policy of a browser session, from its purpose. The purpose decides; nothing a page says changes it. */
export function policyForPurpose(purpose: BrowserSessionPurpose, input: { localEndpoints?: readonly LocalEndpoint[]; approvedHosts?: readonly string[]; forbiddenLocalPorts?: readonly number[]; appNetwork?: 'LOCAL_ONLY' | 'APPROVED_HOSTS' | 'FULL_EXTERNAL' }): NetworkPolicy {
  const forbiddenLocalPorts = input.forbiddenLocalPorts ?? []
  if (purpose === 'PUBLIC_RESEARCH') return { profile: 'RESEARCH_WEB', localEndpoints: [], registryHosts: [], approvedHosts: [], forbiddenLocalPorts }
  if (purpose === 'LOCAL_APP_TEST') {
    const app = input.appNetwork ?? 'LOCAL_ONLY'
    // An application under test that needs a third party reaches it because its project says so, never because
    // research may read the web.
    return {
      profile: app === 'FULL_EXTERNAL' ? 'FULL' : 'LOCAL_APP_ONLY',
      localEndpoints: input.localEndpoints ?? [],
      registryHosts: [],
      approvedHosts: app === 'APPROVED_HOSTS' ? (input.approvedHosts ?? []) : [],
      forbiddenLocalPorts,
    }
  }
  return { profile: 'APPROVED_HOSTS', localEndpoints: [], registryHosts: [], approvedHosts: input.approvedHosts ?? [], forbiddenLocalPorts }
}

/** The policy of project code under AUTONOMOUS_PROJECT: the registries, and nothing else of the public Internet. */
export function policyForProjectCommands(input: { registryHosts?: readonly string[]; approvedHosts?: readonly string[]; localEndpoints?: readonly LocalEndpoint[]; forbiddenLocalPorts?: readonly number[]; network: boolean }): NetworkPolicy {
  return {
    profile: input.network ? 'PACKAGE_REGISTRIES' : 'OFF',
    localEndpoints: input.localEndpoints ?? [],
    registryHosts: input.registryHosts ?? DEFAULT_REGISTRY_HOSTS,
    approvedHosts: input.approvedHosts ?? [],
    forbiddenLocalPorts: input.forbiddenLocalPorts ?? [],
  }
}
