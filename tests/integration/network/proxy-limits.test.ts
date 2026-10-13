import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as netConnect, type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NetworkEvent, Resolver } from '@main/modules/network/guard'
import { policyForPurpose } from '@main/modules/network/policy'
import { startPolicyProxy, type PolicyProxy, type PolicyProxyOptions } from '@main/modules/network/proxy'

// What the filtering proxy does when a session asks for too much or a peer goes quiet: the request and byte
// limits of one proxy, the idle limit of its connections, and the connection cap on plain http as well.
// A local server stands in for a public host, as in fetch-proxy.test.ts.

let site: Server
let port = 0
const hangingSockets: { destroy(): void }[] = []
const resolver: Resolver = async (host) => {
  if (host === 'docs.public-site.org') return ['93.184.216.34']
  throw new Error('ENOTFOUND')
}

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === '/hang') {
      // Headers sent, then nothing: an upstream that stops talking.
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('start')
      hangingSockets.push(res.socket as { destroy(): void })
      return
    }
    if (req.url === '/silent') {
      hangingSockets.push(res.socket as { destroy(): void })
      return
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(400_000, 0x61))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>((resolve) => site.listen({ host: '127.0.0.1', port: 0 }, resolve))
  port = (site.address() as AddressInfo).port
})
afterAll(() => {
  for (const s of hangingSockets) s.destroy()
  return new Promise<void>((resolve) => site.close(() => resolve()))
})

async function withProxy<T>(options: Partial<PolicyProxyOptions>, run: (proxy: PolicyProxy, events: NetworkEvent[], get: (path: string) => Promise<{ status: number; body: number }>) => Promise<T>): Promise<T> {
  const events: NetworkEvent[] = []
  const proxy = await startPolicyProxy({ policy: policyForPurpose('PUBLIC_RESEARCH', {}), resolver, dial: () => ({ host: '127.0.0.1', port }), onEvent: (e) => void events.push(e), readOnly: true, ...options })
  const auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
  const get = (path: string): Promise<{ status: number; body: number }> =>
    new Promise((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: proxy.port, path: `http://docs.public-site.org${path}`, headers: { host: 'docs.public-site.org', 'proxy-authorization': auth }, agent: false }, (res) => {
        let bytes = 0
        res.on('data', (c: Buffer) => (bytes += c.length))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: bytes }))
        res.on('error', () => resolve({ status: res.statusCode ?? 0, body: bytes }))
        res.on('aborted', () => resolve({ status: res.statusCode ?? 0, body: bytes }))
      })
      // A response cut off in the middle is an error on the request: for the test that is a response of no bytes.
      req.on('error', () => resolve({ status: 0, body: 0 }))
      req.end()
    })
  try {
    return await run(proxy, events, get)
  } finally {
    await proxy.close()
  }
}

describe('limits of one proxy', () => {
  it('refuses the requests beyond its limit, tunnels included, and says so through its callback', async () => {
    await withProxy({ maxRequests: 5 }, async (proxy, events, get) => {
      for (let i = 0; i < 5; i += 1) expect((await get('/page')).status).toBe(200)
      const sixth = await get('/page')
      expect(sixth.status).toBe(403)
      const tunnel = await new Promise<string>((resolve) => {
        const socket = netConnect({ host: '127.0.0.1', port: proxy.port })
        let data = ''
        socket.on('connect', () => socket.write(`CONNECT docs.public-site.org:443 HTTP/1.1\r\nHost: docs.public-site.org:443\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n\r\n`))
        socket.on('data', (c: Buffer) => (data += c.toString()))
        socket.on('close', () => resolve(data))
      })
      expect(tunnel).toMatch(/^HTTP\/1\.1 403/)
      expect(events.filter((e) => !e.allowed)).toHaveLength(2)
      expect(events.filter((e) => e.allowed)).toHaveLength(5)
    })
  })

  it('cuts what it relays at its byte limit, and refuses what comes after', async () => {
    await withProxy({ maxBytes: 600_000 }, async (_proxy, events, get) => {
      expect((await get('/big')).body).toBe(400_000)
      // The second response crosses the limit: it is cut short, not delivered whole.
      const second = await get('/big')
      expect(second.body).toBeLessThan(400_000)
      expect((await get('/page')).status).toBe(403)
      expect(events.some((e) => e.via === 'proxy-limit' && !e.allowed)).toBe(true)
    })
  })

  it('drops an upstream that stops talking, and a client that never says anything', async () => {
    await withProxy({ idleMs: 400 }, async (proxy, _events, get) => {
      const started = Date.now()
      const silent = await get('/silent')
      expect(silent.status).toBe(502)
      const hung = await get('/hang')
      expect(hung.body).toBeLessThan(10)
      expect(Date.now() - started).toBeLessThan(5000)
      const quiet = await new Promise<number>((resolve) => {
        const t0 = Date.now()
        const socket = netConnect({ host: '127.0.0.1', port: proxy.port })
        socket.on('close', () => resolve(Date.now() - t0))
        socket.on('error', () => undefined)
      })
      expect(quiet).toBeLessThan(3000)
    })
  })

  it('applies the connection cap to plain http as well as to tunnels', async () => {
    await withProxy({ maxConnections: 2 }, async (proxy, _events, get) => {
      const idle = [0, 1, 2].map(() => netConnect({ host: '127.0.0.1', port: proxy.port }))
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        expect((await get('/page')).status).toBe(503)
      } finally {
        for (const s of idle) s.destroy()
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect((await get('/page')).status).toBe(200)
    })
  })
})
