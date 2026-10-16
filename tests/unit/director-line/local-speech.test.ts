import { describe, expect, it } from 'vitest'
import { chunkPcm, floatToPcm16, pcm16ToFloat, resampleWhole, Resampler, rms, trimLeadingSilence } from '@main/modules/director-line/local-speech-audio'
import { pickResult, TurnMachine, type RecognizerPort, type StreamPort, type VadPort } from '@main/modules/director-line/local-speech-core'
import { LocalSpeech, LocalSpeechToText, LocalTextToSpeech, type VoicePort } from '@main/modules/director-line/local-speech'
import { missingModelFiles } from '@main/modules/director-line/local-speech-models'
import {
  serveStt,
  WorkerSttBackend,
  type SttBackend,
  type HostToWorker,
  type PortLike,
  type WorkerLike,
  type WorkerToHost,
} from '@main/modules/director-line/local-speech-protocol'
import { guessLanguage, normalizeForSpeech, snapToHints, spokenDigits, splitClauses } from '@main/modules/director-line/local-speech-text'

// 0.9.1, local speech: the parts that need no model. Language guess, text for a voice, resampling, the turn
// state machine with a scripted VAD and recogniser, abortable synthesis with a scripted voice, and the worker
// protocol over an in-memory pair of ports.

describe('guessLanguage', () => {
  it('tells English from French on whole sentences', () => {
    expect(guessLanguage('How is RaceDeck going?')).toBe('en')
    expect(guessLanguage('What is blocking it?')).toBe('en')
    expect(guessLanguage('Comment avance le projet ?')).toBe('fr')
    expect(guessLanguage("Qu'est-ce qui bloque ?")).toBe('fr')
    expect(guessLanguage("J'ai lancé la compilation et je vous préviens dès que les tests sont terminés.")).toBe('fr')
    expect(guessLanguage('I have started the build and will tell you as soon as the tests finish running.')).toBe('en')
  })
  it('reads digit words in the language they are in', () => {
    expect(guessLanguage('quatre huit deux neuf un cinq')).toBe('fr')
    expect(guessLanguage('four eight two nine one five')).toBe('en')
  })
  it('falls back to the first language of the call when there is no evidence', () => {
    expect(guessLanguage('RaceDeck', ['fr', 'en'])).toBe('fr')
    expect(guessLanguage('RaceDeck', ['en', 'fr'])).toBe('en')
    expect(guessLanguage('Bonjour', ['en'])).toBe('en')
  })
})

describe('normalizeForSpeech', () => {
  it('says percentages and ranges and keeps every figure', () => {
    expect(normalizeForSpeech('Tests are 85% done, 25–40 min left.', 'en')).toBe('Tests are 85 percent done, 25 to 40 minutes left.')
    expect(normalizeForSpeech('Il reste 25–40 min, 85 % fait.', 'fr')).toBe('Il reste 25 à 40 minutes, 85 pour cent fait.')
    expect(normalizeForSpeech('About 25-40 min', 'en')).toBe('About 25 to 40 minutes')
    expect(normalizeForSpeech('1 min', 'en')).toBe('1 minute')
    expect(normalizeForSpeech('12.5% of 3,5', 'en')).toBe('12.5 percent of 3,5')
  })
  it('does not turn a hyphen between numbers into a range unless a unit follows', () => {
    expect(normalizeForSpeech('call 555-1234 or build 12-3', 'en')).toBe('call 555-1234 or build 12-3')
  })
  it('says ISO dates and times', () => {
    expect(normalizeForSpeech('Done at 14:30.', 'en')).toBe('Done at 14 30.')
    expect(normalizeForSpeech('Fini à 14:30.', 'fr')).toBe('Fini à 14 heures 30.')
    expect(normalizeForSpeech('At 09:05', 'en')).toBe('At 9 oh 5')
    expect(normalizeForSpeech('On 2026-10-13', 'en')).toBe('On October 13, 2026')
    expect(normalizeForSpeech('Le 2026-10-13T14:30:00Z', 'fr')).toBe('Le 13 octobre 2026 à 14 heures 30')
    // Not a date or time: left alone.
    expect(normalizeForSpeech('ratio 3:2:1, version 2026-13-45', 'en')).toBe('ratio 3:2:1, version 2026-13-45')
  })
  it('removes markup that has no sound and keeps names with underscores', () => {
    expect(normalizeForSpeech('**Done**: see `main_branch`', 'en')).toBe('Done: see main_branch')
    expect(normalizeForSpeech('See https://example.com/a?b=1 now', 'en')).toBe('See a link now')
  })
})

