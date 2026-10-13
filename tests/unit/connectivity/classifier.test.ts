import { describe, expect, it } from 'vitest'
import { classifyConnectivity, classifyTransportError, parseRetryAfterMs } from '@main/modules/connectivity/classifier'
import { bad, GUID, ok, raw, wlanDown } from './fakes'

const stateOf = (r: ReturnType<typeof raw>): string => classifyConnectivity(r).state

describe('connectivity classifier: one state from the probes', () => {
  it('says ONLINE when the link, names, the Internet and the provider all answer', () => {
    expect(stateOf(raw())).toBe('ONLINE')
  })

  it('says WLAN_DISCONNECTED when Wi-Fi is not associated, nothing answers and no wired link is up', () => {
    expect(stateOf(wlanDown())).toBe('WLAN_DISCONNECTED')
  })

  it('says WLAN_DISCONNECTED when the machine has no Wi-Fi interface and nothing answers', () => {
    expect(stateOf(wlanDown({ wlan: [] }))).toBe('WLAN_DISCONNECTED')
  })

  it('says WLAN_ASSOCIATED_NO_INTERNET when associated, names fail and no address answers', () => {
    expect(stateOf(raw({ dns: bad('d', 'ENOTFOUND'), endpoints: [bad('a', 'ENOTFOUND'), bad('b', 'ENOTFOUND')], addresses: [bad('1.1.1.1'), bad('8.8.8.8')], providers: { p: bad('p', 'ENOTFOUND') } }))).toBe('WLAN_ASSOCIATED_NO_INTERNET')
  })

  it('says DNS_FAILURE when associated, DNS fails and an IP address is reachable', () => {
    expect(stateOf(raw({ dns: bad('d', 'EAI_AGAIN'), endpoints: [bad('a', 'EAI_AGAIN'), bad('b', 'EAI_AGAIN')], addresses: [bad('1.1.1.1'), ok('8.8.8.8')], providers: { p: bad('p', 'EAI_AGAIN') } }))).toBe('DNS_FAILURE')
  })

  it('says INTERNET_UNREACHABLE when names resolve but neither endpoint nor address can be connected to', () => {
    expect(stateOf(raw({ endpoints: [bad('a'), bad('b')], addresses: [bad('1.1.1.1'), bad('8.8.8.8')], providers: { p: bad('p') } }))).toBe('INTERNET_UNREACHABLE')
  })

  it('does not call the Internet down when only one of two independent endpoints fails', () => {
    expect(stateOf(raw({ endpoints: [bad('a'), ok('b')] }))).toBe('ONLINE')
  })

  it('says PROVIDER_UNREACHABLE when the Internet answers and every provider host does not', () => {
    const c = classifyConnectivity(raw({ providers: { p: bad('p', 'ECONNREFUSED') } }))
    expect(c.state).toBe('PROVIDER_UNREACHABLE')
    expect(c.evidence.providers.p?.code).toBe('ECONNREFUSED')
  })

  it('stays ONLINE when one of two providers is down and the other answers, keeping both in the evidence', () => {
    const c = classifyConnectivity(raw({ providers: { a: ok('a'), b: bad('b') } }))
    expect(c.state).toBe('ONLINE')
    expect(Object.keys(c.evidence.providers)).toEqual(['a', 'b'])
  })

  it('says PROVIDER_QUOTA_WAIT when the provider answers and the usage service reports the account limited', () => {
    expect(stateOf(raw({ quota: { limited: true, resetAt: 5000 } }))).toBe('PROVIDER_QUOTA_WAIT')
  })

  it('says PROVIDER_UNREACHABLE, not a quota wait, when the provider is unreachable and the quota is limited', () => {
    expect(stateOf(raw({ providers: { p: bad('p') }, quota: { limited: true, resetAt: null } }))).toBe('PROVIDER_UNREACHABLE')
  })

  it('does not report a quota wait while the machine is offline', () => {
    expect(stateOf(wlanDown({ quota: { limited: true, resetAt: null } }))).toBe('WLAN_DISCONNECTED')
  })

  it('treats a limited=false quota as no wait', () => {
    expect(stateOf(raw({ quota: { limited: false, resetAt: null } }))).toBe('ONLINE')
  })

  it('says ONLINE for a wired connection with Internet even with Wi-Fi off', () => {
    expect(stateOf(raw({ wlan: [{ guid: GUID, state: 'disconnected', profileName: null, lastReasonCode: 0 }], wiredLinkUp: true }))).toBe('ONLINE')
  })

  it('says ONLINE when Wi-Fi is off but the Internet answers (a wired link this machine could not recognise)', () => {
    expect(stateOf(raw({ wlan: [], wiredLinkUp: false }))).toBe('ONLINE')
  })

  it('says RESEARCH_ONLY_UNAVAILABLE when the provider answers but neither general endpoint does', () => {
    expect(stateOf(raw({ endpoints: [bad('a'), bad('b')], addresses: [bad('1.1.1.1'), bad('8.8.8.8')], providers: { p: ok('p') } }))).toBe('RESEARCH_ONLY_UNAVAILABLE')
  })

  it('does not blame the provider when a wired link is up and nothing answers', () => {
    const c = classifyConnectivity(raw({ wlan: [], wiredLinkUp: true, dns: bad('d', 'ETIMEDOUT'), endpoints: [bad('a'), bad('b')], addresses: [bad('1.1.1.1'), bad('8.8.8.8')], providers: { p: bad('p') } }))
    expect(c.state).toBe('WLAN_ASSOCIATED_NO_INTERNET')
    expect(c.evidence.wiredLinkUp).toBe(true)
  })

  it('treats a missing DNS probe as a failed one when a link exists', () => {
    expect(stateOf(raw({ dns: null, endpoints: [bad('a'), bad('b')], addresses: [bad('1.1.1.1')], providers: {} }))).toBe('WLAN_ASSOCIATED_NO_INTERNET')
  })

  it('records the saved profile name, the interface state and the last reason code as evidence, and nothing else about the network', () => {
    const c = classifyConnectivity(raw({ wlan: [{ guid: GUID, state: 'connected', profileName: 'Home', lastReasonCode: 229377 }] }, 777))
    expect(c.since).toBe(777)
    expect(c.evidence).toMatchObject({ wlanAssociated: true, profileName: 'Home', wlanState: 'connected', lastReasonCode: 229377, wlanInterfaces: 1 })
    expect(JSON.stringify(c.evidence)).not.toMatch(/key|password|passphrase/i)
  })
})

