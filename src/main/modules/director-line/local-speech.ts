import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { chunkPcm, floatToPcm16, pcm16ToFloat, Resampler, trimLeadingSilence } from './local-speech-audio'
import { SttCore, sttDefaults, type SherpaModule, type SherpaOfflineTts, type SttSettings } from './local-speech-core'
import { missingModelFiles, TTS_VOICES } from './local-speech-models'
import { WorkerSttBackend, type SttBackend, type SttBackendSession, type WorkerLike } from './local-speech-protocol'
import { guessLanguage, normalizeForSpeech, snapToHints, splitClauses, type SpeechLanguage } from './local-speech-text'
import type { AudioFormat, SpeechToTextProvider, SpeechToTextSession, TextToSpeechProvider } from './voice-provider'

/**
 * 0.9.1: speech on this PC, with nothing sent anywhere. Recognition is Silero VAD plus a streaming Kroko
 * transducer per language (English, French), run in a worker thread; synthesis is Piper (VITS) voices, one per
 * language, run by sherpa-onnx's own thread pool. Both are `local: true`.
 *
 * Why recognition has no separate turn detector: the VAD that starts and ends a turn is already inside the
 * recognition session, and ends it by forcing the recogniser's final result in the same call. A separate
 * `TurnDetectionProvider` would add a message hop and a second opinion to the one delay that matters, so
 * `LocalSpeech.turns` is null and the voice engine takes `speechStarted` from the recogniser.
 *
 * Hot words: this version of sherpa-onnx-node can bias a transducer only through a hot-words file named when the
 * recogniser is built (modified beam search and a token-level spelling of each word); there is no per-stream list,
 * so a changed list would mean building the recogniser again, seconds of loading. It is not used. `setHints`
 * instead corrects the written text after recognition: where words said in a row, run together, are one name of
 * the list (up to one or two letters off), the name is written as it is spelled ("race deck" becomes "RaceDeck").
 *
 * Never on disk, never in a log: sound and text only pass through memory; the log lines carry lengths and times.
 */

export interface LocalSpeechOptions {
  /** The module `sherpa-onnx-node` as an object (for the calling thread), or the path or name to load it from (needed for the worker). */
  sherpa: SherpaModule | string
  /** The folder that `scripts/fetch-speech-models.mjs` fills. */
  modelsDir: string
  /** Threads for synthesis (default 4); recognition uses 2 per recogniser. */
  threads?: number
  /** Where recognition runs. `worker` is the normal case; `inline` runs it on the calling thread (tests, tools). */
  sttRunsIn?: 'worker' | 'inline'
  /** The compiled worker file (default: `speech-worker.js` next to the running bundle). */
  workerPath?: string
  /** Replaces the creation of the worker, for tests. */
  spawnWorker?: () => WorkerLike
  /** Languages the models are loaded for (default both). */
  languages?: SpeechLanguage[]
  /** Silence that ends what is being said (default 450 ms). */
  silenceMs?: number
  log?: (line: string) => void
}

function languagesOf(list: readonly string[], fallback: SpeechLanguage[]): SpeechLanguage[] {
  const out: SpeechLanguage[] = []
  for (const l of list) {
    const code = l.toLowerCase().slice(0, 2)
    if ((code === 'en' || code === 'fr') && !out.includes(code)) out.push(code)
  }
  return out.length > 0 ? out : fallback
}

export class LocalSpeechToText implements SpeechToTextProvider {
  readonly kind = 'local-sherpa-kroko'
  readonly local = true
  private hints: string[] = []

  constructor(
    private readonly backend: SttBackend,
    private readonly languages: SpeechLanguage[],
    private readonly silenceMs: number | undefined,
    private readonly log: (line: string) => void,
  ) {}

  /** Names (project names) that a spoken name is corrected to. See the note on hot words above. */
  setHints(hints: readonly string[]): void {
    this.hints = hints.filter((h) => h.trim().length > 0).slice(0, 200)
  }

