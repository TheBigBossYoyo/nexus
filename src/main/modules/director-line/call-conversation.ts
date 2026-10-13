import type { DirectorVoice } from './director-voice'
import { SESSION_IDLE_MS, SESSION_MAX_MS, spokenDigits, type VoiceReply, type VoiceSession } from './voice-session'

/**
 * 0.9.1: one live call, between what was heard and what is said. It knows nothing of audio or of the service
 * that carries the call: speech recognition gives it what the operator said, and it gives sentences to whatever
 * speaks them.
 *
 * Two parts answer, and which one is not the model's choice. The voice session decides who is on the line, what
 * was asked among the closed set of commands and whether it is done; its fixed sentences (the PIN, a task read
 * back, a refusal, "done") are said as they are. Only what answers a question is given to the Director voice to
 * word, with the facts NEXUS computed, and only once the caller is authenticated: before that no model session
 * exists for the call.
 *
 * The operator can speak over an answer at any time: it is cut, and what they say next is answered. A fixed
 * sentence is not cut by a noise on the line: a task that was read back must have been heard before a yes counts.
 */

export interface CallOutput {
  /** Queues one sentence to be spoken. */
  say(sentence: string): void
  /** Stops what is being spoken and drops what is queued. */
  clear(): void
  /** Ends the call once what is queued has been spoken. */
  hangUp(): void
}

export interface CallConversationOptions {
  session: VoiceSession
  /** Null: every answer is NEXUS's own sentence. */
  voice: DirectorVoice | null
  /** The facts for a question outside the closed set: the status as NEXUS would give it. */
  generalFacts: () => Promise<string>
  output: CallOutput
  /** A caller who has not given the PIN after this long is ended. */
  unauthenticatedMs?: number
  /** Nothing heard for this long: the call is ended. */
  idleMs?: number
  maxMs?: number
  /** One thing said may take this long to be answered; after it the call goes on without that answer. */
  turnTimeoutMs?: number
  /** Something of this call failed; never what was said. */
  log?: (line: string) => void
}

export interface CallLine {
  who: 'OPERATOR' | 'NEXUS'
  text: string
}

/** What is kept of a call while it lasts, for a task that is dictated over several turns. Not written anywhere by this. */
const MAX_KEPT_LINES = 60
const UNAUTHENTICATED_MS = 60_000
const TURN_TIMEOUT_MS = 30_000
const FAILED = 'That did not work on the PC. Nothing more was done.'

export class CallConversation {
  private chain: Promise<void> = Promise.resolve()
  private speaking = 0
  /** Whether what is being said now may be cut by the operator speaking. */
  private interruptible = false
  private warmed = false
  private over = false
  private readonly lines: CallLine[] = []
  private watch: NodeJS.Timeout | undefined
  private limit: NodeJS.Timeout | undefined

  constructor(private readonly o: CallConversationOptions) {}

  get ended(): boolean {
    return this.over
  }

  /** What was said since the caller was authenticated, oldest first. */
  transcript(): readonly CallLine[] {
    return this.lines
  }

  private keep(who: CallLine['who'], text: string): void {
    // Before the caller is authenticated nothing of what they say is kept: it may be a PIN, or a stranger's words.
    // Digits alone are not kept afterwards either: a PIN said once more by habit is still a PIN.
    if (!this.o.session.isAuthenticated || text === '' || (who === 'OPERATOR' && spokenDigits(text) !== null)) return
    this.lines.push({ who, text })
    if (this.lines.length > MAX_KEPT_LINES) this.lines.shift()
  }

  /** A call left open is not kept open: without the PIN, or with nothing heard, it is ended. */
  private rearm(): void {
    clearTimeout(this.watch)
    if (this.over) return
    const ms = this.o.session.isAuthenticated ? (this.o.idleMs ?? SESSION_IDLE_MS) : (this.o.unauthenticatedMs ?? UNAUTHENTICATED_MS)
    this.watch = setTimeout(() => void this.endWith('This call has been open too long. Goodbye.'), ms)
    this.watch.unref?.()
  }

  private async endWith(sentence: string): Promise<void> {
    if (this.over) return
    this.speaking += 1
    this.o.voice?.interrupt()
    this.sayFixed(sentence)
    this.hangUp()
    await this.close()
  }

  private sayFixed(sentence: string): void {
    if (this.over || sentence === '') return
    try {
      this.o.output.say(sentence)
    } catch {
      this.o.log?.('director-line: a sentence could not be handed on')
    }
  }

