import type { HttpFetch, OperatorChannelProvider, OutboundText, ProviderHealth, RawProviderUpdate, SendResult, UpdateHandler } from './provider'

/**
 * Telegram Bot API over LONG POLLING (getUpdates with offset and timeout). There is no webhook and so no inbound
 * port: the PC only makes outbound HTTPS requests to api.telegram.org. The Bot API cannot deliver to a webhook and
 * to getUpdates at the same time; this provider never sets a webhook.
 *
 * The bot token is part of every request URL, so it is the most leak-prone value here. It is read through
 * `getToken` at call time, never held on the object, never logged, and every error leaving this file is
 * reduced to a class name: no message, no URL, no response body.
 */

export interface OffsetStore {
  get(): Promise<number | null>
  set(offset: number): Promise<void>
}

export class MemoryOffsetStore implements OffsetStore {
  private value: number | null = null
  async get(): Promise<number | null> { return this.value }
  async set(offset: number): Promise<void> { this.value = offset }
}

export interface TelegramProviderOptions {
  getToken: () => Promise<string | null>
  fetch: HttpFetch
  offsetStore: OffsetStore
  sleep?: (ms: number) => Promise<void>
  /** Long-poll wait in seconds. */
  pollTimeoutSeconds?: number
  baseUrl?: string
  /** Receives short lines that never contain a token, a URL or message text. */
  log?: (line: string) => void
}

/** The documented limit of a sendMessage text is 4096 characters; parts are cut a little below it. */
export const TELEGRAM_MAX_TEXT = 4096
const CHUNK = 4000
const MAX_CHUNKS = 3
const MAX_BACKOFF_MS = 60_000
const MAX_RETRY_AFTER_SECONDS = 3600

export type PollOutcome = 'IDLE' | 'HANDLED' | 'UNCONFIGURED' | 'RATE_LIMITED' | 'ERROR'

interface ApiResult {
  ok: boolean
  result?: unknown
  errorClass: string | null
  retryable: boolean
  retryAfterSeconds: number | null
}

/** Removes everything in a string that could carry the token: the token itself, bot<token> path parts, any URL. */
export function scrubSecrets(text: string, token: string | null): string {
  let out = text
  if (token) out = out.split(token).join('[token]')
  out = out.replace(/bot\d{3,}:[A-Za-z0-9_-]{8,}/g, 'bot[token]').replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[token]').replace(/https?:\/\/\S+/gi, '[url]')
  return out
}

export function splitForTelegram(text: string): string[] {
  if (text.length <= CHUNK) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > CHUNK && parts.length < MAX_CHUNKS) {
    let cut = rest.lastIndexOf('\n', CHUNK)
    if (cut < CHUNK / 2) cut = CHUNK
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) {
    const note = '\n[… cut: the message was too long]'
    const last = parts.pop() ?? ''
    parts.push(last.slice(0, CHUNK - note.length) + note)
  }
  return parts
}

export class TelegramProvider implements OperatorChannelProvider {
  readonly kind = 'TELEGRAM' as const
  readonly capabilities = { text: true, voice: false, inbound: true }
  private readonly o: TelegramProviderOptions
  private running = false
  private abort: AbortController | null = null
  private loopDone: Promise<void> | null = null
  private handler: UpdateHandler | null = null
  private consecutiveErrors = 0

