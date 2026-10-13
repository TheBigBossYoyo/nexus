import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LinphoneSipProvider, type HelperProcess, type SipAccount, type SpawnHelper } from '@main/modules/director-line/linphone-sip-provider'
import type { CallEndReason, PlacedCall, VoiceCall } from '@main/modules/director-line/voice-provider'

// 0.9.1: the real nexus-sip.exe and the real Linphone runtime, two of them, calling each other over 127.0.0.1.
// No server, no account, no sound device, nothing leaves this PC. A tone is sent from one provider and measured at
// the other. Needs vendor/linphone-sdk/win64 (node scripts/fetch-linphone-sdk.mjs).
const runtimeDir = resolve('vendor/linphone-sdk/win64')
const available = process.platform === 'win32' && existsSync(join(runtimeDir, 'liblinphone.dll'))
if (!available) {
  console.warn(
    process.platform !== 'win32'
      ? 'sip-loopback: SKIPPED, the SIP helper is a Windows program.'
      : 'sip-loopback: SKIPPED, vendor/linphone-sdk/win64/liblinphone.dll is absent (run: node scripts/fetch-linphone-sdk.mjs).',
  )
}

const root = resolve('test-results/sip-loopback')
// Folders of earlier runs are cleared when this file starts; one that a scanner still holds is left for the next run.
if (available && existsSync(root)) {
  for (const old of readdirSync(root)) {
    if (old === 'native') continue
    try {
      rmSync(join(root, old), { recursive: true, force: true })
    } catch {
      // still held
    }
  }
}
const children: ChildProcess[] = []
const providers: LinphoneSipProvider[] = []

/**
 * Starts the helper like the product does, but with its own pipes: the shared runner does not yet hand over a child's
 * standard input (see the report of 0.9.1), and this test needs to write to it.
 */
const childSpawn: SpawnHelper = (file, args, handlers) => {
  const env: Record<string, string> = {}
  for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
  children.push(child)
  child.stdin.on('error', () => undefined)
  const lines = (sink: (line: string) => void) => {
    let rest = ''
    return (chunk: Buffer): void => {
      rest += chunk.toString('utf8')
      const parts = rest.split(/\r?\n/)
      rest = parts.pop() ?? ''
      for (const part of parts) sink(part)
    }
  }
  child.stdout.on('data', lines(handlers.stdout))
  child.stderr.on('data', lines(handlers.stderr))
  const exited = new Promise<unknown>((done) => child.on('exit', done))
  const helper: HelperProcess = {
    write: (line) => {
      if (!child.stdin.writable) return false
      child.stdin.write(line)
      return true
    },
    end: () => void child.stdin.end(),
    stop: async () => {
      child.kill()
      await exited
    },
    exited,
  }
  return helper
}

afterEach(async () => {
  for (const p of providers.splice(0)) await p.stop().catch(() => undefined)
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill()
})

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const socket = createSocket('udp4')
    socket.once('error', fail)
    socket.bind(0, '127.0.0.1', () => {
      const port = socket.address().port
      socket.close(() => done(port))
    })
  })
}

