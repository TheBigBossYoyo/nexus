import type { BrowserAutomationProvider } from '@main/modules/browser/provider'
import type { GuardOptions } from '@main/modules/network/guard'
import { checkUrl } from '@main/modules/network/policy'
import { startPolicyProxy } from '@main/modules/network/proxy'
import { MAX_HTML_INPUT } from './extract'

/**
 * 0.8: the research browser. Some documentation shows nothing until its script has run. For those pages a
 * headless browser of NEXUS's own loads the address, lets the page settle, and hands back the document as the
 * script left it; from there on the page is read like any other (visible text, screening, artifact).
 *
 * What the page's script can do while it runs is what the session lets it do, and nothing more:
 *  - its only way to the network is a filtering proxy made for this one page, under the public-research
 *    policy: the local host, private ranges and metadata addresses are refused, every redirect and every
 *    request of the page is judged again, and a request that is not a read is refused;
 *  - the profile is made for the page and thrown away: no cookie, password, extension or history of the user's;
 *  - no download is accepted, no file of this machine is given to a file chooser, no permission is granted,
 *    dialogs are dismissed, new windows are closed, service workers are blocked;
 *  - a `file:` address is not opened: only http and https pass the policy, and the browser itself refuses a
 *    page that sends itself there.
 * It is NEXUS that drives the browser. The agent gets text.
 */

export interface RenderedPage {
  /** The address the document was at when it was read, after every redirect the page or the server made. */
  finalUrl: string
  title: string
  /** The document as the script left it, at most `MAX_HTML_INPUT` bytes of it. */
  html: string
  /** What the page showed (`innerText` of the body), when it could be read: text that a stylesheet hides is not in it. */
  text: string | null
  /** The document was longer than what is kept. */
  truncated: boolean
  /** Requests the page made that the policy refused, as `host:port`. */
  refused: string[]
  /** Requests the page made in all. */
  requests: number
}

export class RenderRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderRefused'
  }
}

/** The whole render, load and settle and reading included. A page whose script holds its main thread would otherwise hold this call for ever. */
const RENDER_DEADLINE_MS = 30_000
/** Requests a rendered page may make, and bytes its proxy relays, in all. */
const MAX_PAGE_REQUESTS = 300
const MAX_PAGE_BYTES = 50 * 1024 * 1024

/**
 * Loads one public page in a browser and returns its document. `guard` is the research policy with its
 * resolver; every decision of the page's proxy is reported through `guard.onEvent`. Whatever happens, the
 * session and the proxy of this render are closed before the call returns.
 */
export async function renderPublicPage(browser: BrowserAutomationProvider, url: string, guard: GuardOptions, options: { artifactsDir: string; settleMs?: number; timeoutMs?: number; deadlineMs?: number } = { artifactsDir: '' }): Promise<RenderedPage> {
  const verdict = checkUrl(guard.policy, url)
  if (!verdict.allowed) throw new RenderRefused(`Not opened: ${verdict.reason}`)
  if (browser.availability().browser === null) throw new RenderRefused('No browser is available on this machine to render the page.')
  const refused: string[] = []
  let requests = 0
  const proxy = await startPolicyProxy({
    ...guard,
    readOnly: true,
    maxRequests: MAX_PAGE_REQUESTS,
    maxBytes: MAX_PAGE_BYTES,
    onEvent: (event) => {
      requests += 1
      if (!event.allowed) refused.push(`${event.host}:${event.port}`)
      guard.onEvent?.(event)
    },
  })
  let session: Awaited<ReturnType<BrowserAutomationProvider['open']>> | null = null
  let opening: ReturnType<BrowserAutomationProvider['open']> | null = null
  let timer: NodeJS.Timeout | undefined
  const deadlineMs = options.deadlineMs ?? RENDER_DEADLINE_MS
  const work = async (): Promise<RenderedPage> => {
    opening = browser.open({ purpose: 'PUBLIC_RESEARCH', proxy: { server: proxy.url, username: proxy.username, password: proxy.password }, artifactsDir: options.artifactsDir, maxRequests: MAX_PAGE_REQUESTS })
    session = await opening
    await session.navigate(url)
    const page = await session.rendered({ settleMs: options.settleMs ?? 4000, timeoutMs: options.timeoutMs ?? 20_000 })
    // Where the page ended up is judged like where it was asked to go: a script may have sent it elsewhere.
    const final = checkUrl(guard.policy, page.url)
    if (!final.allowed) throw new RenderRefused(`The page moved to an address that is not opened: ${final.reason}`)
    const truncated = Buffer.byteLength(page.html) > MAX_HTML_INPUT
    if (truncated) page.html = page.html.slice(0, MAX_HTML_INPUT)
    return { finalUrl: page.url, title: page.title, html: page.html, text: page.text, truncated, refused: [...new Set(refused)], requests }
  }
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RenderRefused(`The page could not be rendered: it did not finish within ${Math.round(deadlineMs / 1000)} s (its script may be holding the browser).`)), deadlineMs)
    })
    return await Promise.race([work(), late])
  } catch (e) {
    if (e instanceof RenderRefused) throw e
    const first = e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)
    throw new RenderRefused(/ERR_TUNNEL|ERR_PROXY|ERR_BLOCKED|ERR_ABORTED|ERR_FAILED/i.test(first) ? 'Not opened: the address is not one the research policy allows.' : `The page could not be rendered: ${first.slice(0, 200)}`)
  } finally {
    clearTimeout(timer)
    // A browser that was still being started when the time ran out is closed as soon as it is there.
    if (session === null && opening !== null) void (opening as ReturnType<BrowserAutomationProvider['open']>).then((s) => s.close(), () => undefined)
    await (session as Awaited<ReturnType<BrowserAutomationProvider['open']>> | null)?.close().catch(() => undefined)
    await proxy.close().catch(() => undefined)
  }
}
