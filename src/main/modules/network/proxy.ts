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
  /** The most tunnels and requests at once. Plain http requests count as well as tunnels. */
  maxConnections?: number
  /** The most requests (plain requests and tunnels) this proxy carries in all; the next ones are refused and reported. */
  maxRequests?: number
  /** The most bytes this proxy relays in all, both directions together; at the limit the open connections are cut and later requests are refused. */
  maxBytes?: number
  /**
   * The most bytes one request or tunnel may send towards its destination. Traffic that fetches (an install of
   * dependencies, a download) sends little and receives much; a connection that sends more than this is
   * cut and reported. Inside a tunnel the proxy sees no method, so this is what tells fetching from uploading.
   */
  maxUploadBytesPerConnection?: number
  /** Time without a byte after which a connection, client side or upstream, is dropped. Default 30 s. */
  idleMs?: number
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
  const idleMs = options.idleMs ?? 30_000
  /** Client connections with a request in flight: they are quiet because the proxy is waiting for the upstream, whose own idle limit applies. */
  const waiting = new WeakSet<Duplex>()
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // A peer that stops talking holds a slot for ever otherwise.
    const timed = socket as Partial<Socket>
    if (typeof timed.setTimeout === 'function') {
      timed.setTimeout(idleMs)
      socket.on('timeout', () => {
        if (!waiting.has(socket)) socket.destroy()
      })
    }
  }
  const maxConnections = options.maxConnections ?? 256
  let requestCount = 0
  let relayed = 0
  let exhausted = false
  const refuseEvent = (via: string, method: string, host: string, port: number): void => {
    guard.onEvent?.({ at: new Date().toISOString(), via, method, host, port, allowed: false, denial: 'HOST_NOT_ALLOWED', address: null })
  }
  /** Whether this request may go on: the byte limit not reached, the request limit not reached. A request that may is counted. */
  const admit = (via: string, method: string, host: string, port: number): boolean => {
    if (exhausted || (options.maxRequests !== undefined && requestCount >= options.maxRequests)) {
      refuseEvent(via, method, host, port)
      return false
    }
    requestCount += 1
    return true
  }
  const relay = (bytes: number): void => {
    relayed += bytes
    if (options.maxBytes === undefined || relayed <= options.maxBytes || exhausted) return
    exhausted = true
    refuseEvent('proxy-limit', 'BYTES', '', 0)
    for (const socket of sockets) socket.destroy()
  }

  /** Counts what one connection sends towards its destination and cuts it at the limit. */
  const uploadMeter = (host: string, port: number, cut: () => void): ((bytes: number) => void) => {
    let sent = 0
    let over = false
    return (bytes) => {
      sent += bytes
      if (over || options.maxUploadBytesPerConnection === undefined || sent <= options.maxUploadBytesPerConnection) return
      over = true
      guard.onEvent?.({ at: new Date().toISOString(), via: 'proxy-limit', method: 'UPLOAD', host, port, allowed: false, denial: 'HOST_NOT_ALLOWED', address: null })
      cut()
    }
  }

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
      if (sockets.size > maxConnections) return fail(503, 'Busy.')
      waiting.add(req.socket)
      res.once('close', () => waiting.delete(req.socket))
      if (options.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        guard.onEvent?.({ at: new Date().toISOString(), via: 'proxy-http', method, host: '', port: 0, allowed: false, denial: 'HOST_NOT_ALLOWED', address: null })
        return fail(403, 'Refused by the NEXUS network policy: this session reads and does not send.')
      }
      let asked: URL | null = null
      try {
        asked = new URL(req.url as string)
      } catch {
        // pinUrl refuses it below
      }
      if (!admit('proxy-http', method, asked?.hostname ?? '', Number(asked?.port) || 80)) return fail(403, 'Refused by the NEXUS network policy: this session has used its share of requests or bytes.')
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
          response.on('data', (chunk: Buffer) => relay(chunk.length))
          // An upstream that goes away in the middle of a body leaves the client with a body that never ends, unless it is told.
          response.on('close', () => {
            if (!response.complete) res.destroy()
          })
        })
        upstream.on('socket', track)
        upstream.on('error', () => {
          if (!res.headersSent) fail(502, 'The destination could not be reached.')
          else res.destroy()
        })
        req.pipe(upstream)
        req.on('data', (chunk: Buffer) => relay(chunk.length))
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
      if (!admit('proxy-connect', 'CONNECT', host, port)) return reply(403, 'Forbidden', 'X-Nexus-Refusal: this session has used its share of requests or bytes.\r\n')
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
          upstream.on('data', (chunk: Buffer) => relay(chunk.length))
          const sent = uploadMeter(host, port, () => {
            upstream.destroy()
            client.destroy()
          })
          sent(head.length)
          client.on('data', (chunk: Buffer) => {
            relay(chunk.length)
            sent(chunk.length)
          })
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
  // Node's own idle handling of a connection would end it even while a request waits for its upstream; `track` decides instead.
  server.on('timeout', () => undefined)
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
