import { join } from 'node:path'
import { STT_MODELS, VAD_MODEL } from './local-speech-models'
import { guessLanguage, type SpeechLanguage } from './local-speech-text'

/**
 * 0.9.1, local speech: recognition. This file holds the logic of a spoken turn and the thin adapters to
 * sherpa-onnx; it is plain synchronous code, run either in a worker thread (the normal case, see
 * local-speech-worker.ts) or in the calling thread (tests).
 *
 * How a turn goes: Silero VAD watches every 20 ms frame. When it holds speech, the turn starts: `speechStarted`
 * is given, a streaming recogniser per language is opened and fed the last half second of sound (so the first
 * word is not clipped), and every following frame. When the VAD has seen the configured silence, the turn is
 * over: the recogniser is told that its input is finished, which makes it give its final result at once, instead
 * of waiting for rules of its own about trailing silence (which left 1 to 2.5 s). Nothing is kept: the sound passes
 * through the recogniser and is gone, and a stream is made again for the next turn.
 */

export interface VadPort {
  accept(frame: Float32Array): void
  detected(): boolean
  free?(): void
}

export interface RecognitionResult {
  text: string
  /** Mean log probability of the tokens that were chosen (0 is certain, more negative is less sure). */
  meanLogProb: number
  tokens: number
}

export interface StreamPort {
  accept(samples: Float32Array): void
  /** Says that no more sound comes and gives the final result. */
  finish(): RecognitionResult
}

export interface RecognizerPort {
  readonly lang: SpeechLanguage
  open(): StreamPort
  free?(): void
}

export interface TurnEvents {
  speechStarted(): void
  utterance(text: string, info: { lang: SpeechLanguage; turnMs: number; finishMs: number }): void
  failed(reason: string): void
}

export interface TurnMachineOptions {
  vad: VadPort
  recognizers: RecognizerPort[]
  events: TurnEvents
  sampleRate?: number
  /** Sound before the moment the VAD decided, given to the recogniser. */
  preRollMs?: number
  /** Zeros given, at once and not at the pace of speech, at the end of a turn. The Kroko models give a word about a second after it was said; without this the last words of a sentence are not in the result. */
  tailMs?: number
  /** A turn this long is closed and a new one opens at once, so that nothing is held without end. */
  maxTurnMs?: number
  now?: () => number
}

/**
 * Chooses between what the recognisers of the different languages made of the same sound. A wrong language
 * produces text of its own words with a low confidence; a right one a high confidence. The rule: the mean log
 * probability of the tokens decides when the two differ by more than `margin`; inside the margin the language
 * whose own function words are in the text decides, and then the one with more words.
 */
export function pickResult(
  results: Array<{ lang: SpeechLanguage; result: RecognitionResult }>,
  options: { margin?: number; order?: SpeechLanguage[] } = {},
): { lang: SpeechLanguage; result: RecognitionResult } | null {
  const margin = options.margin ?? 0.12
  const with_text = results.filter((r) => r.result.text.trim().length > 0)
  if (with_text.length === 0) return null
  if (with_text.length === 1) return with_text[0] as { lang: SpeechLanguage; result: RecognitionResult }
  const langs = with_text.map((r) => r.lang)
  const sorted = [...with_text].sort((a, b) => b.result.meanLogProb - a.result.meanLogProb)
  const best = sorted[0] as (typeof sorted)[number]
  const second = sorted[1] as (typeof sorted)[number]
  if (best.result.meanLogProb - second.result.meanLogProb > margin) return best
  const agree = with_text.filter((r) => guessLanguage(r.result.text, langs) === r.lang)
  if (agree.length === 1) return agree[0] as (typeof with_text)[number]
  const order = options.order ?? langs
  return [...with_text].sort((a, b) => b.result.tokens - a.result.tokens || order.indexOf(a.lang) - order.indexOf(b.lang))[0] as (typeof with_text)[number]
}

export class TurnMachine {
  private readonly rate: number
  private readonly preRoll: number
  private readonly tail: number
  private readonly maxTurn: number
  private readonly now: () => number
  private ring: Float32Array[] = []
  private ringSamples = 0
  private streams: Array<{ lang: SpeechLanguage; stream: StreamPort }> | null = null
  private turnSamples = 0
  private turnStartedAt = 0
  private closed = false

