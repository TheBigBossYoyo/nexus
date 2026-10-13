import { describe, expect, it } from 'vitest'
import { interpretMessage } from '@main/modules/director-line/intent'
import { DEFAULT_VOICE_LINE_POLICY, DirectorVoiceLine, type CallRecord, type VoiceLinePolicy } from '@main/modules/director-line/voice-line'
import { normalizeSipIdentity, type CallEndReason, type DirectorVoiceProvider, type PlacedCall, type SpeechToTextProvider, type TextToSpeechProvider, type VoiceCall, type VoiceProviderState } from '@main/modules/director-line/voice-provider'

// 0.9.1: the Director's voice line with a scripted provider, recogniser and synthesizer. No SIP, no sound, no model.
const OPERATOR = 'sip:user@sip.example.test'
const PIN = '482915'

function fakeCall(direction: 'INBOUND' | 'OUTBOUND', remote: string, assurance: VoiceCall['identityAssurance'] = 'TRANSPORT_AUTHENTICATED') {
  const played: string[] = []
  const log: string[] = []
  let ended: (r: CallEndReason) => void = () => undefined
  const call: VoiceCall = {
    id: `call-${Math.random().toString(36).slice(2, 8)}`,
    direction,
    remoteIdentity: remote,
    identityAssurance: assurance,
    format: { sampleRate: 16000 },
    answer: async () => void log.push('answer'),
    hangUp: async () => void log.push('hangUp'),
    sendAudio: (pcm) => void played.push(pcm.toString('utf8')),
    clearAudio: () => undefined,
    drained: async () => undefined,
    onAudio: () => undefined,
    onDigit: () => undefined,
    onEnded: (l) => (ended = l),
    security: () => ({ signalling: 'TLS', media: 'SRTP', endToEnd: false }),
  }
  return { call, played, log, said: () => played.join('').trim(), remoteHangUp: () => ended('REMOTE_HUNG_UP') }
}

function rig(over: { paired?: string | null; policy?: Partial<VoiceLinePolicy>; placed?: () => PlacedCall; state?: VoiceProviderState } = {}) {
  let incoming: (call: VoiceCall) => void = () => undefined
  let utter: (text: string) => void = () => undefined
  let nowMs = Date.parse('2026-10-14T08:00:00Z')
  const placedTo: string[] = []
  const provider: DirectorVoiceProvider = {
    kind: 'fake',
    start: async (on) => void (incoming = on.incoming),
    stop: async () => undefined,
    state: () => over.state ?? 'REGISTERED',
    placeCall: async (to) => (placedTo.push(to), over.placed ? over.placed() : { outcome: 'NO_ANSWER' }),
  }
  const stt: SpeechToTextProvider = { kind: 'fake', local: true, open: (_f, on) => ((utter = on.utterance), { push: () => undefined, close: () => undefined }) }
  const tts: TextToSpeechProvider = { kind: 'fake', local: true, speak: async (text, _f, onAudio) => onAudio(Buffer.from(`${text} `)) }
  const records: CallRecord[] = []
  const messages: string[] = []
  const performed: { kind: string; channel: string; transcript: string[] }[] = []
  const authTried: string[] = []
  const line = new DirectorVoiceLine({
    channel: 'SIP_VOICE',
    provider,
    stt,
    tts,
    turns: null,
    languages: ['en'],
    pairedIdentity: async () => (over.paired === undefined ? OPERATOR : over.paired),
    authenticate: async (identity, pin) => (authTried.push(identity), identity !== OPERATOR ? 'WRONG_NUMBER' : pin === PIN ? 'OK' : 'WRONG_PIN'),
    interpret: async (text) => ({ text, command: await interpretMessage(text) }),
    perform: async (input) => (performed.push({ kind: input.command.kind, channel: input.channel, transcript: input.transcript }), 'RaceDeck is at 73 percent.'),
    generalFacts: async () => 'x',
    directorVoice: () => null,
    policy: () => ({ ...DEFAULT_VOICE_LINE_POLICY, ...over.policy }),
    fallback: async (text) => void messages.push(text),
    record: (r) => records.push(r),
    now: () => new Date(nowMs),
  })
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25))
  return { line, records, messages, performed, placedTo, authTried, settle, ring: (c: VoiceCall) => incoming(c), utter: (t: string) => utter(t), advanceMinutes: (m: number) => (nowMs += m * 60_000) }
}

