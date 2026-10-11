import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { NetworkDenied, pinUrl, pinnedLookup, socketMatches, type GuardOptions, type NetworkEvent } from './guard'

/**
 * 0.8: the filtering proxy. A browser session (or a package manager) is pointed at it and has no other way
 * out; the proxy resolves every name itself, checks the address, and connects to the address it checked. A
 * page cannot talk it into another destination: a redirect, a script, a WebSocket and a subresource are each
 * a new request here and are each judged.
 *
 * It listens on the loopback only and wants the session's own credential on every request, so that a process
 * that finds the port cannot use it as its way to the Internet.
 */

export interface PolicyProxyOptions extends GuardOptions {
  /**
   * True for a session that only reads (public research): a request that is not GET, HEAD or OPTIONS is refused
   * where the proxy can see the method, which is plain http. Inside a CONNECT tunnel the method is not visible;
   * the browser driver refuses it there.
   */
  readOnly?: boolean
  /** The most tunnels and requests at once. */
  maxConnections?: number
}

export interface PolicyProxy {
  /** `http://127.0.0.1:<port>` */
  url: string
  port: number
  username: string
  password: string
  /** Every decision since the start, oldest first (bounded). */
  events(): NetworkEvent[]
  close(): Promise<void>
}

const MAX_EVENTS = 5000

function authorized(header: string | undefined, expected: Buffer): boolean {
  if (header === undefined) return false
  const m = /^Basic\s+(.+)$/i.exec(header.trim())
  if (m === null) return false
  const given = Buffer.from(m[1] as string, 'base64')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function refusal(denied: unknown): { status: number; text: string } {
  if (denied instanceof NetworkDenied) return { status: 403, text: `Refused by the NEXUS network policy: ${denied.message}` }
  return { status: 502, text: 'The destination could not be reached.' }
}

const HOP_HEADERS = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'])

export async function startPolicyProxy(options: PolicyProxyOptions): Promise<PolicyProxy> {
  const username = 'nexus'
  const password = randomBytes(24).toString('hex')
  const expected = Buffer.from(`${username}:${password}`)
  const events: NetworkEvent[] = []
  const guard: GuardOptions = {
    ...options,
    onEvent: (event) => {
      events.push(event)
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
      options.onEvent?.(event)
    },
  }
  const sockets = new Set<Duplex>()
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }
  const maxConnections = options.maxConnections ?? 256

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const fail = (status: number, text: string, extra: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close', ...extra })
        res.end(text)
      }
      if (!authorized(req.headers['proxy-authorization'], expected)) return fail(407, 'Proxy authentication required.', { 'proxy-authenticate': 'Basic realm="nexus"' })
      const method = (req.method ?? 'GET').toUpperCase()
      // A proxy request names an absolute URL. Anything else is a request to the proxy itself, which serves nothing.
      if (!/^http:\/\//i.test(req.url ?? '')) return fail(400, 'Not a proxy request.')
      if (options.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        guard.onEvent?.({ at: new Date().toISOString(), via: 'proxy-http', method, host: '', port: 0, allowed: false, denial: 'HOST_NOT_ALLOWED', address: null })
        return fail(403, 'Refused by the NEXUS network policy: this session reads and does not send.')
      }
      try {
        const { url, target } = await pinUrl(guard, 'proxy-http', method, req.url as string)
        const headers: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase())) headers[name] = value
        headers['host'] = url.host
        const upstream = httpRequest({ method, host: url.hostname.replace(/^\[|\]$/g, ''), port: target.connect.port, path: `${url.pathname}${url.search}`, headers, lookup: pinnedLookup(target), agent: false }, (response) => {
          if (!socketMatches(target, response.socket.remoteAddress)) {
            upstream.destroy()
            return fail(502, 'The destination could not be reached.')
          }
          const out: Record<string, string | string[]> = {}
          for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase())) out[name] = value
          res.writeHead(response.statusCode ?? 502, out)
          response.pipe(res)
        })
        upstream.on('error', () => {
          if (!res.headersSent) fail(502, 'The destination could not be reached.')
          else res.destroy()
        })
        req.pipe(upstream)
      } catch (e) {
        const r = refusal(e)
        fail(r.status, r.text)
      }
    })()
  })

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client)
    client.on('error', () => undefined)
    const reply = (status: number, text: string, extra = ''): void => {
      client.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n${extra}\r\n`)
    }
    void (async () => {
      if (sockets.size > maxConnections) return reply(503, 'Busy')
      if (!authorized(req.headers['proxy-authorization'], expected)) return reply(407, 'Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="nexus"\r\n')
      const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? '')
      if (m === null) return reply(400, 'Bad Request')
      const host = (m[1] as string).replace(/^\[|\]$/g, '')
      const port = Number(m[2])
      try {
        // The tunnel is judged as the https URL it will carry: scheme, host, port, then the resolved address.
        const { target } = await pinUrl(guard, 'proxy-connect', 'CONNECT', `https://${host.includes(':') ? `[${host}]` : host}:${port}/`)
        const upstream: Socket = netConnect({ host: target.connect.host, port: target.connect.port })
        track(upstream)
        upstream.once('connect', () => {
          if (!socketMatches(target, upstream.remoteAddress)) {
            upstream.destroy()
            return reply(502, 'Bad Gateway')
          }
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length > 0) upstream.write(head)
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on('error', () => {
          if (!client.destroyed) reply(502, 'Bad Gateway')
        })
        client.once('close', () => upstream.destroy())
        upstream.once('close', () => client.destroy())
      } catch (e) {
        const r = refusal(e)
        reply(r.status, r.status === 403 ? 'Forbidden' : 'Bad Gateway', `X-Nexus-Refusal: ${r.text.replace(/[\r\n]/g, ' ').slice(0, 200)}\r\n`)
      }
    })()
  })
  server.on('connection', track)
  server.on('clientError', (_e, socket) => socket.destroy())

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // The loopback only: nothing on the network can reach the proxy.
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    username,
    password,
    events: () => [...events],
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