  constructor(options: TelegramProviderOptions) {
    this.o = options
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms))
  }

  private note(line: string): void {
    this.o.log?.(`telegram: ${line}`)
  }

  /** One Bot API call. The token exists only in this stack frame. */
  private async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ApiResult> {
    const token = await this.o.getToken()
    if (!token) return { ok: false, errorClass: 'NOT_CONFIGURED', retryable: false, retryAfterSeconds: null }
    const url = `${this.o.baseUrl ?? 'https://api.telegram.org'}/bot${token}/${method}`
    let status: number
    let body: unknown
    try {
      const response = await this.o.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal })
      status = response.status
      try { body = await response.json() } catch { body = null }
    } catch {
      // The error of a failed request usually quotes the URL, and so the token. Only the class survives.
      return { ok: false, errorClass: 'NETWORK', retryable: true, retryAfterSeconds: null }
    }
    const b = (body && typeof body === 'object' ? body : {}) as { ok?: boolean; result?: unknown; error_code?: number; parameters?: { retry_after?: number } }
    if (status === 200 && b.ok === true) return { ok: true, result: b.result, errorClass: null, retryable: false, retryAfterSeconds: null }
    const code = typeof b.error_code === 'number' ? b.error_code : status
    if (code === 429) {
      const ra = typeof b.parameters?.retry_after === 'number' ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(b.parameters.retry_after))) : 5
      return { ok: false, errorClass: 'RATE_LIMITED', retryable: true, retryAfterSeconds: ra }
    }
    if (code === 401 || code === 404) return { ok: false, errorClass: 'AUTH', retryable: false, retryAfterSeconds: null }
    if (code >= 500) return { ok: false, errorClass: 'PROVIDER', retryable: true, retryAfterSeconds: null }
    return { ok: false, errorClass: 'REJECTED', retryable: false, retryAfterSeconds: null }
  }

  /** Reduces a Bot API message to the update the line understands, or null for everything that is ignored. */
  private toRawUpdate(raw: unknown): RawProviderUpdate | null {
    if (!raw || typeof raw !== 'object') return null
    const u = raw as { update_id?: unknown; message?: { message_id?: unknown; date?: unknown; text?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown; is_bot?: unknown; first_name?: unknown; username?: unknown } } }
    // Only `message`. edited_message, channel_post, inline_query, callback_query and the rest are not read at all.
    const m = u.message
    if (typeof u.update_id !== 'number' || !m || typeof m !== 'object') return null
    if (m.chat?.type !== 'private') return null
    if (typeof m.chat.id !== 'number' || !m.from || typeof m.from.id !== 'number' || m.from.is_bot === true) return null
    if (m.from.id !== m.chat.id) return null
    if (typeof m.text !== 'string' || m.text.length === 0 || typeof m.message_id !== 'number') return null
    const label = String(m.from.username ?? m.from.first_name ?? 'unknown').replace(/[^\p{L}\p{N}_ .-]/gu, '').slice(0, 40) || 'unknown'
    return {
      channel: 'TELEGRAM',
      dedupeKey: `telegram:${u.update_id}`,
      providerMessageId: String(m.message_id),
      providerUserId: String(m.chat.id),
      senderLabel: label,
      text: m.text,
      receivedAt: typeof m.date === 'number' ? new Date(m.date * 1000).toISOString() : new Date().toISOString(),
      providerAuthenticated: true,
    }
  }

  /** One getUpdates round. Public so a test (or the loop) can drive it step by step. */
  async pollOnce(signal?: AbortSignal): Promise<PollOutcome> {
    if (!this.handler) throw new Error('provider not started')
    const offset = await this.o.offsetStore.get()
    const params: Record<string, unknown> = { timeout: this.o.pollTimeoutSeconds ?? 30, allowed_updates: ['message'] }
    if (offset !== null) params.offset = offset
    const res = await this.call('getUpdates', params, signal)
    if (!res.ok) {
      if (res.errorClass === 'NOT_CONFIGURED') return 'UNCONFIGURED'
      this.note(`getUpdates failed (${res.errorClass})`)
      if (res.errorClass === 'RATE_LIMITED') {
        await this.sleep((res.retryAfterSeconds ?? 5) * 1000)
        return 'RATE_LIMITED'
      }
      return 'ERROR'
    }
    const updates = Array.isArray(res.result) ? (res.result as unknown[]) : []
    const ordered = updates.filter((x): x is { update_id: number } => !!x && typeof x === 'object' && typeof (x as { update_id?: unknown }).update_id === 'number').sort((a, b) => a.update_id - b.update_id)
    let handled = false
    for (const update of ordered) {
      const raw = this.toRawUpdate(update)
      if (raw) {
        // Handed over first. If this throws, the offset stays where it was and the update comes again.
        await this.handler(raw)
        handled = true
      }
      await this.o.offsetStore.set(update.update_id + 1)
    }
    return handled ? 'HANDLED' : 'IDLE'
  }

  /** Sets the hand-over function without starting the loop (a caller that drives pollOnce itself). */
  attach(onUpdate: UpdateHandler): void {
    this.handler = onUpdate
  }

  async start(onUpdate: UpdateHandler): Promise<void> {
    if (this.running) return
    this.handler = onUpdate
    this.running = true
    this.abort = new AbortController()
    this.loopDone = this.loop(this.abort.signal)
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (this.running) {
      let outcome: PollOutcome = 'ERROR'
      try {
        outcome = await this.pollOnce(signal)
      } catch {
        // A failure of the hand-over (or an aborted request). Class only.
        this.note('poll round failed')
      }
      if (!this.running) break
      if (outcome === 'ERROR' || outcome === 'UNCONFIGURED') {
        this.consecutiveErrors += 1
        await this.sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.consecutiveErrors, 6)))
      } else {
        this.consecutiveErrors = 0
        // Short polling (timeout 0) must not spin; a real long poll waits on the server side.
        if (outcome === 'IDLE' && (this.o.pollTimeoutSeconds ?? 30) === 0) await this.sleep(1000)
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false
    this.abort?.abort()
    await this.loopDone?.catch(() => undefined)
    this.loopDone = null
    this.handler = null
  }

  async send(message: OutboundText): Promise<SendResult> {
    if (!/^-?\d{1,20}$/.test(message.providerUserId)) return { ok: false, providerReference: null, errorClass: 'REJECTED', retryable: false }
    let last: string | null = null
    for (const part of splitForTelegram(message.text)) {
      // No parse_mode: the text may carry project- or model-derived content, and it must stay inert plain text.
      const res = await this.call('sendMessage', { chat_id: message.providerUserId, text: part, link_preview_options: { is_disabled: true } })
      if (!res.ok) {
        if (res.errorClass === 'RATE_LIMITED') this.note(`sendMessage rate limited, retry after ${res.retryAfterSeconds}s`)
        return { ok: false, providerReference: last, errorClass: res.errorClass, retryable: res.retryable }
      }
      const id = (res.result as { message_id?: unknown } | undefined)?.message_id
      last = typeof id === 'number' ? String(id) : last
    }
    return { ok: true, providerReference: last, errorClass: null, retryable: false }
  }

  async health(): Promise<ProviderHealth> {
    const res = await this.call('getMe', {})
    if (res.ok) {
      const username = (res.result as { username?: unknown } | undefined)?.username
      return { status: 'OK', errorClass: null, detail: typeof username === 'string' ? `@${username.replace(/[^\w]/g, '').slice(0, 40)}` : null }
    }
    if (res.errorClass === 'NOT_CONFIGURED') return { status: 'UNCONFIGURED', errorClass: null, detail: null }
    return { status: 'ERROR', errorClass: res.errorClass, detail: null }
  }
}