describe('splitClauses', () => {
  it('leaves a short sentence whole', () => {
    expect(splitClauses('How is it going, then?')).toEqual(['How is it going, then?'])
  })
  it('cuts a long sentence at clause boundaries, never into fragments', () => {
    const s = 'I have started the build, and I will tell you as soon as the tests finish running, then I will wait for your answer, ok?'
    const parts = splitClauses(s)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join(' ')).toBe(s)
    expect(parts[0]!.length).toBeLessThan(40)
    for (const p of parts.slice(1)) expect(p.length).toBeGreaterThanOrEqual(28)
    expect(parts[0]!.length).toBeLessThan(90)
  })
  it('leaves a long sentence with no clause boundary whole', () => {
    const s = 'word '.repeat(40).trim()
    expect(splitClauses(s)).toEqual([s])
  })
})

describe('snapToHints', () => {
  it('writes a name as it is spelled when the words run together are the name', () => {
    expect(snapToHints('how is race deck going', ['RaceDeck'])).toBe('how is RaceDeck going')
    expect(snapToHints('How is Race Deck, and', ['RaceDeck'])).toBe('How is RaceDeck, and')
    expect(snapToHints('what about rase deck', ['RaceDeck'])).toBe('what about RaceDeck')
    expect(snapToHints("how is Ray's deck going", ['RaceDeck'])).toBe('how is RaceDeck going')
    expect(snapToHints('the face check is red', ['RaceDeck'])).toBe('the face check is red')
  })
  it('changes nothing else', () => {
    expect(snapToHints('pause after the current task', ['RaceDeck'])).toBe('pause after the current task')
    expect(snapToHints('hello', [])).toBe('hello')
    expect(snapToHints('the deck is on the race', ['RaceDeck'])).toBe('the deck is on the race')
  })
})

describe('spokenDigits', () => {
  it('reads digit words, including near-homophones inside a run', () => {
    expect(spokenDigits('four eight two nine one five')).toBe('482915')
    expect(spokenDigits('for eight two nine one five')).toBe('482915')
    expect(spokenDigits('quatre huit deux neuf un cinq')).toBe('482915')
    expect(spokenDigits('Quatre huit de neuf un cinq.')).toBe('482915')
  })
  it('is null when any word is not a digit or the run is short', () => {
    expect(spokenDigits('four eight two nine one five please')).toBeNull()
    expect(spokenDigits('four eight')).toBeNull()
    expect(spokenDigits('for the win')).toBeNull()
  })
})

