import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { connect as netConnect, type AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FetchFailed, safeFetch } from '@main/modules/network/fetch'
import { NetworkDenied, type GuardOptions, type NetworkEvent, type Resolver } from '@main/modules/network/guard'
import { policyForPurpose } from '@main/modules/network/policy'
import { startPolicyProxy, type PolicyProxy } from '@main/modules/network/proxy'

// A local server stands in for the public Internet: names resolve, through the test's resolver, to public
// addresses, and the test's dial sends a connection to a public address to the local server. The policy is
// evaluated on the resolved address before the dial is consulted, so what is tested is the policy and the
// pinning, not the stand-in. `secret` counts requests that reached the "internal" page: it must stay 0.

let site: Server
let port = 0
const seen: { url: string; method: string; headers: IncomingMessage['headers'] }[] = []
let secretHits = 0
let resolves: string[] = []

const PUBLIC = '93.184.216.34'
const names: Record<string, string[] | (() => string[])> = {
  'docs.public-site.org': [PUBLIC],
  'other.public-site.org': ['93.184.216.35'],
  'rebind.attacker.org': ['127.0.0.1'],
  'lan.attacker.org': ['192.168.1.10'],
  'metadata.attacker.org': ['169.254.169.254'],
  'mixed.attacker.org': [PUBLIC, '10.0.0.7'],
  'v6map.attacker.org': ['::ffff:127.0.0.1'],
}
const resolver: Resolver = async (host) => {
  resolves.push(host)
  const entry = names[host]
  if (entry === undefined) throw new Error('ENOTFOUND')
  return typeof entry === 'function' ? entry() : entry
}

function guard(over: Partial<GuardOptions> = {}): GuardOptions & { events: NetworkEvent[] } {
  const events: NetworkEvent[] = []
  return { policy: policyForPurpose('PUBLIC_RESEARCH', {}), resolver, dial: () => ({ host: '127.0.0.1', port }), onEvent: (e) => void events.push(e), events, ...over }
}

beforeAll(async () => {
  site = createServer((req, res) => {
    seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers })
    const url = req.url ?? ''
    const redirect = (to: string): void => {
      res.writeHead(302, { location: to })
      res.end()
    }
    if (url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=1' })
      res.end('<html><title>Docs</title><body>Job objects group processes.</body></html>')
    } else if (url === '/secret') {
      secretHits += 1
      res.end('INTERNAL-SENTINEL')
    } else if (url === '/to-localhost') redirect(`http://127.0.0.1:${port}/secret`)
    else if (url === '/to-localhost-name') redirect(`http://localhost:${port}/secret`)
    else if (url === '/to-lan') redirect('http://192.168.1.10/admin')
    else if (url === '/to-metadata') redirect('http://169.254.169.254/latest/meta-data/')
    else if (url === '/to-file') redirect('file:///C:/Users/x/.ssh/id_rsa')
    else if (url === '/to-rebind') redirect('http://rebind.attacker.org/secret')
    else if (url === '/to-decimal') redirect('http://2130706433/secret')
    else if (url === '/hop1') redirect('/hop2')
    else if (url === '/hop2') redirect('http://other.public-site.org/page')
    else if (url === '/chain-then-local') redirect('/chain-2')
    else if (url === '/chain-2') redirect('http://other.public-site.org/to-localhost')
    else if (url === '/loop') redirect('/loop')
    else if (url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(300_000))
    } else if (url === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      res.end(gzipSync('compressed body'))
    } else if (url === '/bomb') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      res.end(gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x61)))
    } else if (url === '/file') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="setup.exe"' })
      res.end('MZ')
    } else if (url === '/echo' && req.method === 'POST') {
      secretHits += 1
      res.end('posted')
    } else {
      res.writeHead(404)
      res.end('no')
    }
  })
  await new Promise<void>((resolve) => site.listen({ host: '127.0.0.1', port: 0 }, resolve))
  port = (site.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => site.close(() => resolve())))
beforeEach(() => {
  seen.length = 0
  secretHits = 0
  resolves = []
})

const denied = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return 'ALLOWED'
  } catch (e) {
    if (e instanceof NetworkDenied) return e.denial
    if (e instanceof FetchFailed) return `FAILED:${e.code}`
    throw e
  }
}