describe('a SIP address in one form', () => {
  it('two spellings of one account are equal, and what is not an address is nothing', () => {
    expect(normalizeSipIdentity('sip:user@SIP.example.test')).toBe(OPERATOR)
    expect(normalizeSipIdentity('"NEXUS" <sip:user@sip.example.test;transport=tls>')).toBe(OPERATOR)
    expect(normalizeSipIdentity('user@sip.example.test:5061')).toBe(OPERATOR)
    expect(normalizeSipIdentity('sip:user@sip.example.test.evil.test')).toBe('sip:user@sip.example.test.evil.test')
    expect(normalizeSipIdentity('sip:user@sip.example.test@evil.test')).toBeNull()
    expect(normalizeSipIdentity('"sip:user@sip.example.test" <sip:mallory@evil.test>')).toBe('sip:mallory@evil.test')
    expect(normalizeSipIdentity('user')).toBeNull()
    expect(normalizeSipIdentity('sip:you ssef@x.test')).toBeNull()
    expect(normalizeSipIdentity('')).toBeNull()
  })
})

describe('calls that come in', () => {
  it('the paired identity is answered and gets a conversation; a task said on the call carries the call\'s transcript', async () => {
    const w = rig()
    await w.line.start()
    const c = fakeCall('INBOUND', OPERATOR)
    w.ring(c.call)
    await w.settle()
    expect(c.log).toEqual(['answer'])
    expect(c.said()).toContain('What is the PIN?')
    w.utter('four eight two nine one five')
    await w.settle()
    w.utter('what is the status')
    await w.settle()
    w.utter('after this add improve the telemetry panel')
    await w.settle()
    w.utter('yes')
    await w.settle()
    expect(w.performed.map((p) => p.kind)).toEqual(['STATUS', 'ADD_TASK_AFTER_CURRENT'])
    expect(w.performed[1]?.channel).toBe('SIP_VOICE')
    expect(w.performed[1]?.transcript).toContain('Operator: after this add improve the telemetry panel')
    expect(w.performed[1]?.transcript.join(' ')).not.toContain('four eight')
    expect(w.line.inCall).toBe(true)
    c.remoteHangUp()
    await w.settle()
    expect(w.line.inCall).toBe(false)
    expect(w.records).toHaveLength(1)
    expect(w.records[0]).toMatchObject({ direction: 'INBOUND', outcome: 'CONVERSATION', endReason: 'REMOTE_HUNG_UP', authenticated: true, security: { signalling: 'TLS', media: 'SRTP', endToEnd: false } })
    expect(JSON.stringify(w.records)).not.toContain('telemetry')
  })

  it('any other caller is declined without being answered: it hears nothing', async () => {
    const w = rig()
    await w.line.start()
    const c = fakeCall('INBOUND', 'sip:mallory@evil.test')
    w.ring(c.call)
    await w.settle()
    expect(c.log).toEqual(['hangUp'])
    expect(c.played).toEqual([])
    expect(w.records[0]?.outcome).toBe('DECLINED_UNPAIRED')
    expect(w.authTried).toEqual(['sip:mallory@evil.test'])
    expect(w.performed).toEqual([])

    const nobody = rig({ paired: null })
    await nobody.line.start()
    const d = fakeCall('INBOUND', OPERATOR)
    nobody.ring(d.call)
    await nobody.settle()
    expect(d.log).toEqual(['hangUp'])
  })

  it('one call at a time: a second one is declined', async () => {
    const w = rig()
    await w.line.start()
    const first = fakeCall('INBOUND', OPERATOR)
    const second = fakeCall('INBOUND', OPERATOR)
    w.ring(first.call)
    w.ring(second.call)
    await w.settle()
    expect(first.log).toEqual(['answer'])
    expect(second.log).toEqual(['hangUp'])
    expect(w.records.map((r) => r.outcome)).toEqual(['DECLINED_BUSY'])
    first.remoteHangUp()
  })

  it('where the owner chose that the paired identity is enough, it is, but never for an identity the transport only passes on', async () => {
    const w = rig({ policy: { requirePin: false } })
    await w.line.start()
    const trusted = fakeCall('INBOUND', OPERATOR)
    w.ring(trusted.call)
    await w.settle()
    expect(trusted.said()).toBe('NEXUS Director. What would you like to know?')
    trusted.remoteHangUp()
    await w.settle()

    const claimed = fakeCall('INBOUND', OPERATOR, 'CLAIMED')
    w.ring(claimed.call)
    await w.settle()
    expect(claimed.said()).toContain('What is the PIN?')
    w.utter('what is the status')
    await w.settle()
    expect(w.performed).toEqual([])
    claimed.remoteHangUp()
  })
})

