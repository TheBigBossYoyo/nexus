import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import { DirectorVoice } from '@main/modules/director-line/director-voice'
import { interpretMessage } from '@main/modules/director-line/intent'
import { LinphoneSipProvider } from '@main/modules/director-line/linphone-sip-provider'
import { LocalSpeech } from '@main/modules/director-line/local-speech'
import { DEFAULT_VOICE_LINE_POLICY, DirectorVoiceLine, type CallRecord } from '@main/modules/director-line/voice-line'
import { normalizeSipIdentity, type VoiceCall } from '@main/modules/director-line/voice-provider'

// Manually invoked only (`pnpm smoke:voice-call`, after `pnpm build`). A rehearsal of a whole call WITHOUT the
// owner's telephone: a second SIP endpoint on this PC, signed in to the "phone" account, calls the NEXUS account
// through their SIP service and "speaks" with a synthetic voice; the NEXUS side is the real voice line: the real
// SIP helper, the real speech engines, a real model session. What the stand-in hears back is transcribed.
//
// It is not the acceptance: both ends are on one PC behind one router, the caller's voice is synthetic, and the
// paired identity alone opens the line here (no PIN), because a synthetic voice cannot key one in.
// Uses a few model turns of the fast tier. What was measured goes to test-results/voice-call/, without passwords.
const accountsFile = process.env['NEXUS_SIP_ACCOUNTS'] ?? join(homedir(), 'nexus-sip-accounts.json')
const runtimeDir = resolve('vendor/linphone-sdk/win64')
const modelsDir = resolve('vendor/speech-models')
const workerPath = resolve('out/main/speech-worker.js')
const out = resolve('test-results/voice-call')
const FACTS = 'NEXUS status\nRaceDeck: 73%, verifying. 25–40 min of active work remain. Tasks: 16 done, 2 running.'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) return false
    await sleep(20)
  }
  return true
}
const loud = (pcm: Buffer): boolean => {
  let t = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) t += pcm.readInt16LE(i) ** 2
  return Math.sqrt(t / Math.max(1, pcm.length / 2)) > 600
}

const cleanup: (() => Promise<unknown>)[] = []
afterAll(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined)
})

