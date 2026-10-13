import type { OperatorCallState } from '@shared/director-line'
import type { HttpFetch, ProviderHealth } from './provider'

/**
 * The voice side. RELEASE_READY_BUT_UNCONFIGURED: it places an outbound call that speaks a short report and does
 * nothing until the user has configured Twilio credentials and a paired number. Nothing here signs up, spends, or
 * calls a number on its own; every PSTN call costs money on the user's own Twilio account.
 *
 * Outbound state is learned by POLLING the call resource over an outbound HTTPS request, so a plain report call needs
 * no inbound endpoint. Interactive input (the PIN, a spoken choice) needs Twilio to reach a public HTTPS URL, which the
 * PC does not have and must not get: that is what the OperatorRelay design is for (relay.ts, docs/DIRECTOR_LINE.md).
 * Calls are not recorded: `Record=false` is sent explicitly.
 */

export interface VoiceCallSpec {
  /** E.164 number of the paired operator. */
  to: string
  /** Concise plain text to speak. */
  spokenText: string
  /** When a relay exists, the HTTPS URL Twilio posts the gathered PIN and choice to. Absent: the call only speaks. */
  gatherActionUrl?: string
}

export interface VoiceCallResult {
  ok: boolean
  providerCallId: string | null
  finalState: OperatorCallState
  errorClass: string | null
  /** Always false in this implementation. */
  recorded: false
}

export interface VoiceProvider {
  readonly kind: 'TWILIO_VOICE'
  health(): Promise<ProviderHealth>
  placeCall(spec: VoiceCallSpec): Promise<VoiceCallResult>
}

