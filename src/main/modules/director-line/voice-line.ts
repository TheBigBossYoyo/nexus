import type { OperatorChannelKind, OperatorCommand } from '@shared/director-line'
import { CallConversation } from './call-conversation'
import type { DirectorVoice } from './director-voice'
import type { PhoneAuthResult } from './pairing'
import { VoiceEngine } from './voice-engine'
import type { CallEndReason, CallSecurity, DirectorVoiceProvider, SpeechToTextProvider, TextToSpeechProvider, TurnDetectionProvider, VoiceCall, VoiceProviderState } from './voice-provider'
import { VoiceSession } from './voice-session'

/**
 * 0.9.1: the Director's voice line. One provider carries calls; this decides which calls exist.
 *
 * A call that comes in and a call NEXUS places end in the same thing: one live conversation (a VoiceEngine).
 * There is no call that says a report and hangs up.
 *
 * - A call that comes in is taken only when it names the one paired identity. Any other caller is declined
 *   without being answered: it hears nothing, not even that this is NEXUS.
 * - An identity the transport only passes on (it did not establish it itself) is never enough: the PIN is asked
 *   whatever the owner chose.
 * - One call at a time. A second one is declined.
 * - NEXUS rings the operator once per reason, a limited number of times a day; unanswered, the report goes by
 *   message instead.
 */

export interface VoiceLinePolicy {
  /** Whether the paired identity alone is enough when the transport established it. */
  requirePin: boolean
  ringSeconds: number
  maxPlacedCallsPerDay: number
  /** Between two calls NEXUS places. */
  minMinutesBetweenPlacedCalls: number
}

export const DEFAULT_VOICE_LINE_POLICY: VoiceLinePolicy = { requirePin: true, ringSeconds: 30, maxPlacedCallsPerDay: 6, minMinutesBetweenPlacedCalls: 10 }

/** What is kept of a call: when, which way, how it ended, what was negotiated. Never what was said. */
export interface CallRecord {
  callId: string
  direction: 'INBOUND' | 'OUTBOUND'
  startedAt: string
  endedAt: string
  outcome: 'CONVERSATION' | 'DECLINED_UNPAIRED' | 'DECLINED_BUSY' | 'NO_ANSWER' | 'BUSY' | 'DECLINED' | 'FAILED' | 'SUPPRESSED'
  endReason: CallEndReason | null
  authenticated: boolean
  security: CallSecurity | null
  /** Median time from the end of what was said to the first sound of the answer, when it was measured. */
  medianAnswerMs: number | null
}

export interface VoiceLineOptions {
  channel: OperatorChannelKind
  provider: DirectorVoiceProvider
  stt: SpeechToTextProvider
  tts: TextToSpeechProvider
  turns: TurnDetectionProvider | null
  languages: string[]
  /** The paired identity of this channel, or null. */
  pairedIdentity: () => Promise<string | null>
  authenticate: (identity: string, pin: string | null) => Promise<PhoneAuthResult>
  interpret: (text: string) => Promise<{ text: string; command: OperatorCommand }>
  perform: (input: { from: string; callId: string; turnId: string; text: string; command: OperatorCommand; channel: OperatorChannelKind; transcript: string[] }) => Promise<string>
  generalFacts: () => Promise<string>
  /** A model session for one call, or null when none may be used now. */
  directorVoice: () => DirectorVoice | null
  policy: () => Promise<VoiceLinePolicy> | VoiceLinePolicy
  /** The report of a call that was not answered, sent by message instead. */
  fallback: (text: string) => Promise<void>
  record?: (call: CallRecord) => void
  onState?: (state: VoiceProviderState, detail?: string) => void
  now?: () => Date
  log?: (line: string) => void
}

export type PlaceResult = 'CONVERSATION' | 'NO_ANSWER' | 'BUSY' | 'DECLINED' | 'FAILED' | 'NOT_PAIRED' | 'LINE_BUSY' | 'NOT_REGISTERED' | 'SUPPRESSED'

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

export class DirectorVoiceLine {
  private active: { call: VoiceCall; engine: VoiceEngine } | null = null
  private placing = false
  private placed: number[] = []
  private readonly now: () => Date

  constructor(private readonly o: VoiceLineOptions) {
    this.now = o.now ?? (() => new Date())
  }

  async start(): Promise<void> {
    await this.o.provider.start({
      incoming: (call) => void this.incoming(call).catch(() => this.o.log?.('director-line: an incoming call could not be handled')),
      state: (state, detail) => this.o.onState?.(state, detail),
    })
  }

  async stop(): Promise<void> {
    await this.hangUp()
    await this.o.provider.stop()
  }

  get inCall(): boolean {
    return this.active !== null
  }

  state(): VoiceProviderState {
    return this.o.provider.state()
  }

  private async incoming(call: VoiceCall): Promise<void> {
    const startedAt = this.now().toISOString()
    const decline = async (outcome: CallRecord['outcome']): Promise<void> => {
      await call.hangUp().catch(() => undefined)
      this.o.record?.({ callId: call.id, direction: 'INBOUND', startedAt, endedAt: this.now().toISOString(), outcome, endReason: 'LOCAL_HUNG_UP', authenticated: false, security: null, medianAnswerMs: null })
    }
    const paired = await this.o.pairedIdentity()
    if (paired === null || call.remoteIdentity !== paired) {
      // Counted against that identity, so that the line cannot be probed without bound.
      await this.o.authenticate(call.remoteIdentity, null).catch(() => undefined)
      this.o.log?.('director-line: a call from an identity that is not paired was declined')
      return decline('DECLINED_UNPAIRED')
    }
    if (this.active !== null || this.placing) return decline('DECLINED_BUSY')
    // Reserved before the first await, so that two calls arriving together do not both get in.
    this.placing = true
    try {
      await call.answer()
    } catch {
      this.placing = false
      return decline('FAILED')
    }
    await this.converse(call, startedAt, undefined)
  }