  open(
    format: AudioFormat,
    on: { speechStarted?(): void; utterance(text: string): void; failed(reason: string): void },
    options: { languages: string[] },
  ): SpeechToTextSession {
    const resampler = format.sampleRate === 16000 ? null : new Resampler(format.sampleRate, 16000)
    let closed = false
    let session: SttBackendSession | null = null
    const pending: Float32Array[] = []
    const failed = (reason: string): void => {
      if (!closed) on.failed(reason)
    }
    const languages = languagesOf(options.languages, this.languages)
    this.backend
      .ready()
      .then(() => {
        if (closed) return
        session = this.backend.open(
          languages,
          {
            speechStarted: () => {
              if (!closed) on.speechStarted?.()
            },
            utterance: (text, info) => {
              if (closed || text.length === 0) return
              this.log(`director-line: local speech heard ${text.length} characters (${info.lang}), turn ${info.turnMs} ms, final result ${info.finishMs} ms`)
              on.utterance(snapToHints(text, this.hints))
            },
            failed,
          },
          { silenceMs: this.silenceMs },
        )
        for (const p of pending.splice(0)) session.push(p)
      })
      .catch((e: unknown) => failed(e instanceof Error ? e.message : 'speech recognition could not start'))
    return {
      push(pcm) {
        if (closed || pcm.length < 2) return
        let floats = pcm16ToFloat(pcm)
        if (resampler !== null) floats = resampler.process(floats)
        if (floats.length === 0) return
        // Sound that arrives while the models are still loading is kept for a short while, not for long.
        if (session === null) {
          pending.push(floats)
          while (pending.length > 100) pending.shift()
        } else session.push(floats)
      },
      endOfTurn() {
        session?.endOfTurn()
      },
      close() {
        if (closed) return
        closed = true
        session?.close()
        session = null
        pending.length = 0
      },
    }
  }
}

/** Synthesizes one clause with the voice of a language. Replaced by a fake in tests. */
export interface VoicePort {
  synth(lang: SpeechLanguage, text: string, signal: AbortSignal): Promise<{ samples: Float32Array; sampleRate: number } | null>
  free?(): void
}

export class SherpaVoices implements VoicePort {
  private readonly voices = new Map<SpeechLanguage, Promise<SherpaOfflineTts>>()

  constructor(
    private readonly sherpa: SherpaModule,
    private readonly modelsDir: string,
    private readonly threads: number,
  ) {}

  warm(languages: SpeechLanguage[]): Promise<unknown> {
    return Promise.all(languages.map((l) => this.voice(l)))
  }

  private voice(lang: SpeechLanguage): Promise<SherpaOfflineTts> {
    let v = this.voices.get(lang)
    if (!v) {
      const f = TTS_VOICES[lang]
      const dir = join(this.modelsDir, f.dir)
      v = this.sherpa.OfflineTts.createAsync({
        model: { vits: { model: join(dir, f.model), tokens: join(dir, 'tokens.txt'), dataDir: join(dir, 'espeak-ng-data') }, debug: false, numThreads: this.threads, provider: 'cpu' },
        maxNumSentences: 1,
      })
      this.voices.set(lang, v)
      v.catch(() => this.voices.delete(lang))
    }
    return v
  }

  async synth(lang: SpeechLanguage, text: string, signal: AbortSignal): Promise<{ samples: Float32Array; sampleRate: number } | null> {
    const tts = await this.voice(lang)
    if (signal.aborted) return null
    // The progress callback is asked, as sound is made, whether to go on: 0 stops the synthesis in the library.
    const audio = await tts.generateAsync({ text, sid: TTS_VOICES[lang].speakerId, speed: 1.0, onProgress: () => (signal.aborted ? 0 : 1) })
    return signal.aborted ? null : audio
  }

  free(): void {
    this.voices.clear()
  }
}

export class LocalTextToSpeech implements TextToSpeechProvider {
  readonly kind = 'local-sherpa-piper'
  readonly local = true
  private order: SpeechLanguage[]

  constructor(
    private readonly voices: VoicePort,
    languages: SpeechLanguage[] = ['en', 'fr'],
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.order = languages
  }

  /** The languages of the call, in order: the first is the voice for a sentence that cannot be told apart. */
  setLanguages(languages: readonly string[]): void {
    this.order = languagesOf(languages, this.order)
  }

  async speak(text: string, format: AudioFormat, onAudio: (pcm: Buffer) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const lang = guessLanguage(text, this.order)
    const clauses = splitClauses(normalizeForSpeech(text, lang))
    const aborted = new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null)
      else signal.addEventListener('abort', () => resolve(null), { once: true })
    })
    const t0 = performance.now()
    let first = true
    for (const clause of clauses) {
      if (signal.aborted) return
      const made = this.voices.synth(lang, clause, signal)
      made.catch(() => undefined)
      // On abort the caller is released at once; what the library still makes is dropped.
      const audio = await Promise.race([made, aborted])
      if (audio === null || signal.aborted) return
      let samples = await resampleYielding(audio.samples, audio.sampleRate, format.sampleRate, signal)
      if (signal.aborted) return
      samples = trimLeadingSilence(samples, format.sampleRate, { keepMs: first ? 8 : 40 })
      if (samples.length === 0) continue
      for (const piece of chunkPcm(floatToPcm16(samples), format.sampleRate, 100)) {
        if (signal.aborted) return
        if (first) {
          first = false
          this.log(`director-line: local speech first sound of ${text.length} characters (${lang}) after ${Math.round(performance.now() - t0)} ms`)
        }
        onAudio(piece)
      }
    }
  }
}

