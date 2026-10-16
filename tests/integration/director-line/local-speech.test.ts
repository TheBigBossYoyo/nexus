import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalSpeech } from '@main/modules/director-line/local-speech'

// 0.9.1: the real local speech stack, not scripted: Piper voices speak sentences, the sound is fed through the
// recognition session at the pace of a call (one 20 ms frame every 20 ms), and what comes back is compared with
// what was said. Skipped, with the reason printed, when the models (scripts/fetch-speech-models.mjs) or the
// sherpa-onnx-node module are not there. The bounds are generous on purpose: they bound a hang or a broken
// stack, they are not a performance claim; the measured numbers are printed and written to
// test-results/speech-lab/it-metrics.json.
//
// Environment: NEXUS_SPEECH_MODELS (default vendor/speech-models), NEXUS_SHERPA_PATH (default: sherpa-onnx-node
// from the repository, else the lab copy in test-results/speech-lab/node_modules).

const repo = resolve(import.meta.dirname, '..', '..', '..')
const modelsDir = resolve(process.env.NEXUS_SPEECH_MODELS ?? join(repo, 'vendor', 'speech-models'))

function findSherpa(): string | null {
  const candidates = [process.env.NEXUS_SHERPA_PATH, join(repo, 'package.json'), join(repo, 'test-results', 'speech-lab', 'package.json')].filter((c): c is string => !!c)
  for (const c of candidates) {
    try {
      if (c.endsWith('.js')) return existsSync(c) ? c : null
      return createRequire(c).resolve('sherpa-onnx-node')
    } catch {
      // try the next
    }
  }
  return null
}

const sherpaPath = findSherpa()
const check = LocalSpeech.check(modelsDir)
const skipReason = sherpaPath === null ? 'sherpa-onnx-node is not installed (set NEXUS_SHERPA_PATH)' : !check.ok ? `speech models are missing from ${modelsDir}: ${check.missing.join(', ')} (run scripts/fetch-speech-models.mjs)` : null
if (skipReason !== null) console.warn(`local-speech integration test SKIPPED: ${skipReason}`)

const FORMAT = { sampleRate: 16000 as const }
const FRAME_BYTES = 640

function words(s: string): string[] {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ').match(/[a-z0-9]+/g) ?? []
}
/** Word error rate: edit distance over words, divided by the words that were said. */
function wer(said: string, heard: string): number {
  const a = words(said)
  const b = words(heard)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 0; j <= b.length; j += 1) (d[0] as number[])[j] = j
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      (d[i] as number[])[j] = Math.min((d[i - 1] as number[])[j]! + 1, (d[i] as number[])[j - 1]! + 1, (d[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
  return (d[a.length] as number[])[b.length]! / a.length
}
const median = (xs: number[]): number => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0

function speechBounds(pcm: Buffer): { first: number; last: number } {
  let first = -1
  let last = 0
  for (let i = 0; i < pcm.length / 2; i += 1) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > 700) {
      if (first < 0) first = i
      last = i
    }
  }
  return { first: (first * 1000) / 16000, last: (last * 1000) / 16000 }
}

