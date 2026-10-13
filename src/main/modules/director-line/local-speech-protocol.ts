import { SttCore, sttDefaults, type SherpaModule, type SttSettings, type TurnMachine } from './local-speech-core'
import type { SpeechLanguage } from './local-speech-text'

/**
 * 0.9.1, local speech: the messages between the runtime process and the worker thread that holds the
 * recognisers. Loading a recogniser takes seconds and one 20 ms frame of sound takes a millisecond or two, but
 * neither may run on the thread that serves the rest of the runtime, so recognition lives in a worker. No
 * module of worker_threads is used here: both ends are given a port, so that the protocol is tested with a pair
 * of in-memory ports.
 */

export type HostToWorker =
  | { t: 'init'; sherpa: string; settings: SttSettings }
  | { t: 'open'; id: number; languages: SpeechLanguage[]; silenceMs?: number }
  | { t: 'audio'; id: number; samples: Float32Array }
  | { t: 'endOfTurn'; id: number }
  | { t: 'close'; id: number }
  | { t: 'dispose' }

export type WorkerToHost =
  | { t: 'ready'; loadMs: number }
  | { t: 'initFailed'; reason: string }
  | { t: 'speechStarted'; id: number }
  | { t: 'utterance'; id: number; text: string; lang: SpeechLanguage; turnMs: number; finishMs: number }
  | { t: 'failed'; id: number; reason: string }

/** The part of a worker's port (or the other end of one) that the protocol uses. */
export interface PortLike<Out, In> {
  postMessage(message: Out, transfer?: ArrayBuffer[]): void
  on(event: 'message', listener: (message: In) => void): unknown
}