describe('transport error classifier: network, provider outage, quota, auth, other', () => {
  const kind = (input: Parameters<typeof classifyTransportError>[0]): string => classifyTransportError(input).kind
  const coded = (code: string): Error => Object.assign(new Error(`connect ${code}`), { code })

  it('classifies the Node network error codes as NETWORK', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EPIPE']) {
      expect(kind({ error: coded(code) }), code).toBe('NETWORK')
    }
  })

  it('finds the code on error.cause, where undici puts it behind "fetch failed"', () => {
    const e = Object.assign(new TypeError('fetch failed'), { cause: coded('ENOTFOUND') })
    expect(classifyTransportError({ error: e })).toMatchObject({ kind: 'NETWORK', basis: 'ENOTFOUND' })
  })

  it('finds the code inside an AggregateError from a failed connect', () => {
    const e = Object.assign(new Error(''), { errors: [coded('ENETUNREACH'), coded('ETIMEDOUT')] })
    expect(kind({ error: e })).toBe('NETWORK')
  })

  it('classifies a bare "fetch failed" as NETWORK', () => {
    expect(kind({ error: new TypeError('fetch failed') })).toBe('NETWORK')
  })

  it('classifies TLS handshake and certificate errors as NETWORK, with the detail kept', () => {
    expect(classifyTransportError({ error: coded('ERR_SSL_WRONG_VERSION_NUMBER') })).toMatchObject({ kind: 'NETWORK', detail: 'TLS_HANDSHAKE' })
    expect(classifyTransportError({ error: coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE') })).toMatchObject({ kind: 'NETWORK', detail: 'TLS_CERTIFICATE' })
    expect(classifyTransportError({ error: new Error('Client network socket disconnected before secure TLS connection was established') })).toMatchObject({ kind: 'NETWORK', detail: 'TLS_HANDSHAKE' })
  })

  it('classifies HTTP 429 as QUOTA with and without Retry-After', () => {
    expect(classifyTransportError({ status: 429 })).toMatchObject({ kind: 'QUOTA', retryAfterMs: null })
    expect(classifyTransportError({ status: 429, retryAfter: '30' })).toMatchObject({ kind: 'QUOTA', retryAfterMs: 30_000 })
  })

  it('classifies HTTP 529 and 503 as PROVIDER_OUTAGE with and without Retry-After', () => {
    expect(classifyTransportError({ status: 529 })).toMatchObject({ kind: 'PROVIDER_OUTAGE', retryAfterMs: null })
    expect(classifyTransportError({ status: 503, retryAfter: '12' })).toMatchObject({ kind: 'PROVIDER_OUTAGE', retryAfterMs: 12_000 })
    expect(kind({ status: 502 })).toBe('PROVIDER_OUTAGE')
  })

  it('classifies HTTP 401 as AUTH, never as a network wait', () => {
    expect(kind({ status: 401 })).toBe('AUTH')
  })

  it('lets the HTTP status win over an error that carries a network-looking code', () => {
    expect(kind({ status: 401, error: coded('ECONNRESET') })).toBe('AUTH')
  })

  it('classifies other 4xx statuses and unknown errors as OTHER', () => {
    expect(kind({ status: 400 })).toBe('OTHER')
    expect(kind({ status: 404 })).toBe('OTHER')
    expect(kind({ error: new Error('Unexpected token < in JSON') })).toBe('OTHER')
    expect(kind({})).toBe('OTHER')
    expect(kind({ error: 'weird' })).toBe('OTHER')
  })

  it('reads a Retry-After given as an HTTP date, and refuses nonsense', () => {
    expect(parseRetryAfterMs(new Date(5_000 + 90_000).toUTCString(), 5_000)).toBeGreaterThanOrEqual(89_000)
    expect(parseRetryAfterMs('soon', 0)).toBeNull()
    expect(parseRetryAfterMs(null, 0)).toBeNull()
    expect(parseRetryAfterMs(-4, 0)).toBeNull()
  })

  it('survives a cyclic cause chain', () => {
    const a: { message: string; cause?: unknown } = { message: 'a' }
    a.cause = a
    expect(kind({ error: a })).toBe('OTHER')
  })
})
