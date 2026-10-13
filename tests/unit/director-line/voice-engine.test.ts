import { describe, expect, it } from 'vitest'
import { CallConversation } from '@main/modules/director-line/call-conversation'
import { interpretMessage } from '@main/modules/director-line/intent'
import { VoiceEngine } from '@main/modules/director-line/voice-engine'
import type { CallEndReason, SpeechToTextProvider, TextToSpeechProvider, TurnDetectionProvider, VoiceCall } from '@main/modules/director-line/voice-provider'
import { VoiceSession } from '@main/modules/director-line/voice-session'

// 0.9.1: one call in sound, with a call, a recogniser and a synthesizer that are scripted. No audio device, no
// network, no model. "Sound" here is the sentence's own bytes, so that what was played can be read.
const OPERATOR = 'sip:user@sip.example.test'
const PIN = '482915'

function fakeCall(remote = OPERATOR) {
  const played: string[] = []
  const log: string[] = []
  let audio: (pcm: Buffer) => void = () => undefined
  let digit: (d: string) => void = () => undefined
  let ended: (r: CallEndReason) => void = () => undefined
  const call: VoiceCall = {
    id: 'c1',
    direction: 'INBOUND',
    remoteIdentity: remote,
    identityAssurance: 'TRANSPORT_AUTHENTICATED',
    format: { sampleRate: 16000 },
    answer: async () => void log.push('answer'),
    hangUp: async () => void log.push('hangUp'),
    sendAudio: (pcm) => void played.push(pcm.toString('utf8')),
    clearAudio: () => void log.push('clear'),
    drained: async () => void log.push('drained'),
    onAudio: (l) => (audio = l),
    onDigit: (l) => (digit = l),
    onEnded: (l) => (ended = l),
    security: () => ({ signalling: 'TLS', media: 'SRTP', endToEnd: false, peerVerified: false, sas: null }),
  }
  return { call, played, log, hear: (pcm: Buffer) => audio(pcm), press: (d: string) => digit(d), remoteHangUp: () => ended('REMOTE_HUNG_UP') }
}

function rig(over: { remote?: string; ttsDelayMs?: number; turns?: boolean; sttThrows?: boolean } = {}) {
  const c = fakeCall(over.remote)
  const heardPcm: Buffer[] = []
  let on: Parameters<SpeechToTextProvider['open']>[1] | null = null
  let turnOn: Parameters<TurnDetectionProvider['open']>[1] | null = null
  const closed: string[] = []
  let endOfTurns = 0
  const stt: SpeechToTextProvider = {
    kind: 'fake',
    local: true,
    open: (_format, handlers) => {
      if (over.sttThrows) throw new Error('no model')
      on = handlers
      return { push: (pcm) => void heardPcm.push(pcm), endOfTurn: () => void endOfTurns++, close: () => void closed.push('stt') }
    },
  }
  const aborted: string[] = []
  const tts: TextToSpeechProvider = {
    kind: 'fake',
    local: true,
    speak: async (text, _format, onAudio, signal) => {
      for (const word of text.split(' ')) {
        if (over.ttsDelayMs) await new Promise((r) => setTimeout(r, over.ttsDelayMs))
        if (signal.aborted) {
          aborted.push(text)
          return
        }
        onAudio(Buffer.from(`${word} `))
      }
    },
  }
  const turns: TurnDetectionProvider | null = over.turns ? { kind: 'fake', open: (_f, handlers) => ((turnOn = handlers), { push: () => undefined, close: () => void closed.push('turns') }) } : null
  const performed: string[] = []
  const timings: number[] = []
  const engine = new VoiceEngine({
    call: c.call,
    stt,
    tts,
    turns,
    languages: ['en', 'fr'],
    onTiming: (t) => timings.push(t.heardToFirstSoundMs),
    conversation: (output) =>
      new CallConversation({
        session: new VoiceSession(
          { callId: 'c1', direction: 'INBOUND', from: c.call.remoteIdentity },
          {
            authenticatePhone: async (from, pin) => (from !== OPERATOR ? 'WRONG_NUMBER' : pin === PIN ? 'OK' : 'WRONG_PIN'),
            isPairedNumber: async (from) => from === OPERATOR,
            interpret: async (text) => ({ text, command: await interpretMessage(text) }),
            perform: async ({ command }) => (performed.push(command.kind), 'RaceDeck is at 73 percent and it is verifying now.'),
            now: () => 1,
          },
        ),
        voice: null,
        generalFacts: async () => 'x',
        output,
      }),
  })
  const said = (): string => c.played.join('').trim()
  const settle = async (): Promise<void> => {
    // Until nothing more is played for a while: timers are coarse on Windows.
    let seen = -1
    while (seen !== c.played.length) {
      seen = c.played.length
      await new Promise((r) => setTimeout(r, over.ttsDelayMs ? 80 : 20))
    }
  }
  return { ...c, engine, said, settle, performed, heardPcm, closed, aborted, timings, utter: (t: string) => on?.utterance(t), sttStarted: () => on?.speechStarted?.(), sttFailed: () => on?.failed('gone'), turnStarted: () => turnOn?.speechStarted(), turnEnded: () => turnOn?.speechEnded(), endOfTurns: () => endOfTurns }
}