  /**
   * Rings the operator. Resolves when the call was answered (the conversation then goes on by itself) or was
   * not. `report` is what the call is about: said first when answered, sent by message when not.
   */
  async callOperator(input: { report: string; reason: 'OPERATOR_ASKED' | 'EVENT' }): Promise<PlaceResult> {
    const paired = await this.o.pairedIdentity()
    if (paired === null) return 'NOT_PAIRED'
    if (this.active !== null || this.placing) return 'LINE_BUSY'
    if (this.o.provider.state() !== 'REGISTERED') {
      await this.fallback(input.report, 'the voice line is not connected')
      return 'NOT_REGISTERED'
    }
    const policy = await this.o.policy()
    const nowMs = this.now().getTime()
    this.placed = this.placed.filter((at) => nowMs - at < 24 * 3600_000)
    // The operator's own "call me" is not held back by the interval, only by the day's limit.
    const tooSoon = input.reason === 'EVENT' && this.placed.some((at) => nowMs - at < policy.minMinutesBetweenPlacedCalls * 60_000)
    if (this.placed.length >= policy.maxPlacedCallsPerDay || tooSoon) {
      await this.fallback(input.report, null)
      this.o.record?.({ callId: '', direction: 'OUTBOUND', startedAt: this.now().toISOString(), endedAt: this.now().toISOString(), outcome: 'SUPPRESSED', endReason: null, authenticated: false, security: null, medianAnswerMs: null })
      return 'SUPPRESSED'
    }
    this.placing = true
    this.placed.push(nowMs)
    const startedAt = this.now().toISOString()
    let result
    try {
      result = await this.o.provider.placeCall(paired, { ringSeconds: policy.ringSeconds })
    } catch {
      result = { outcome: 'FAILED' as const }
    }
    if (result.outcome !== 'ANSWERED') {
      this.placing = false
      this.o.record?.({ callId: '', direction: 'OUTBOUND', startedAt, endedAt: this.now().toISOString(), outcome: result.outcome, endReason: null, authenticated: false, security: null, medianAnswerMs: null })
      // One attempt. What the call was for is not lost: it goes by message.
      await this.fallback(input.report, 'I called and there was no answer')
      return result.outcome
    }
    void this.converse(result.call, startedAt, input.report).catch(() => this.o.log?.('director-line: a placed call ended badly'))
    return 'CONVERSATION'
  }

  private async fallback(report: string, why: string | null): Promise<void> {
    const text = report.trim()
    if (text === '' && why === null) return
    try {
      await this.o.fallback(why === null ? text : text === '' ? `NEXUS: ${why}.` : `NEXUS: ${why}. ${text}`)
    } catch {
      this.o.log?.('director-line: the message that replaces a call could not be sent')
    }
  }

  private async converse(call: VoiceCall, startedAt: string, report: string | undefined): Promise<void> {
    const policy = await this.o.policy()
    const timings: number[] = []
    let conversation: CallConversation | null = null
    const session = new VoiceSession(
      // An identity the transport did not establish itself never does without the PIN.
      { callId: call.id, direction: call.direction, from: call.remoteIdentity, ...(report !== undefined ? { report } : {}), requirePin: policy.requirePin || call.identityAssurance !== 'TRANSPORT_AUTHENTICATED' },
      {
        authenticatePhone: (from, pin) => this.o.authenticate(from, pin),
        isPairedNumber: async (from) => from === (await this.o.pairedIdentity()),
        interpret: (text) => this.o.interpret(text),
        perform: (input) => this.o.perform({ ...input, channel: this.o.channel, transcript: (conversation?.transcript() ?? []).map((l) => `${l.who === 'OPERATOR' ? 'Operator' : 'NEXUS'}: ${l.text}`) }),
        now: () => this.now().getTime(),
        note: (what) => this.o.log?.(`director-line: ${what}`),
      },
    )
    const engine = new VoiceEngine({
      call,
      stt: this.o.stt,
      tts: this.o.tts,
      turns: this.o.turns,
      languages: this.o.languages,
      onTiming: (t) => timings.push(t.heardToFirstSoundMs),
      ...(this.o.log ? { log: this.o.log } : {}),
      conversation: (output) => {
        conversation = new CallConversation({ session, voice: this.o.directorVoice(), generalFacts: this.o.generalFacts, output, ...(this.o.log ? { log: this.o.log } : {}) })
        return conversation
      },
    })
    this.active = { call, engine }
    this.placing = false
    await engine.start()
    const endReason = await engine.ended
    // Read when the call is over: what was negotiated in the end (a key exchange finishes after the call is up),
    // not what was asked for.
    let security: CallSecurity | null
    try {
      security = call.security()
    } catch {
      security = null
    }
    if (this.active?.engine === engine) this.active = null
    this.o.record?.({ callId: call.id, direction: call.direction, startedAt, endedAt: this.now().toISOString(), outcome: 'CONVERSATION', endReason, authenticated: session.isAuthenticated, security, medianAnswerMs: median(timings) })
  }

  /** Ends the call in progress, if any (the owner pressed "hang up" on the PC, or the line is being turned off). */
  async hangUp(): Promise<void> {
    const active = this.active
    if (!active) return
    await active.call.hangUp().catch(() => undefined)
    await active.engine.close('LOCAL_HUNG_UP')
  }
}
