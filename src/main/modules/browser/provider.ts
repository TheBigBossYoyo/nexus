import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page, type Request } from 'playwright-core'
import type { BrowserSessionPurpose } from '@main/modules/network/policy'

/**
 * 0.8: browser and application automation. One interface (`BrowserAutomationProvider`), one backend in this
 * release: Playwright, called directly from a process NEXUS owns (docs/BROWSER_AUTOMATION_RESEARCH.md has the
 * comparison with the CLI and the MCP server and the measurements). The agent never holds the browser: it
 * calls a few NEXUS tools, and this module is what they do.
 *
 * What a session can reach is fixed when it is opened, by its purpose, and enforced below it: the browser has
 * one way out, the filtering proxy it was started with. A page cannot change that, whatever it contains.
 */

export type BrowserBackend = 'PLAYWRIGHT_DIRECT'

export interface BrowserProxy {
  /** `http://127.0.0.1:<port>` */
  server: string
  username: string
  password: string
}

export interface BrowserSessionSpec {
  purpose: BrowserSessionPurpose
  /** The filtering proxy of this session. Every request of the browser goes through it, loopback included. Not used when attaching. */
  proxy?: BrowserProxy
  /** Where snapshots, screenshots, traces and logs of the session are written. */
  artifactsDir: string
  viewport?: { width: number; height: number }
  /**
   * An application that is already running (an Electron application inside a containment) to look at through
   * its debugging endpoint, instead of a browser started here. Its network is its containment's; the driver
   * only talks to it over the loopback and never becomes part of it.
   */
  attach?: { endpoint: string; timeoutMs?: number }
}

export interface PageState {
  url: string
  title: string
}

export interface SnapshotResult extends PageState {
  /** The accessibility snapshot, cut to the limit. Elements carry `[ref=…]`, valid until the page changes. */
  text: string
  /** Characters of the whole snapshot. */
  totalChars: number
  truncated: boolean
  /** The whole snapshot as a file, when it was cut. */
  artifact: string | null
}

export interface ConsoleEntry {
  at: string
  level: string
  text: string
  location: string
}

export interface NetworkEntry {
  at: string
  method: string
  url: string
  status: number | null
  failure: string | null
  resourceType: string
}

export interface BrowserSession {
  readonly id: string
  readonly purpose: BrowserSessionPurpose
  readonly kind: 'browser' | 'electron'
  navigate(url: string): Promise<PageState>
  reload(): Promise<PageState>
  state(): Promise<PageState>
  snapshot(options?: { depth?: number; maxChars?: number; ref?: string }): Promise<SnapshotResult>
  /** Lines of the snapshot that contain the text, each with its ref: the cheap way to find a control. */
  find(text: string, limit?: number): Promise<{ matches: string[]; total: number }>
  click(ref: string): Promise<PageState>
  type(ref: string, text: string): Promise<PageState>
  fill(ref: string, value: string): Promise<PageState>
  select(ref: string, values: string[]): Promise<PageState>
  key(keys: string): Promise<PageState>
  wait(options: { text?: string; gone?: string; ms?: number }): Promise<PageState>
  screenshot(options?: { fullPage?: boolean }): Promise<{ path: string; bytes: number; width: number; height: number }>
  console(options?: { level?: 'error' | 'warning' | 'all'; last?: number }): { entries: ConsoleEntry[]; total: number; errors: number; warnings: number }
  network(options?: { failedOnly?: boolean; contains?: string; last?: number }): { entries: NetworkEntry[]; total: number; failed: number }
  /** Windows of an Electron application, by title and URL. One entry for a browser session. */
  windows(): Promise<{ index: number; title: string; url: string }[]>
  useWindow(index: number): Promise<PageState>
  close(): Promise<void>
  /** Whether the browser or the application is still there. */
  alive(): boolean
}

export interface BrowserAutomationProvider {
  readonly backend: BrowserBackend
  /** What can be started on this machine, found by looking: a browser channel or an installed Chromium. */
  availability(): { browser: string | null; detail: string }
  open(spec: BrowserSessionSpec): Promise<BrowserSession>
}

const MAX_LOG = 2000
const DEFAULT_SNAPSHOT_CHARS = 6000
const ACTION_TIMEOUT_MS = 10_000
const NAVIGATION_TIMEOUT_MS = 30_000

/** Chromium switches of every session: nothing leaves but through the proxy, and nothing asks the user anything. */
function chromiumArgs(): string[] {
  return [
    // Loopback goes through the proxy too: the default bypass would let a page reach local services directly.
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-features=NetworkPrediction,Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CalculateNativeWinOcclusion',
    '--dns-prefetch-disable',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--no-default-browser-check',
    '--no-first-run',
    '--no-pings',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--metrics-recording-only',
    '--password-store=basic',
  ]
}

