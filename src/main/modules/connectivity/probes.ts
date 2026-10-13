import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import { connect as tlsConnect } from 'node:tls'
import type { ProbeResult, WlanInterfaceEvidence } from '@shared/connectivity'
import type { RawProbes } from './classifier'
import type { Timers } from './timers'
import type { WlanAdapter } from './wlan'

export interface ProbeIo {
  /** Resolves a name through the operating system's resolver (what applications use). Resolves to an address or throws with a `code`. */
  lookup(host: string): Promise<string>
  /** Completes a TLS handshake with host:port, verifying the certificate. Resolves on success, throws with a `code` otherwise. Sends nothing. */
  tlsReach(host: string, port: number, timeoutMs: number): Promise<void>
  /** Addresses of the machine's non-Wi-Fi adapters, as [adapter name, address]. */
  localAddresses(): Array<[string, string]>
}

export const realProbeIo: ProbeIo = {
  lookup: async (host) => (await lookup(host)).address,
  tlsReach: (host, port, timeoutMs) =>
    new Promise((resolve, reject) => {
      // An IP address must not be sent as a server name.
      const isIp = /^[\d.]+$/.test(host) || host.includes(':')
      const socket = tlsConnect({ host, port, servername: isIp ? undefined : host, timeout: timeoutMs, ALPNProtocols: ['http/1.1'] })
      const fail = (code: string): void => {
        socket.destroy()
        reject(Object.assign(new Error(code), { code }))
      }
      socket.once('secureConnect', () => {
        // authorized is false when the certificate did not verify: a captive portal or an interception is not "the Internet".
        if (socket.authorized) {
          socket.destroy()
          resolve()
        } else fail(String(socket.authorizationError ?? 'CERT_NOT_AUTHORIZED'))
      })
      socket.once('timeout', () => fail('ETIMEDOUT'))
      socket.once('error', (e: NodeJS.ErrnoException) => fail(e.code ?? e.message.slice(0, 60)))
    }),
  localAddresses: () => {
    const out: Array<[string, string]> = []
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push([name, a.address])
    }
    return out
  },
}

/** Names of adapters that are not a cable or a tether: virtual switches, VPNs, containers, Bluetooth. They do not count as a wired link. */
const VIRTUAL_ADAPTER = /vethernet|virtual|vmware|vmnet|hyper-v|wsl|loopback|bluetooth|tap-|tun|wintun|tailscale|zerotier|vpn|npcap|docker|podman|pseudo|isatap|teredo/i

export interface ConnectivityProbeOptions {
  wlan: Pick<WlanAdapter, 'status'>
  timers: Timers
  io?: ProbeIo
  /** Two independent well-known endpoints, by name. Default: Cloudflare and Google. */
  endpoints?: string[]
  /** Two literal addresses for the same check without DNS. Default: 1.1.1.1 and 8.8.8.8 (both present IP addresses in their certificates). */
  addresses?: string[]
  /** Host names of the model providers whose reachability matters (the runtime knows them). Reached by TLS handshake; no request, no credential is sent. */
  providerHosts: () => string[]
  quota: () => { limited: boolean; resetAt: number | null } | null
  timeoutMs?: number
}

/** The probe the supervisor runs: every check in parallel, each bounded by the timeout, none sending anything but a TLS handshake or a name lookup. */
export function createConnectivityProbe(o: ConnectivityProbeOptions): () => Promise<RawProbes> {
  const io = o.io ?? realProbeIo
  const timeoutMs = o.timeoutMs ?? 4_000
  const endpoints = o.endpoints ?? ['www.cloudflare.com', 'www.google.com']
  const addresses = o.addresses ?? ['1.1.1.1', '8.8.8.8']

  const timed = async (target: string, fn: () => Promise<unknown>): Promise<ProbeResult> => {
    const began = o.timers.now()
    let guard: NodeJS.Timeout | undefined
    try {
      // The IO has its own timeout; this one bounds a lookup, which has none.
      await Promise.race([fn(), new Promise((_, reject) => (guard = setTimeout(() => reject(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })), timeoutMs + 500)))])
      return { target, ok: true, code: null, ms: o.timers.now() - began }
    } catch (e) {
      const code = (e as { code?: unknown }).code
      return { target, ok: false, code: typeof code === 'string' ? code : 'ERROR', ms: o.timers.now() - began }
    } finally {
      clearTimeout(guard)
    }
  }

  return async () => {
    let wlan: WlanInterfaceEvidence[] = []
    let wlanAliases: string[] = []
    try {
      const interfaces = await o.wlan.status()
      wlan = interfaces.map((i) => ({ guid: i.guid, state: i.state, profileName: i.profileName, lastReasonCode: i.lastReasonCode }))
      wlanAliases = interfaces.map((i) => i.alias).filter((a): a is string => a !== null)
    } catch {
      // The WLAN service or the helper is unavailable: Wi-Fi is unknown, and the Internet checks still decide.
    }
    const providers = [...new Set(o.providerHosts())]
    const [dns, ...rest] = await Promise.all([
      timed(endpoints[0] ?? 'www.cloudflare.com', () => io.lookup(endpoints[0] ?? 'www.cloudflare.com')),
      ...endpoints.map((h) => timed(h, () => io.tlsReach(h, 443, timeoutMs))),
      ...addresses.map((a) => timed(a, () => io.tlsReach(a, 443, timeoutMs))),
      ...providers.map((h) => timed(h, () => io.tlsReach(h, 443, timeoutMs))),
    ])
    const endpointResults = rest.slice(0, endpoints.length)
    const addressResults = rest.slice(endpoints.length, endpoints.length + addresses.length)
    const providerResults = rest.slice(endpoints.length + addresses.length)
    const wired = io.localAddresses().some(([name, address]) => !wlanAliases.includes(name) && !VIRTUAL_ADAPTER.test(name) && !address.startsWith('169.254.'))
    return {
      at: o.timers.now(),
      wlan,
      wiredLinkUp: wired,
      dns: dns as ProbeResult,
      endpoints: endpointResults,
      addresses: addressResults,
      providers: Object.fromEntries(providers.map((h, i) => [h, providerResults[i] as ProbeResult])),
      quota: o.quota(),
    }
  }
}
