import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SherpaVoices } from '@main/modules/director-line/local-speech'
import type { SherpaModule } from '@main/modules/director-line/local-speech-core'

/**
 * 0.9.1: speech synthesis inside Electron. Every sentence of the voice line failed in the installed application
 * ("a sentence could not be synthesized"): Electron's V8 sandbox refuses the buffer over native memory that
 * sherpa-onnx hands back by default ("External buffers are not allowed"), and the rehearsals had run under plain
 * Node, where it is allowed. Found on 2026-10-14 when the owner answered a call and heard nothing.
 */

const electron = resolve('node_modules', 'electron', 'dist', 'electron.exe')
const models = resolve('vendor', 'speech-models')
const voice = join(models, 'tts-piper-en_US-ljspeech-medium')
const runnable = process.platform === 'win32' && existsSync(electron) && existsSync(join(voice, 'en_US-ljspeech-medium.onnx'))

describe('speech synthesis in Electron', () => {
  it('asks the library for an ordinary buffer, never one over its native memory', async () => {
    const requests: Record<string, unknown>[] = []
    const fake = {
      OfflineTts: {
        createAsync: async () => ({
          generateAsync: async (request: Record<string, unknown>) => {
            requests.push(request)
            return { samples: new Float32Array(10), sampleRate: 22050 }
          },
        }),
      },
    } as unknown as SherpaModule
    const voices = new SherpaVoices(fake, models, 1)
    await voices.synth('en', 'Please enter your PIN.', new AbortController().signal)
    expect(requests[0]).toMatchObject({ enableExternalBuffer: false })
  })

  it.runIf(runnable)('synthesizes a sentence in the Electron runtime with that setting, and fails without it (the cause)', () => {
    const dir = resolve('test-results', 'speech-in-electron')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'tts.cjs')
    writeFileSync(
      script,
      [
        "const path = require('path')",
        "const sherpa = require(process.argv[2])",
        'const dir = process.argv[3]',
        "const cfg = { model: { vits: { model: path.join(dir, 'en_US-ljspeech-medium.onnx'), tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data') }, debug: false, numThreads: 1, provider: 'cpu' }, maxNumSentences: 1 }",
        'sherpa.OfflineTts.createAsync(cfg).then(async (tts) => {',
        "  const ok = await tts.generateAsync({ text: 'Please enter your PIN.', sid: 0, speed: 1, enableExternalBuffer: false })",
        "  let external = 'worked'",
        "  try { await tts.generateAsync({ text: 'Hello.', sid: 0, speed: 1 }) } catch (e) { external = 'failed' }",
        "  console.log(JSON.stringify({ samples: ok.samples.length, rate: ok.sampleRate, external }))",
        "}).catch((e) => console.log(JSON.stringify({ error: String(e && e.message) })))",
      ].join('\n'),
    )
    const r = spawnSync(electron, [script, resolve('node_modules', 'sherpa-onnx-node'), voice], { encoding: 'utf8', windowsHide: true, timeout: 120_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { samples?: number; rate?: number; external?: string; error?: string }
    expect(out.error).toBeUndefined()
    expect(out.samples).toBeGreaterThan(10_000)
    expect(out.rate).toBe(22050)
    // The library's default fails here; if a later Electron or sherpa-onnx changes that, this says so.
    expect(out.external).toBe('failed')
  }, 150_000)
})