class PlaywrightSession implements BrowserSession {
  readonly id = randomBytes(8).toString('hex')
  private readonly consoleLog: ConsoleEntry[] = []
  private readonly networkLog: NetworkEntry[] = []
  private readonly requests = new WeakMap<Request, NetworkEntry>()
  private closed = false
  private shots = 0

  constructor(
    readonly purpose: BrowserSessionPurpose,
    readonly kind: 'browser' | 'electron',
    private readonly artifactsDir: string,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private page: Page,
  ) {
    mkdirSync(artifactsDir, { recursive: true })
    this.context.setDefaultTimeout(ACTION_TIMEOUT_MS)
    this.context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    for (const existing of this.context.pages()) this.watch(existing)
    this.context.on('page', (p) => this.watch(p))
  }

  private watch(page: Page): void {
    page.on('console', (m: ConsoleMessage) => {
      const loc = m.location()
      this.push(this.consoleLog, { at: new Date().toISOString(), level: m.type(), text: m.text().slice(0, 2000), location: loc.url ? `${loc.url}:${loc.lineNumber}` : '' })
    })
    page.on('pageerror', (e) => this.push(this.consoleLog, { at: new Date().toISOString(), level: 'error', text: `Uncaught: ${e.message}`.slice(0, 2000), location: '' }))
    page.on('request', (r) => {
      const entry: NetworkEntry = { at: new Date().toISOString(), method: r.method(), url: r.url().slice(0, 500), status: null, failure: null, resourceType: r.resourceType() }
      this.requests.set(r, entry)
      this.push(this.networkLog, entry)
    })
    page.on('response', (r) => {
      const entry = this.requests.get(r.request())
      if (entry) entry.status = r.status()
    })
    page.on('requestfailed', (r) => {
      const entry = this.requests.get(r)
      if (entry) entry.failure = r.failure()?.errorText ?? 'failed'
    })
    // A page's own dialogs block it and ask a person who is not there: they are dismissed, and noted.
    page.on('dialog', (dialog) => {
      this.push(this.consoleLog, { at: new Date().toISOString(), level: 'warning', text: `A ${dialog.type()} dialog was dismissed: ${dialog.message().slice(0, 300)}`, location: '' })
      void dialog.dismiss().catch(() => undefined)
    })
    // No file of this machine is given to a page: a file chooser gets nothing.
    page.on('filechooser', (chooser) => void chooser.setFiles([]).catch(() => undefined))
  }

  private push<T>(log: T[], entry: T): void {
    log.push(entry)
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
  }

  alive(): boolean {
    if (this.closed) return false
    return this.browser.isConnected() && (this.kind === 'browser' || this.context.pages().some((p) => !p.isClosed()))
  }

  private ensure(): Page {
    if (this.closed) throw new Error('The session is closed.')
    if (this.page.isClosed()) {
      const open = this.context.pages().find((p) => !p.isClosed())
      if (!open) throw new Error('The application has no window any more. It may have crashed: read its console, then launch it again.')
      this.page = open
    }
    return this.page
  }

  async state(): Promise<PageState> {
    const page = this.ensure()
    return { url: page.url(), title: (await page.title().catch(() => '')).slice(0, 200) }
  }

  async navigate(url: string): Promise<PageState> {
    const page = this.ensure()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return this.state()
  }

  async reload(): Promise<PageState> {
    await this.ensure().reload({ waitUntil: 'domcontentloaded' })
    return this.state()
  }

