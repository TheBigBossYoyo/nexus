import { isIP } from 'node:net'

/**
 * 0.8: what an IP address is, for the network policy. The check that matters is made on the address a socket
 * is about to connect to, after the name was resolved; a look at the host name is only a first filter. Every
 * range below is refused to a session that may only reach the public Internet (docs/UNTRUSTED_CONTENT_SECURITY.md,
 * 4.4, with the registries it cites). An address this module cannot parse is not public.
 */

export type AddressClass =
  | 'PUBLIC'
  | 'LOOPBACK'
  | 'PRIVATE'
  | 'LINK_LOCAL'
  | 'SHARED'
  | 'UNSPECIFIED'
  | 'MULTICAST'
  | 'RESERVED'
  | 'DOCUMENTATION'
  | 'TRANSLATED'
  | 'INVALID'

/** Four octets of a dotted IPv4 address as Node reports it (canonical form only), or null. */
function v4Octets(text: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (m === null) return null
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (o.some((n) => n > 255)) return null
  return o as [number, number, number, number]
}

function classifyV4(o: readonly [number, number, number, number]): AddressClass {
  const [a, b, c, d] = o
  if (a === 0) return 'UNSPECIFIED' // 0.0.0.0/8: "this network"; 0.0.0.0 reaches the local host on many systems
  if (a === 127) return 'LOOPBACK'
  if (a === 10) return 'PRIVATE'
  if (a === 172 && b >= 16 && b <= 31) return 'PRIVATE'
  if (a === 192 && b === 168) return 'PRIVATE'
  if (a === 169 && b === 254) return 'LINK_LOCAL' // includes the cloud metadata address 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return 'SHARED' // carrier NAT; some clouds use it internally
  if (a === 192 && b === 0 && c === 0) return 'RESERVED' // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'DOCUMENTATION'
  if (a === 198 && b === 51 && c === 100) return 'DOCUMENTATION'
  if (a === 203 && b === 0 && c === 113) return 'DOCUMENTATION'
  if (a === 192 && b === 88 && c === 99) return 'RESERVED' // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'RESERVED' // benchmarking
  if (a === 168 && b === 63 && c === 129 && d === 16) return 'RESERVED' // Azure wireserver
  if (a >= 224 && a <= 239) return 'MULTICAST'
  if (a >= 240) return 'RESERVED' // includes the broadcast address
  return 'PUBLIC'
}

/** Eight 16-bit groups of an IPv6 address in any textual form Node accepts, or null. A zone id is refused. */
function v6Groups(text: string): number[] | null {
  if (text.includes('%')) return null
  let rest = text
  const tail: number[] = []
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(rest)
  if (dotted !== null) {
    const o = v4Octets(dotted[2] as string)
    if (o === null) return null
    tail.push(o[0] * 256 + o[1], o[2] * 256 + o[3])
    rest = (dotted[1] as string).endsWith('::') ? (dotted[1] as string) : (dotted[1] as string).slice(0, -1)
  }
  const halves = rest.split('::')
  if (halves.length > 2) return null
  const part = (s: string): number[] | null => {
    if (s === '') return []
    const out: number[] = []
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
    return out
  }
  const left = part(halves[0] ?? '')
  const right = halves.length === 2 ? part(halves[1] ?? '') : []
  if (left === null || right === null) return null
  const want = 8 - tail.length
  if (halves.length === 1) return left.length === want ? [...left, ...tail] : null
  const fill = want - left.length - right.length
  if (fill < 1) return null
  return [...left, ...new Array<number>(fill).fill(0), ...right, ...tail]
}

const embedded = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]

function classifyV6(g: readonly number[]): AddressClass {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number]
  const zeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0)
  if (zeros(8)) return 'UNSPECIFIED'
  if (zeros(7) && g7 === 1) return 'LOOPBACK'
  // An IPv4 address carried inside an IPv6 one is judged as that IPv4 address, and is never better than translated.
  const inner = (hi: number, lo: number): AddressClass => {
    const cls = classifyV4(embedded(hi, lo))
    return cls === 'PUBLIC' ? 'TRANSLATED' : cls
  }
  if (zeros(5) && g5 === 0xffff) return inner(g6, g7) // ::ffff:a.b.c.d, IPv4-mapped
  if (zeros(6)) return inner(g6, g7) // ::a.b.c.d, IPv4-compatible (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return inner(g6, g7) // NAT64 well-known prefix
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return 'TRANSLATED' // local-use NAT64
  if (g0 === 0x2002) return inner(g1, g2) // 6to4
  if (g0 === 0x2001 && g1 === 0) return 'TRANSLATED' // Teredo
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return 'RESERVED' // discard-only
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x10) return 'RESERVED' // ORCHID
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x20) return 'RESERVED' // ORCHIDv2
  if (g0 === 0x2001 && g1 === 0xdb8) return 'DOCUMENTATION'
  if ((g0 & 0xfff0) === 0x3ff0) return 'DOCUMENTATION' // 3fff::/20
  if ((g0 & 0xfe00) === 0xfc00) return 'PRIVATE' // unique local, including the AWS metadata address fd00:ec2::254
  if ((g0 & 0xffc0) === 0xfe80) return 'LINK_LOCAL'
  if ((g0 & 0xffc0) === 0xfec0) return 'PRIVATE' // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return 'MULTICAST'
  // Only the global unicast block is public; the rest of the space is unassigned.
  if ((g0 & 0xe000) !== 0x2000) return 'RESERVED'
  return 'PUBLIC'
}

/**
 * The class of an address as a resolver or a socket reports it: canonical dotted IPv4, or IPv6 with or without
 * brackets. Anything else is INVALID. Host names are not addresses: resolve first.
 */
export function classifyAddress(address: string): AddressClass {
  const text = address.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const family = isIP(text)
  if (family === 4) {
    const o = v4Octets(text)
    return o === null ? 'INVALID' : classifyV4(o)
  }
  if (family === 6) {
    const g = v6Groups(text)
    return g === null ? 'INVALID' : classifyV6(g)
  }
  return 'INVALID'
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'PUBLIC'
}

export function isLoopbackAddress(address: string): boolean {
  return classifyAddress(address) === 'LOOPBACK'
}

/** Names that never mean a public host. A cheap first filter and a readable refusal; the address check is the control. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'intranet', 'corp', 'home', 'private', 'home.arpa', 'test', 'invalid', 'example', 'onion']

export function isLocalName(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, '')
  if (host === '') return true
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return false
  const labels = host.split('.')
  if (labels.length === 1) return true // a single label is resolved by the local network (NetBIOS, LLMNR, search suffixes)
  return LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}
