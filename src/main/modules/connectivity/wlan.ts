import { spawn } from 'node:child_process'
import { isPlausibleProfileName, type WlanInterfaceState } from '@shared/connectivity'
import { runProcess, type ProcessResult } from '../process/run-process'
import type { ConnectivityLogger, Timers } from './timers'
import { realTimers } from './timers'

export interface WlanInterfaceStatus {
  guid: string
  description: string
  /** The name Windows shows for the connection ("Wi-Fi"); used to tell Wi-Fi from other adapters. */
  alias: string | null
  state: WlanInterfaceState
  /** The saved profile NAME this interface is connected through. */
  profileName: string | null
  ssid: string | null
  signal: number | null
  /** The last reason code a notification carried for this interface; null until one was seen. */
  lastReasonCode: number | null
}

export interface SavedProfile {
  name: string
  security: 'open' | 'secured' | 'unknown'
  autoConnect: boolean
}

export interface WlanEvent {
  at: number
  kind: 'connected' | 'disconnected' | 'attempt_failed' | 'watch_lost'
  interfaceGuid: string | null
  profileName: string | null
  reasonCode: number | null
}

export interface ConnectResult {
  /** True when Windows accepted the request. Association happens afterwards and is observed, not assumed. */
  requested: boolean
  reasonCode: number | null
  detail: string | null
}

/**
 * The only way this module touches Wi-Fi. It can read what is saved and connected, ask Windows to connect a
 * SAVED profile by name, and listen for connection notifications. It cannot create, change or delete a profile,
 * and no method here returns or accepts a key.
 */
export interface WlanAdapter {
  status(): Promise<WlanInterfaceStatus[]>
  profiles(): Promise<SavedProfile[]>
  connect(profileName: string, interfaceGuid: string): Promise<ConnectResult>
  subscribe(listener: (event: WlanEvent) => void): () => void
}

export class WlanAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WlanAdapterError'
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing what the helper prints. Its output is data from another process: every field is checked, nothing is trusted.

const MAX_JSON_BYTES = 256 * 1024
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const MAX_INTERFACES = 16
const MAX_PROFILES = 512

const STATE_MAP: Record<string, WlanInterfaceState> = {
  connected: 'connected',
  disconnected: 'disconnected',
  associating: 'connecting',
  discovering: 'connecting',
  authenticating: 'connecting',
  disconnecting: 'disconnecting',
  not_ready: 'not_ready',
  ad_hoc_network_formed: 'ad_hoc',
}

function parseObject(text: string, what: string): Record<string, unknown> {
  if (text.length > MAX_JSON_BYTES) throw new WlanAdapterError(`${what}: output is larger than ${MAX_JSON_BYTES} bytes.`)
  let value: unknown
  try {
    value = JSON.parse(text.trim())
  } catch {
    throw new WlanAdapterError(`${what}: output is not JSON.`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WlanAdapterError(`${what}: output is not a JSON object.`)
  const o = value as Record<string, unknown>
  if (o.ok === false) throw new WlanAdapterError(`${what}: the helper reported an error${typeof o.error === 'string' ? `: ${o.error.slice(0, 200).replace(/[\u0000-\u001f]/g, ' ')}` : '.'}`) // eslint-disable-line no-control-regex
  if (o.ok !== true) throw new WlanAdapterError(`${what}: output does not say ok.`)
  return o
}

// eslint-disable-next-line no-control-regex
const cleanText = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null)
const code = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? v : null)

export function parseStatusJson(text: string): WlanInterfaceStatus[] {
  const o = parseObject(text, 'status')
  if (!Array.isArray(o.interfaces)) throw new WlanAdapterError('status: "interfaces" is not a list.')
  const out: WlanInterfaceStatus[] = []
  for (const raw of o.interfaces.slice(0, MAX_INTERFACES)) {
    if (typeof raw !== 'object' || raw === null) continue
    const i = raw as Record<string, unknown>
    if (typeof i.guid !== 'string' || !GUID.test(i.guid)) continue
    const profile = isPlausibleProfileName(i.profile) ? i.profile : null
    const signal = typeof i.signal === 'number' && Number.isInteger(i.signal) && i.signal >= 0 && i.signal <= 100 ? i.signal : null
    out.push({
      guid: i.guid.toLowerCase(),
      description: cleanText(i.description, 256) ?? '',
      alias: cleanText(i.alias, 256),
      state: typeof i.state === 'string' ? (STATE_MAP[i.state] ?? 'unknown') : 'unknown',
      profileName: profile,
      ssid: cleanText(i.ssid, 64),
      signal,
      lastReasonCode: null,
    })
  }
  return out
}