  private locator(ref: string) {
    const clean = ref.trim().replace(/^\[?ref=/, '').replace(/\]$/, '')
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(clean)) throw new Error('That is not an element reference. Take a snapshot and use a ref from it, such as f2e8.')
    return this.ensure().locator(`aria-ref=${clean}`)
  }

  private async act(action: () => Promise<unknown>): Promise<PageState> {
    try {
      await action()
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0] : String(e)
      // A ref belongs to the snapshot it came from; after the page changed it names nothing.
      throw new Error(/aria-ref|not found|No element|resolved to 0/i.test(message ?? '') ? 'That element reference is no longer on the page. Take a new snapshot and use a ref from it.' : `The action did not succeed: ${(message ?? '').slice(0, 300)}`, { cause: e })
    }
    await this.ensure().waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined)
    return this.state()
  }

  click(ref: string): Promise<PageState> {
    return this.act(() => this.locator(ref).click())
  }

  type(ref: string, text: string): Promise<PageState> {
    return this.act(() => this.locator(ref).pressSequentially(text, { delay: 5 }))
  }

  fill(ref: string, value: string): Promise<PageState> {
    return this.act(() => this.locator(ref).fill(value))
  }

  select(ref: string, values: string[]): Promise<PageState> {
    return this.act(() => this.locator(ref).selectOption(values))
  }

  key(keys: string): Promise<PageState> {
    if (!/^[A-Za-z0-9+ ]{1,40}$/.test(keys)) return Promise.reject(new Error('Keys are named as in "Enter", "Tab", "Control+A", "ArrowDown".'))
    return this.act(() => this.ensure().keyboard.press(keys))
  }

  async wait(options: { text?: string; gone?: string; ms?: number }): Promise<PageState> {
    const page = this.ensure()
    const timeout = Math.min(Math.max(options.ms ?? ACTION_TIMEOUT_MS, 50), 30_000)
    if (options.text !== undefined) await page.getByText(options.text).first().waitFor({ state: 'visible', timeout })
    else if (options.gone !== undefined) await page.getByText(options.gone).first().waitFor({ state: 'hidden', timeout })
    else await page.waitForTimeout(timeout)
    return this.state()
  }

  private async rawSnapshot(options: { depth?: number; ref?: string }): Promise<string> {
    const page = this.ensure()
    const snapshotOptions = { mode: 'ai' as const, ...(options.depth !== undefined ? { depth: options.depth } : {}) }
    const target = options.ref !== undefined ? this.locator(options.ref) : page.locator('body')
    return (target as unknown as { ariaSnapshot(o: object): Promise<string> }).ariaSnapshot(snapshotOptions)
  }

  async snapshot(options: { depth?: number; maxChars?: number; ref?: string } = {}): Promise<SnapshotResult> {
    const text = await this.rawSnapshot(options)
    const max = Math.min(Math.max(options.maxChars ?? DEFAULT_SNAPSHOT_CHARS, 500), 30_000)
    const state = await this.state()
    if (text.length <= max) return { ...state, text, totalChars: text.length, truncated: false, artifact: null }
    // The whole tree goes to a file; the prompt gets its top and a way to read on.
    const artifact = join(this.artifactsDir, `snapshot-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.yml`)
    if (!existsSync(artifact)) writeFileSync(artifact, text)
    const cut = text.slice(0, max)
    return { ...state, text: cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : cut.length), totalChars: text.length, truncated: true, artifact }
  }

  async find(text: string, limit = 20): Promise<{ matches: string[]; total: number }> {
    const needle = text.trim().toLowerCase()
    if (needle === '') return { matches: [], total: 0 }
    const lines = (await this.rawSnapshot({})).split('\n').filter((line) => line.toLowerCase().includes(needle))
    return { matches: lines.slice(0, Math.min(Math.max(limit, 1), 50)).map((l) => l.trim().slice(0, 300)), total: lines.length }
  }

  async screenshot(options: { fullPage?: boolean } = {}): Promise<{ path: string; bytes: number; width: number; height: number }> {
    const page = this.ensure()
    this.shots += 1
    const path = join(this.artifactsDir, `screenshot-${String(this.shots).padStart(3, '0')}.png`)
    const buffer = await page.screenshot({ path, fullPage: options.fullPage === true, type: 'png', animations: 'disabled' })
    const size = page.viewportSize() ?? { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    return { path, bytes: buffer.length, width: buffer.readUInt32BE(16) || size.width, height: buffer.readUInt32BE(20) || size.height }
  }

  console(options: { level?: 'error' | 'warning' | 'all'; last?: number } = {}): { entries: ConsoleEntry[]; total: number; errors: number; warnings: number } {
    const level = options.level ?? 'warning'
    const wanted = level === 'all' ? this.consoleLog : this.consoleLog.filter((e) => e.level === 'error' || (level === 'warning' && e.level === 'warning'))
    return { entries: wanted.slice(-Math.min(Math.max(options.last ?? 20, 1), 100)), total: this.consoleLog.length, errors: this.consoleLog.filter((e) => e.level === 'error').length, warnings: this.consoleLog.filter((e) => e.level === 'warning').length }
  }

  network(options: { failedOnly?: boolean; contains?: string; last?: number } = {}): { entries: NetworkEntry[]; total: number; failed: number } {
    const failed = (e: NetworkEntry): boolean => e.failure !== null || (e.status !== null && e.status >= 400)
    let wanted = options.failedOnly === true ? this.networkLog.filter(failed) : this.networkLog
    if (options.contains) wanted = wanted.filter((e) => e.url.includes(options.contains as string))
    return { entries: wanted.slice(-Math.min(Math.max(options.last ?? 20, 1), 100)), total: this.networkLog.length, failed: this.networkLog.filter(failed).length }
  }

  async windows(): Promise<{ index: number; title: string; url: string }[]> {
    const pages = this.context.pages().filter((p) => !p.isClosed())
    return Promise.all(pages.map(async (p, index) => ({ index, title: (await p.title().catch(() => '')).slice(0, 200), url: p.url() })))
  }

  async useWindow(index: number): Promise<PageState> {
    const pages = this.context.pages().filter((p) => !p.isClosed())
    const page = pages[index]
    if (!page) throw new Error(`There is no window ${index}; there are ${pages.length}.`)
    this.page = page
    return this.state()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const bounded = <T>(p: Promise<T>): Promise<unknown> => Promise.race([p.catch(() => undefined), new Promise((done) => setTimeout(done, 8000))])
    // An attached application is not this session's to end: whoever started it stops it. The connection is dropped.
    if (this.kind === 'browser') await bounded(this.context.close())
    await bounded(this.browser.close())
  }
}

