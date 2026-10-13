import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import type { HttpFetch } from './provider'
import type { SeenStore } from './stores'

/**
 * OperatorRelay, client side and envelope format. DESIGNED, not deployed: no relay server is built here.
 *
 * Why: Twilio can only deliver inbound calls and status callbacks to a public HTTPS URL. The PC has none and must
 * not open one. A relay (a small hosted function) receives Twilio's webhook, checks Twilio's signature (that
 * authenticates the PROVIDER, not the caller), seals the result into an envelope for NEXUS and queues it. NEXUS
 * fetches queued envelopes over an OUTBOUND request. The relay holds no project file, no model credential, issues no
 * NEXUS capability, executes nothing, and is not a shell.
 *
 * The envelope is sealed to NEXUS's public key (X25519 ephemeral key agreement, HKDF-SHA256, AES-256-GCM). The relay
 * holds only the public key: it can seal, it cannot read what it queued earlier, and an observer of the queue
 * cannot read anything. A relay that is compromised can still forge an envelope, which is why an envelope never
 * carries authority by itself: a voice command still needs the paired number AND the PIN, with an attempt limit.
 */

export const ENVELOPE_VERSION = 1
export const ENVELOPE_WINDOW_MS = 5 * 60 * 1000
const INFO = Buffer.from('nexus-director-line-envelope-v1')

export interface OperatorEnvelope {
  v: 1
  /** 128-bit random id: the replay key. */
  id: string
  /** Milliseconds since the epoch when sealed. Authenticated (part of the AAD). */
  ts: number
  /** Ephemeral X25519 public key, base64 SPKI DER. */
  epk: string
  iv: string
  ct: string
  tag: string
}

export interface EnvelopePayload {
  kind: 'VOICE_INPUT' | 'CALL_STATUS' | 'TEXT'
  provider: 'TWILIO'
  /** The relay checked the provider's webhook signature. Says nothing about the human. */
  providerAuthenticated: boolean
  from: string
  callSid: string
  digits?: string
  speech?: string
  callStatus?: string
}

export interface RelayKeyPair {
  /** Goes to the relay's configuration. */
  publicKey: string
  /** Stays on the PC, in protected storage (Electron safeStorage). */
  privateKey: string
}

export function generateRelayKeyPair(): RelayKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }
}

function aad(v: number, id: string, ts: number, epk: string): Buffer {
  return Buffer.from(`${v}|${id}|${ts}|${epk}`)
}

function deriveKey(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), INFO, 32))
}