export function parseProfilesJson(text: string): SavedProfile[] {
  const o = parseObject(text, 'profiles')
  if (!Array.isArray(o.interfaces)) throw new WlanAdapterError('profiles: "interfaces" is not a list.')
  const byName = new Map<string, SavedProfile>()
  for (const raw of o.interfaces.slice(0, MAX_INTERFACES)) {
    if (typeof raw !== 'object' || raw === null) continue
    const list = (raw as Record<string, unknown>).profiles
    if (!Array.isArray(list)) continue
    for (const p of list.slice(0, MAX_PROFILES)) {
      if (typeof p !== 'object' || p === null) continue
      const r = p as Record<string, unknown>
      // A name that Windows could not have (control characters, over 255 characters) is not listed, so it can never be asked for.
      if (!isPlausibleProfileName(r.name)) continue
      const security = r.security === 'open' ? 'open' : r.security === 'secured' ? 'secured' : 'unknown'
      const entry: SavedProfile = { name: r.name, security, autoConnect: r.autoConnect === true }
      const known = byName.get(entry.name)
      // The same name saved on two adapters with different answers is not trusted to be secured.
      if (known === undefined) byName.set(entry.name, entry)
      else if (known.security !== entry.security) known.security = 'unknown'
    }
  }
  return [...byName.values()]
}

export function parseConnectJson(text: string): ConnectResult {
  const o = parseObject(text, 'connect')
  return { requested: o.requested === true, reasonCode: code(o.reasonCode), detail: cleanText(o.detail, 200) }
}

export function parseWatchLine(line: string, at: number): WlanEvent | null {
  if (line.length > 4096) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (o.event !== 'connected' && o.event !== 'disconnected' && o.event !== 'attempt_failed') return null
  return {
    at,
    kind: o.event,
    interfaceGuid: typeof o.guid === 'string' && GUID.test(o.guid) ? o.guid.toLowerCase() : null,
    profileName: isPlausibleProfileName(o.profile) ? o.profile : null,
    reasonCode: code(o.reasonCode),
  }
}

// ---------------------------------------------------------------------------------------------------------------

export interface WatchHandlers {
  onLine(line: string): void
  onExit(): void
}
export type WatchStarter = (file: string, handlers: WatchHandlers) => { stop(): void }

/** Starts `nexus-wlan watch`; its stdin stays open, and closing it ends the helper. */
export const spawnWatch: WatchStarter = (file, handlers) => {
  const child = spawn(file, ['watch'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      handlers.onLine(buffer.slice(0, nl).trim())
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
    if (buffer.length > 8192) buffer = ''
  })
  child.stdin.on('error', () => undefined)
  child.on('error', () => handlers.onExit())
  child.on('close', () => handlers.onExit())
  return {
    stop: () => {
      child.stdin.end()
      setTimeout(() => child.kill(), 2000).unref()
    },
  }
}

export interface NativeWlanAdapterOptions {
  /** Path of nexus-wlan.exe (out/native/nexus-wlan.exe, built by scripts/build-wlan.mjs). */
  helperPath: string
  cwd?: string
  /** For status and profiles. A connect waits for Windows' answer (up to 10 s in the helper) and gets 25 s. */
  timeoutMs?: number
  run?: (file: string, args: readonly string[], timeoutMs: number) => Promise<ProcessResult>
  watch?: WatchStarter
  timers?: Timers
  logger?: ConnectivityLogger
  /** How long to wait before the notification watcher is started again after it ended. */
  watchRestartMs?: number
}

export class NativeWlanAdapter implements WlanAdapter {
  private readonly run: (file: string, args: readonly string[], timeoutMs: number) => Promise<ProcessResult>
  private readonly watchStarter: WatchStarter
  private readonly timers: Timers
  private readonly listeners = new Set<(event: WlanEvent) => void>()
  private readonly lastReason = new Map<string, number>()
  private watcher: { stop(): void } | null = null
  private restartTimer: unknown = null

  constructor(private readonly opts: NativeWlanAdapterOptions) {
    this.timers = opts.timers ?? realTimers
    this.watchStarter = opts.watch ?? spawnWatch
    this.run = opts.run ?? ((file, args, timeoutMs) => runProcess(file, args, { cwd: opts.cwd ?? process.cwd(), timeoutMs, maxOutputBytes: MAX_JSON_BYTES, keep: 'head' }))
  }

  private async invoke(args: string[], what: string, timeoutMs = this.opts.timeoutMs ?? 10_000): Promise<string> {
    let result: ProcessResult
    try {
      result = await this.run(this.opts.helperPath, args, timeoutMs)
    } catch (e) {
      throw new WlanAdapterError(`${what}: the helper could not be started (${e instanceof Error ? e.message : String(e)}).`)
    }
    if (result.timedOut) throw new WlanAdapterError(`${what}: the helper did not answer in time.`)
    if (result.truncated) throw new WlanAdapterError(`${what}: the helper's output was too large.`)
    return result.stdout
  }

  async status(): Promise<WlanInterfaceStatus[]> {
    const list = parseStatusJson(await this.invoke(['status'], 'status'))
    return list.map((i) => ({ ...i, lastReasonCode: this.lastReason.get(i.guid) ?? null }))
  }