  constructor(private readonly o: TurnMachineOptions) {
    this.rate = o.sampleRate ?? 16000
    this.preRoll = Math.round(((o.preRollMs ?? 500) * this.rate) / 1000)
    this.tail = Math.round(((o.tailMs ?? 1500) * this.rate) / 1000)
    this.maxTurn = Math.round(((o.maxTurnMs ?? 30_000) * this.rate) / 1000)
    this.now = o.now ?? (() => performance.now())
  }

  get active(): boolean {
    return this.streams !== null
  }

  push(frame: Float32Array): void {
    if (this.closed || frame.length === 0) return
    try {
      this.o.vad.accept(frame)
      const speaking = this.o.vad.detected()
      if (this.streams === null) {
        this.keep(frame)
        if (speaking) this.begin()
        return
      }
      this.feed(frame)
      if (!speaking) this.end()
      else if (this.turnSamples >= this.maxTurn) this.end()
    } catch (e) {
      this.o.events.failed(e instanceof Error ? e.message : 'speech recognition failed')
    }
  }

  /** The speaker stopped, said by somebody else (a turn detector): the turn is closed now. */
  endOfTurn(): void {
    if (this.streams !== null && !this.closed) {
      try {
        this.end()
      } catch (e) {
        this.o.events.failed(e instanceof Error ? e.message : 'speech recognition failed')
      }
    }
  }

  close(): void {
    this.closed = true
    this.streams = null
    this.ring = []
    this.o.vad.free?.()
  }

  private keep(frame: Float32Array): void {
    this.ring.push(frame)
    this.ringSamples += frame.length
    while (this.ring.length > 1 && this.ringSamples - (this.ring[0] as Float32Array).length >= this.preRoll) {
      this.ringSamples -= (this.ring.shift() as Float32Array).length
    }
  }

  private begin(): void {
    this.turnStartedAt = this.now()
    this.streams = this.o.recognizers.map((r) => ({ lang: r.lang, stream: r.open() }))
    this.turnSamples = 0
    this.o.events.speechStarted()
    const held = this.ring
    this.ring = []
    this.ringSamples = 0
    for (const f of held) this.feed(f)
  }

  private feed(frame: Float32Array): void {
    this.turnSamples += frame.length
    for (const s of this.streams ?? []) s.stream.accept(frame)
  }

  private end(): void {
    const streams = this.streams
    if (streams === null) return
    this.streams = null
    const turnMs = Math.round(this.now() - this.turnStartedAt)
    const t0 = this.now()
    const zeros = new Float32Array(this.tail)
    const results = streams.map((s) => {
      s.stream.accept(zeros)
      return { lang: s.lang, result: s.stream.finish() }
    })
    const picked = pickResult(results, { order: this.o.recognizers.map((r) => r.lang) })
    const finishMs = Math.round(this.now() - t0)
    if (picked !== null) this.o.events.utterance(picked.result.text.trim(), { lang: picked.lang, turnMs, finishMs })
  }
}

// ---- adapters to sherpa-onnx-node -----------------------------------------------------------------------------

/** The part of the `sherpa-onnx-node` module that is used. Typed loosely: the module has no declaration file. */
export interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => SherpaOnlineRecognizer
  Vad: new (config: unknown, bufferSeconds: number) => SherpaVad
  OfflineTts: { createAsync(config: unknown): Promise<SherpaOfflineTts> }
}
export interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream
  isReady(s: SherpaOnlineStream): boolean
  decode(s: SherpaOnlineStream): void
  getResult(s: SherpaOnlineStream): { text: string; ys_probs?: number[]; tokens?: string[] }
}
export interface SherpaOnlineStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void
  inputFinished(): void
}
export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isDetected(): boolean
  isEmpty(): boolean
  pop(): void
}
export interface SherpaOfflineTts {
  readonly sampleRate: number
  generateAsync(request: { text: string; sid: number; speed: number; onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void }): Promise<{ samples: Float32Array; sampleRate: number }>
}