describe('audio', () => {
  const tone = (hz: number, rate: number, seconds: number): Float32Array => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate))
  const gainDb = (hz: number, inRate: number, outRate: number): number => {
    const out = resampleWhole(tone(hz, inRate, 0.5), inRate, outRate)
    // The first and last 10 ms hold the filter's edges.
    const edge = Math.round(outRate / 100)
    const mid = out.subarray(edge, out.length - edge)
    return 20 * Math.log10(rms(mid) / (0.5 / Math.SQRT2))
  }

  it('keeps the energy of a tone in the band, across a sweep, 22050 to 16000', () => {
    for (const hz of [200, 500, 1000, 2000, 3500, 5000, 6500]) {
      expect(Math.abs(gainDb(hz, 22050, 16000)), `${hz} Hz`).toBeLessThan(0.5)
    }
  })
  it('removes what lies above the new Nyquist frequency instead of folding it back', () => {
    // 9 kHz at 22050 Hz would fold to 7 kHz at 16000 Hz if samples were just dropped.
    expect(gainDb(9000, 22050, 16000)).toBeLessThan(-50)
    expect(gainDb(10500, 22050, 16000)).toBeLessThan(-50)
    // 48000 to 16000: 12 kHz must go, 3 kHz must stay.
    expect(gainDb(12000, 48000, 16000)).toBeLessThan(-50)
    expect(Math.abs(gainDb(3000, 48000, 16000))).toBeLessThan(0.5)
    // 16000 to 8000 (telephone): 6 kHz must go.
    expect(gainDb(6000, 16000, 8000)).toBeLessThan(-50)
    expect(Math.abs(gainDb(1000, 16000, 8000))).toBeLessThan(0.5)
  })
  it('gives the right number of samples and the same result in pieces as in one', () => {
    const x = tone(440, 22050, 1.0)
    const whole = resampleWhole(x, 22050, 16000)
    expect(Math.abs(whole.length - 16000)).toBeLessThanOrEqual(2)
    const r = new Resampler(22050, 16000)
    const parts: Float32Array[] = []
    for (let i = 0; i < x.length; i += 441) parts.push(r.process(x.subarray(i, Math.min(x.length, i + 441))))
    parts.push(r.flush())
    const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      joined.set(p, at)
      at += p.length
    }
    expect(Math.abs(joined.length - whole.length)).toBeLessThanOrEqual(1)
    let worst = 0
    for (let i = 0; i < Math.min(whole.length, joined.length); i += 1) worst = Math.max(worst, Math.abs((joined[i] as number) - (whole[i] as number)))
    expect(worst).toBeLessThan(1e-4)
  })
  it('goes up as well (16000 to 24000) and passes the same rate through', () => {
    expect(Math.abs(gainDb(2000, 16000, 24000))).toBeLessThan(0.5)
    const x = tone(100, 16000, 0.1)
    expect(resampleWhole(x, 16000, 16000)).toBe(x)
  })
  it('converts PCM both ways without loss beyond one step', () => {
    const x = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.123])
    const back = pcm16ToFloat(floatToPcm16(x))
    for (let i = 0; i < x.length; i += 1) expect(Math.abs((back[i] as number) - (x[i] as number))).toBeLessThan(1 / 16384)
  })
  it('trims the silence at the start and keeps a little before the onset', () => {
    const rate = 16000
    const s = new Float32Array(rate)
    for (let i = 8000; i < 8400; i += 1) s[i] = 0.3
    const t = trimLeadingSilence(s, rate, { keepMs: 10 })
    expect(t.length).toBe(rate - 8000 + 160)
    expect(trimLeadingSilence(new Float32Array(100), rate).length).toBe(0)
  })
  it('cuts PCM into pieces of at most 100 ms, each a whole number of samples', () => {
    const pcm = Buffer.alloc(16000 * 2 * 0.35)
    const pieces = chunkPcm(pcm, 16000, 100)
    expect(pieces.map((p) => p.length)).toEqual([3200, 3200, 3200, 1600])
    for (const p of chunkPcm(Buffer.alloc(24000 * 2), 24000)) expect(p.length).toBeLessThanOrEqual(4800)
  })
})

// ---- the turn machine with a scripted VAD and recogniser ----------------------------------------------------------

const FRAME = 320

/** A VAD that holds speech exactly on the frames the script says (by index of the frame). */
function scriptedVad(speechFrames: (i: number) => boolean): VadPort & { fed: number } {
  const vad = {
    fed: 0,
    accept: () => {
      vad.fed += 1
    },
    detected: () => speechFrames(vad.fed - 1),
  }
  return vad
}

function scriptedRecognizer(lang: 'en' | 'fr', text: (samples: number) => string, meanLogProb = -0.3): RecognizerPort & { opened: number; samplesPerStream: number[] } {
  const r = {
    lang,
    opened: 0,
    samplesPerStream: [] as number[],
    open(): StreamPort {
      r.opened += 1
      let n = 0
      const idx = r.samplesPerStream.push(0) - 1
      return {
        accept: (s) => {
          n += s.length
          r.samplesPerStream[idx] = n
        },
        finish: () => ({ text: text(n), meanLogProb, tokens: text(n).split(' ').length }),
      }
    },
  }
  return r
}