function account(identity: string, enc: SipAccount['mediaEncryption']): SipAccount {
  return {
    identity,
    password: '',
    displayName: 'NEXUS loopback',
    server: 'sip:nexus.test',
    transport: 'udp',
    mediaEncryption: enc,
    mediaEncryptionMandatory: enc !== 'none',
    stunServer: null,
    ice: false,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(what: string, test: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`)
    await sleep(25)
  }
}

function tone(hz: number, seconds: number, amplitude = 0.5): Buffer {
  const n = Math.round(seconds * 16000)
  const out = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * hz * i) / 16000)), i * 2)
  return out
}

function samples(buffers: Buffer[]): Int16Array {
  const all = Buffer.concat(buffers)
  return new Int16Array(all.buffer, all.byteOffset, all.length >> 1).slice()
}

function rms(x: Int16Array, from = 0, to = x.length): number {
  let t = 0
  for (let i = from; i < to; i++) t += (x[i] as number) ** 2
  return to > from ? Math.sqrt(t / (to - from)) : 0
}

/** Amplitude of one frequency (Goertzel). */
function amplitudeAt(x: Int16Array, from: number, count: number, hz: number): number {
  const w = (2 * Math.PI * hz) / 16000
  const c = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < count; i++) {
    const s0 = (x[from + i] as number) + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / count
}

async function loopback(name: string, enc: SipAccount['mediaEncryption']) {
  // A fresh folder for every run: a folder of an earlier run may still be held by a scanner for a moment.
  const dir = join(root, `${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const helperPath = (() => {
    const out = join(root, 'native')
    const built = spawnSync(process.execPath, [resolve('scripts/build-sip.mjs'), out], { encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    return join(out, 'nexus-sip.exe')
  })()
  const [portA, portB] = [await freePort(), await freePort()]
  const logs: string[] = []
  const make = (who: 'a' | 'b', port: number, identity: string): LinphoneSipProvider => {
    const provider = new LinphoneSipProvider({
      helperPath,
      runtimeDir,
      stateDir: join(dir, who),
      account: async () => account(identity, enc),
      spawn: childSpawn,
      register: false,
      sipPort: port,
      log: (m) => void logs.push(`${who}: ${m}`),
    })
    providers.push(provider)
    return provider
  }
  const a = make('a', portA, 'sip:caller@nexus.test')
  const b = make('b', portB, 'sip:callee@nexus.test')
  const incoming: VoiceCall[] = []
  await a.start({ incoming: () => undefined, state: () => undefined })
  await b.start({ incoming: (call) => void incoming.push(call), state: () => undefined })
  expect(a.state()).toBe('REGISTERED')
  expect(b.state()).toBe('REGISTERED')
  await sleep(1500) // the helpers start listening a moment after they say ready

  const placed: PlacedCall = await (async () => {
    const pending = a.placeCall(`sip:127.0.0.1:${portB}`, { ringSeconds: 25 })
    await until('the incoming call at B', () => incoming.length === 1)
    const callB = incoming[0] as VoiceCall
    expect(callB.direction).toBe('INBOUND')
    expect(callB.remoteIdentity).toBe('sip:caller@nexus.test')
    expect(callB.identityAssurance).toBe('CLAIMED') // straight between two programs, no account vouches for it
    await callB.answer()
    return pending
  })()
  if (placed.outcome !== 'ANSWERED') throw new Error(`The call was not answered: ${JSON.stringify(placed)}\n${logs.join('\n')}`)
  const callA = placed.call
  const callB = incoming[0] as VoiceCall
  expect(callA.direction).toBe('OUTBOUND')
  const endsA: CallEndReason[] = []
  const endsB: CallEndReason[] = []
  callA.onEnded((r) => void endsA.push(r))
  callB.onEnded((r) => void endsB.push(r))
  const heardB: { at: number; pcm: Buffer }[] = []
  callB.onAudio((pcm) => void heardB.push({ at: performance.now(), pcm }))
  return { a, b, callA, callB, heardB, endsA, endsB, logs }
}

describe.skipIf(!available)('two real SIP helpers calling each other on 127.0.0.1', () => {
  it('carries a 440 Hz tone, stops it on clear, drains, and hangs up', { timeout: 180_000 }, async () => {
    const { callA, callB, heardB, endsA, endsB } = await loopback('plain', 'none')
    await until('media', () => callA.security().media === 'NONE' && callB.security().media === 'NONE', 15_000)
    expect(callA.security()).toEqual({ signalling: 'NONE', media: 'NONE', endToEnd: false, peerVerified: false, sas: null })
    await sleep(500)

    // ---- a tone from A is heard at B
    const mark = heardB.length
    const sentAt = performance.now()
    callA.sendAudio(tone(440, 2))
    await sleep(3200)
    const frames = heardB.slice(mark)
    let firstLoud = -1
    for (const f of frames) {
      if (rms(samples([f.pcm])) > 1500) {
        firstLoud = f.at - sentAt
        break
      }
    }
    expect(firstLoud, 'a loud frame arrived').toBeGreaterThan(0)
    const heard = samples(frames.map((f) => f.pcm))
    let start = 0
    while (start + 160 <= heard.length && rms(heard, start, start + 160) < 1500) start += 160
    const at440 = amplitudeAt(heard, start + 4800, 16000, 440)
    const at1000 = amplitudeAt(heard, start + 4800, 16000, 1000)
    console.log(`sip-loopback (no encryption): provider -> helper -> helper -> provider, first loud 20 ms frame after ${firstLoud.toFixed(0)} ms; amp@440=${at440.toFixed(0)} (sent 16384) amp@1000=${at1000.toFixed(0)}`)
    expect(at440).toBeGreaterThan(0.6 * 16384)
    expect(at440).toBeLessThan(1.2 * 16384)
    expect(at1000).toBeLessThan(0.03 * at440)
    expect(firstLoud).toBeLessThan(1500)
    // every frame is 20 ms
    expect(frames.every((f) => f.pcm.length === 640)).toBe(true)

    // ---- drained: resolves when the queued sound has been played, not before
    const drainStart = performance.now()
    callA.sendAudio(tone(440, 0.6))
    await callA.drained()
    const drainMs = performance.now() - drainStart
    expect(drainMs).toBeGreaterThan(400)
    expect(drainMs).toBeLessThan(3000)

    // ---- clear: ten seconds are queued, one second later they are gone
    callA.sendAudio(tone(1000, 10))
    await sleep(700)
    const clearedAt = performance.now()
    callA.clearAudio()
    await callA.drained() // returns at once: nothing is queued
    await sleep(1500)
    const afterClear = heardB.filter((f) => f.at > clearedAt + 500)
    expect(afterClear.length).toBeGreaterThan(20)
    const tail = rms(samples(afterClear.map((f) => f.pcm)))
    console.log(`sip-loopback: rms of what B heard from 0.5 s after clear on: ${tail.toFixed(1)}`)
    expect(tail).toBeLessThan(300)

    // ---- the other party hangs up
    await callA.hangUp()
    await until('both ended', () => endsA.length === 1 && endsB.length === 1, 10_000)
    expect(endsA).toEqual(['LOCAL_HUNG_UP'])
    expect(endsB).toEqual(['REMOTE_HUNG_UP'])
  })

  it('negotiates ZRTP and reports it as end to end only once its string was verified', { timeout: 180_000 }, async () => {
    const { callA, callB, heardB, endsA, endsB } = await loopback('zrtp', 'zrtp')
    await until('ZRTP on both ends', () => callA.security().media === 'ZRTP' && callB.security().media === 'ZRTP', 20_000)
    // Encrypted, with a string to compare, and not end to end: nobody compared it.
    await until('the string on both ends', () => callA.security().sas !== null && callB.security().sas !== null, 10_000)
    expect(callA.security()).toMatchObject({ signalling: 'NONE', media: 'ZRTP', endToEnd: false, peerVerified: false })
    expect(callB.security()).toMatchObject({ signalling: 'NONE', media: 'ZRTP', endToEnd: false, peerVerified: false })
    expect(callA.security().sas).toMatch(/^[0-9A-Za-z]{4}$/)
    // The person compared the strings: from then on it is end to end.
    callA.confirmSas?.()
    await until('verified on A', () => callA.security().peerVerified, 10_000)
    expect(callA.security()).toMatchObject({ media: 'ZRTP', endToEnd: true, peerVerified: true })
    await sleep(500)
    const mark = heardB.length
    callA.sendAudio(tone(440, 2))
    await sleep(3200)
    const heard = samples(heardB.slice(mark).map((f) => f.pcm))
    let start = 0
    while (start + 160 <= heard.length && rms(heard, start, start + 160) < 1500) start += 160
    const at440 = amplitudeAt(heard, start + 4800, 16000, 440)
    console.log(`sip-loopback (ZRTP): amp@440=${at440.toFixed(0)} (sent 16384)`)
    expect(at440).toBeGreaterThan(0.6 * 16384)
    await callB.hangUp()
    await until('both ended', () => endsA.length === 1 && endsB.length === 1, 10_000)
    expect(endsB).toEqual(['LOCAL_HUNG_UP'])
    expect(endsA).toEqual(['REMOTE_HUNG_UP'])
  })

  it('stops both helpers when the providers stop, within a few seconds', { timeout: 120_000 }, async () => {
    const { a, b } = await loopback('stop', 'none')
    const pids = children.map((c) => c.pid)
    expect(pids.length).toBeGreaterThanOrEqual(2)
    const t0 = performance.now()
    await Promise.all([a.stop(), b.stop()])
    const ms = performance.now() - t0
    console.log(`sip-loopback: both providers stopped (call in progress) in ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(5000)
    expect(children.every((c) => c.exitCode !== null || c.signalCode !== null)).toBe(true)
  })
})

describe.skipIf(!available)('what the real helper does with calls it does not manage', () => {
  async function pair(): Promise<{ b: LinphoneSipProvider; portB: number; incoming: VoiceCall[]; make: (who: string, identity: string) => LinphoneSipProvider; logs: string[] }> {
    const dir = join(root, `unmanaged-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const out = join(root, 'native')
    const built = spawnSync(process.execPath, [resolve('scripts/build-sip.mjs'), out], { encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    const helperPath = join(out, 'nexus-sip.exe')
    const logs: string[] = []
    const make = (who: string, identity: string, port = -1): LinphoneSipProvider => {
      const provider = new LinphoneSipProvider({ helperPath, runtimeDir, stateDir: join(dir, who), account: async () => account(identity, 'none'), spawn: childSpawn, register: false, sipPort: port, log: (m) => void logs.push(`${who}: ${m}`) })
      providers.push(provider)
      return provider
    }
    const portB = await freePort()
    const incoming: VoiceCall[] = []
    const b = make('b', 'sip:callee@nexus.test', portB)
    await b.start({ incoming: (call) => void incoming.push(call), state: () => undefined })
    await sleep(1500)
    return { b, portB, incoming, make: (who, identity) => make(who, identity), logs }
  }

  it('a caller whose address is far too long is declined at once and never announced; the next caller gets through', { timeout: 120_000 }, async () => {
    const { portB, incoming, make, logs } = await pair()
    const long = make('long', `sip:${'a'.repeat(400)}@nexus.test`)
    await long.start({ incoming: () => undefined, state: () => undefined })
    await sleep(1000)
    const t0 = Date.now()
    const refused = await long.placeCall(`sip:127.0.0.1:${portB}`, { ringSeconds: 20 })
    // Declined at once: not after the 45 s the helper lets a call ring.
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(refused.outcome).not.toBe('ANSWERED')
    expect(incoming).toHaveLength(0)
    expect(logs.join('\n')).not.toContain('printed something that is not an event')
    // The helper is free for the next one.
    const ok = make('ok', 'sip:caller@nexus.test')
    await ok.start({ incoming: () => undefined, state: () => undefined })
    await sleep(1000)
    const pending = ok.placeCall(`sip:127.0.0.1:${portB}`, { ringSeconds: 20 })
    await until('the incoming call at B', () => incoming.length === 1)
    expect(incoming[0]?.remoteIdentity).toBe('sip:caller@nexus.test')
    await incoming[0]?.hangUp()
    await pending
  })

  it('a call while another is in progress is declined as busy, and the call in progress is not disturbed', { timeout: 120_000 }, async () => {
    const { portB, incoming, make } = await pair()
    const first = make('first', 'sip:one@nexus.test')
    const second = make('second', 'sip:two@nexus.test')
    await first.start({ incoming: () => undefined, state: () => undefined })
    await second.start({ incoming: () => undefined, state: () => undefined })
    await sleep(1000)
    const pendingFirst = first.placeCall(`sip:127.0.0.1:${portB}`, { ringSeconds: 20 })
    await until('the first call at B', () => incoming.length === 1)
    await incoming[0]?.answer()
    const placed = await pendingFirst
    expect(placed.outcome).toBe('ANSWERED')
    const refused = await second.placeCall(`sip:127.0.0.1:${portB}`, { ringSeconds: 20 })
    expect(refused.outcome).toBe('BUSY')
    expect(incoming).toHaveLength(1)
    expect(incoming[0]?.security().media).not.toBe('UNKNOWN')
    await incoming[0]?.hangUp()
  })
})