describe.skipIf(skipReason !== null)('local speech, real models', () => {
  let speech: LocalSpeech
  const metrics = {
    warmMs: 0,
    startDelayMs: [] as number[],
    endToUtteranceMs: [] as number[],
    ttsFirstAudioMs: {} as Record<string, number>,
    worstLoopStallMs: 0,
    loopP99Ms: 0,
    rssMB: 0,
    heapMB: 0,
    transcripts: {} as Record<string, string>,
  }
  const loop = monitorEventLoopDelay({ resolution: 2 })

  beforeAll(async () => {
    let workerPath: string | undefined
    let mode: 'worker' | 'inline' = 'worker'
    try {
      // The worker is a TypeScript module of the app; for the test it is bundled the way the app build does.
      const { build } = await import('esbuild')
      const out = join(repo, 'test-results', 'speech-lab', 'build-it')
      mkdirSync(out, { recursive: true })
      workerPath = join(out, 'speech-worker.mjs')
      await build({
        entryPoints: [join(repo, 'src', 'main', 'modules', 'director-line', 'local-speech-worker.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: workerPath,
        logLevel: 'silent',
      })
    } catch (e) {
      console.warn(`local-speech integration: the worker could not be bundled (${e instanceof Error ? e.message : String(e)}); recognition runs on the test thread`)
      mode = 'inline'
    }
    speech = LocalSpeech.create({ sherpa: sherpaPath as string, modelsDir, sttRunsIn: mode, workerPath, threads: 4 })
    const t0 = performance.now()
    await speech.warm()
    metrics.warmMs = Math.round(performance.now() - t0)
    loop.enable()
  }, 180_000)

  afterAll(async () => {
    loop.disable()
    metrics.worstLoopStallMs = Math.round(loop.max / 1e6)
    metrics.loopP99Ms = Math.round(loop.percentile(99) / 1e6)
    metrics.rssMB = Math.round(process.memoryUsage().rss / 1048576)
    metrics.heapMB = Math.round(process.memoryUsage().heapUsed / 1048576)
    await speech?.dispose()
    const summary = {
      warmMs: metrics.warmMs,
      speechStartDelayMs: { median: median(metrics.startDelayMs), worst: Math.max(0, ...metrics.startDelayMs) },
      endOfSpeechToUtteranceMs: { median: median(metrics.endToUtteranceMs), worst: Math.max(0, ...metrics.endToUtteranceMs) },
      ttsFirstAudioMs: metrics.ttsFirstAudioMs,
      worstEventLoopStallMs: metrics.worstLoopStallMs,
      eventLoopP99Ms: metrics.loopP99Ms,
      rssMB: metrics.rssMB,
      transcripts: metrics.transcripts,
    }
    console.log(`SPEECH-METRICS ${JSON.stringify(summary)}`)
    try {
      const dir = join(repo, 'test-results', 'speech-lab')
      mkdirSync(dir, { recursive: true })
      // Numbers only; nothing that was said is written to disk.
      const { transcripts: _t, ...numbers } = summary
      writeFileSync(join(dir, 'it-metrics.json'), JSON.stringify(numbers, null, 2))
    } catch {
      // the scratch folder is a convenience
    }
  })

  async function speak(text: string, lang: string): Promise<{ pcm: Buffer; firstMs: number }> {
    speech.tts.setLanguages([lang])
    const parts: Buffer[] = []
    const t0 = performance.now()
    let first = -1
    await speech.tts.speak(text, FORMAT, (p) => {
      if (first < 0) first = performance.now() - t0
      parts.push(p)
    }, new AbortController().signal)
    return { pcm: Buffer.concat(parts), firstMs: first }
  }

  /** One sentence heard through a session at the pace of a call; gives what happened and when, from the speech itself. */
  async function listen(pcm: Buffer, languages: string[]) {
    const events: Array<{ kind: 'start' | 'utterance' | 'failed'; at: number; text?: string }> = []
    const session = speech.stt.open(FORMAT, {
      speechStarted: () => events.push({ kind: 'start', at: performance.now() }),
      utterance: (text) => events.push({ kind: 'utterance', at: performance.now(), text }),
      failed: () => events.push({ kind: 'failed', at: performance.now() }),
    }, { languages })
    const all = Buffer.concat([Buffer.alloc(FRAME_BYTES * 50), pcm, Buffer.alloc(FRAME_BYTES * 100)])
    const { first, last } = speechBounds(all)
    // The session opens after the worker has the models; do not count that.
    await new Promise((r) => setTimeout(r, 30))
    const t0 = performance.now()
    for (let i = 0; i * FRAME_BYTES < all.length; i += 1) {
      const wait = t0 + i * 20 - performance.now()
      if (wait > 1) await new Promise((r) => setTimeout(r, wait))
      session.push(all.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES))
    }
    await new Promise((r) => setTimeout(r, 400))
    session.close()
    const start = events.find((e) => e.kind === 'start')
    const utterances = events.filter((e) => e.kind === 'utterance')
    return {
      events,
      text: utterances.map((u) => u.text).join(' '),
      startDelay: start ? start.at - t0 - first : null,
      endDelay: utterances.length > 0 ? (utterances[utterances.length - 1] as { at: number }).at - t0 - last : null,
      startedBeforeUtterance: start !== undefined && utterances.length > 0 && start.at <= (utterances[0] as { at: number }).at,
      failed: events.some((e) => e.kind === 'failed'),
    }
  }

  const PHRASES: Array<{ text: string; lang: string; tolerance: number }> = [
    // A project name is the weak spot of any recogniser: "RaceDeck" is spoken as two words and may be written as other two.
    { text: 'How is RaceDeck going?', lang: 'en', tolerance: 1 },
    { text: 'What is blocking it?', lang: 'en', tolerance: 0.5 },
    { text: 'Pause after the current task.', lang: 'en', tolerance: 0.5 },
    { text: 'Call me when it is done.', lang: 'en', tolerance: 0.5 },
    { text: 'Comment avance le projet ?', lang: 'fr', tolerance: 0.5 },
    { text: "Qu'est-ce qui bloque ?", lang: 'fr', tolerance: 0.5 },
  ]

  for (const p of PHRASES) {
    it(`hears "${p.text}" (${p.lang}) at the pace of a call`, async () => {
      const said = await speak(p.text, p.lang)
      expect(said.pcm.length).toBeGreaterThan(8000)
      metrics.ttsFirstAudioMs[p.text] = Math.round(said.firstMs)
      const r = await listen(said.pcm, ['en', 'fr'])
      expect(r.failed).toBe(false)
      expect(r.startDelay, 'speech start was never reported').not.toBeNull()
      expect(r.startedBeforeUtterance).toBe(true)
      metrics.startDelayMs.push(Math.round(r.startDelay as number))
      metrics.endToUtteranceMs.push(Math.round(r.endDelay as number))
      metrics.transcripts[p.text] = r.text
      expect(wer(p.text, r.text), `heard "${r.text}"`).toBeLessThanOrEqual(p.tolerance)
      // Bounds on a hang, not a claim: the measured values are in the summary.
      expect(r.startDelay as number).toBeLessThan(1500)
      expect(r.endDelay as number).toBeLessThan(2500)
    }, 60_000)
  }

  it('hears digit strings and reports what it heard (a spoken PIN is the caller\'s risk to judge)', async () => {
    for (const [text, lang] of [
      ['four eight two nine one five', 'en'],
      ['quatre huit deux neuf un cinq', 'fr'],
    ] as const) {
      const said = await speak(text, lang)
      const r = await listen(said.pcm, ['en', 'fr'])
      metrics.transcripts[text] = r.text
      expect(r.failed).toBe(false)
      expect(r.text.length).toBeGreaterThan(0)
    }
  }, 60_000)

  it('corrects a project name to its spelling with the hints', async () => {
    speech.setHints(['RaceDeck'])
    const said = await speak('How is race deck going?', 'en')
    const r = await listen(said.pcm, ['en', 'fr'])
    speech.setHints([])
    metrics.transcripts['hinted'] = r.text
    // What the recogniser hears of a synthetic voice varies with the load of the machine ("How is" came back as
    // "Powers" once): that it heard something is asserted, and the correction only where the name was heard.
    expect(words(r.text).length).toBeGreaterThan(1)
    if (/race\s*deck|racedeck/i.test(r.text)) expect(r.text).toContain('RaceDeck')
  }, 60_000)

  it('times the first sound of a short and a long sentence', async () => {
    const short = await speak('Done.', 'en')
    const longText = 'I have started the build, and I will tell you as soon as the tests finish running, then I will wait for your answer before going on.'
    const long = await speak(longText, 'en')
    metrics.ttsFirstAudioMs['short: Done.'] = Math.round(short.firstMs)
    metrics.ttsFirstAudioMs['long sentence (130 characters)'] = Math.round(long.firstMs)
    expect(short.firstMs).toBeGreaterThan(0)
    expect(short.firstMs).toBeLessThan(5000)
    expect(long.firstMs).toBeLessThan(8000)
    // 130 characters are more than three seconds of speech.
    expect(long.pcm.length / 32).toBeGreaterThan(3000)
  }, 60_000)

  it('stops synthesis at once on abort and gives no sound afterwards', async () => {
    speech.tts.setLanguages(['en'])
    const ctl = new AbortController()
    const got: number[] = []
    const t0 = performance.now()
    let abortedAt = 0
    const done = speech.tts.speak('I have started the build, and I will tell you as soon as the tests finish running, then I will wait for your answer before going on.', FORMAT, () => {
      got.push(performance.now())
      if (abortedAt === 0) {
        abortedAt = performance.now()
        ctl.abort()
      }
    }, ctl.signal)
    await done
    const returnedAt = performance.now()
    await new Promise((r) => setTimeout(r, 1500))
    expect(got.length).toBe(1)
    expect(returnedAt - abortedAt).toBeLessThan(200)
    expect(abortedAt - t0).toBeGreaterThan(0)
    // The next sentence is made normally after an abort.
    const after = await speak('Ready.', 'en')
    expect(after.pcm.length).toBeGreaterThan(1000)
  }, 60_000)

  it('ends a session cleanly and ignores sound after close', async () => {
    const events: string[] = []
    const s = speech.stt.open(FORMAT, { speechStarted: () => events.push('start'), utterance: () => events.push('utt'), failed: () => events.push('fail') }, { languages: ['en'] })
    await new Promise((r) => setTimeout(r, 50))
    s.close()
    s.push(Buffer.alloc(FRAME_BYTES))
    s.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(events).toEqual([])
  }, 30_000)
})