describe('TurnMachine', () => {
  const run = (frames: number, m: TurnMachine): void => {
    for (let i = 0; i < frames; i += 1) m.push(new Float32Array(FRAME).fill(0.1))
  }

  it('starts at the first frame of speech, gives the pre-roll, and ends the turn at once when the VAD does', () => {
    const events: string[] = []
    // Speech on frames 50 to 119, silence after.
    const vad = scriptedVad((i) => i >= 50 && i < 120)
    const rec = scriptedRecognizer('en', () => 'how is it going')
    const m = new TurnMachine({
      vad,
      recognizers: [rec],
      preRollMs: 300,
      tailMs: 1000,
      events: {
        speechStarted: () => events.push(`start@${vad.fed - 1}`),
        utterance: (t) => events.push(`utt:${t}@${vad.fed - 1}`),
        failed: (r) => events.push(`fail:${r}`),
      },
    })
    run(200, m)
    // The turn starts on frame 50 and ends on the first frame without speech (120): nothing waits for a rule of the recogniser.
    expect(events).toEqual(['start@50', 'utt:how is it going@120'])
    // The stream had: 300 ms of pre-roll (15 frames of 20 ms, including frame 50) + frames 51..120 + 1000 ms of tail.
    const preRoll = Math.ceil(4800 / FRAME)
    expect(rec.samplesPerStream[0]).toBe((preRoll + (120 - 50)) * FRAME + 16000)
  })
  it('hears a second turn after the first and keeps nothing between them', () => {
    const events: string[] = []
    const vad = scriptedVad((i) => (i >= 10 && i < 30) || (i >= 60 && i < 80))
    let n = 0
    const rec = scriptedRecognizer('en', () => `turn ${n}`)
    const m = new TurnMachine({ vad, recognizers: [rec], events: { speechStarted: () => events.push('start'), utterance: (t) => events.push(t), failed: () => undefined } })
    run(100, m)
    n = 1
    expect(events).toEqual(['start', 'turn 0', 'start', 'turn 0'])
    expect(rec.opened).toBe(2)
  })
  it('gives no utterance for a turn that recognised nothing, and none for silence', () => {
    const events: string[] = []
    const vad = scriptedVad((i) => i >= 5 && i < 12)
    const m = new TurnMachine({ vad, recognizers: [scriptedRecognizer('en', () => '')], events: { speechStarted: () => events.push('start'), utterance: (t) => events.push(t), failed: () => undefined } })
    run(40, m)
    expect(events).toEqual(['start'])
    const quiet = new TurnMachine({ vad: scriptedVad(() => false), recognizers: [scriptedRecognizer('en', () => 'x')], events: { speechStarted: () => events.push('start2'), utterance: () => events.push('utt2'), failed: () => undefined } })
    run(40, quiet)
    expect(events).toEqual(['start'])
  })
  it('closes a turn that goes on too long and opens the next at once', () => {
    const events: string[] = []
    const m = new TurnMachine({
      vad: scriptedVad(() => true),
      recognizers: [scriptedRecognizer('en', () => 'long')],
      maxTurnMs: 1000,
      events: { speechStarted: () => events.push('start'), utterance: (t) => events.push(t), failed: () => undefined },
    })
    run(120, m)
    expect(events.filter((e) => e === 'long').length).toBeGreaterThanOrEqual(2)
    expect(events.filter((e) => e === 'start').length).toBe(events.filter((e) => e === 'long').length + 1)
  })
  it('ends on request (a turn detector elsewhere) and does nothing after close', () => {
    const events: string[] = []
    const m = new TurnMachine({ vad: scriptedVad(() => true), recognizers: [scriptedRecognizer('en', () => 'ok')], events: { speechStarted: () => events.push('start'), utterance: (t) => events.push(t), failed: () => undefined } })
    run(10, m)
    m.endOfTurn()
    expect(events).toEqual(['start', 'ok'])
    m.close()
    run(10, m)
    expect(events).toEqual(['start', 'ok'])
  })
  it('reports a failure of the VAD or recogniser as failed, once per frame, without throwing', () => {
    const events: string[] = []
    const vad: VadPort = {
      accept: () => {
        throw new Error('boom')
      },
      detected: () => false,
    }
    const m = new TurnMachine({ vad, recognizers: [], events: { speechStarted: () => undefined, utterance: () => undefined, failed: (r) => events.push(r) } })
    expect(() => run(2, m)).not.toThrow()
    expect(events).toEqual(['boom', 'boom'])
  })
  it('runs a recogniser per language and gives the better one', () => {
    const events: string[] = []
    const vad = scriptedVad((i) => i >= 2 && i < 20)
    const en = scriptedRecognizer('en', () => 'comme en avance le pro', -1.4)
    const fr = scriptedRecognizer('fr', () => 'comment avance le projet', -0.3)
    const m = new TurnMachine({ vad, recognizers: [en, fr], events: { speechStarted: () => undefined, utterance: (t, i) => events.push(`${i.lang}:${t}`), failed: () => undefined } })
    run(40, m)
    expect(events).toEqual(['fr:comment avance le projet'])
  })
})

