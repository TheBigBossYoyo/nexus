import { createHash } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Readable } from 'node:stream'
import { NetworkDenied, pinUrl, pinnedLookup, socketMatches, type GuardOptions } from './guard'

/**
 * 0.8: NEXUS's own page fetch (the NEXUS_HTTP_FETCH backend of web research). It reads; it cannot send. One
 * method (GET), no body, no cookie, no credential, no header a caller chose; redirects are followed here, one
 * hop at a time, and every hop passes the whole policy again, on its URL and on the address it resolves to.
 */

export interface SafeFetchOptions extends GuardOptions {
  /** The most bytes of body kept (after decompression). Default 1 MiB. More is cut and reported. */
  maxBytes?: number
  /** The most redirects followed. Default 5. */
  maxRedirects?: number
  /** For the whole fetch, every hop included. Default 20 s. */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface SafeFetchResult {
  requestedUrl: string
  finalUrl: string
  /** Every URL visited, the requested one first. */
  chain: string[]
  status: number
  contentType: string | null
  /** The body as received and decompressed, cut at `maxBytes`. */
  body: Buffer
  truncated: boolean
  sha256: string
  fetchedAt: string
  /** The address the final response came from. */
  address: string
  /** Set when the server asked for a file to be saved: its suggested name, untrusted. */
  dispositionFilename: string | null
}

const USER_AGENT = 'NEXUS-Research/0.8 (+local engineering assistant; reads public documentation)'
const DEFAULT_MAX_BYTES = 1024 * 1024
const HARD_COMPRESSED_FACTOR = 20

export class FetchFailed extends Error {
  constructor(
    readonly code: 'TIMEOUT' | 'TOO_MANY_REDIRECTS' | 'REDIRECT_DOWNGRADE' | 'BAD_REDIRECT' | 'TRANSPORT' | 'ABORTED' | 'ADDRESS_MISMATCH',
    message: string,
  ) {
    super(message)
    this.name = 'FetchFailed'
  }
}

function dispositionName(header: string | undefined): string | null {
  if (header === undefined || !/attachment/i.test(header)) return null
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  return m?.[1] ? decodeURIComponentSafe(m[1]).slice(0, 200) : ''
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

interface HopResult {
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
  truncated: boolean
  address: string
}

function readBody(stream: Readable, maxBytes: number, onDone: (body: Buffer, truncated: boolean) => void, onError: (e: Error) => void, stop: () => void): void {
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  let finished = false
  const done = (): void => {
    if (finished) return
    finished = true
    onDone(Buffer.concat(chunks), truncated)
  }
  stream.on('data', (chunk: Buffer) => {
    if (finished) return
    const room = maxBytes - size
    if (chunk.length > room) {
      if (room > 0) chunks.push(chunk.subarray(0, room))
      size = maxBytes
      truncated = true
      // Enough was read: the rest is not downloaded.
      stop()
      done()
      return
    }
    chunks.push(chunk)
    size += chunk.length
  })
  stream.on('end', done)
  stream.on('error', (e: Error) => {
    if (truncated) done()
    else if (!finished) {
      finished = true
      onError(e)
    }
  })
}

function hop(options: SafeFetchOptions, url: URL, target: Awaited<ReturnType<typeof pinUrl>>['target'], maxBytes: number, signal: AbortSignal): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:'
    const request = (secure ? httpsRequest : httpRequest)(
      {
        method: 'GET',
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: target.connect.port,
        path: `${url.pathname}${url.search}`,
        // The name stays what the URL said, for the Host header and for the certificate; the address is the pinned one.
        headers: { host: url.host, 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.5', 'accept-language': 'en', 'accept-encoding': 'gzip, deflate, br' },
        lookup: pinnedLookup(target),
        ...(secure ? { servername: url.hostname.replace(/^\[|\]$/g, '') } : {}),
        agent: false,
        signal,
      },
      (response) => {
        if (!socketMatches(target, response.socket.remoteAddress)) {
          request.destroy()
          reject(new FetchFailed('ADDRESS_MISMATCH', 'The connection did not go to the address that was checked.'))
          return
        }
        const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
        let stream: Readable = response
        // A small compressed body that expands without end is cut by the same limit as any other body.
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(createGunzip())
        else if (encoding === 'deflate') stream = response.pipe(createInflate())
        else if (encoding === 'br') stream = response.pipe(createBrotliDecompress())
        let received = 0
        response.on('data', (c: Buffer) => {
          received += c.length
          if (received > maxBytes * HARD_COMPRESSED_FACTOR) request.destroy()
        })
        readBody(
          stream,
          maxBytes,
          (body, truncated) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body, truncated, address: target.address }),
          (e) => reject(new FetchFailed('TRANSPORT', e.message)),
          () => request.destroy(),
        )
      },
    )
    request.on('error', (e: NodeJS.ErrnoException) => {
      if (signal.aborted) reject(new FetchFailed(e.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED', 'The fetch was stopped.'))
      else reject(new FetchFailed('TRANSPORT', e.message))
    })
    request.end()
  })
}

/**
 * Fetches one public page under a policy. Throws NetworkDenied when the policy refuses a hop (the requested
 * URL or any redirect), FetchFailed for transport errors. An HTTP error status is a result, not a throw.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? 5
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const chain: string[] = []
  let current = rawUrl
  for (let redirects = 0; ; redirects += 1) {
    const { url, target } = await pinUrl(options, 'fetch', 'GET', current)
    chain.push(url.href)
    let result: HopResult
    try {
      result = await hop(options, url, target, maxBytes, signal)
    } catch (e) {
      if (e instanceof NetworkDenied || e instanceof FetchFailed) {
        if (e instanceof FetchFailed && e.code === 'ABORTED' && timeout.aborted) throw new FetchFailed('TIMEOUT', 'The fetch took too long.')
        throw e
      }
      throw new FetchFailed('TRANSPORT', e instanceof Error ? e.message : String(e))
    }
    const location = result.headers['location']
    if (result.status >= 300 && result.status < 400 && typeof location === 'string' && location !== '') {
      if (redirects >= maxRedirects) throw new FetchFailed('TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects.`)
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new FetchFailed('BAD_REDIRECT', 'A redirect named something that is not a URL.')
      }
      // From a protected connection to an open one is not followed; any other scheme is refused by the policy.
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new FetchFailed('REDIRECT_DOWNGRADE', 'A redirect from https to http is not followed.')
      current = next.href
      continue
    }
    const contentType = typeof result.headers['content-type'] === 'string' ? result.headers['content-type'] : null
    return {
      requestedUrl: rawUrl,
      finalUrl: url.href,
      chain,
      status: result.status,
      contentType,
      body: result.body,
      truncated: result.truncated,
      sha256: createHash('sha256').update(result.body).digest('hex'),
      fetchedAt: new Date().toISOString(),
      address: result.address,
      dispositionFilename: dispositionName(typeof result.headers['content-disposition'] === 'string' ? result.headers['content-disposition'] : undefined),
    }
  }
}