export interface SttSettings {
  languages: SpeechLanguage[]
  modelsDir: string
  threads: number
  /** Silence after speech that ends a turn. */
  silenceMs: number
  /** Speech that must be there before a turn starts. */
  minSpeechMs: number
  vadThreshold: number
}

export function sttDefaults(modelsDir: string, languages: SpeechLanguage[]): SttSettings {
  return { languages, modelsDir, threads: 2, silenceMs: 450, minSpeechMs: 100, vadThreshold: 0.5 }
}

export function createVad(sherpa: SherpaModule, s: SttSettings): VadPort {
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: join(s.modelsDir, VAD_MODEL),
        threshold: s.vadThreshold,
        minSilenceDuration: s.silenceMs / 1000,
        minSpeechDuration: s.minSpeechMs / 1000,
        windowSize: 512,
        maxSpeechDuration: 60,
      },
      sampleRate: 16000,
      numThreads: 1,
      debug: 0,
    },
    60,
  )
  return {
    accept(frame) {
      vad.acceptWaveform(frame)
      // The segments that the VAD cuts are not used (the turn is the VAD's `detected`); drop them.
      while (!vad.isEmpty()) vad.pop()
    },
    detected: () => vad.isDetected(),
  }
}

export function createRecognizer(sherpa: SherpaModule, lang: SpeechLanguage, s: SttSettings): RecognizerPort {
  const dir = join(s.modelsDir, STT_MODELS[lang].dir)
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: join(dir, 'encoder.onnx'), decoder: join(dir, 'decoder.onnx'), joiner: join(dir, 'joiner.onnx') },
      tokens: join(dir, 'tokens.txt'),
      numThreads: s.threads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    // The model's own end-of-speech rules are off: the VAD decides, and the final result is forced.
    enableEndpoint: false,
  })
  return {
    lang,
    open() {
      const stream = rec.createStream()
      const decodeReady = (): void => {
        while (rec.isReady(stream)) rec.decode(stream)
      }
      return {
        accept(samples) {
          stream.acceptWaveform({ sampleRate: 16000, samples })
          decodeReady()
        },
        finish() {
          stream.inputFinished()
          decodeReady()
          const r = rec.getResult(stream)
          const p = r.ys_probs ?? []
          return { text: r.text, tokens: r.tokens?.length ?? 0, meanLogProb: p.length > 0 ? p.reduce((a, b) => a + b, 0) / p.length : -5 }
        },
      }
    },
  }
}

/** Recognisers are loaded once (this takes seconds); each call gets a VAD and a turn machine of its own. */
export class SttCore {
  private readonly recognizers = new Map<SpeechLanguage, RecognizerPort>()
  private vadWarm = false

  constructor(
    private readonly sherpa: SherpaModule,
    private readonly settings: SttSettings,
  ) {}

  load(): void {
    for (const lang of this.settings.languages) {
      if (this.recognizers.has(lang)) continue
      const r = createRecognizer(this.sherpa, lang, this.settings)
      // The first decode of a fresh recogniser is slow (memory is set up on use); do it now, not in the first call.
      const warm = r.open()
      warm.accept(new Float32Array(16000))
      warm.finish()
      this.recognizers.set(lang, r)
    }
    if (this.vadWarm) return
    this.vadWarm = true
    // The same for the VAD: one made and used for a moment.
    const vad = createVad(this.sherpa, this.settings)
    vad.accept(new Float32Array(3200))
    vad.free?.()
  }

  open(languages: SpeechLanguage[], events: TurnEvents, tune: { silenceMs?: number } = {}): TurnMachine {
    this.load()
    const use = languages.filter((l) => this.recognizers.has(l))
    const chosen = use.length > 0 ? use : this.settings.languages
    const s = tune.silenceMs === undefined ? this.settings : { ...this.settings, silenceMs: tune.silenceMs }
    return new TurnMachine({
      vad: createVad(this.sherpa, s),
      recognizers: chosen.map((l) => this.recognizers.get(l) as RecognizerPort),
      events,
    })
  }

  free(): void {
    for (const r of this.recognizers.values()) r.free?.()
    this.recognizers.clear()
  }
}
