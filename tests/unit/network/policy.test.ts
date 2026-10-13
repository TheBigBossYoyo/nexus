import { describe, expect, it } from 'vitest'
import { classifyAddress, isLocalName, isPublicAddress } from '@main/modules/network/address'
import { checkConnect, checkUrl, policyForProjectCommands, policyForPurpose, type NetworkPolicy } from '@main/modules/network/policy'

const research = policyForPurpose('PUBLIC_RESEARCH', { forbiddenLocalPorts: [41234] })
const appTest = policyForPurpose('LOCAL_APP_TEST', { localEndpoints: [{ host: '127.0.0.1', port: 5173 }], forbiddenLocalPorts: [41234] })
const denial = (v: ReturnType<typeof checkUrl>): string => (v.allowed ? 'ALLOWED' : v.denial)

describe('address classes', () => {
  it('names every range a public session must not reach (IPv4)', () => {
    const blocked: Record<string, string> = {
      '0.0.0.0': 'UNSPECIFIED',
      '0.1.2.3': 'UNSPECIFIED',
      '10.0.0.1': 'PRIVATE',
      '10.255.255.255': 'PRIVATE',
      '100.64.0.1': 'SHARED',
      '100.100.100.200': 'SHARED',
      '127.0.0.1': 'LOOPBACK',
      '127.255.255.254': 'LOOPBACK',
      '169.254.169.254': 'LINK_LOCAL',
      '169.254.170.2': 'LINK_LOCAL',
      '172.16.0.1': 'PRIVATE',
      '172.31.255.255': 'PRIVATE',
      '192.0.0.192': 'RESERVED',
      '192.0.2.1': 'DOCUMENTATION',
      '198.51.100.7': 'DOCUMENTATION',
      '203.0.113.9': 'DOCUMENTATION',
      '192.88.99.1': 'RESERVED',
      '192.168.1.1': 'PRIVATE',
      '198.18.0.1': 'RESERVED',
      '198.19.255.255': 'RESERVED',
      '168.63.129.16': 'RESERVED',
      '224.0.0.1': 'MULTICAST',
      '239.255.255.255': 'MULTICAST',
      '240.0.0.1': 'RESERVED',
      '255.255.255.255': 'RESERVED',
    }
    for (const [address, cls] of Object.entries(blocked)) expect(classifyAddress(address), address).toBe(cls)
  })

  it('does not block the neighbours of those ranges', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.1', '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.1', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255', '93.184.216.34']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('names every blocked IPv6 range, and judges an IPv4 address carried inside by that address', () => {
    const blocked: Record<string, string> = {
      '::': 'UNSPECIFIED',
      '::1': 'LOOPBACK',
      '0:0:0:0:0:0:0:1': 'LOOPBACK',
      '::ffff:127.0.0.1': 'LOOPBACK',
      '::ffff:7f00:1': 'LOOPBACK',
      '::ffff:10.0.0.1': 'PRIVATE',
      '::ffff:169.254.169.254': 'LINK_LOCAL',
      '::127.0.0.1': 'LOOPBACK',
      '64:ff9b::7f00:1': 'LOOPBACK',
      '64:ff9b::10.1.2.3': 'PRIVATE',
      '64:ff9b:1::1': 'TRANSLATED',
      '2002:7f00:1::': 'LOOPBACK',
      '2002:c0a8:101::1': 'PRIVATE',
      '2001::1': 'TRANSLATED',
      '100::1': 'RESERVED',
      '2001:10::1': 'RESERVED',
      '2001:20::1': 'RESERVED',
      '2001:db8::1': 'DOCUMENTATION',
      '3fff::1': 'DOCUMENTATION',
      'fc00::1': 'PRIVATE',
      'fd00:ec2::254': 'PRIVATE',
      'fe80::1': 'LINK_LOCAL',
      'fec0::1': 'PRIVATE',
      'ff02::1': 'MULTICAST',
      '[::1]': 'LOOPBACK',
    }
    for (const [address, cls] of Object.entries(blocked)) expect(classifyAddress(address), address).toBe(cls)
    // A public IPv4 address reached through a translation prefix is still not a plain public address.
    expect(classifyAddress('::ffff:8.8.8.8')).toBe('TRANSLATED')
    expect(classifyAddress('64:ff9b::8.8.8.8')).toBe('TRANSLATED')
    expect(classifyAddress('2002:808:808::1')).toBe('TRANSLATED')
    for (const address of ['2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '2001:4860:4860::8888']) expect(isPublicAddress(address), address).toBe(true)
  })

  it('is not public when it cannot be read: zone ids, names, shorthand, nonsense', () => {
    for (const text of ['fe80::1%eth0', 'localhost', 'example.com', '127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '1.2.3', '1.2.3.4.5', '256.1.1.1', '', ':::', 'gggg::1']) expect(classifyAddress(text), text).toBe('INVALID')
  })

  it('knows the names of the local network', () => {
    for (const name of ['localhost', 'printer', 'nas.local', 'db.internal', 'metadata.google.internal', 'router.lan', 'x.home.arpa', 'a.b.localhost', 'thing.test', '']) expect(isLocalName(name), name).toBe(true)
    for (const name of ['example.com', 'docs.microsoft.com', 'localhost.example.com', 'internal.example.org', '8.8.8.8']) expect(isLocalName(name), name).toBe(false)
  })
})

describe('the URL check of a public research session', () => {
  it('opens ordinary public pages', () => {
    for (const url of ['https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects', 'http://example.com/', 'https://github.com/microsoft/playwright/issues/1?q=a', 'https://[2606:4700:4700::1111]/']) expect(denial(checkUrl(research, url)), url).toBe('ALLOWED')
  })

  it('refuses every scheme but http and https', () => {
    for (const url of ['file:///C:/Users/x/.ssh/id_rsa', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'view-source:https://example.com', 'blob:https://example.com/1', 'about:blank', 'chrome://settings', 'ftp://example.com/x', 'ws://example.com/', 'vscode://file/x', 'ms-settings:privacy', 'mailto:a@b.c', 'ssh://example.com']) {
      expect(denial(checkUrl(research, url)), url).toMatch(/SCHEME|URL_INVALID/)
    }
  })

  it('refuses the local host and private addresses in every spelling a URL allows', () => {
    const local = [
      'http://localhost/', 'http://LOCALHOST:8080/', 'http://localhost./', 'http://app.localhost/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://0x7f.1/',
      'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://0.0.0.0/', 'http://0/',
    ]
    for (const url of local) expect(denial(checkUrl(research, url)), url).toMatch(/PRIVATE_ADDRESS|NEXUS_ENDPOINT/)
    const lan = ['http://10.0.0.5/', 'http://192.168.1.1/admin', 'http://172.16.3.4/', 'http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'http://100.100.100.200/', 'http://[64:ff9b::a00:1]/', 'http://168.63.129.16/']
    for (const url of lan) expect(denial(checkUrl(research, url)), url).toBe('PRIVATE_ADDRESS')
    for (const url of ['http://intranet/', 'http://nas.local/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://build.corp/']) expect(denial(checkUrl(research, url)), url).toBe('LOCAL_NAME')
  })

  it('refuses credentials in the URL, an over-long URL, and a port that is not a web port', () => {
    expect(denial(checkUrl(research, 'https://user:pass@example.com/'))).toBe('USERINFO')
    expect(denial(checkUrl(research, 'https://example.com@evil.example/'))).toBe('USERINFO')
    expect(denial(checkUrl(research, `https://example.com/?q=${'a'.repeat(2100)}`))).toBe('URL_TOO_LONG')
    expect(denial(checkUrl(research, 'http://example.com:22/'))).toBe('PORT')
    expect(denial(checkUrl(research, 'https://example.com:8443/'))).toBe('PORT')
    // 0.9 (review, K-3): the registries too are reached on the web's ports only: no ssh to github.com through the proxy.
    const deps = policyForProjectCommands({ network: true })
    expect(denial(checkUrl(deps, 'https://github.com:22/'))).toBe('PORT')
    expect(denial(checkUrl(deps, 'https://registry.npmjs.org:25/'))).toBe('PORT')
    expect(denial(checkUrl(deps, 'http://nodejs.org:8080/'))).toBe('PORT')
    expect(checkUrl(deps, 'https://registry.npmjs.org/react').allowed).toBe(true)
    expect(checkUrl(deps, 'http://registry.npmjs.org:80/react').allowed).toBe(true)
    expect(denial(checkUrl(research, 'not a url'))).toBe('URL_INVALID')
  })
})

describe('the connect check: the address the socket will use', () => {
  it('lets a public name through when every address it resolved to is public', () => {
    expect(checkConnect(research, 'example.com', 443, ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']).allowed).toBe(true)
  })

  it('refuses a public name that resolves to a private or local address: rebinding', () => {
    for (const addresses of [['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['::1'], ['192.168.0.10'], ['::ffff:127.0.0.1'], ['fd00::1']]) {
      const v = checkConnect(research, 'rebind.attacker.example', 80, addresses)
      expect(v.allowed, addresses.join()).toBe(false)
      if (!v.allowed) expect(v.denial).toBe('PRIVATE_ADDRESS')
    }
  })

  it('refuses when one answer of several is not public', () => {
    expect(checkConnect(research, 'mixed.attacker.example', 80, ['93.184.216.34', '127.0.0.1']).allowed).toBe(false)
    expect(checkConnect(research, 'mixed.attacker.example', 80, ['10.0.0.1', '93.184.216.34']).allowed).toBe(false)
  })

  it('refuses a name with no answer and an answer that is not an address', () => {
    expect(checkConnect(research, 'example.com', 80, []).allowed).toBe(false)
    expect(checkConnect(research, 'example.com', 80, ['not-an-address']).allowed).toBe(false)
  })
})

describe('a local application test session', () => {
  it('reaches the registered endpoint and nothing else on the machine', () => {
    expect(denial(checkUrl(appTest, 'http://127.0.0.1:5173/'))).toBe('ALLOWED')
    expect(denial(checkUrl(appTest, 'http://localhost:5173/settings'))).toBe('ALLOWED')
    expect(denial(checkUrl(appTest, 'http://127.0.0.1:5174/'))).toBe('NOT_REGISTERED_ENDPOINT')
    expect(denial(checkUrl(appTest, 'http://127.0.0.1:3000/'))).toBe('NOT_REGISTERED_ENDPOINT')
    expect(denial(checkUrl(appTest, 'http://127.0.0.1/'))).toBe('NOT_REGISTERED_ENDPOINT')
    expect(denial(checkUrl(appTest, 'http://192.168.1.1/'))).toBe('PRIVATE_ADDRESS')
    expect(checkConnect(appTest, 'localhost', 5173, ['127.0.0.1', '::1']).allowed).toBe(true)
    expect(checkConnect(appTest, 'localhost', 9999, ['127.0.0.1']).allowed).toBe(false)
  })

  it('does not reach the public Internet by default, and reaches a host its project approved', () => {
    expect(denial(checkUrl(appTest, 'https://example.com/'))).toBe('PUBLIC_NOT_ALLOWED')
    expect(checkConnect(appTest, 'example.com', 443, ['93.184.216.34']).allowed).toBe(false)
    const withApi = policyForPurpose('LOCAL_APP_TEST', { localEndpoints: [{ host: '127.0.0.1', port: 5173 }], appNetwork: 'APPROVED_HOSTS', approvedHosts: ['api.example.com'] })
    expect(denial(checkUrl(withApi, 'https://api.example.com/v1'))).toBe('ALLOWED')
    expect(denial(checkUrl(withApi, 'https://other.example.com/'))).toBe('PUBLIC_NOT_ALLOWED')
  })

  it("never reaches NEXUS's own local port, even when it is registered by mistake or the profile is FULL", () => {
    const mistaken: NetworkPolicy = { ...appTest, localEndpoints: [{ host: '127.0.0.1', port: 41234 }] }
    expect(denial(checkUrl(mistaken, 'http://127.0.0.1:41234/'))).toBe('NEXUS_ENDPOINT')
    const full: NetworkPolicy = { ...mistaken, profile: 'FULL' }
    expect(denial(checkUrl(full, 'http://127.0.0.1:41234/'))).toBe('NEXUS_ENDPOINT')
    expect(checkConnect(full, 'localhost', 41234, ['127.0.0.1']).allowed).toBe(false)
  })
})

describe('the two purposes share nothing', () => {
  it('research cannot reach what the application test can, and the other way round', () => {
    expect(denial(checkUrl(research, 'http://127.0.0.1:5173/'))).toBe('PRIVATE_ADDRESS')
    expect(denial(checkUrl(appTest, 'https://learn.microsoft.com/'))).toBe('PUBLIC_NOT_ALLOWED')
  })
})

describe('project commands', () => {
  it('reach the approved registries and nothing else that is public', () => {
    const deps = policyForProjectCommands({ network: true })
    expect(denial(checkUrl(deps, 'https://registry.npmjs.org/left-pad'))).toBe('ALLOWED')
    expect(denial(checkUrl(deps, 'https://pypi.org/simple/requests/'))).toBe('ALLOWED')
    expect(denial(checkUrl(deps, 'https://collector.attacker.org/collect?d=x'))).toBe('HOST_NOT_ALLOWED')
    expect(denial(checkUrl(deps, 'https://registry.npmjs.org.attacker.org/'))).toBe('HOST_NOT_ALLOWED')
    expect(checkConnect(deps, 'registry.npmjs.org', 443, ['10.0.0.1']).allowed).toBe(false)
    expect(denial(checkUrl(policyForProjectCommands({ network: false }), 'https://registry.npmjs.org/'))).toBe('NETWORK_OFF')
  })
})
