import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { LinphoneSipProvider, type SipAccount } from '@main/modules/director-line/linphone-sip-provider'
import { normalizeSipIdentity, type VoiceCall, type VoiceProviderState } from '@main/modules/director-line/voice-provider'

// Manually invoked only (`pnpm smoke:sip`). A REAL call through the SIP service of the two accounts in the owner's
// accounts file: the "phone" account, registered from this PC, calls the "nexus" account, also on this PC. The
// call goes in that direction so that the owner's telephone, which may be signed in to the phone account, does
// not ring. Nothing is printed of the passwords; what was measured is written to test-results/sip-real/.
//
// Both ends are behind the same router here, so this says nothing about a telephone on a mobile network.
const accountsFile = process.env['NEXUS_SIP_ACCOUNTS'] ?? join(homedir(), 'nexus-sip-accounts.json')
const runtimeDir = resolve('vendor/linphone-sdk/win64')
const out = resolve('test-results/sip-real')
const stun = process.env['NEXUS_SIP_STUN'] ?? ''
const enc = (process.env['NEXUS_SIP_ENC'] ?? 'zrtp') as SipAccount['mediaEncryption']

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(what: string, test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) return false
    await sleep(25)
  }
  return true
}
function tone(hz: number, seconds: number): Buffer {
  const n = Math.round(seconds * 16000)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * hz * i) / 16000)), i * 2)
  return b
}
function amplitudeAt(buffers: Buffer[], hz: number): number {
  const all = Buffer.concat(buffers)
  const x = new Int16Array(all.buffer, all.byteOffset, all.length >> 1)
  // The loudest second of what was heard.
  let best = 0
  for (let from = 0; from + 16000 <= x.length; from += 4000) {
    const c = 2 * Math.cos((2 * Math.PI * hz) / 16000)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < 16000; i++) {
      const s0 = (x[from + i] as number) + c * s1 - s2
      s2 = s1
      s1 = s0
    }
    best = Math.max(best, (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / 16000)
  }
  return Math.round(best)
}

const providers: LinphoneSipProvider[] = []
afterAll(async () => {
  for (const p of providers) await p.stop().catch(() => undefined)
})

it('a real call between the two accounts through their SIP service', async () => {
  expect(existsSync(accountsFile), 'the accounts file').toBe(true)
  expect(existsSync(join(runtimeDir, 'liblinphone.dll')), 'vendor/linphone-sdk (pnpm fetch:linphone)').toBe(true)
  const accounts = JSON.parse(readFileSync(accountsFile, 'utf8')) as Record<'nexus' | 'phone', { address: string; password: string }>
  const built = spawnSync(process.execPath, [resolve('scripts/build-sip.mjs')], { encoding: 'utf8' })
  expect(built.status, built.stderr).toBe(0)
  const helperPath = resolve('out/native/nexus-sip.exe')
  mkdirSync(out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const result: Record<string, unknown> = { at: stamp, mediaEncryption: enc, stun: stun || null }
  const logs: string[] = []

  const make = (who: 'nexus' | 'phone'): { provider: LinphoneSipProvider; identity: string; states: VoiceProviderState[]; incoming: VoiceCall[] } => {
    const identity = normalizeSipIdentity(accounts[who].address) as string
    const domain = identity.split('@')[1] as string
    const states: VoiceProviderState[] = []
    const incoming: VoiceCall[] = []
    const provider = new LinphoneSipProvider({
      helperPath,
      runtimeDir,
      stateDir: join(out, `state-${who}-${stamp}`),
      account: async () => ({ identity, password: accounts[who].password, displayName: who === 'nexus' ? 'NEXUS Director' : 'Phone (test)', server: `sip:${domain};transport=tls`, transport: 'tls', mediaEncryption: enc, mediaEncryptionMandatory: enc !== 'none', stunServer: stun || null, ice: stun !== '' }),
      log: (m) => void logs.push(`${who}: ${m}`),
    })
    providers.push(provider)
    void provider.start({ incoming: (c) => void incoming.push(c), state: (s) => void states.push(s) })
    return { provider, identity, states, incoming }
  }
  const nexus = make('nexus')
  const phone = make('phone')
  const registered = await until('both registered', () => nexus.provider.state() === 'REGISTERED' && phone.provider.state() === 'REGISTERED', 40_000)
  result['registration'] = { nexus: nexus.provider.state(), phone: phone.provider.state() }
  const write = (): void => writeFileSync(join(out, `sip-real-${stamp}.json`), JSON.stringify({ ...result, logs: logs.filter((l) => !/passw/i.test(l)).slice(-80) }, null, 1))
  if (!registered) {
    write()
    throw new Error(`not registered: ${JSON.stringify(result['registration'])}`)
  }

  const t0 = Date.now()
  const pending = phone.provider.placeCall(nexus.identity, { ringSeconds: 30 })
  const rang = await until('the call arrives at NEXUS', () => nexus.incoming.length > 0, 30_000)
  result['incomingAfterMs'] = rang ? Date.now() - t0 : null
  if (!rang) {
    result['placed'] = await pending
    write()
    throw new Error('the call did not arrive at the NEXUS account')
  }
  const callN = nexus.incoming[0] as VoiceCall
  result['incoming'] = { remoteIdentity: callN.remoteIdentity, expected: phone.identity, identityAssurance: callN.identityAssurance }
  const heardByNexus: Buffer[] = []
  const heardByPhone: Buffer[] = []
  callN.onAudio((pcm) => void heardByNexus.push(pcm))
  await callN.answer()
  const placed = await pending
  result['placed'] = placed.outcome
  result['answeredAfterMs'] = Date.now() - t0
  if (placed.outcome !== 'ANSWERED') {
    write()
    throw new Error(`the call was not answered: ${placed.outcome}`)
  }
  const callP = placed.call
  callP.onAudio((pcm) => void heardByPhone.push(pcm))
  await sleep(2500) // the key exchange of ZRTP ends a moment after the call is up
  callP.sendAudio(tone(440, 3))
  callN.sendAudio(tone(880, 3))
  await sleep(4500)
  result['audio'] = { phoneToNexus440: amplitudeAt(heardByNexus, 440), nexusToPhone880: amplitudeAt(heardByPhone, 880), sent: 16384, framesAtNexus: heardByNexus.length, framesAtPhone: heardByPhone.length }
  result['security'] = { nexus: callN.security(), phone: callP.security() }
  await callP.hangUp()
  await sleep(1500)
  write()
  console.log(JSON.stringify(result))
  expect((result['audio'] as { phoneToNexus440: number }).phoneToNexus440).toBeGreaterThan(4000)
  expect((result['audio'] as { nexusToPhone880: number }).nexusToPhone880).toBeGreaterThan(4000)
}, 180_000)