describe('pickResult', () => {
  const r = (lang: 'en' | 'fr', text: string, meanLogProb: number) => ({ lang, result: { text, meanLogProb, tokens: text.split(' ').length } })
  it('takes the only recogniser that heard something', () => {
    expect(pickResult([r('en', '', -5), r('fr', 'oui', -2)])?.lang).toBe('fr')
    expect(pickResult([r('en', '', -5), r('fr', '', -2)])).toBeNull()
  })
  it('takes the more confident one when they differ by more than the margin', () => {
    expect(pickResult([r('en', 'what is blocking it', -0.3), r('fr', 'oua is bloc king', -1.2)])?.lang).toBe('en')
    expect(pickResult([r('en', 'comme en avance', -1.0), r('fr', 'comment avance le projet', -0.4)])?.lang).toBe('fr')
  })
  it('inside the margin, takes the one whose own words are in the text', () => {
    expect(pickResult([r('en', 'qu est ce qui bloque', -0.5), r('fr', "qu'est-ce qui bloque", -0.55)])?.lang).toBe('fr')
    expect(pickResult([r('en', 'what is the status', -0.5), r('fr', 'oua est le status', -0.45)])?.lang).toBe('en')
  })
})

// ---- the voice with a scripted synthesizer -------------------------------------------------------------------------

function scriptedVoices(calls: Array<{ lang: string; text: string }>, ms = 5, sampleRate = 22050): VoicePort {
  return {
    async synth(lang, text, signal) {
      calls.push({ lang, text })
      await new Promise((resolve) => setTimeout(resolve, ms))
      if (signal.aborted) return null
      // 100 ms of silence, then 300 ms of a tone: the silence must be cut.
      const samples = new Float32Array(Math.round(sampleRate * 0.4))
      for (let i = Math.round(sampleRate * 0.1); i < samples.length; i += 1) samples[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)
      return { samples, sampleRate }
    },
  }
}