it('a whole call, with a stand-in for the telephone', async () => {
  for (const [what, path] of [['the accounts file', accountsFile], ['vendor/linphone-sdk', join(runtimeDir, 'liblinphone.dll')], ['out/main/speech-worker.js (pnpm build)', workerPath]] as const) expect(existsSync(path), what).toBe(true)
  expect(LocalSpeech.check(modelsDir).ok, 'vendor/speech-models').toBe(true)
  const accounts = JSON.parse(readFileSync(accountsFile, 'utf8')) as Record<'nexus' | 'phone', { address: string; password: string }>
  expect(spawnSync(process.execPath, [resolve('scripts/build-sip.mjs')], { encoding: 'utf8' }).status).toBe(0)
  const helperPath = resolve('out/native/nexus-sip.exe')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(join(out, 'cwd'), { recursive: true })
  const sherpa = createRequire(import.meta.url).resolve('sherpa-onnx-node')
  const logs: string[] = []
  const log = (who: string) => (m: string) => void logs.push(`${Date.now()} ${who}: ${m}`)
  const result: Record<string, unknown> = { at: stamp }
  const write = (): void => writeFileSync(join(out, `voice-call-${stamp}.json`), JSON.stringify({ ...result, logs: logs.filter((l) => !/passw/i.test(l)).slice(-120) }, null, 1))

  const provider = (who: 'nexus' | 'phone'): LinphoneSipProvider => {
    const identity = normalizeSipIdentity(accounts[who].address) as string
    const p = new LinphoneSipProvider({
      helperPath,
      runtimeDir,
      stateDir: join(out, `state-${who}-${stamp}`),
      account: async () => ({ identity, password: accounts[who].password, displayName: who === 'nexus' ? 'NEXUS Director' : 'Phone (rehearsal)', server: `sip:${identity.split('@')[1]};transport=tls`, transport: 'tls', mediaEncryption: 'zrtp', mediaEncryptionMandatory: true, stunServer: null, ice: false }),
      log: log(`sip-${who}`),
    })
    cleanup.push(() => p.stop())
    return p
  }
  const nexusIdentity = normalizeSipIdentity(accounts.nexus.address) as string
  const phoneIdentity = normalizeSipIdentity(accounts.phone.address) as string

  // ---- The NEXUS side: the real voice line.
  const nexusSpeech = LocalSpeech.create({ sherpa, modelsDir, threads: 4, workerPath, log: log('speech-nexus') })
  cleanup.push(() => nexusSpeech.dispose())
  nexusSpeech.tts.setLanguages(['en', 'fr'])
  nexusSpeech.setHints(['RaceDeck'])
  const runtime = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })
  const turns: { outcome: string; firstWordMs: number | null }[] = []
  const performed: string[] = []
  const records: CallRecord[] = []
  const line = new DirectorVoiceLine({
    channel: 'SIP_VOICE',
    provider: provider('nexus'),
    stt: nexusSpeech.stt,
    tts: nexusSpeech.tts,
    turns: null,
    languages: ['en', 'fr'],
    pairedIdentity: async () => phoneIdentity,
    authenticate: async (identity) => (identity === phoneIdentity ? 'OK' : 'WRONG_NUMBER'),
    interpret: async (text) => ({ text, command: await interpretMessage(text) }),
    perform: async ({ command, text }) => {
      performed.push(`${command.kind}: ${text}`)
      if (command.kind === 'UNKNOWN') return 'I did not understand that.'
      if (command.kind === 'REFUSED_AT_MACHINE') return 'That is decided at the machine, not from here.'
      if (command.kind === 'BLOCKERS') return 'Nothing is blocking.'
      if (command.kind === 'ADD_TASK_AFTER_CURRENT' || command.kind === 'CREATE_TASK') return 'Task received and sent through the normal checks.'
      return FACTS
    },
    generalFacts: async () => FACTS,
    directorVoice: () => new DirectorVoice({ runtime, cwd: join(out, 'cwd'), model: 'haiku', subscriptionMode: true, onTurn: (t) => void turns.push({ outcome: t.outcome, firstWordMs: t.firstWordMs }) }),
    policy: () => ({ ...DEFAULT_VOICE_LINE_POLICY, requirePin: false }),
    mediaEncryptionMandatory: true,
    fallback: async (text) => void logs.push(`fallback message: ${text.length} characters`),
    record: (r) => void records.push(r),
    log: log('line'),
  })
  cleanup.push(() => line.stop())

  // ---- The stand-in for the telephone.
  const phoneSpeech = LocalSpeech.create({ sherpa, modelsDir, threads: 2, workerPath, log: log('speech-phone') })
  cleanup.push(() => phoneSpeech.dispose())
  phoneSpeech.tts.setLanguages(['en'])
  const phone = provider('phone')

  await Promise.all([nexusSpeech.warm(), phoneSpeech.warm()])
  await line.start()
  void phone.start({ incoming: () => undefined, state: () => undefined })
  const registered = await until(() => line.state() === 'REGISTERED' && phone.state() === 'REGISTERED', 40_000)
  result['registered'] = registered
  if (!registered) {
    write()
    throw new Error('not registered')
  }

  const placed = await phone.placeCall(nexusIdentity, { ringSeconds: 30 })
  result['placed'] = placed.outcome
  if (placed.outcome !== 'ANSWERED') {
    write()
    throw new Error(`NEXUS did not answer: ${placed.outcome}`)
  }
  const call: VoiceCall = placed.call
  // What the stand-in hears: transcribed, and timed.
  const heard: { at: number; text: string }[] = []
  let lastLoudAt = 0
  let firstLoudAfter: number | null = null
  let waitingSince: number | null = null
  const ears = phoneSpeech.stt.open(call.format, { utterance: (text) => void heard.push({ at: Date.now(), text }), failed: (r) => void logs.push(`phone ears failed: ${r}`) }, { languages: ['en'] })
  call.onAudio((pcm) => {
    ears.push(pcm)
    if (loud(pcm)) {
      lastLoudAt = Date.now()
      if (waitingSince !== null && firstLoudAfter === null) firstLoudAfter = Date.now() - waitingSince
    }
  })
  const quiet = (ms: number, max = 25_000): Promise<boolean> => until(() => lastLoudAt !== 0 && Date.now() - lastLoudAt > ms, max)
  /** Says a sentence into the call and returns when its sound has been sent. */
  const say = async (text: string): Promise<void> => {
    const chunks: Buffer[] = []
    await phoneSpeech.tts.speak(text, call.format, (pcm) => void chunks.push(pcm), new AbortController().signal)
    const all = Buffer.concat(chunks)
    call.sendAudio(all)
    await sleep((all.length / 2 / call.format.sampleRate) * 1000)
    waitingSince = Date.now()
    firstLoudAfter = null
  }
  const exchanges: Record<string, unknown>[] = []
  const exchange = async (text: string): Promise<void> => {
    const from = heard.length
    await say(text)
    await until(() => firstLoudAfter !== null, 20_000)
    const answerAfterMs = firstLoudAfter
    await quiet(1500)
    await sleep(1200)
    exchanges.push({ said: text, answerAfterMs, heard: heard.slice(from).map((h) => h.text) })
  }

  // 1. The greeting.
  await quiet(1500)
  await sleep(1200)
  result['greeting'] = heard.map((h) => h.text)
  // 2. Questions, a question outside the commands, and something that needs the machine.
  await exchange('How is RaceDeck going?')
  await exchange('What is blocking it?')
  await exchange('Push the repository.')
  // 3. Speaking over an answer: the answer must stop.
  await say('What is the status?')
  await until(() => firstLoudAfter !== null, 20_000)
  await sleep(700)
  const cutAt = Date.now()
  const over = say('What is blocking it?')
  await sleep(900)
  const stillLoudAfterMs = lastLoudAt > cutAt ? lastLoudAt - cutAt : 0
  await over
  await quiet(1500)
  await sleep(1200)
  result['bargeIn'] = { nexusKeptSpeakingForMs: stillLoudAfterMs, heardAfter: heard.slice(-2).map((h) => h.text) }
  // 4. Goodbye: NEXUS says it and hangs up.
  let ended = false
  call.onEnded(() => (ended = true))
  await say('Goodbye.')
  result['nexusHungUp'] = await until(() => ended, 15_000)
  if (!ended) await call.hangUp()
  await sleep(1500)
  ears.close()

  result['exchanges'] = exchanges
  result['performed'] = performed
  result['modelTurns'] = turns
  result['security'] = call.security()
  result['records'] = records
  write()
  console.log(JSON.stringify(result))
  expect(records).toHaveLength(1)
}, 400_000)
