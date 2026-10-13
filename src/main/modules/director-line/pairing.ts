import { createHash, randomBytes as nodeRandomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { OperatorChannelKind, OperatorIdentity, PairingMethod } from '@shared/director-line'
import type { AttemptCounter, IdentityStore, PairingState, PairingStateStore } from './stores'

/**
 * Pairing and authentication of the one human who may talk to NEXUS from away.
 *
 * Who is authoritative is decided here, from the provider's stable id and a secret the human proved they know, and
 * never from anything a message says. A pairing code is shown on the PC (Settings), typed into the bot from the
 * phone, used once and expires. A phone number is never enough by itself: a voice caller must also give the PIN.
 * Provider authentication (a webhook signature) is a different thing and is carried separately on the message.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const PAIRING_CODE_LENGTH = 12 // 12 base32 characters = 60 bits; the brief asks for at least 10
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000
export const MAX_WRONG_CODES_PER_CHAT = 5
export const MAX_WRONG_CODES_PER_CODE = 40
export const CHAT_COOLING_MS = 30 * 60 * 1000
export const MAX_PIN_ATTEMPTS = 3
export const PIN_COOLING_MS = 30 * 60 * 1000
export const MIN_PIN_LENGTH = 6
export const MAX_PIN_LENGTH = 12

export function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}

export type PairingAttemptResult =
  | { kind: 'PAIRED'; identity: OperatorIdentity }
  /** The chat is cooling off after too many wrong codes: say nothing at all. */
  | { kind: 'COOLING' }
  | { kind: 'WRONG_CODE' }
  /** No pairing is open, or the text does not look like a code: nothing happens and nothing is learned. */
  | { kind: 'NOT_A_CODE' }

export type PhoneAuthResult = 'OK' | 'WRONG_NUMBER' | 'WRONG_PIN' | 'LOCKED' | 'NO_PIN_SET' | 'NOT_PAIRED'

export interface PairingOptions {
  state: PairingStateStore
  identities: IdentityStore
  now?: () => Date
  /** For tests. */
  randomBytes?: (n: number) => Buffer
  /** More than one paired identity per channel is allowed only when this is set explicitly. */
  allowMultiplePerChannel?: boolean
}

export class PairingService {
  private readonly o: PairingOptions
  private readonly now: () => Date
  private readonly rand: (n: number) => Buffer

  constructor(options: PairingOptions) {
    this.o = options
    this.now = options.now ?? (() => new Date())
    this.rand = options.randomBytes ?? nodeRandomBytes
  }

  private async salt(state: PairingState): Promise<Buffer> {
    if (!state.installSalt) {
      state.installSalt = this.rand(16).toString('hex')
      await this.o.state.save(state)
    }
    return Buffer.from(state.installSalt, 'hex')
  }

  private hashCode(code: string, salt: Buffer): string {
    return createHash('sha256').update(salt).update(code).digest('hex')
  }

  private hashPin(pin: string, salt: Buffer): string {
    return scryptSync(pin, salt, 32, { N: 2 ** 14, r: 8, p: 1 }).toString('hex')
  }

  /** Normalises what a person typed: case, spaces and dashes, and a leading /start or /pair. */
  static normalizeCode(text: string): string {
    return text.trim().replace(/^\/(?:start|pair)(?:@\w+)?\s*/i, '').toUpperCase().replace(/[\s-]/g, '')
  }

  static formatCode(code: string): string {
    return code.match(/.{1,4}/g)?.join('-') ?? code
  }

  /**
   * Opens a pairing window and returns the code ONCE. Only its hash is kept. A second call replaces the first code.
   * Refuses when the channel already has its paired operator: unpair first.
   */
  async startPairing(channel: OperatorChannelKind): Promise<{ code: string; displayCode: string; expiresAt: string }> {
    const existing = (await this.o.identities.list()).filter((i) => i.channel === channel)
    if (existing.length > 0 && !this.o.allowMultiplePerChannel) throw new Error('ALREADY_PAIRED: unpair the current operator first')
    const state = await this.o.state.load()
    const salt = await this.salt(state)
    // Rejection sampling is unnecessary: 256 is a multiple of 32, so the modulo is uniform.
    const bytes = this.rand(PAIRING_CODE_LENGTH)
    const code = Array.from(bytes, (b) => BASE32[b % 32]).join('')
    const expiresAt = new Date(this.now().getTime() + PAIRING_CODE_TTL_MS).toISOString()
    state.code = { channel, hash: this.hashCode(code, salt), expiresAt, wrongAttempts: 0 }
    await this.o.state.save(state)
    return { code, displayCode: PairingService.formatCode(code), expiresAt }
  }

  async cancelPairing(): Promise<void> {
    const state = await this.o.state.load()
    state.code = null
    await this.o.state.save(state)
  }

  async isPairingOpen(): Promise<boolean> {
    const state = await this.o.state.load()
    return !!state.code && state.code.expiresAt > this.now().toISOString()
  }

  private isLocked(counter: AttemptCounter | undefined): boolean {
    return !!counter?.lockedUntil && counter.lockedUntil > this.now().toISOString()
  }

  /** A chat that is not paired sent this text. Decides whether it is the right code. Never interprets the text otherwise. */
  async attemptPairing(channel: OperatorChannelKind, providerUserId: string, label: string, text: string): Promise<PairingAttemptResult> {
    const state = await this.o.state.load()
    const key = `chat:${channel}:${providerUserId}`
    if (this.isLocked(state.attempts[key])) return { kind: 'COOLING' }
    const open = state.code
    if (!open || open.channel !== channel) return { kind: 'NOT_A_CODE' }
    if (open.expiresAt <= this.now().toISOString()) {
      state.code = null
      await this.o.state.save(state)
      return { kind: 'NOT_A_CODE' }
    }
    const candidate = PairingService.normalizeCode(text.slice(0, 200))
    if (candidate.length !== PAIRING_CODE_LENGTH || !/^[A-Z2-7]+$/.test(candidate)) return { kind: 'NOT_A_CODE' }
    const salt = await this.salt(state)
    const ok = sameSecret(this.hashCode(candidate, salt), open.hash)
    if (ok) {
      state.code = null
      delete state.attempts[key]
      const identity: OperatorIdentity = { channel, providerUserId, label: label.slice(0, 60), pairedAt: this.now().toISOString(), pairedVia: 'PAIRING_CODE' }
      await this.o.identities.put(identity)
      await this.o.state.save(state)
      return { kind: 'PAIRED', identity }
    }
    const counter = (state.attempts[key] ??= { count: 0, lockedUntil: null })
    counter.count += 1
    if (counter.count >= MAX_WRONG_CODES_PER_CHAT) {
      counter.lockedUntil = new Date(this.now().getTime() + CHAT_COOLING_MS).toISOString()
      counter.count = 0
    }
    open.wrongAttempts += 1
    // Many chats guessing one code: the code is burned rather than left open to a patient crowd.
    if (open.wrongAttempts >= MAX_WRONG_CODES_PER_CODE) state.code = null
    await this.o.state.save(state)
    return { kind: 'WRONG_CODE' }
  }

  async findPaired(channel: OperatorChannelKind, providerUserId: string): Promise<OperatorIdentity | null> {
    const all = await this.o.identities.list()
    return all.find((i) => i.channel === channel && sameSecret(i.providerUserId, providerUserId)) ?? null
  }

  async listPaired(): Promise<OperatorIdentity[]> {
    return this.o.identities.list()
  }

  /** Ends authority at once, for one channel or for all. */
  async unpair(channel?: OperatorChannelKind): Promise<number> {
    const all = await this.o.identities.list()
    let n = 0
    for (const i of all) {
      if (channel && i.channel !== channel) continue
      await this.o.identities.remove(i.channel, i.providerUserId)
      n += 1
    }
    const state = await this.o.state.load()
    state.code = null
    await this.o.state.save(state)
    return n
  }

  /** Configures the PIN for voice. Stored as a salted scrypt hash. */
  async setPin(pin: string): Promise<void> {
    if (!/^\d+$/.test(pin) || pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) throw new Error(`PIN must be ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} digits`)
    const state = await this.o.state.load()
    const salt = await this.salt(state)
    state.pin = { hash: this.hashPin(pin, salt) }
    for (const k of Object.keys(state.attempts)) if (k.startsWith('pin:')) delete state.attempts[k]
    await this.o.state.save(state)
  }

  async hasPin(): Promise<boolean> {
    return !!(await this.o.state.load()).pin
  }

  /**
   * A phone caller claims to be the operator. The number must be the paired number AND the PIN must be right. A wrong
   * number is not told apart from a wrong PIN by what the caller hears (the caller gets one refusal); the distinction
   * here is for the log only.
   */
  async authenticatePhone(channel: OperatorChannelKind, fromNumber: string, pin: string | null): Promise<PhoneAuthResult> {
    const paired = await this.findPaired(channel, fromNumber)
    const state = await this.o.state.load()
    const key = `pin:${fromNumber}`
    if (this.isLocked(state.attempts[key])) return 'LOCKED'
    if (!paired) {
      // Unknown numbers also count, so that a number cannot be probed without bound.
      const counter = (state.attempts[key] ??= { count: 0, lockedUntil: null })
      counter.count += 1
      if (counter.count >= MAX_PIN_ATTEMPTS) { counter.lockedUntil = new Date(this.now().getTime() + PIN_COOLING_MS).toISOString(); counter.count = 0 }
      await this.o.state.save(state)
      return 'WRONG_NUMBER'
    }
    if (!state.pin) return 'NO_PIN_SET'
    if (pin === null || !/^\d{1,20}$/.test(pin)) return 'WRONG_PIN'
    const salt = await this.salt(state)
    if (sameSecret(this.hashPin(pin, salt), state.pin.hash)) {
      delete state.attempts[key]
      await this.o.state.save(state)
      return 'OK'
    }
    const counter = (state.attempts[key] ??= { count: 0, lockedUntil: null })
    counter.count += 1
    if (counter.count >= MAX_PIN_ATTEMPTS) { counter.lockedUntil = new Date(this.now().getTime() + PIN_COOLING_MS).toISOString(); counter.count = 0 }
    await this.o.state.save(state)
    return 'WRONG_PIN'
  }

  /** Pairs a phone number directly (from Settings, on the PC, where the user is present). */
  async pairPhoneFromSettings(channel: OperatorChannelKind, e164: string, label: string, via: PairingMethod = 'PHONE_AND_PIN'): Promise<OperatorIdentity> {
    if (!/^\+[1-9]\d{6,14}$/.test(e164)) throw new Error('number must be E.164, like +33612345678')
    const identity: OperatorIdentity = { channel, providerUserId: e164, label: label.slice(0, 60), pairedAt: this.now().toISOString(), pairedVia: via }
    await this.o.identities.put(identity)
    return identity
  }
}