describe('safe fetch', () => {
  it('reads a public page: one resolution, the content, its hash and where it came from', async () => {
    const g = guard()
    const r = await safeFetch('http://docs.public-site.org/page', g)
    expect(r.status).toBe(200)
    expect(r.body.toString()).toContain('Job objects group processes.')
    expect(r.finalUrl).toBe('http://docs.public-site.org/page')
    expect(r.chain).toEqual(['http://docs.public-site.org/page'])
    expect(r.address).toBe(PUBLIC)
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.contentType).toContain('text/html')
    expect(resolves).toEqual(['docs.public-site.org'])
    expect(g.events).toMatchObject([{ via: 'fetch', method: 'GET', host: 'docs.public-site.org', port: 80, allowed: true, address: PUBLIC }])
  })

  it('sends a GET with no cookie, no credential and no referrer, and keeps the name in the Host header', async () => {
    await safeFetch('http://docs.public-site.org/page', guard())
    const request = seen[0]
    expect(request?.method).toBe('GET')
    expect(request?.headers.host).toBe('docs.public-site.org')
    for (const header of ['cookie', 'authorization', 'referer', 'origin']) expect(request?.headers[header], header).toBeUndefined()
    expect(request?.headers['user-agent']).toContain('NEXUS')
  })

  it('re-checks every redirect: a public page cannot send it to the local host, the LAN, the metadata address or a file', async () => {
    const cases: Record<string, string> = {
      '/to-localhost': 'PRIVATE_ADDRESS',
      '/to-localhost-name': 'PRIVATE_ADDRESS',
      '/to-lan': 'PRIVATE_ADDRESS',
      '/to-metadata': 'PRIVATE_ADDRESS',
      '/to-file': 'SCHEME',
      '/to-rebind': 'PRIVATE_ADDRESS',
      '/to-decimal': 'PRIVATE_ADDRESS',
      '/chain-then-local': 'PRIVATE_ADDRESS',
    }
    for (const [path, want] of Object.entries(cases)) expect(await denied(safeFetch(`http://docs.public-site.org${path}`, guard())), path).toBe(want)
    expect(secretHits).toBe(0)
    expect(seen.some((s) => s.url === '/secret')).toBe(false)
  })

  it('follows redirects between public hosts and records the chain', async () => {
    const r = await safeFetch('http://docs.public-site.org/hop1', guard())
    expect(r.chain).toEqual(['http://docs.public-site.org/hop1', 'http://docs.public-site.org/hop2', 'http://other.public-site.org/page'])
    expect(r.finalUrl).toBe('http://other.public-site.org/page')
    expect(r.address).toBe('93.184.216.35')
  })

  it('refuses a public name that resolves to a local or private address, without connecting', async () => {
    for (const host of ['rebind.attacker.org', 'lan.attacker.org', 'metadata.attacker.org', 'mixed.attacker.org', 'v6map.attacker.org']) {
      expect(await denied(safeFetch(`http://${host}/secret`, guard())), host).toBe('PRIVATE_ADDRESS')
    }
    expect(seen).toEqual([])
  })

  it('uses the address it checked: a name that answers differently the second time gains nothing', async () => {
    let calls = 0
    names['flip.attacker.org'] = () => (calls++ === 0 ? [PUBLIC] : ['127.0.0.1'])
    const dialed: string[] = []
    const g = guard({ dial: (address) => (dialed.push(address), { host: '127.0.0.1', port }) })
    const r = await safeFetch('http://flip.attacker.org/page', g)
    expect(r.status).toBe(200)
    // One resolution for the one connection, and the connection went to the address of that resolution.
    expect(calls).toBe(1)
    expect(dialed).toEqual([PUBLIC])
    // A second fetch resolves again and is judged again: now the answer is local, and it is refused.
    expect(await denied(safeFetch('http://flip.attacker.org/secret', g))).toBe('PRIVATE_ADDRESS')
    expect(secretHits).toBe(0)
  })

  it('refuses local and private targets in every spelling, with no resolution and no connection', async () => {
    for (const url of [`http://127.0.0.1:${port}/secret`, `http://localhost:${port}/secret`, 'http://2130706433/secret', 'http://0x7f.1/secret', 'http://[::1]/secret', 'http://[::ffff:127.0.0.1]/secret', 'http://10.0.0.1/', 'http://169.254.169.254/', 'file:///C:/Windows/win.ini', 'javascript:1']) {
      expect(await denied(safeFetch(url, guard())), url).toMatch(/PRIVATE_ADDRESS|SCHEME/)
    }
    expect(resolves).toEqual([])
    expect(seen).toEqual([])
  })

  it('stops at the redirect limit and at the size limit, and decodes a compressed body under the same limit', async () => {
    expect(await denied(safeFetch('http://docs.public-site.org/loop', guard()))).toBe('FAILED:TOO_MANY_REDIRECTS')
    const big = await safeFetch('http://docs.public-site.org/big', { ...guard(), maxBytes: 10_000 })
    expect(big.body.length).toBe(10_000)
    expect(big.truncated).toBe(true)
    const gz = await safeFetch('http://docs.public-site.org/gzip', guard())
    expect(gz.body.toString()).toBe('compressed body')
    const bomb = await safeFetch('http://docs.public-site.org/bomb', { ...guard(), maxBytes: 50_000 })
    expect(bomb.body.length).toBe(50_000)
    expect(bomb.truncated).toBe(true)
  })

  it('reports a file the server wants saved, with its name as data', async () => {
    const r = await safeFetch('http://docs.public-site.org/file', guard())
    expect(r.dispositionFilename).toBe('setup.exe')
    expect(r.contentType).toBe('application/octet-stream')
  })

  it('fails for a name that does not resolve, and records the refusal', async () => {
    const g = guard()
    expect(await denied(safeFetch('http://nowhere.public-site.org/', g))).toBe('RESOLUTION')
    expect(g.events[0]).toMatchObject({ allowed: false, denial: 'RESOLUTION' })
  })
})