describe('a call in sound', () => {
  it('what is heard goes to recognition, what is said is synthesized and played in order', async () => {
    const w = rig()
    await w.engine.start()
    await w.settle()
    expect(w.said()).toBe('NEXUS Director. What is the PIN? You can say it or key it in, then press pound.')
    w.hear(Buffer.alloc(640))
    expect(w.heardPcm).toHaveLength(1)
    w.played.length = 0
    w.utter('four eight two nine one five')
    await w.settle()
    w.utter('what is the status')
    await w.settle()
    expect(w.said()).toBe('Thank you. What would you like to know? RaceDeck is at 73 percent and it is verifying now.')
    expect(w.timings).toHaveLength(2)
    w.remoteHangUp()
    expect(await w.engine.ended).toBe('REMOTE_HUNG_UP')
    expect(w.closed).toEqual(['stt'])
  })

  it('keys pressed reach the conversation', async () => {
    const w = rig()
    await w.engine.start()
    await w.settle()
    w.played.length = 0
    for (const d of `${PIN}#`) w.press(d)
    await w.settle()
    expect(w.said()).toBe('Thank you. What would you like to know?')
    w.remoteHangUp()
  })

  it('spoken over: the sentence being synthesized stops, what was queued in the call is cleared, and the next thing said is answered', async () => {
    const w = rig({ ttsDelayMs: 5, turns: true })
    await w.engine.start()
    await w.settle()
    w.utter('four eight two nine one five')
    await w.settle()
    w.played.length = 0
    w.log.length = 0
    w.utter('what is the status')
    await expect.poll(() => w.played.length).toBeGreaterThan(1)
    w.turnStarted()
    const cutAt = w.played.length
    await w.settle()
    expect(w.log).toContain('clear')
    expect(w.aborted).toEqual(['RaceDeck is at 73 percent and it is verifying now.'])
    expect(w.played.length).toBe(cutAt)
    w.turnEnded()
    expect(w.endOfTurns()).toBe(1)
    w.utter('what is the status')
    await w.settle()
    expect(w.played.slice(cutAt).join('').trim()).toBe('RaceDeck is at 73 percent and it is verifying now.')
    w.remoteHangUp()
    await w.engine.ended
    expect(w.closed).toEqual(['stt', 'turns'])
  })

  it('goodbye: the last sentence is played to its end, then the call is hung up', async () => {
    const w = rig({ ttsDelayMs: 2 })
    await w.engine.start()
    await w.settle()
    w.utter('four eight two nine one five')
    await w.settle()
    w.played.length = 0
    w.utter('goodbye')
    expect(await w.engine.ended).toBe('LOCAL_HUNG_UP')
    expect(w.said()).toBe('Goodbye.')
    expect(w.log.slice(-2)).toEqual(['drained', 'hangUp'])
  })

  it('an identity that is not paired hears one sentence and is hung up on', async () => {
    const w = rig({ remote: 'sip:stranger@elsewhere.test' })
    await w.engine.start()
    expect(await w.engine.ended).toBe('LOCAL_HUNG_UP')
    expect(w.said()).toBe('This number is not available. Goodbye.')
    expect(w.performed).toEqual([])
  })

  it('without ears the call is ended rather than left open: recognition that cannot start, or that stops', async () => {
    const deaf = rig({ sttThrows: true })
    await deaf.engine.start()
    expect(await deaf.engine.ended).toBe('FAILED')
    expect(deaf.log).toContain('hangUp')

    const w = rig()
    await w.engine.start()
    await w.settle()
    w.sttFailed()
    expect(await w.engine.ended).toBe('FAILED')
    expect(w.log).toContain('hangUp')
  })
})