  private hangUp(): void {
    try {
      this.o.output.hangUp()
    } catch {
      this.o.log?.('director-line: the call could not be ended from here')
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.over) return
      let timer: NodeJS.Timeout | undefined
      try {
        // Something on the PC that never answers must not leave the call silent for good.
        const done = await Promise.race([
          work().then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), this.o.turnTimeoutMs ?? TURN_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
        if (!done) {
          // Whatever that turn still produces is no longer said.
          this.speaking += 1
          this.o.voice?.interrupt()
          this.o.log?.('director-line: a turn of a call was not answered in time')
          this.sayFixed(FAILED)
        }
      } catch {
        this.o.log?.('director-line: a turn of a call failed')
        this.sayFixed(FAILED)
      } finally {
        clearTimeout(timer)
      }
    })
    this.chain = run
    return run
  }

  /** The call is connected. */
  start(): Promise<void> {
    this.limit = setTimeout(() => void this.endWith('This call has been open too long. Call again. Goodbye.'), this.o.maxMs ?? SESSION_MAX_MS)
    this.limit.unref?.()
    this.rearm()
    return this.enqueue(async () => this.deliver('', await this.o.session.open(), true))
  }

  /** The operator began to speak. An answer that was being said stops; a fixed sentence is said to its end. */
  speechStarted(): void {
    if (this.over || !this.interruptible) return
    this.speaking += 1
    this.o.voice?.interrupt()
    try {
      this.o.output.clear()
    } catch {
      this.o.log?.('director-line: what was being said could not be stopped')
    }
  }

  /** What the operator said, once they stopped. */
  utterance(text: string): Promise<void> {
    const said = text.trim()
    if (said === '' || this.over) return Promise.resolve()
    this.rearm()
    // An answer that is still being worded is no longer wanted.
    this.speaking += 1
    this.o.voice?.interrupt()
    return this.enqueue(async () => {
      // Whether it is kept is decided by who they were BEFORE they said it: the sentence that authenticates is the PIN.
      const known = this.o.session.isAuthenticated
      const reply = await this.o.session.onSpeech(said)
      if (known) this.keep('OPERATOR', said)
      await this.deliver(said, reply, false)
    })
  }

  /** A key pressed. */
  digit(digit: string): Promise<void> {
    if (this.over) return Promise.resolve()
    this.rearm()
    return this.enqueue(async () => {
      const reply = await this.o.session.onDigit(digit)
      if (reply !== null) await this.deliver('', reply, false)
    })
  }

  private async deliver(said: string, reply: VoiceReply, opening: boolean): Promise<void> {
    const mine = ++this.speaking
    const current = (): boolean => mine === this.speaking && !this.over
    const authenticated = this.o.session.isAuthenticated
    const voice = this.o.voice
    // The model session of a call starts when the caller is known, never before.
    if (authenticated && !this.warmed && !reply.end) {
      this.warmed = true
      voice?.warm()
      this.rearm()
    }
    if (reply.about !== undefined && voice !== null && authenticated && !reply.end && said !== '') {
      this.interruptible = true
      const facts = reply.about === 'OPEN' ? await this.o.generalFacts().catch(() => '') : reply.say
      if (!current()) return
      if (facts === '') this.sayFixed(reply.say)
      else {
        const answer = await voice.answer({ said, facts, ...(reply.about === 'OPEN' ? { fallback: reply.say } : {}) }, (sentence) => {
          if (current()) this.o.output.say(sentence)
        })
        // Only what was handed on to be spoken is kept as said.
        if (current() || answer.interrupted) this.keep('NEXUS', answer.text)
      }
    } else if (reply.say !== '') {
      // NEXUS's own sentences are said whatever was heard meanwhile: the result of something done, a question that waits for a yes.
      // The report of a call NEXUS placed (said at the opening, or once the PIN is given) may be cut short; a question that waits for a yes may not.
      this.interruptible = (opening || reply.about !== undefined || reply.report === true) && !this.o.session.awaitsConfirmation
      this.sayFixed(reply.say)
      this.keep('NEXUS', reply.say)
    }
    if (reply.end) {
      this.hangUp()
      await this.close()
    }
  }

  /** The call is over, whoever ended it. */
  async close(): Promise<void> {
    if (this.over) return
    this.over = true
    clearTimeout(this.watch)
    clearTimeout(this.limit)
    await this.o.voice?.close()
  }
}