export function xmlEscape(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** TwiML for a spoken report. With `gatherActionUrl` it also asks for the PIN on the keypad, then a short choice. */
export function buildReportTwiml(spokenText: string, gatherActionUrl?: string): string {
  const say = `<Say>${xmlEscape(spokenText.slice(0, 600))}</Say>`
  if (!gatherActionUrl) return `<Response>${say}</Response>`
  if (!/^https:\/\//i.test(gatherActionUrl)) throw new Error('gather action must be an https URL')
  const url = xmlEscape(gatherActionUrl)
  return `<Response>${say}<Gather input="dtmf" numDigits="12" finishOnKey="#" timeout="8" action="${url}" method="POST"><Say>Enter your PIN, then the pound key.</Say></Gather><Say>No PIN was entered. Goodbye.</Say></Response>`
}

export interface TwilioCredentials {
  accountSid: string
  /** An API key SID and its secret (the documented way); the secret never leaves this call frame. */
  apiKeySid: string
  apiKeySecret: string
  /** The Twilio number calls come from. */
  fromNumber: string
}

export interface TwilioVoiceOptions {
  getCredentials: () => Promise<TwilioCredentials | null>
  fetch: HttpFetch
  sleep?: (ms: number) => Promise<void>
  /** How long to follow a call before giving up on it and cancelling the ringing. */
  maxWaitMs?: number
  pollIntervalMs?: number
  baseUrl?: string
}

const STATE_MAP: Record<string, OperatorCallState> = {
  queued: 'QUEUED', initiated: 'QUEUED', ringing: 'RINGING', 'in-progress': 'ANSWERED', completed: 'COMPLETED',
  busy: 'BUSY', 'no-answer': 'NO_ANSWER', failed: 'FAILED', canceled: 'FAILED',
}
const SETTLED: OperatorCallState[] = ['ANSWERED', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED']

export class TwilioVoiceProvider implements VoiceProvider {
  readonly kind = 'TWILIO_VOICE' as const
  private readonly o: TwilioVoiceOptions

  constructor(options: TwilioVoiceOptions) {
    this.o = options
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async request(creds: TwilioCredentials, method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> } | null> {
    const base = this.o.baseUrl ?? 'https://api.twilio.com/2010-04-01'
    try {
      const res = await this.o.fetch(`${base}/Accounts/${encodeURIComponent(creds.accountSid)}/${path}`, {
        method,
        headers: { authorization: `Basic ${Buffer.from(`${creds.apiKeySid}:${creds.apiKeySecret}`).toString('base64')}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form).toString() : undefined,
      })
      let body: unknown = {}
      try { body = await res.json() } catch { body = {} }
      return { status: res.status, body: (body && typeof body === 'object' ? body : {}) as Record<string, unknown> }
    } catch {
      return null
    }
  }

  async health(): Promise<ProviderHealth> {
    const creds = await this.o.getCredentials()
    if (!creds) return { status: 'UNCONFIGURED', errorClass: null, detail: null }
    const res = await this.request(creds, 'GET', 'Calls.json?PageSize=1')
    if (!res) return { status: 'ERROR', errorClass: 'NETWORK', detail: null }
    if (res.status === 200) return { status: 'OK', errorClass: null, detail: `…${creds.accountSid.slice(-4)}` }
    return { status: 'ERROR', errorClass: res.status === 401 || res.status === 403 ? 'AUTH' : 'PROVIDER', detail: null }
  }

  async placeCall(spec: VoiceCallSpec): Promise<VoiceCallResult> {
    const fail = (errorClass: string, state: OperatorCallState = 'FAILED', id: string | null = null): VoiceCallResult => ({ ok: false, providerCallId: id, finalState: state, errorClass, recorded: false })
    const creds = await this.o.getCredentials()
    if (!creds) return fail('NOT_CONFIGURED')
    if (!/^\+[1-9]\d{6,14}$/.test(spec.to)) return fail('REJECTED')
    const created = await this.request(creds, 'POST', 'Calls.json', { To: spec.to, From: creds.fromNumber, Twiml: buildReportTwiml(spec.spokenText, spec.gatherActionUrl), Record: 'false' })
    if (!created) return fail('NETWORK')
    const sid = typeof created.body.sid === 'string' && /^CA[0-9a-f]{32}$/i.test(created.body.sid) ? created.body.sid : null
    if (created.status !== 201 || !sid) return fail(created.status === 401 || created.status === 403 ? 'AUTH' : created.status === 429 ? 'RATE_LIMITED' : 'PROVIDER')

    const maxWait = this.o.maxWaitMs ?? 90_000
    const interval = this.o.pollIntervalMs ?? 3000
    let waited = 0
    let state: OperatorCallState = 'QUEUED'
    while (waited <= maxWait) {
      const poll = await this.request(creds, 'GET', `Calls/${sid}.json`)
      if (poll?.status === 200 && typeof poll.body.status === 'string') {
        state = STATE_MAP[poll.body.status] ?? state
        if (SETTLED.includes(state)) return { ok: state === 'ANSWERED' || state === 'COMPLETED', providerCallId: sid, finalState: state, errorClass: state === 'FAILED' ? 'PROVIDER' : null, recorded: false }
      }
      await this.sleep(interval)
      waited += interval
    }
    // Still ringing: stop it, so a late answer does not meet a report nobody is ready to hear, and nothing rings twice.
    await this.request(creds, 'POST', `Calls/${sid}.json`, { Status: 'canceled' })
    return { ok: false, providerCallId: sid, finalState: 'NO_ANSWER', errorClass: null, recorded: false }
  }
}

/** A voice provider for tests and for running without credentials. */
export class FakeVoiceProvider implements VoiceProvider {
  readonly kind = 'TWILIO_VOICE' as const
  readonly calls: VoiceCallSpec[] = []
  configured = true
  next: OperatorCallState = 'ANSWERED'
  async health(): Promise<ProviderHealth> {
    return this.configured ? { status: 'OK', errorClass: null, detail: 'fake' } : { status: 'UNCONFIGURED', errorClass: null, detail: null }
  }
  async placeCall(spec: VoiceCallSpec): Promise<VoiceCallResult> {
    this.calls.push(spec)
    const ok = this.next === 'ANSWERED' || this.next === 'COMPLETED'
    return { ok, providerCallId: `CA${'0'.repeat(32)}`, finalState: this.next, errorClass: ok ? null : this.next === 'FAILED' ? 'PROVIDER' : null, recorded: false }
  }
}
