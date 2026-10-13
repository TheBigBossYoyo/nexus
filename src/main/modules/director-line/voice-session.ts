import type { OperatorCommand } from '@shared/director-line'
import { commandRisk } from './intent'
import type { PhoneAuthResult } from './pairing'

/**
 * 0.9.1: one telephone call with the Director, as a conversation. It knows nothing of the telephone service: it
 * is given what the caller said or pressed, and answers with what to say and whether to hang up. The relay and
 * Twilio's speech recognition are on the other side of it.
 *
 * Who is on the line is established here and nowhere else, once per call:
 * - A call that comes IN must come from the paired number AND give the PIN, before anything is answered: a
 *   caller's number can be forged, so the number alone opens nothing, not even a status.
 * - A call NEXUS placed went to the paired number. It says its report, which is what the call is for, and then
 *   nothing more until the PIN: whoever picked up the phone is not thereby the operator.
 * - Until then the only thing listened for is the PIN. What an unauthenticated caller says is not interpreted,
 *   not kept and not given to any model.
 * - `requirePin: false` is for a service that itself establishes whose account is calling (not a telephone
 *   number that a network merely reports): the paired identity is then enough. It is the owner's choice.
 *
 * What an authenticated caller can ask is the same closed set as by message. A task is read back and created
 * only after a yes: speech recognition errs. The session grants nothing; what asks for authority is answered
 * with "that is decided at the machine", as by message.
 */

export interface VoiceSessionDeps {
  authenticatePhone: (from: string, pin: string | null) => Promise<PhoneAuthResult>
  isPairedNumber: (from: string) => Promise<boolean>
  interpret: (text: string) => Promise<{ text: string; command: OperatorCommand }>
  perform: (input: { from: string; callId: string; turnId: string; text: string; command: OperatorCommand }) => Promise<string>
  now: () => number
  /** A note for the record: a refusal, a wrong PIN, an unknown caller. Never the PIN, never the words of an unauthenticated caller. */
  note?: (what: string) => void
}

export interface VoiceSessionStart {
  callId: string
  direction: 'INBOUND' | 'OUTBOUND'
  /** The other party's number as the telephone service reports it (E.164). For an outbound call, the number NEXUS dialled. */
  from: string
  /** For a call NEXUS placed: the report to say first. */
  report?: string
  /** Default true. See the note on who is on the line. */
  requirePin?: boolean
}

export interface VoiceReply {
  say: string
  /** The call ends after this is said. */
  end: boolean
  /**
   * FACTS: `say` is what NEXUS computed for a question, and may be put into spoken words by the Director voice.
   * OPEN: what was said is outside the closed set of commands; `say` is the fixed answer to that, and the Director
   * voice may answer from the facts instead. Absent: `say` is said as it is.
   */
  about?: 'FACTS' | 'OPEN'
}

export const MAX_PIN_TRIES_PER_CALL = 3
/** A session is good for this long after its last authenticated turn; a call left open is not an open door. */
export const SESSION_IDLE_MS = 5 * 60_000
export const SESSION_MAX_MS = 20 * 60_000