/** What the relay does (here for tests and for the relay's author to copy). */
export function sealEnvelope(recipientPublicKey: string, payload: EnvelopePayload, options: { now?: () => number } = {}): OperatorEnvelope {
  const eph = generateKeyPairSync('x25519')
  const recipient = createPublicKey({ key: Buffer.from(recipientPublicKey, 'base64'), format: 'der', type: 'spki' })
  const key = deriveKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }))
  const id = randomBytes(16).toString('hex')
  const ts = (options.now ?? Date.now)()
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(ENVELOPE_VERSION, id, ts, epk))
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return { v: 1, id, ts, epk, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

export type OpenResult = { ok: true; payload: EnvelopePayload; id: string } | { ok: false; reason: 'MALFORMED' | 'STALE' | 'AUTH_FAILED' | 'REPLAY' }

/** Verifies and opens. Replay is checked only after authentication, so forged junk cannot fill the seen-set. */
export async function openEnvelope(privateKey: string, envelope: unknown, options: { seen: SeenStore; now?: () => number; windowMs?: number }): Promise<OpenResult> {
  const e = envelope as Partial<OperatorEnvelope> | null
  if (!e || typeof e !== 'object' || e.v !== 1 || typeof e.id !== 'string' || !/^[0-9a-f]{32}$/.test(e.id) || typeof e.ts !== 'number' || !Number.isFinite(e.ts)
    || typeof e.epk !== 'string' || typeof e.iv !== 'string' || typeof e.ct !== 'string' || typeof e.tag !== 'string' || e.ct.length > 20_000) return { ok: false, reason: 'MALFORMED' }
  const now = (options.now ?? Date.now)()
  if (Math.abs(now - e.ts) > (options.windowMs ?? ENVELOPE_WINDOW_MS)) return { ok: false, reason: 'STALE' }
  let plain: string
  try {
    const sender = createPublicKey({ key: Buffer.from(e.epk, 'base64'), format: 'der', type: 'spki' })
    const mine = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    const key = deriveKey(diffieHellman({ privateKey: mine, publicKey: sender }))
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'))
    decipher.setAAD(aad(1, e.id, e.ts, e.epk))
    decipher.setAuthTag(Buffer.from(e.tag, 'base64'))
    plain = Buffer.concat([decipher.update(Buffer.from(e.ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return { ok: false, reason: 'AUTH_FAILED' }
  }
  let payload: EnvelopePayload
  try {
    const parsed = JSON.parse(plain) as Partial<EnvelopePayload>
    if (!parsed || typeof parsed.from !== 'string' || typeof parsed.callSid !== 'string' || !['VOICE_INPUT', 'CALL_STATUS', 'TEXT'].includes(parsed.kind as string)) return { ok: false, reason: 'MALFORMED' }
    payload = parsed as EnvelopePayload
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }
  if (!(await options.seen.addIfAbsent(`envelope:${e.id}`, new Date(now).toISOString()))) return { ok: false, reason: 'REPLAY' }
  return { ok: true, payload, id: e.id }
}

export interface OperatorRelayClientOptions {
  /** HTTPS base of the relay. Anything else is refused. */
  baseUrl: string
  fetch: HttpFetch
  /** Credential for POLLING the relay only. It grants nothing in NEXUS. */
  getAuth: () => Promise<{ bearer: string; privateKey: string } | null>
  seen: SeenStore
  now?: () => number
}

export interface RelayPollResult {
  payloads: Array<{ id: string; payload: EnvelopePayload }>
  rejected: number
  errorClass: string | null
}

/** Polls the relay over an OUTBOUND connection. Never listens on a port. */
export class OperatorRelayClient {
  private readonly o: OperatorRelayClientOptions

  constructor(options: OperatorRelayClientOptions) {
    if (!/^https:\/\//i.test(options.baseUrl)) throw new Error('relay must be reached over https')
    this.o = options
  }

  async pollOnce(): Promise<RelayPollResult> {
    const auth = await this.o.getAuth()
    if (!auth) return { payloads: [], rejected: 0, errorClass: 'NOT_CONFIGURED' }
    const base = this.o.baseUrl.replace(/\/+$/, '')
    let list: unknown
    try {
      const res = await this.o.fetch(`${base}/v1/operator-envelopes`, { method: 'GET', headers: { authorization: `Bearer ${auth.bearer}` } })
      if (res.status !== 200) return { payloads: [], rejected: 0, errorClass: res.status === 401 || res.status === 403 ? 'AUTH' : 'PROVIDER' }
      list = await res.json()
    } catch {
      return { payloads: [], rejected: 0, errorClass: 'NETWORK' }
    }
    const envelopes = Array.isArray((list as { envelopes?: unknown })?.envelopes) ? ((list as { envelopes: unknown[] }).envelopes).slice(0, 50) : []
    const payloads: RelayPollResult['payloads'] = []
    let rejected = 0
    const ack: string[] = []
    for (const env of envelopes) {
      const result = await openEnvelope(auth.privateKey, env, { seen: this.o.seen, now: this.o.now })
      if (result.ok) payloads.push({ id: result.id, payload: result.payload })
      else rejected += 1
      // Everything handled is acknowledged, forged or stale included, so the queue does not fill with junk.
      const id = (env as { id?: unknown } | null)?.id
      if (typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)) ack.push(id)
    }
    if (ack.length > 0) {
      try { await this.o.fetch(`${base}/v1/operator-envelopes/ack`, { method: 'POST', headers: { authorization: `Bearer ${auth.bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ack }) }) } catch { /* the next poll shows them again and the seen-set drops them */ }
    }
    return { payloads, rejected, errorClass: null }
  }
}
