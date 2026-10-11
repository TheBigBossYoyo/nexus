import { lookup as dnsLookup } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import { checkConnect, checkUrl, normalizeHost, type NetworkDenial, type NetworkPolicy, type NetworkVerdict } from './policy'

/**
 * 0.8: the connect-time half of the network policy. A name is resolved here, once; every address of the answer
 * is checked; and the connection is made to the address that was checked, not to a second resolution of the
 * name. That is what makes a rebinding answer useless: the address a later lookup would give is never used.
 */

export type Resolver = (hostname: string) => Promise<string[]>

/** Every address the system resolver gives for a name, in its own order. */
export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error)
      else resolve(addresses.map((a) => a.address))
    })
  })

export class NetworkDenied extends Error {
  constructor(
    readonly denial: NetworkDenial,
    message: string,
    readonly target: string,
  ) {
    super(message)
    this.name = 'NetworkDenied'
  }
}

export interface NetworkEvent {
  at: string
  /** What asked: 'fetch', 'proxy-connect', 'proxy-http'. */
  via: string
  method: string
  host: string
  port: number
  allowed: boolean
  denial: NetworkDenial | null
  /** The address connected to, when allowed. */
  address: string | null
}

export interface GuardOptions {
  policy: NetworkPolicy
  resolver?: Resolver
  /** Told about every decision: the record of which hosts a session reached and which it was refused. */
  onEvent?: (event: NetworkEvent) => void
  /**
   * Tests only: where to really connect for an address that passed the check, so that a test can stand a local
   * server in for a public host. The policy is evaluated on the resolved address before this is consulted.
   */
  dial?: (address: string, port: number) => { host: string; port: number }
}

export interface PinnedTarget {
  hostname: string
  port: number
  /** The checked address the connection must use. */
  address: string
  family: 4 | 6
  /** Where the socket is really opened: the address itself, or a test's stand-in. */
  connect: { host: string; port: number }
}

function refuse(verdict: Exclude<NetworkVerdict, { allowed: true }>, target: string): never {
  throw new NetworkDenied(verdict.denial, verdict.reason, target)
}

/**
 * Resolves a host and decides whether this policy may connect to it. Returns the one address to use. Throws
 * NetworkDenied otherwise. An IP literal is its own answer and is checked the same way.
 */
export async function pin(options: GuardOptions, via: string, method: string, hostname: string, port: number): Promise<PinnedTarget> {
  const host = normalizeHost(hostname)
  const emit = (allowed: boolean, denial: NetworkDenial | null, address: string | null): void => {
    try {
      options.onEvent?.({ at: new Date().toISOString(), via, method, host, port, allowed, denial, address })
    } catch {
      // The record is not the gate.
    }
  }
  let addresses: string[]
  try {
    addresses = isIP(host) !== 0 ? [host] : await (options.resolver ?? systemResolver)(host)
  } catch {
    emit(false, 'RESOLUTION', null)
    throw new NetworkDenied('RESOLUTION', `${host} could not be resolved.`, `${host}:${port}`)
  }
  const verdict = checkConnect(options.policy, host, port, addresses)
  if (!verdict.allowed) {
    emit(false, verdict.denial, null)
    refuse(verdict, `${host}:${port}`)
  }
  const address = addresses[0] as string
  emit(true, null, address)
  const connect = options.dial ? options.dial(address, port) : { host: address, port }
  return { hostname: host, port, address, family: isIP(address) === 6 ? 6 : 4, connect }
}

/** The URL half and the connect half together, for one request. */
export async function pinUrl(options: GuardOptions, via: string, method: string, raw: string, urlOptions: { websocket?: boolean } = {}): Promise<{ url: URL; target: PinnedTarget }> {
  const checked = checkUrl(options.policy, raw, urlOptions)
  if (!checked.allowed || checked.url === undefined) {
    const verdict = checked as Exclude<NetworkVerdict, { allowed: true }>
    let host = ''
    let port = 0
    try {
      const u = new URL(raw)
      host = normalizeHost(u.hostname)
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    } catch {
      // not a URL: nothing to name
    }
    try {
      options.onEvent?.({ at: new Date().toISOString(), via, method, host, port, allowed: false, denial: verdict.denial, address: null })
    } catch {
      // The record is not the gate.
    }
    refuse(verdict, raw.slice(0, 200))
  }
  const url = checked.url
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
  return { url, target: await pin(options, via, method, url.hostname, port) }
}

/**
 * A `lookup` for Node's sockets that answers with the pinned address and nothing else. Passed to a request so
 * that the socket cannot be given another address than the one that was checked.
 */
export function pinnedLookup(target: PinnedTarget): LookupFunction {
  const host = target.connect.host
  const family = isIP(host) === 6 ? 6 : 4
  return ((_hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (error: Error | null, address: unknown, family?: number) => void
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
    if (all) cb(null, [{ address: host, family }])
    else cb(null, host, family)
  }) as LookupFunction
}

/**
 * The second look, after the socket is connected: the address at the other end must be the pinned one. A
 * mismatch means something below this code chose another address, and the connection is not used.
 */
export function socketMatches(target: PinnedTarget, remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false
  const strip = (a: string): string => a.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1').toLowerCase()
  return strip(remoteAddress) === strip(target.connect.host)
}