describe('LocalTextToSpeech', () => {
  it('picks the voice by the sentence, resamples to the call, trims the leading silence and chunks at 100 ms', async () => {
    const calls: Array<{ lang: string; text: string }> = []
    const tts = new LocalTextToSpeech(scriptedVoices(calls))
    const got: Buffer[] = []
    await tts.speak('Comment avance le projet ? Il reste 85%', { sampleRate: 16000 }, (p) => got.push(p), new AbortController().signal)
    expect(calls).toEqual([{ lang: 'fr', text: 'Comment avance le projet ? Il reste 85 pour cent' }])
    expect(got.length).toBeGreaterThan(0)
    for (const p of got) expect(p.length).toBeLessThanOrEqual(3200)
    const all = Buffer.concat(got)
    // About 300 ms of tone at 16 kHz: the 100 ms of silence is gone (a few ms of onset are kept).
    expect(all.length / 32).toBeGreaterThan(290)
    expect(all.length / 32).toBeLessThan(320)
    expect(Math.max(...Array.from({ length: 300 }, (_, i) => Math.abs(all.readInt16LE(i * 2))))).toBeGreaterThan(5000)
    await tts.speak('What is blocking it?', { sampleRate: 8000 }, () => undefined, new AbortController().signal)
    expect(calls[1]).toEqual({ lang: 'en', text: 'What is blocking it?' })
  })
  it('uses the first language of the call for a sentence it cannot tell apart', async () => {
    const calls: Array<{ lang: string; text: string }> = []
    const tts = new LocalTextToSpeech(scriptedVoices(calls))
    tts.setLanguages(['fr-FR', 'en'])
    await tts.speak('RaceDeck', { sampleRate: 16000 }, () => undefined, new AbortController().signal)
    expect(calls[0]?.lang).toBe('fr')
  })
  it('speaks a long sentence one clause at a time, the first sound after the first clause', async () => {
    const calls: Array<{ lang: string; text: string }> = []
    const tts = new LocalTextToSpeech(scriptedVoices(calls, 20))
    const t0 = performance.now()
    let firstAt = 0
    await tts.speak('I have started the build, and I will tell you as soon as the tests finish running, then I will wait for your answer, ok?', { sampleRate: 16000 }, () => {
      if (firstAt === 0) firstAt = performance.now() - t0
    }, new AbortController().signal)
    expect(calls.length).toBeGreaterThan(1)
    expect(firstAt).toBeLessThan(20 * calls.length)
  })
  it('stops at once on abort: no more sound, no further clause is started, and the call returns without waiting', async () => {
    const calls: Array<{ lang: string; text: string }> = []
    const slow: VoicePort = {
      async synth(lang, text, signal) {
        calls.push({ lang, text })
        await new Promise((resolve) => setTimeout(resolve, 400))
        return signal.aborted ? null : { samples: new Float32Array(8000).fill(0.3), sampleRate: 16000 }
      },
    }
    const tts = new LocalTextToSpeech(slow)
    const ctl = new AbortController()
    const heard: Buffer[] = []
    const t0 = performance.now()
    const done = tts.speak('One long sentence, with several clauses in it, so that more than one is made, every one slow, and so on.', { sampleRate: 16000 }, (p) => heard.push(p), ctl.signal)
    setTimeout(() => ctl.abort(), 50)
    await done
    expect(performance.now() - t0).toBeLessThan(250)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(heard).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })
  it('stops between pieces of one clause when aborted from the sound callback', async () => {
    const tts = new LocalTextToSpeech({ synth: () => Promise.resolve({ samples: new Float32Array(16000).fill(0.3), sampleRate: 16000 }) })
    const ctl = new AbortController()
    let pieces = 0
    await tts.speak('A second of tone.', { sampleRate: 16000 }, () => {
      pieces += 1
      ctl.abort()
    }, ctl.signal)
    expect(pieces).toBe(1)
    let started = false
    await tts.speak('Never started.', { sampleRate: 16000 }, () => (started = true), ctl.signal)
    expect(started).toBe(false)
  })
  it('survives a voice that fails: the error is the caller\'s to log, nothing is half-played', async () => {
    const tts = new LocalTextToSpeech({ synth: () => Promise.reject(new Error('model gone')) })
    await expect(tts.speak('x y z', { sampleRate: 16000 }, () => undefined, new AbortController().signal)).rejects.toThrow('model gone')
  })
})

// ---- the worker protocol over in-memory ports ----------------------------------------------------------------------

type Listener<T> = (m: T) => void

function memoryPair() {
  const toWorker: Array<Listener<HostToWorker>> = []
  const toHost: Array<Listener<WorkerToHost>> = []
  const transfers: Array<ArrayBuffer[] | undefined> = []
  const workerPort: PortLike<WorkerToHost, HostToWorker> = {
    postMessage: (m) => queueMicrotask(() => toHost.forEach((l) => l(m))),
    on: (_e, l) => toWorker.push(l),
  }
  const hostPort: WorkerLike = {
    postMessage: (m, t) => {
      transfers.push(t)
      queueMicrotask(() => toWorker.forEach((l) => l(m)))
    },
    on: ((e: string, l: Listener<unknown>) => {
      if (e === 'message') toHost.push(l as Listener<WorkerToHost>)
    }) as WorkerLike['on'],
    terminate: () => Promise.resolve(0),
  }
  return { workerPort, hostPort, transfers }
}