/** The worker side: answers the host's messages with a core built from `loadSherpa`. */
export function serveStt(
  port: PortLike<WorkerToHost, HostToWorker>,
  loadSherpa: (spec: string) => SherpaModule,
  makeCore: (sherpa: SherpaModule, settings: SttSettings) => Pick<SttCore, 'load' | 'open' | 'free'> = (s, c) => new SttCore(s, c),
): void {
  let core: Pick<SttCore, 'load' | 'open' | 'free'> | null = null
  const sessions = new Map<number, TurnMachine>()
  port.on('message', (m) => {
    try {
      switch (m.t) {
        case 'init': {
          const t0 = performance.now()
          core = makeCore(loadSherpa(m.sherpa), m.settings)
          core.load()
          port.postMessage({ t: 'ready', loadMs: Math.round(performance.now() - t0) })
          return
        }
        case 'open': {
          if (core === null) {
            port.postMessage({ t: 'failed', id: m.id, reason: 'speech recognition is not loaded' })
            return
          }
          const id = m.id
          sessions.set(
            id,
            core.open(
              m.languages,
              {
                speechStarted: () => port.postMessage({ t: 'speechStarted', id }),
                utterance: (text, info) => port.postMessage({ t: 'utterance', id, text, lang: info.lang, turnMs: info.turnMs, finishMs: info.finishMs }),
                failed: (reason) => port.postMessage({ t: 'failed', id, reason }),
              },
              { silenceMs: m.silenceMs },
            ),
          )
          return
        }
        case 'audio':
          sessions.get(m.id)?.push(m.samples)
          return
        case 'endOfTurn':
          sessions.get(m.id)?.endOfTurn()
          return
        case 'close':
          sessions.get(m.id)?.close()
          sessions.delete(m.id)
          return
        case 'dispose':
          for (const s of sessions.values()) s.close()
          sessions.clear()
          core?.free()
          core = null
          return
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'speech recognition failed'
      if (m.t === 'init') port.postMessage({ t: 'initFailed', reason })
      else if ('id' in m) port.postMessage({ t: 'failed', id: m.id, reason })
    }
  })
}

// ---- the host side -------------------------------------------------------------------------------------------

export interface WorkerLike {
  postMessage(message: HostToWorker, transfer?: ArrayBuffer[]): void
  on(event: 'message', listener: (message: WorkerToHost) => void): unknown
  on(event: 'error', listener: (e: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number> | unknown
}

export interface SttSessionHandlers {
  speechStarted(): void
  utterance(text: string, info: { lang: SpeechLanguage; turnMs: number; finishMs: number }): void
  failed(reason: string): void
}

export interface SttBackendSession {
  /** 16 kHz mono floats; the buffer is handed over. */
  push(samples: Float32Array): void
  endOfTurn(): void
  close(): void
}

export interface SttBackend {
  /** Loads the models (seconds). Resolves when a call can be listened to. */
  ready(): Promise<void>
  open(languages: SpeechLanguage[], handlers: SttSessionHandlers, tune?: { silenceMs?: number }): SttBackendSession
  dispose(): Promise<void>
}

/** The host side of the protocol over a worker that is started when first needed and again after it was lost. */
export class WorkerSttBackend implements SttBackend {
  private worker: WorkerLike | null = null
  private loading: Promise<void> | null = null
  private nextId = 1
  private readonly handlers = new Map<number, SttSessionHandlers>()
  private onReady: { resolve(): void; reject(e: Error): void } | null = null

  constructor(
    private readonly spawn: () => WorkerLike,
    private readonly sherpa: string,
    private readonly settings: SttSettings,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  ready(): Promise<void> {
    if (this.loading !== null) return this.loading
    const worker = this.spawn()
    this.worker = worker
    const loading = new Promise<void>((resolve, reject) => {
      this.onReady = { resolve, reject }
    })
    this.loading = loading
    worker.on('message', (m) => this.receive(worker, m))
    worker.on('error', (e) => this.lost(worker, `speech recognition stopped (${e.message})`))
    worker.on('exit', () => this.lost(worker, 'speech recognition stopped'))
    worker.postMessage({ t: 'init', sherpa: this.sherpa, settings: this.settings })
    loading.catch(() => undefined)
    return loading
  }

  open(languages: SpeechLanguage[], handlers: SttSessionHandlers, tune: { silenceMs?: number } = {}): SttBackendSession {
    const worker = this.worker
    if (worker === null || this.loading === null) throw new Error('speech recognition is not loaded')
    const id = this.nextId++
    this.handlers.set(id, handlers)
    worker.postMessage({ t: 'open', id, languages, silenceMs: tune.silenceMs })
    return {
      push: (samples) => worker.postMessage({ t: 'audio', id, samples }, [samples.buffer as ArrayBuffer]),
      endOfTurn: () => worker.postMessage({ t: 'endOfTurn', id }),
      close: () => {
        if (this.handlers.delete(id)) worker.postMessage({ t: 'close', id })
      },
    }
  }

  async dispose(): Promise<void> {
    const worker = this.worker
    this.worker = null
    this.loading = null
    this.handlers.clear()
    if (worker === null) return
    try {
      worker.postMessage({ t: 'dispose' })
    } catch {
      // already gone
    }
    await Promise.resolve(worker.terminate()).catch(() => undefined)
  }

  private receive(from: WorkerLike, m: WorkerToHost): void {
    if (from !== this.worker) return
    switch (m.t) {
      case 'ready':
        this.log(`director-line: local speech recognition loaded in ${m.loadMs} ms`)
        this.onReady?.resolve()
        return
      case 'initFailed':
        this.onReady?.reject(new Error(m.reason))
        this.worker = null
        this.loading = null
        return
      case 'speechStarted':
        this.handlers.get(m.id)?.speechStarted()
        return
      case 'utterance':
        this.handlers.get(m.id)?.utterance(m.text, { lang: m.lang, turnMs: m.turnMs, finishMs: m.finishMs })
        return
      case 'failed':
        this.handlers.get(m.id)?.failed(m.reason)
        return
    }
  }

  private lost(worker: WorkerLike, reason: string): void {
    if (worker !== this.worker) return
    this.worker = null
    this.loading = null
    this.onReady?.reject(new Error(reason))
    const open = [...this.handlers.values()]
    this.handlers.clear()
    for (const h of open) h.failed(reason)
  }
}

export { sttDefaults }