  async profiles(): Promise<SavedProfile[]> {
    return parseProfilesJson(await this.invoke(['profiles'], 'profiles'))
  }

  /**
   * Asks Windows to connect a saved profile. The name is checked against the saved list read just now, and the
   * interface against the interfaces read just now; anything else is refused before a process is started. The name
   * goes to the helper as one argv element (no shell), and the helper checks it against the list once more.
   */
  async connect(profileName: string, interfaceGuid: string): Promise<ConnectResult> {
    if (!isPlausibleProfileName(profileName)) throw new WlanAdapterError('connect: not a profile name.')
    if (!GUID.test(interfaceGuid)) throw new WlanAdapterError('connect: not an interface GUID.')
    const saved = await this.profiles()
    if (!saved.some((p) => p.name === profileName)) throw new WlanAdapterError('connect: that profile is not in the saved profiles of Windows.')
    const interfaces = await this.status()
    if (!interfaces.some((i) => i.guid === interfaceGuid.toLowerCase())) throw new WlanAdapterError('connect: that interface is not a Wi-Fi interface of this machine.')
    return parseConnectJson(await this.invoke(['connect', interfaceGuid.toLowerCase(), profileName], 'connect', 25_000))
  }

  subscribe(listener: (event: WlanEvent) => void): () => void {
    this.listeners.add(listener)
    if (this.watcher === null && this.restartTimer === null) this.startWatch()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stopWatch()
    }
  }

  private emit(event: WlanEvent): void {
    if (event.reasonCode !== null && event.interfaceGuid !== null) this.lastReason.set(event.interfaceGuid, event.reasonCode)
    // A connection clears the earlier reason: it described the disconnect that is over.
    if (event.kind === 'connected' && event.interfaceGuid !== null) this.lastReason.delete(event.interfaceGuid)
    for (const l of [...this.listeners]) {
      try {
        l(event)
      } catch (e) {
        this.opts.logger?.(`wlan listener threw: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  private startWatch(): void {
    this.watcher = this.watchStarter(this.opts.helperPath, {
      onLine: (line) => {
        const event = parseWatchLine(line, this.timers.now())
        if (event !== null) this.emit(event)
      },
      onExit: () => {
        this.watcher = null
        if (this.listeners.size === 0) return
        // While the watcher is down nothing is heard, so the supervisor is told to look for itself.
        this.emit({ at: this.timers.now(), kind: 'watch_lost', interfaceGuid: null, profileName: null, reasonCode: null })
        this.restartTimer = this.timers.setTimeout(() => {
          this.restartTimer = null
          if (this.listeners.size > 0 && this.watcher === null) this.startWatch()
        }, this.opts.watchRestartMs ?? 15_000)
      },
    })
  }

  private stopWatch(): void {
    if (this.restartTimer !== null) this.timers.clearTimeout(this.restartTimer)
    this.restartTimer = null
    const w = this.watcher
    this.watcher = null
    w?.stop()
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** A scriptable adapter for tests. It does no checking of its own: it records exactly what it is asked, so a test can see what the caller did. */
export class FakeWlanAdapter implements WlanAdapter {
  interfaces: WlanInterfaceStatus[] = []
  saved: SavedProfile[] = []
  connectCalls: Array<{ profileName: string; interfaceGuid: string }> = []
  statusCalls = 0
  /** Decides what a connect does. The default accepts the request and changes nothing. */
  onConnect: (profileName: string, interfaceGuid: string) => ConnectResult | Promise<ConnectResult> = () => ({ requested: true, reasonCode: 0, detail: null })
  private readonly listeners = new Set<(event: WlanEvent) => void>()

  static iface(partial: Partial<WlanInterfaceStatus> = {}): WlanInterfaceStatus {
    return { guid: '11111111-2222-3333-4444-555555555555', description: 'Test Wi-Fi adapter', alias: 'Wi-Fi', state: 'disconnected', profileName: null, ssid: null, signal: null, lastReasonCode: null, ...partial }
  }

  async status(): Promise<WlanInterfaceStatus[]> {
    this.statusCalls++
    return this.interfaces.map((i) => ({ ...i }))
  }

  async profiles(): Promise<SavedProfile[]> {
    return this.saved.map((p) => ({ ...p }))
  }

  async connect(profileName: string, interfaceGuid: string): Promise<ConnectResult> {
    this.connectCalls.push({ profileName, interfaceGuid })
    return this.onConnect(profileName, interfaceGuid)
  }

  subscribe(listener: (event: WlanEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: Partial<WlanEvent> & Pick<WlanEvent, 'kind'>): void {
    const full: WlanEvent = { at: 0, interfaceGuid: null, profileName: null, reasonCode: null, ...event }
    for (const l of [...this.listeners]) l(full)
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}