describe('worker protocol', () => {
  it('loads, opens a session, takes audio, gives events and closes, with sound handed over', async () => {
    const { workerPort, hostPort, transfers } = memoryPair()
    const seen: string[] = []
    serveStt(
      workerPort,
      () => ({}) as never,
      () => ({
        load: () => undefined,
        free: () => seen.push('free'),
        open: (languages, events) => {
          seen.push(`open:${languages.join(',')}`)
          let n = 0
          return {
            push: (f: Float32Array) => {
              n += f.length
              if (n === FRAME) events.speechStarted()
              if (n === FRAME * 3) events.utterance('bonjour', { lang: 'fr', turnMs: 60, finishMs: 4 })
            },
            endOfTurn: () => seen.push('end'),
            close: () => seen.push('close'),
          } as unknown as TurnMachine
        },
      }),
    )
    const backend = new WorkerSttBackend(() => hostPort, '/x/sherpa.js', { languages: ['en', 'fr'], modelsDir: '/m', threads: 2, silenceMs: 450, minSpeechMs: 100, vadThreshold: 0.5 })
    await backend.ready()
    const events: string[] = []
    const session = backend.open(['fr'], { speechStarted: () => events.push('start'), utterance: (t, i) => events.push(`${t}/${i.lang}`), failed: (r) => events.push(`fail:${r}`) })
    const frames = [new Float32Array(FRAME), new Float32Array(FRAME), new Float32Array(FRAME)]
    for (const f of frames) session.push(f)
    session.endOfTurn()
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual(['start', 'bonjour/fr'])
    expect(seen).toEqual(['open:fr', 'end'])
    // The buffers were handed over, not copied.
    expect(transfers.filter((t) => t && t.length === 1).length).toBe(3)
    session.close()
    session.close()
    await backend.dispose()
    await new Promise((r) => setTimeout(r, 5))
    expect(seen).toContain('close')
  })
  it('refuses to open before the models are loaded and reports a failed load', async () => {
    const { workerPort, hostPort } = memoryPair()
    serveStt(workerPort, () => {
      throw new Error('cannot load sherpa')
    })
    const backend = new WorkerSttBackend(() => hostPort, '/x', { languages: ['en'], modelsDir: '/m', threads: 2, silenceMs: 450, minSpeechMs: 100, vadThreshold: 0.5 })
    expect(() => backend.open(['en'], { speechStarted: () => undefined, utterance: () => undefined, failed: () => undefined })).toThrow('not loaded')
    await expect(backend.ready()).rejects.toThrow('cannot load sherpa')
  })
  it('tells every open call that recognition stopped when the worker dies, and loads again on the next call', async () => {
    const errors: Array<(e: Error) => void> = []
    let spawned = 0
    const { workerPort, hostPort } = memoryPair()
    serveStt(workerPort, () => ({}) as never, () => ({ load: () => undefined, free: () => undefined, open: () => ({ push: () => undefined, endOfTurn: () => undefined, close: () => undefined }) as unknown as TurnMachine }))
    const worker: WorkerLike = {
      ...hostPort,
      on: ((e: string, l: Listener<never>) => {
        if (e === 'error') errors.push(l as unknown as (e: Error) => void)
        else (hostPort.on as (e: string, l: Listener<never>) => void)(e, l)
      }) as WorkerLike['on'],
    }
    const backend = new WorkerSttBackend(() => (spawned++, worker), '/x', { languages: ['en'], modelsDir: '/m', threads: 2, silenceMs: 450, minSpeechMs: 100, vadThreshold: 0.5 })
    await backend.ready()
    const failures: string[] = []
    backend.open(['en'], { speechStarted: () => undefined, utterance: () => undefined, failed: (r) => failures.push(r) })
    errors.forEach((l) => l(new Error('crashed')))
    expect(failures).toEqual(['speech recognition stopped (crashed)'])
    expect(() => backend.open(['en'], { speechStarted: () => undefined, utterance: () => undefined, failed: () => undefined })).toThrow('not loaded')
    await backend.ready().catch(() => undefined)
    expect(spawned).toBe(2)
  })
})

