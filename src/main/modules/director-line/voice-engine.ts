import type { CallConversation, CallConversationOptions } from './call-conversation'
import type { CallEndReason, SpeechToTextProvider, SpeechToTextSession, TextToSpeechProvider, TurnDetectionProvider, TurnDetectionSession, VoiceCall } from './voice-provider'

/**
 * 0.9.1: one call in sound. It joins a call that some transport carries, speech recognition, speech synthesis
 * and the conversation: what is heard goes to recognition and becomes what was said; each sentence to say is
 * synthesized, in order, and played into the call.
 *
 * When the operator starts to speak while NEXUS is speaking, three things stop at once: the sentences not yet
 * synthesized are dropped, the synthesis in progress is aborted, and the sound already queued in the call is
 * cleared. Nothing of the sound is kept: it passes through and is gone.
 */

export interface VoiceEngineOptions {
  call: VoiceCall
  stt: SpeechToTextProvider
  tts: TextToSpeechProvider
  /** Null when the speech recogniser says itself when somebody starts to speak. */
  turns: TurnDetectionProvider | null
  languages: string[]
  /** Builds the conversation of this call, given where its sentences go. */
  conversation: (output: CallConversationOptions['output']) => CallConversation
  /** Times of one exchange, for the record of how fast the call answers. Never what was said. */
  onTiming?: (timing: { heardToFirstSoundMs: number }) => void
  now?: () => number
  log?: (line: string) => void
}

export class VoiceEngine {
  private readonly conversation: CallConversation
  private stt: SpeechToTextSession | null = null
  private turns: TurnDetectionSession | null = null
  private queue: string[] = []
  private speaking: AbortController | null = null
  private pump: Promise<void> = Promise.resolve()
  private hangUpWhenSaid = false
  private over = false
  private heardAt: number | null = null
  private readonly now: () => number
  private readonly done: Promise<CallEndReason>
  private finish: (reason: CallEndReason) => void = () => undefined

  constructor(private readonly o: VoiceEngineOptions) {
    this.now = o.now ?? Date.now
    this.done = new Promise((resolve) => (this.finish = resolve))
    this.conversation = o.conversation({
      say: (sentence) => this.say(sentence),
      clear: () => this.clear(),
      hangUp: () => {
        this.hangUpWhenSaid = true
        this.kick()
      },
    })
  }

  /** Resolves when the call is over, with why. */
  get ended(): Promise<CallEndReason> {
    return this.done
  }

  /** The call is connected (answered by either side): listening starts and the conversation opens. */
  async start(): Promise<void> {
    const { call } = this.o
    call.onEnded((reason) => void this.close(reason))
    const heard = (text: string): void => {
      this.heardAt = this.now()
      void this.conversation.utterance(text)
    }
    const started = (): void => this.conversation.speechStarted()
    try {
      this.stt = this.o.stt.open(call.format, { speechStarted: started, utterance: heard, failed: () => this.fail('speech recognition stopped') }, { languages: this.o.languages })
      this.turns = this.o.turns?.open(call.format, { speechStarted: started, speechEnded: () => this.stt?.endOfTurn?.() }) ?? null
    } catch {
      this.fail('speech recognition could not start')
      return
    }
    call.onAudio((pcm) => {
      if (this.over) return
      try {
        this.turns?.push(pcm)
        this.stt?.push(pcm)
      } catch {
        this.fail('speech recognition stopped')
      }
    })
    call.onDigit((digit) => void this.conversation.digit(digit))
    await this.conversation.start()
  }

  /** Without ears the call cannot go on: it is ended rather than left open and deaf. */
  private fail(what: string): void {
    if (this.over) return
    this.o.log?.(`director-line: ${what}; the call is ended`)
    void this.o.call.hangUp().catch(() => undefined)
    void this.close('FAILED')
  }

  private say(sentence: string): void {
    if (this.over) return
    this.queue.push(sentence)
    this.kick()
  }

  private clear(): void {
    this.queue = []
    this.speaking?.abort()
    this.o.call.clearAudio()
  }

  /** Sentences are synthesized one after the other, so that they are heard in order. */
  private kick(): void {
    this.pump = this.pump.then(async () => {
      while (!this.over && this.queue.length > 0) {
        const sentence = this.queue.shift() as string
        const abort = new AbortController()
        this.speaking = abort
        let first = true
        try {
          await this.o.tts.speak(sentence, this.o.call.format, (pcm) => {
            if (abort.signal.aborted || this.over) return
            if (first && this.heardAt !== null) {
              this.o.onTiming?.({ heardToFirstSoundMs: this.now() - this.heardAt })
              this.heardAt = null
            }
            first = false
            this.o.call.sendAudio(pcm)
          }, abort.signal)
        } catch {
          // A sentence that could not be spoken is not a reason to end the call; the next one is tried.
          if (!abort.signal.aborted) this.o.log?.('director-line: a sentence could not be synthesized')
        }
        if (this.speaking === abort) this.speaking = null
      }
      if (this.hangUpWhenSaid && !this.over && this.queue.length === 0) {
        await this.o.call.drained().catch(() => undefined)
        await this.o.call.hangUp().catch(() => undefined)
        await this.close('LOCAL_HUNG_UP')
      }
    })
  }

  /** The call is over, whoever ended it. */
  async close(reason: CallEndReason): Promise<void> {
    if (this.over) return
    this.over = true
    this.queue = []
    this.speaking?.abort()
    try {
      this.stt?.close()
      this.turns?.close()
    } catch {
      // already gone
    }
    await this.conversation.close()
    this.finish(reason)
  }
}