export interface PlaywrightProviderOptions {
  /** A browser channel to prefer (`msedge`, `chrome`), or an executable. Default: Edge, which every Windows 11 has. */
  channel?: string
  executablePath?: string
}

/**
 * Playwright, called directly. A web session is a headless browser with a profile made for the session and
 * thrown away with it: no cookie, password, extension or history of the user's. An application session attaches
 * to the debugging endpoint of an Electron application somebody else started, which is how the application
 * stays inside its containment: Playwright talks to it over the loopback and never becomes part of it.
 */
export class PlaywrightDirectProvider implements BrowserAutomationProvider {
  readonly backend = 'PLAYWRIGHT_DIRECT' as const

  constructor(private readonly options: PlaywrightProviderOptions = {}) {}

  availability(): { browser: string | null; detail: string } {
    if (this.options.executablePath) return existsSync(this.options.executablePath) ? { browser: this.options.executablePath, detail: 'A browser executable was named.' } : { browser: null, detail: `The named browser does not exist: ${this.options.executablePath}` }
    const edge = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']].filter((p): p is string => !!p).map((p) => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((p) => existsSync(p))
    if (this.options.channel) return { browser: this.options.channel, detail: `The ${this.options.channel} channel was named.` }
    if (edge) return { browser: 'msedge', detail: `Microsoft Edge at ${edge}, started headless with a profile of its own for each session.` }
    try {
      const bundled = chromium.executablePath()
      if (existsSync(bundled)) return { browser: bundled, detail: 'The Chromium that Playwright installs.' }
    } catch {
      // no bundled browser
    }
    return { browser: null, detail: 'No browser was found: neither Microsoft Edge nor a Chromium installed for Playwright.' }
  }

  async open(spec: BrowserSessionSpec): Promise<BrowserSession> {
    mkdirSync(spec.artifactsDir, { recursive: true })
    if (spec.attach) {
      const timeout = spec.attach.timeoutMs ?? 45_000
      const browser = await chromium.connectOverCDP(spec.attach.endpoint, { timeout })
      try {
        const context = browser.contexts()[0]
        if (!context) throw new Error('The application exposes no browser context.')
        const page = context.pages().find((p) => !p.isClosed()) ?? (await context.waitForEvent('page', { timeout }))
        return new PlaywrightSession(spec.purpose, 'electron', spec.artifactsDir, browser, context, page)
      } catch (e) {
        await browser.close().catch(() => undefined)
        throw e
      }
    }
    if (!spec.proxy) throw new Error('A browser session needs its proxy.')
    const available = this.availability()
    if (available.browser === null) throw new Error(available.detail)
    const launch = this.options.executablePath
      ? { executablePath: this.options.executablePath }
      : available.browser === 'msedge' || this.options.channel
        ? { channel: this.options.channel ?? 'msedge' }
        : { executablePath: available.browser }
    const browser = await chromium.launch({
      ...launch,
      headless: true,
      args: chromiumArgs(),
      proxy: { server: spec.proxy.server, username: spec.proxy.username, password: spec.proxy.password, bypass: '<-loopback>' },
    })
    try {
      const context = await browser.newContext({
        viewport: spec.viewport ?? { width: 1280, height: 800 },
        serviceWorkers: 'block',
        acceptDownloads: false,
        permissions: [],
        ignoreHTTPSErrors: false,
        javaScriptEnabled: true,
        // A research session reads; it does not send. What the proxy cannot see inside a tunnel is refused here.
      })
      if (spec.purpose === 'PUBLIC_RESEARCH') {
        await context.route('**/*', (route) => {
          const method = route.request().method()
          if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return route.abort('blockedbyclient')
          return route.continue()
        })
      }
      const page = await context.newPage()
      return new PlaywrightSession(spec.purpose, 'browser', spec.artifactsDir, browser, context, page)
    } catch (e) {
      await browser.close().catch(() => undefined)
      throw e
    }
  }
}