// ---- the provider on top of a scripted backend ------------------------------------------------------------------------

describe('LocalSpeechToText', () => {
  function fakeBackend() {
    const pushed: Float32Array[] = []
    let handlers: Parameters<SttBackend['open']>[1] | null = null
    const log = { opened: 0, closed: 0, languages: [] as string[][] }
    return {
      pushed,
      log,
      say: () => handlers,
      backend: {
        ready: () => Promise.resolve(),
        open: (languages: string[], h: NonNullable<typeof handlers>) => {
          log.opened += 1
          log.languages.push(languages)
          handlers = h
          return { push: (s: Float32Array) => pushed.push(s), endOfTurn: () => undefined, close: () => (log.closed += 1) }
        },
        dispose: () => Promise.resolve(),
      },
    }
  }

  it('is local, passes the sound on as floats, resamples a call at another rate, and corrects names with the hints', async () => {
    const f = fakeBackend()
    const stt = new LocalSpeechToText(f.backend as never, ['en', 'fr'], undefined, () => undefined)
    stt.setHints(['RaceDeck'])
    expect(stt.local).toBe(true)
    const heard: string[] = []
    let started = 0
    const session = stt.open({ sampleRate: 8000 }, { speechStarted: () => (started += 1), utterance: (t) => heard.push(t), failed: () => undefined }, { languages: ['fr-FR', 'EN', 'de'] })
    session.push(Buffer.alloc(320)) // before the backend is open: kept
    await new Promise((r) => setTimeout(r, 5))
    expect(f.log.languages).toEqual([['fr', 'en']])
    session.push(Buffer.alloc(320))
    const total = f.pushed.reduce((n, p) => n + p.length, 0)
    expect(total).toBeGreaterThan(300)
    expect(total).toBeLessThanOrEqual(640)
    f.say()?.speechStarted()
    f.say()?.utterance('how is race deck going', { lang: 'en', turnMs: 1, finishMs: 1 })
    f.say()?.utterance('', { lang: 'en', turnMs: 1, finishMs: 1 })
    expect(started).toBe(1)
    expect(heard).toEqual(['how is RaceDeck going'])
    session.close()
    f.say()?.utterance('late', { lang: 'en', turnMs: 1, finishMs: 1 })
    expect(heard).toEqual(['how is RaceDeck going'])
    expect(f.log.closed).toBe(1)
  })
  it('reports a backend that cannot start', async () => {
    const stt = new LocalSpeechToText({ ready: () => Promise.reject(new Error('no models')), open: () => { throw new Error('x') }, dispose: () => Promise.resolve() }, ['en'], undefined, () => undefined)
    const reasons: string[] = []
    stt.open({ sampleRate: 16000 }, { utterance: () => undefined, failed: (r) => reasons.push(r) }, { languages: ['en'] })
    await new Promise((r) => setTimeout(r, 5))
    expect(reasons).toEqual(['no models'])
  })
})

describe('LocalSpeech.check', () => {
  it('names what is missing and says ok only when nothing is', () => {
    const none = LocalSpeech.check('C:/definitely/not/here')
    expect(none.ok).toBe(false)
    expect(none.missing).toContain('silero_vad.onnx')
    expect(none.missing).toContain('stt-kroko-fr/encoder.onnx')
    expect(none.missing).toContain('tts-piper-en_US-ljspeech-medium/en_US-ljspeech-medium.onnx')
    expect(LocalSpeech.check('C:/definitely/not/here', ['en']).missing.some((m) => m.includes('kroko-fr'))).toBe(false)
    expect(missingModelFiles('C:/definitely/not/here', ['en'], { tts: false }).every((m) => !m.startsWith('tts-'))).toBe(true)
  })
  it('refuses to be created without its models, with a message that says what to run', () => {
    expect(() => LocalSpeech.create({ sherpa: 'x', modelsDir: 'C:/definitely/not/here' })).toThrow(/fetch-speech-models/)
  })
})