// A yes is the whole of what was said, or it is not a yes: "yes, but change it" and "right, no" create nothing.
const YES = /^(yes|yeah|yep|correct|right|do it|confirm|confirmed|go ahead|oui|ouais|d'accord|vas-y|c'est ca|c'est ça|exact)(?:[\s,]+(?:please|add it|do it|go ahead|s'il te pla[iî]t|s'il vous pla[iî]t|merci|thanks|thank you))?[\s.!,]*$/i
const NO = /^(no|nope|cancel|stop|wrong|don't|do not|non|annule|annuler|pas ca|pas ça)\b/i
const BYE = /^(bye|goodbye|bye bye|that's all|that is all|thanks,? bye|thank you,? bye|hang up|au revoir|c'est tout|merci,? au revoir)[\s.!,]*$/i
/** A task longer than this cannot be read back whole, and what was not heard is not created. */
export const MAX_SPOKEN_TASK_CHARS = 240

/** Digits as a caller says them ("one two three four", "un deux trois") or presses them. Null when the words are not only digits. */
export function spokenDigits(text: string): string | null {
  const words: Record<string, string> = {
    zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    zéro: '0', un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5', sept: '7', huit: '8', neuf: '9',
  }
  const tokens = text.toLowerCase().replace(/[.,;:!?#*-]/g, ' ').split(/\s+/).filter((t) => t !== '')
  if (tokens.length === 0) return null
  let digits = ''
  for (const token of tokens) {
    if (/^\d+$/.test(token)) digits += token
    else if (token in words) digits += words[token]
    else return null
  }
  return digits.length >= 1 && digits.length <= 20 ? digits : null
}

export class VoiceSession {
  private authenticated = false
  private pinTries = 0
  private keyed = ''
  private turn = 0
  private readonly startedAt: number
  private lastAuthenticatedAt = 0
  private pendingTask: { text: string; command: OperatorCommand } | null = null
  private closed = false

  constructor(private readonly start: VoiceSessionStart, private readonly deps: VoiceSessionDeps) {
    this.startedAt = deps.now()
  }

  get isAuthenticated(): boolean {
    return this.authenticated
  }

  private end(say: string): VoiceReply {
    this.closed = true
    return { say, end: true }
  }

  /** True while a task that was read back waits for its yes or no. */
  get awaitsConfirmation(): boolean {
    return this.pendingTask !== null
  }

  /** What is said when the call is connected. */
  async open(): Promise<VoiceReply> {
    const paired = await this.deps.isPairedNumber(this.start.from)
    if (paired && this.start.requirePin === false) {
      this.authenticated = true
      this.lastAuthenticatedAt = this.deps.now()
    }
    if (this.start.direction === 'OUTBOUND') {
      const report = (this.start.report ?? '').trim()
      const then = this.authenticated ? 'You can ask about it, or say goodbye.' : 'To ask about it or to change anything, say your PIN or key it in, then press pound.'
      return { say: `This is NEXUS. ${report === '' ? 'Nothing needs your attention.' : report} ${then}`, end: false }
    }
    // An unknown number learns nothing: not that this is NEXUS, not whether a PIN exists.
    if (!paired) {
      this.deps.note?.('a call from a number that is not paired was ended')
      // The attempt is counted against that number, so that it cannot be probed without bound.
      await this.deps.authenticatePhone(this.start.from, null).catch(() => undefined)
      return this.end('This number is not available. Goodbye.')
    }
    if (this.authenticated) return { say: 'NEXUS Director. What would you like to know?', end: false }
    return { say: 'NEXUS Director. What is the PIN? You can say it or key it in, then press pound.', end: false }
  }

  /** A key pressed. Digits are collected until the pound key; nothing is said back for a single digit. */
  async onDigit(digit: string): Promise<VoiceReply | null> {
    // Once the caller is known, keys are nothing: a stray pound must not count as a wrong PIN.
    if (this.closed || this.authenticated) return null
    if (/^\d$/.test(digit)) {
      if (this.keyed.length < 20) this.keyed += digit
      return null
    }
    if (digit === '*') {
      this.keyed = ''
      return null
    }
    if (digit !== '#') return null
    const pin = this.keyed
    this.keyed = ''
    return pin === '' ? null : this.tryPin(pin)
  }

  private async tryPin(pin: string): Promise<VoiceReply> {
    const result = await this.deps.authenticatePhone(this.start.from, pin)
    if (result === 'OK') {
      this.authenticated = true
      this.lastAuthenticatedAt = this.deps.now()
      return { say: 'Thank you. What would you like to know?', end: false }
    }
    this.pinTries += 1
    this.deps.note?.(result === 'LOCKED' ? 'a call was ended: too many wrong PINs for that number' : result === 'NO_PIN_SET' ? 'a call could not be authenticated: no PIN is set on the machine' : 'a wrong PIN was given on a call')
    if (result === 'NO_PIN_SET') return this.end('No PIN is set for this line. Set one on the machine first. Goodbye.')
    if (result === 'LOCKED' || result === 'WRONG_NUMBER' || this.pinTries >= MAX_PIN_TRIES_PER_CALL) return this.end('That is not right. Goodbye.')
    return { say: 'That is not right. Try again.', end: false }
  }

  private expired(): boolean {
    const now = this.deps.now()
    return now - this.startedAt > SESSION_MAX_MS || (this.authenticated && now - this.lastAuthenticatedAt > SESSION_IDLE_MS)
  }

  /** What the caller said, as the telephone service understood it. */
  async onSpeech(text: string): Promise<VoiceReply> {
    if (this.closed) return { say: '', end: true }
    const said = text.trim()
    if (said === '') return { say: '', end: false }
    if (this.expired()) return this.end('This call has been open too long. Call again. Goodbye.')
    if (BYE.test(said)) return this.end('Goodbye.')

    // Before the PIN, in either direction, the only thing listened for is the PIN. Nothing else that is said is
    // interpreted, by a pattern or by a model.
    if (!this.authenticated) {
      const digits = spokenDigits(said)
      if (digits === null) return { say: 'The PIN first, please.', end: false }
      return this.tryPin(digits)
    }

    // A yes or a no to the task that was read back. No is looked for first.
    if (this.pendingTask !== null) {
      const pending = this.pendingTask
      this.pendingTask = null
      if (NO.test(said)) return { say: 'Cancelled. Nothing was added.', end: false }
      if (YES.test(said)) return this.run(pending.text, pending.command)
      // Anything else replaces the question: the task is dropped, not created by a sentence that was not a yes.
    }

    const { text: cleaned, command } = await this.deps.interpret(said)
    return this.act(cleaned, command)
  }

  private async act(text: string, command: OperatorCommand): Promise<VoiceReply> {
    if (commandRisk(command) === 'TASK_HANDOFF') {
      const task = command.kind === 'ADD_TASK_AFTER_CURRENT' || command.kind === 'CREATE_TASK' ? command.text : text
      if (task.length > MAX_SPOKEN_TASK_CHARS) return { say: 'That task is too long to read back, so it was not added. Say it shorter, or send it as a message.', end: false }
      // Read back whole, because speech recognition errs; created only on a yes.
      this.pendingTask = { text, command }
      const where = command.kind === 'CREATE_TASK' ? ` for ${command.project}` : command.kind === 'ADD_TASK_AFTER_CURRENT' ? ' after the current work' : ''
      return { say: `I heard a task${where}: ${task}. Shall I add it? Say yes or no.`, end: false }
    }
    return this.run(text, command)
  }

  private async run(text: string, command: OperatorCommand): Promise<VoiceReply> {
    this.lastAuthenticatedAt = this.deps.now()
    this.turn += 1
    const risk = commandRisk(command)
    if (risk === 'REFUSED') this.deps.note?.('a request that needs the machine was refused on a call')
    const say = await this.deps.perform({ from: this.start.from, callId: this.start.callId, turnId: String(this.turn), text, command })
    if (say === '') return { say: 'Done.', end: false }
    return { say, end: false, ...(risk === 'READ_ONLY' ? { about: 'FACTS' as const } : command.kind === 'UNKNOWN' ? { about: 'OPEN' as const } : {}) }
  }
}