describe('the filtering proxy', () => {
  let proxy: PolicyProxy
  const events: NetworkEvent[] = []

  beforeAll(async () => {
    proxy = await startPolicyProxy({ ...guard(), onEvent: (e) => void events.push(e), readOnly: true })
  })
  afterAll(() => proxy.close())
  beforeEach(() => void (events.length = 0))

  const auth = (): string => `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`

  function through(url: string, options: { method?: string; auth?: string | null; body?: string } = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: new URL(url).host }
      if (options.auth !== null) headers['proxy-authorization'] = options.auth ?? auth()
      const req = httpRequest({ host: '127.0.0.1', port: proxy.port, method: options.method ?? 'GET', path: url, headers, agent: false }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end(options.body)
    })
  }

  function tunnel(hostPort: string, withAuth = true): Promise<{ status: number; reply: string }> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: '127.0.0.1', port: proxy.port })
      let data = ''
      socket.on('connect', () => {
        socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n${withAuth ? `Proxy-Authorization: ${auth()}\r\n` : ''}\r\n`)
      })
      socket.on('data', (c: Buffer) => {
        data += c.toString()
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)
        if (status === 200 && !data.includes('GET-SENT')) {
          // Through the tunnel, speak plain HTTP to the stand-in server to prove bytes pass both ways.
          data += 'GET-SENT'
          socket.write('GET /page HTTP/1.1\r\nHost: docs.public-site.org\r\nConnection: close\r\n\r\n')
        }
      })
      socket.on('close', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), reply: data }))
      socket.on('error', reject)
    })
  }

  it('listens on the loopback only and serves nobody without the session credential', async () => {
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect((await through('http://docs.public-site.org/page', { auth: null })).status).toBe(407)
    expect((await through('http://docs.public-site.org/page', { auth: 'Basic bmV4dXM6d3Jvbmc=' })).status).toBe(407)
    expect((await tunnel('docs.public-site.org:443', false)).status).toBe(407)
    expect(seen).toEqual([])
  })

  it('carries a public request and refuses the local host, the LAN and a rebinding name', async () => {
    const ok = await through('http://docs.public-site.org/page')
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('Job objects')
    for (const url of [`http://127.0.0.1:${port}/secret`, `http://localhost:${port}/secret`, 'http://192.168.1.10/admin', 'http://169.254.169.254/latest/', 'http://rebind.attacker.org/secret', 'http://mixed.attacker.org/secret', 'http://2130706433/secret']) {
      const r = await through(url)
      expect(r.status, url).toBe(403)
      expect(r.body).toContain('NEXUS network policy')
    }
    expect(secretHits).toBe(0)
    expect(events.filter((e) => !e.allowed).length).toBe(7)
  })

  it('a read-only session cannot send: POST, PUT and DELETE are refused before any connection', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await through('http://docs.public-site.org/echo', { method, body: 'sentinel=1' })).status, method).toBe(403)
    expect(secretHits).toBe(0)
    expect(seen).toEqual([])
  })

  it('tunnels to a public host and passes bytes both ways', async () => {
    const t = await tunnel('docs.public-site.org:443')
    expect(t.status).toBe(200)
    expect(t.reply).toContain('Job objects group processes.')
    expect(events.at(-1)).toMatchObject({ via: 'proxy-connect', method: 'CONNECT', host: 'docs.public-site.org', port: 443, allowed: true, address: PUBLIC })
  })

  it('refuses a tunnel to the local host, to a private address, to a rebinding name and to a port that is not a web port', async () => {
    for (const target of [`127.0.0.1:${port}`, `localhost:${port}`, '10.0.0.5:443', '[::1]:443', 'rebind.attacker.org:443', 'lan.attacker.org:443', 'docs.public-site.org:22', 'docs.public-site.org:3389']) {
      expect((await tunnel(target)).status, target).toBe(403)
    }
    expect(seen).toEqual([])
  })

  it('a local application test proxy reaches its registered endpoint and nothing else', async () => {
    const app = await startPolicyProxy({ policy: policyForPurpose('LOCAL_APP_TEST', { localEndpoints: [{ host: '127.0.0.1', port }] }), resolver })
    try {
      const call = (url: string): Promise<number> =>
        new Promise((resolve, reject) => {
          const req = httpRequest({ host: '127.0.0.1', port: app.port, path: url, headers: { host: new URL(url).host, 'proxy-authorization': `Basic ${Buffer.from(`${app.username}:${app.password}`).toString('base64')}` }, agent: false }, (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          })
          req.on('error', reject)
          req.end()
        })
      expect(await call(`http://127.0.0.1:${port}/page`)).toBe(200)
      expect(await call(`http://127.0.0.1:${port + 1}/page`)).toBe(403)
      expect(await call('http://docs.public-site.org/page')).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('a tunnel that sends more than fetching does is cut and reported; one that fetches is not', async () => {
    const g = guard()
    const limited = await startPolicyProxy({ ...g, maxUploadBytesPerConnection: 2000 })
    const send = (bytes: number): Promise<{ established: boolean; answered: boolean }> =>
      new Promise((resolve, reject) => {
        const socket = netConnect({ host: '127.0.0.1', port: limited.port })
        let data = ''
        let sent = false
        socket.on('connect', () => socket.write(`CONNECT docs.public-site.org:443 HTTP/1.1\r\nHost: docs.public-site.org:443\r\nProxy-Authorization: Basic ${Buffer.from(`${limited.username}:${limited.password}`).toString('base64')}\r\n\r\n`))
        socket.on('data', (c: Buffer) => {
          data += c.toString()
          if (!sent && data.includes(' 200 ')) {
            sent = true
            // A request with a body of that size: what an upload looks like from outside the tunnel.
            socket.write(`POST /page HTTP/1.1\r\nHost: docs.public-site.org\r\nConnection: close\r\nContent-Length: ${bytes}\r\n\r\n${'x'.repeat(bytes)}`)
          }
        })
        socket.on('close', () => resolve({ established: data.includes(' 200 '), answered: data.split('\r\n\r\n').length > 2 || /HTTP\/1\.1 \d+[^]*HTTP\/1\.1 \d+/.test(data) }))
        socket.on('error', reject)
      })
    try {
      const small = await send(200)
      expect(small.established).toBe(true)
      expect(small.answered, 'a small request passes and is answered').toBe(true)
      expect(g.events.some((e) => e.via === 'proxy-limit')).toBe(false)
      const large = await send(50_000)
      expect(large.established).toBe(true)
      expect(large.answered, 'the connection is cut before the destination answers').toBe(false)
      expect(g.events.find((e) => e.via === 'proxy-limit')).toMatchObject({ method: 'UPLOAD', host: 'docs.public-site.org', allowed: false })
    } finally {
      await limited.close()
    }
  })
})
