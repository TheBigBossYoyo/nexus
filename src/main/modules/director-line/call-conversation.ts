import type { DirectorVoice } from './director-voice'
import type { VoiceReply, VoiceSession } from './voice-session'

/**
 * 0.9.1: one live call, between what was heard and what is said. It knows nothing of audio or of the service
 * that carries the call: speech recognition gives it what the operator said, and it gives sentences to whatever
 * speaks them.
 *
 * Two parts answer, and which one is not the model's choice. The voice session decides who is on the line, what
 * was asked among the closed set of commands and whether it is done; its fixed sentences (the PIN, a task read
 * back, a refusal, "done") are said as they are. Only what answers a question is given to the Director voice to
 * word, with the facts NEXUS computed.
 *
 * The operator can speak over NEXUS at any time: what is being said is cut, and what they say next is answered.
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
  /** Something of this call failed; never what was said. */
  log?: (line: string) => void
}

export interface CallLine {
  who: 'OPERATOR' | 'NEXUS'
  text: string
}

/** What is kept of a call while it lasts, for a task that is dictated over several turns. Not written anywhere by this. */
const MAX_KEPT_LINES = 60

export class CallConversation {
  private chain: Promise<void> = Promise.resolve()
  private speaking = 0
  private over = false
  private readonly lines: CallLine[] = []

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
    if (!this.o.session.isAuthenticated || text === '') return
    this.lines.push({ who, text })
    if (this.lines.length > MAX_KEPT_LINES) this.lines.shift()
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.over) return
      try {
        await work()
      } catch {
        this.o.log?.('director-line: a turn of a call failed')
        this.o.output.say('That did not work on the PC. Nothing more was done.')
      }
    })
    this.chain = run
    return run
  }

  /** The call is connected. */
  start(): Promise<void> {
    return this.enqueue(async () => {
      const reply = await this.o.session.open()
      // A caller who was ended at once costs no model session.
      if (!reply.end) this.o.voice?.warm()
      await this.deliver('', reply)
    })
  }

  /** The operator began to speak. Whatever was being said stops. */
  speechStarted(): void {
    if (this.over) return
    this.speaking += 1
    this.o.voice?.interrupt()
    this.o.output.clear()
  }

  /** What the operator said, once they stopped. */
  utterance(text: string): Promise<void> {
    const said = text.trim()
    if (said === '' || this.over) return Promise.resolve()
    // What is still being answered is no longer wanted.
    this.speaking += 1
    this.o.voice?.interrupt()
    return this.enqueue(async () => {
      // Whether it is kept is decided by who they were BEFORE they said it: the sentence that authenticates is the PIN.
      const known = this.o.session.isAuthenticated
      const reply = await this.o.session.onSpeech(said)
      if (known) this.keep('OPERATOR', said)
      await this.deliver(said, reply)
    })
  }

  /** A key pressed. */
  digit(digit: string): Promise<void> {
    if (this.over) return Promise.resolve()
    return this.enqueue(async () => {
      const reply = await this.o.session.onDigit(digit)
      if (reply !== null) await this.deliver('', reply)
    })
  }

  private async deliver(said: string, reply: VoiceReply): Promise<void> {
    const mine = ++this.speaking
    const say = (sentence: string): void => {
      if (mine === this.speaking && !this.over) this.o.output.say(sentence)
    }
    const voice = this.o.voice
    if (reply.about !== undefined && voice !== null && !reply.end && said !== '') {
      const facts = reply.about === 'OPEN' ? await this.o.generalFacts().catch(() => '') : reply.say
      if (facts === '') say(reply.say)
      else {
        const answer = await voice.answer({ said, facts, ...(reply.about === 'OPEN' ? { fallback: reply.say } : {}) }, say)
        this.keep('NEXUS', answer.text)
      }
    } else if (reply.say !== '') {
      say(reply.say)
      this.keep('NEXUS', reply.say)
    }
    if (reply.end) {
      this.o.output.hangUp()
      await this.close()
    }
  }

  /** The call is over, whoever ended it. */
  async close(): Promise<void> {
    if (this.over) return
    this.over = true
    await this.o.voice?.close()
  }
}
