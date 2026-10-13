import type { OperatorChannelKind } from '@shared/director-line'

/** The smallest `fetch` the providers need. The runtime passes global fetch; tests pass a fake. */
export interface HttpResponseLike {
  status: number
  json(): Promise<unknown>
  text?(): Promise<string>
}
export type HttpFetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<HttpResponseLike>

/** What a provider hands over for one inbound text. Raw: nothing here has been trusted or interpreted yet. */
export interface RawProviderUpdate {
  channel: OperatorChannelKind
  /** Unique per delivery at the provider ('telegram:123456'). Used for dedupe and for the durable seen-set. */
  dedupeKey: string
  providerMessageId: string
  /** Chat id or number the text came from, and where a reply goes. */
  providerUserId: string
  senderLabel: string
  text: string
  receivedAt: string
  /** The provider vouches for the delivery (TLS to the provider's API, a verified webhook signature). Not about the human. */
  providerAuthenticated: boolean
}

export interface OutboundText {
  providerUserId: string
  text: string
}

export interface SendResult {
  ok: boolean
  providerReference: string | null
  /** 'NETWORK' | 'RATE_LIMITED' | 'AUTH' | 'PROVIDER' | 'REJECTED' | 'NOT_CONFIGURED'. Never a raw error message. */
  errorClass: string | null
  retryable: boolean
}

export interface ProviderHealth {
  status: 'UNCONFIGURED' | 'OK' | 'ERROR'
  errorClass: string | null
  /** Provider-side account name for the Settings view ('@nexus_bot'). Never a credential. */
  detail: string | null
}

/**
 * Handed each update by a provider. The provider treats the update as confirmed only after the returned promise
 * resolves, so that an update is handed over durably before the provider's own offset moves.
 */
export type UpdateHandler = (update: RawProviderUpdate) => Promise<void>

export interface OperatorChannelProvider {
  readonly kind: OperatorChannelKind
  readonly capabilities: { text: boolean; voice: boolean; inbound: boolean }
  start(onUpdate: UpdateHandler): Promise<void>
  stop(): Promise<void>
  send(message: OutboundText): Promise<SendResult>
  health(): Promise<ProviderHealth>
}

/** For tests: records what is sent, lets a test push updates, can be told to fail. */
export class FakeProvider implements OperatorChannelProvider {
  readonly kind: OperatorChannelKind
  readonly capabilities = { text: true, voice: false, inbound: true }
  readonly sent: OutboundText[] = []
  failNext: SendResult | null = null
  configured = true
  private handler: UpdateHandler | null = null

  constructor(kind: OperatorChannelKind = 'TELEGRAM') {
    this.kind = kind
  }

  async start(onUpdate: UpdateHandler): Promise<void> {
    this.handler = onUpdate
  }

  async stop(): Promise<void> {
    this.handler = null
  }

  async push(update: RawProviderUpdate): Promise<void> {
    if (!this.handler) throw new Error('provider not started')
    await this.handler(update)
  }

  async send(message: OutboundText): Promise<SendResult> {
    if (!this.configured) return { ok: false, providerReference: null, errorClass: 'NOT_CONFIGURED', retryable: false }
    if (this.failNext) {
      const result = this.failNext
      this.failNext = null
      return result
    }
    this.sent.push(message)
    return { ok: true, providerReference: `fake-${this.sent.length}`, errorClass: null, retryable: false }
  }

  async health(): Promise<ProviderHealth> {
    return this.configured ? { status: 'OK', errorClass: null, detail: 'fake' } : { status: 'UNCONFIGURED', errorClass: null, detail: null }
  }
}

export function fakeUpdate(partial: Partial<RawProviderUpdate> & { text: string }): RawProviderUpdate {
  const id = partial.providerMessageId ?? String(Math.floor(Math.random() * 1e9))
  return {
    channel: 'TELEGRAM',
    dedupeKey: `telegram:${id}`,
    providerMessageId: id,
    providerUserId: '1001',
    senderLabel: 'someone',
    receivedAt: new Date().toISOString(),
    providerAuthenticated: true,
    ...partial,
  }
}