describe('calls NEXUS places', () => {
  it('answered, it is the same conversation: the report is said and the call goes on', async () => {
    const c = fakeCall('OUTBOUND', OPERATOR)
    const w = rig({ placed: () => ({ outcome: 'ANSWERED', call: c.call }) })
    await w.line.start()
    expect(await w.line.callOperator({ report: 'RaceDeck is complete.', reason: 'EVENT' })).toBe('CONVERSATION')
    await w.settle()
    expect(w.placedTo).toEqual([OPERATOR])
    expect(c.said()).toContain('This is NEXUS. RaceDeck is complete.')
    w.utter('4 8 2 9 1 5')
    await w.settle()
    w.utter('what is the status')
    await w.settle()
    expect(w.performed.map((p) => p.kind)).toEqual(['STATUS'])
    expect(w.messages).toEqual([])
    c.remoteHangUp()
    await w.settle()
    expect(w.records[0]).toMatchObject({ direction: 'OUTBOUND', outcome: 'CONVERSATION', authenticated: true })
  })

  it('not answered: one attempt, then the report goes by message', async () => {
    const w = rig()
    await w.line.start()
    expect(await w.line.callOperator({ report: 'RaceDeck is blocked.', reason: 'EVENT' })).toBe('NO_ANSWER')
    expect(w.placedTo).toHaveLength(1)
    expect(w.messages).toEqual(['NEXUS: I called and there was no answer. RaceDeck is blocked.'])
    expect(w.records[0]?.outcome).toBe('NO_ANSWER')
    expect(w.line.inCall).toBe(false)
  })

  it('does not ring again and again: events are spaced, the day has a limit, and what was not called about goes by message', async () => {
    const w = rig({ policy: { maxPlacedCallsPerDay: 3, minMinutesBetweenPlacedCalls: 10 } })
    await w.line.start()
    await w.line.callOperator({ report: 'one', reason: 'EVENT' })
    expect(await w.line.callOperator({ report: 'two', reason: 'EVENT' })).toBe('SUPPRESSED')
    expect(w.messages.at(-1)).toBe('two')
    // The operator's own "call me" is not held back by the interval.
    expect(await w.line.callOperator({ report: '', reason: 'OPERATOR_ASKED' })).toBe('NO_ANSWER')
    w.advanceMinutes(11)
    await w.line.callOperator({ report: 'three', reason: 'EVENT' })
    w.advanceMinutes(11)
    expect(await w.line.callOperator({ report: 'four', reason: 'OPERATOR_ASKED' })).toBe('SUPPRESSED')
    expect(w.placedTo).toHaveLength(3)
    w.advanceMinutes(24 * 60)
    expect(await w.line.callOperator({ report: 'five', reason: 'EVENT' })).toBe('NO_ANSWER')
  })

  it('nobody paired, the line busy, or not connected: no call is placed', async () => {
    const unpaired = rig({ paired: null })
    await unpaired.line.start()
    expect(await unpaired.line.callOperator({ report: 'x', reason: 'EVENT' })).toBe('NOT_PAIRED')
    expect(unpaired.placedTo).toEqual([])

    const offline = rig({ state: 'UNREACHABLE' })
    await offline.line.start()
    expect(await offline.line.callOperator({ report: 'RaceDeck is complete.', reason: 'EVENT' })).toBe('NOT_REGISTERED')
    expect(offline.messages).toEqual(['NEXUS: the voice line is not connected. RaceDeck is complete.'])

    const busy = rig()
    await busy.line.start()
    const c = fakeCall('INBOUND', OPERATOR)
    busy.ring(c.call)
    await busy.settle()
    expect(await busy.line.callOperator({ report: 'x', reason: 'EVENT' })).toBe('LINE_BUSY')
    expect(busy.placedTo).toEqual([])
    await busy.line.hangUp()
    expect(c.log).toEqual(['answer', 'hangUp'])
    await busy.settle()
    expect(busy.line.inCall).toBe(false)
  })
})
