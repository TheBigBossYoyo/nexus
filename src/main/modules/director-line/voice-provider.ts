/**
 * 0.9.1: what carries a call with the Director, and what turns sound into words and words into sound, as
 * interfaces. The conversation (voice-session, director-voice, call-conversation) knows none of them, and none
 * of them knows the conversation: a provider is transport and media only. It gets no project file, no model
 * credential and no way to act on NEXUS; it hands over sound and takes sound.
 *
 * Sound is always signed 16-bit little-endian PCM, one channel, at the rate the call states.
 */

export interface AudioFormat {
  sampleRate: 8000 | 16000 | 24000 | 48000
}

/**
 * A SIP address in one normal form, `sip:user@domain` in lower case, or null when the text is not one. A display
 * name, angle brackets, a port and parameters are dropped: two spellings of one account compare equal, and
 * nothing a caller can add to its address changes which account it names.
 */
export function normalizeSipIdentity(text: string): string | null {
  const inner = /<([^<>]*)>/.exec(text)?.[1] ?? text
  const m = /^\s*(?:sips?:)?([a-z0-9._+~-]{1,64})@([a-z0-9.-]{1,253})(?::\d{1,5})?(?:;[^\s]*)?\s*$/i.exec(inner)
  if (!m) return null
  const domain = (m[2] as string).toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null
  return `sip:${(m[1] as string).toLowerCase()}@${domain}`
}

export type CallEndReason = 'REMOTE_HUNG_UP' | 'LOCAL_HUNG_UP' | 'NETWORK_LOST' | 'FAILED'

/** What was really negotiated for one call, as the transport reports it. UNKNOWN is said rather than assumed. */
export interface CallSecurity {
  /** TLS is the hop to the SIP server only: it says nothing about the other end of the call. */
  signalling: 'TLS' | 'NONE' | 'UNKNOWN'
  media: 'SRTP' | 'ZRTP' | 'DTLS_SRTP' | 'NONE' | 'UNKNOWN'
  /**
   * True ONLY for ZRTP whose short authentication string was verified (by a person comparing it with the other
   * telephone's, or by the retained secrets of an earlier verified call). SRTP keys are known to the SIP server, and
   * the DTLS-SRTP fingerprints travel through it, so neither is ever end to end. ZRTP not yet verified is encrypted,
   * but whoever sits between the two ends could still be one of them.
   */
  endToEnd: boolean
  /** Whether the other end was verified: the ZRTP string was compared, or matched the retained secrets. */
  peerVerified: boolean
  /** The ZRTP short authentication string to compare with the one the other telephone shows; null when there is none. */
  sas: string | null
}

export interface VoiceCall {
  /** Unique across restarts of the transport: call records and the keys of confirmed commands are made of it. */
  readonly id: string
  readonly direction: 'INBOUND' | 'OUTBOUND'
  /** The other party as the transport names it, in one normal form (for SIP: `sip:user@domain`, lower case, no parameters). */
  readonly remoteIdentity: string
  /**
   * Whether the transport itself established that identity (an account its server authenticated) or only passes
   * on what the caller claimed. A claimed identity opens nothing by itself.
   */
  readonly identityAssurance: 'TRANSPORT_AUTHENTICATED' | 'CLAIMED'
  readonly format: AudioFormat
  /** Takes an incoming call. Nothing is heard or said before it. */
  answer(): Promise<void>
  hangUp(): Promise<void>
  /** Queues sound to be played to the other party, in order, at the pace of speech. */
  sendAudio(pcm: Buffer): void
  /** Drops what is queued and stops what is playing. */
  clearAudio(): void
  /** Resolves when everything queued has been played (or was cleared). */
  drained(): Promise<void>
  onAudio(listener: (pcm: Buffer) => void): void
  onDigit(listener: (digit: string) => void): void
  /** Called once. */
  onEnded(listener: (reason: CallEndReason) => void): void
  security(): CallSecurity
  /**
   * The person compared the ZRTP string with the other telephone's and it matched: the transport keeps that, so that
   * later calls with the same peer are known by their keys. Absent on a transport that has no such string.
   */
  confirmSas?(): void
}

export type VoiceProviderState = 'STOPPED' | 'CONNECTING' | 'REGISTERED' | 'UNREACHABLE' | 'REJECTED'

export type PlacedCall =
  | { outcome: 'ANSWERED'; call: VoiceCall }
  /** LINE_BUSY: the transport already has a call, so nobody was rung. */
  | { outcome: 'NO_ANSWER' | 'BUSY' | 'DECLINED' | 'FAILED' | 'LINE_BUSY'; reason?: string }

export interface DirectorVoiceProvider {
  readonly kind: string
  start(on: { incoming(call: VoiceCall): void; state(state: VoiceProviderState, detail?: string): void }): Promise<void>
  stop(): Promise<void>
  state(): VoiceProviderState
  /** Rings the other party once, for at most `ringSeconds`. Resolves when it is answered or was not. */
  placeCall(to: string, options: { ringSeconds: number }): Promise<PlacedCall>
}

export interface SpeechToTextSession {
  push(pcm: Buffer): void
  /** The speaker stopped (from turn detection): what was heard so far is to be given now. */
  endOfTurn?(): void
  close(): void
}

export interface SpeechToTextProvider {
  readonly kind: string
  /** Whether sound leaves the PC for it. Shown to the owner. */
  readonly local: boolean
  open(format: AudioFormat, on: { speechStarted?(): void; utterance(text: string): void; failed(reason: string): void }, options: { languages: string[] }): SpeechToTextSession
}

export interface TextToSpeechProvider {
  readonly kind: string
  readonly local: boolean
  /** Synthesizes one sentence, giving sound as it is made. Stops, without an error, when the signal aborts. */
  speak(text: string, format: AudioFormat, onAudio: (pcm: Buffer) => void, signal: AbortSignal): Promise<void>
}

export interface TurnDetectionSession {
  push(pcm: Buffer): void
  close(): void
}

/** Says when somebody starts and stops speaking. A speech recogniser that does this itself needs none. */
export interface TurnDetectionProvider {
  readonly kind: string
  open(format: AudioFormat, on: { speechStarted(): void; speechEnded(): void }): TurnDetectionSession
}