/**
 * Resamples a clause in slices, giving the event loop a turn between them: a clause of six seconds is about
 * twenty milliseconds of work in one go, which is a stall on the thread that serves the rest of the runtime.
 */
async function resampleYielding(samples: Float32Array, inRate: number, outRate: number, signal: AbortSignal): Promise<Float32Array> {
  if (inRate === outRate) return samples
  const r = new Resampler(inRate, outRate)
  const parts: Float32Array[] = []
  const slice = Math.max(2048, Math.round(inRate / 8))
  for (let at = 0; at < samples.length; at += slice) {
    if (signal.aborted) return new Float32Array(0)
    parts.push(r.process(samples.subarray(at, Math.min(samples.length, at + slice))))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  parts.push(r.flush())
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function defaultWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'speech-worker.js')
}

export class LocalSpeech {
  readonly stt: LocalSpeechToText
  readonly tts: LocalTextToSpeech
  /** Null on purpose: the recogniser session decides where a turn begins and ends (see the note at the top). */
  readonly turns = null
  private readonly backend: SttBackend
  private readonly voices: SherpaVoices
  private readonly languages: SpeechLanguage[]

  private constructor(o: LocalSpeechOptions) {
    const log = o.log ?? (() => undefined)
    this.languages = o.languages ?? ['en', 'fr']
    const settings: SttSettings = { ...sttDefaults(o.modelsDir, this.languages), ...(o.silenceMs === undefined ? {} : { silenceMs: o.silenceMs }) }
    const require = createRequire(import.meta.url)
    const sherpaObject = (): SherpaModule => (typeof o.sherpa === 'string' ? (require(o.sherpa) as SherpaModule) : o.sherpa)
    if ((o.sttRunsIn ?? 'worker') === 'inline') {
      this.backend = inlineBackend(() => new SttCore(sherpaObject(), settings))
    } else {
      if (typeof o.sherpa !== 'string') throw new Error('LocalSpeech: running recognition in a worker needs the path of the sherpa-onnx-node module, not the module itself')
      const workerPath = o.workerPath ?? defaultWorkerPath()
      this.backend = new WorkerSttBackend(o.spawnWorker ?? (() => new Worker(workerPath) as unknown as WorkerLike), o.sherpa, settings, log)
    }
    this.voices = new SherpaVoices(sherpaObject(), o.modelsDir, o.threads ?? 4)
    this.stt = new LocalSpeechToText(this.backend, this.languages, o.silenceMs, log)
    this.tts = new LocalTextToSpeech(this.voices, this.languages, log)
  }

  /** What is missing from the models folder, to be asked before `create`. */
  static check(modelsDir: string, languages: readonly SpeechLanguage[] = ['en', 'fr']): { ok: boolean; missing: string[] } {
    const missing = missingModelFiles(modelsDir, languages)
    return { ok: missing.length === 0, missing }
  }

  static create(o: LocalSpeechOptions): LocalSpeech {
    const check = LocalSpeech.check(o.modelsDir, o.languages ?? ['en', 'fr'])
    if (!check.ok) throw new Error(`local speech models are missing from ${o.modelsDir}: ${check.missing.join(', ')} (run scripts/fetch-speech-models.mjs)`)
    return new LocalSpeech(o)
  }

  /** Loads the models now (about two seconds), so that the first call does not wait for them. */
  async warm(): Promise<void> {
    await Promise.all([this.backend.ready(), this.voices.warm(this.languages)])
  }

  setHints(hints: readonly string[]): void {
    this.stt.setHints(hints)
  }

  async dispose(): Promise<void> {
    await this.backend.dispose()
    this.voices.free()
  }
}

/** Recognition on the calling thread: the same core, without the messages. */
function inlineBackend(make: () => SttCore): SttBackend {
  let core: SttCore | null = null
  return {
    ready() {
      try {
        core ??= make()
        core.load()
        return Promise.resolve()
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error('speech recognition could not start'))
      }
    },
    open(languages, handlers, tune) {
      if (core === null) throw new Error('speech recognition is not loaded')
      const machine = core.open(languages, handlers, tune)
      return { push: (s) => machine.push(s), endOfTurn: () => machine.endOfTurn(), close: () => machine.close() }
    },
    dispose() {
      core?.free()
      core = null
      return Promise.resolve()
    },
  }
}
