import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMUNICATION_POLICY } from '@shared/director-line'
import { ipcInputs } from '@shared/ipc'
import { openDatabase } from '@main/modules/persistence'
import { createDirectorLineRuntime, MemorySecretStore } from '@main/modules/director-line/runtime'
import type { HttpFetch } from '@main/modules/director-line/provider'
import { createDirectorLineHandlers, policyWidens } from '@main/modules/ipc/v9-handlers'

const TOKEN = '987654321:AAHandlersHandlersHandlers_QRST'
const SIP_PASSWORD = 'sip-handlers-password-0123456789'
const PIN = '482915'

/** A Bot API that answers getMe and sendMessage and never has an update. Nothing leaves the process. */
const idleFetch: HttpFetch = async (url, init) => {
  const method = url.split('/').pop()
  if (method === 'getUpdates') {
    await new Promise<void>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  return { status: 200, json: async () => ({ ok: true, result: method === 'getMe' ? { username: 'bot' } : { message_id: 1 } }) }
}

function rig(confirm?: (title: string, message: string, detail: string, accept: string) => Promise<boolean>) {
  const db = openDatabase(':memory:')
  const secrets = new MemorySecretStore()
  const runtime = createDirectorLineRuntime({
    db, secrets, fetch: idleFetch,
    reads: { getStatus: async () => ({ snapshots: [], facts: { paused: false, online: true, pendingBoundaryRequests: 0 } }), getOvernightReport: async () => null, getLatestChecks: async () => null },
    actions: { pauseAfterCurrentTask: async () => undefined, resume: async () => undefined, submitIntent: async () => ({ accepted: true }) },
    isOnline: () => true, localNotify: async () => undefined, recordNote: () => undefined, machineTimeZone: 'UTC',
  })
  const handlers = createDirectorLineHandlers({ directorLine: runtime, ...(confirm ? { confirm } : {}) })
  return { db, secrets, runtime, handlers, close: async () => { await runtime.stop(); db.close() } }
}

const SIP = { identity: 'sip:nexus-test@sip.linphone.org', password: SIP_PASSWORD, operatorIdentity: 'sip:owner-test@sip.linphone.org', mediaEncryption: 'zrtp' as const, mediaEncryptionMandatory: true, stunServer: null, ice: true }
const VOICE_POLICY_NO_PIN = { requirePin: false, ringSeconds: 30, maxPlacedCallsPerDay: 6, minMinutesBetweenPlacedCalls: 10 }
const policyWithCalls = () => {
  const p = structuredClone(DEFAULT_COMMUNICATION_POLICY)
  p.events.ETA_SLIPPED.enabled = true
  p.events.ETA_SLIPPED.call = true
  return p
}

type Call = { name: string; run: (h: ReturnType<typeof rig>['handlers']) => Promise<unknown> }
const CONFIRMING: Call[] = [
  { name: 'setEnabled(true)', run: (h) => h['directorLine.setEnabled']({ enabled: true }) as Promise<unknown> },
  { name: 'setProvider telegram', run: (h) => h['directorLine.setProvider']({ kind: 'TELEGRAM', secret: TOKEN }) as Promise<unknown> },
  { name: 'setSip', run: (h) => h['directorLine.setSip'](SIP) as Promise<unknown> },
  { name: 'removeSip', run: (h) => h['directorLine.removeSip']({}) as Promise<unknown> },
  { name: 'setVoicePolicy that turns the PIN off', run: (h) => h['directorLine.setVoicePolicy'](VOICE_POLICY_NO_PIN) as Promise<unknown> },
  { name: 'setPolicy that enables calls', run: (h) => h['directorLine.setPolicy']({ policy: policyWithCalls() }) as Promise<unknown> },
  { name: 'setPin', run: (h) => h['directorLine.setPin']({ pin: PIN }) as Promise<unknown> },
]

describe('director line handlers: native confirmation', () => {
  it('without a confirm function every confirming channel refuses and changes nothing', async () => {
    const r = rig()
    for (const c of CONFIRMING) await expect(c.run(r.handlers), c.name).rejects.toThrow(/Nothing was changed/)
    // startPairing needs the line on first, so prepare that state directly through the runtime, then ask.
    await r.runtime.setProvider({ kind: 'TELEGRAM', secret: TOKEN })
    await r.runtime.setEnabled(true)
    await expect(r.handlers['directorLine.startPairing']({ channel: 'TELEGRAM' })).rejects.toThrow(/Nothing was changed/)
    expect(await r.runtime.pairing.isPairingOpen()).toBe(false)
    await r.runtime.setEnabled(false)
    await r.runtime.setProvider({ kind: 'TELEGRAM', secret: null })

    const view = await r.runtime.settingsView()
    expect(view.enabled).toBe(false)
    expect(view.pinConfigured).toBe(false)
    expect(view.voice).toMatchObject({ configured: false, identity: null, passwordSet: false, operatorIdentity: null })
    expect(view.voice.policy.requirePin).toBe(true)
    expect(view.policy).toEqual(DEFAULT_COMMUNICATION_POLICY)
    expect(await r.secrets.get('sip.password')).toBeNull()
    await r.close()
  })

  it('a declining confirm refuses likewise, and is asked in plain words what is being allowed', async () => {
    const confirm = vi.fn(async () => false)
    const r = rig(confirm)
    for (const c of CONFIRMING) await expect(c.run(r.handlers), c.name).rejects.toThrow(/Nothing was changed/)
    expect(confirm).toHaveBeenCalledTimes(CONFIRMING.length)
    const enableText = confirm.mock.calls.find((c) => (c as unknown as string[])[0] === 'Turn on the Director Line') as unknown as string[]
    expect(enableText[2]).toMatch(/status/)
    expect(enableText[2]).toMatch(/pause/)
    expect(enableText[2]).toMatch(/add tasks/)
    expect(enableText[2]).toMatch(/never:/)
    expect(enableText[2]).toMatch(/grant or approve a boundary request/)
    expect(enableText[2]).toMatch(/push/)
    expect(enableText[2]).toMatch(/change settings/)
    const view = await r.runtime.settingsView()
    expect(view.enabled).toBe(false)
    expect(view.messageProvider.configured).toBe(false)
    expect(view.pinConfigured).toBe(false)
    expect(await r.secrets.get('telegram.botToken')).toBeNull()
    await r.close()
  })

  it('an accepting confirm lets it work, and no output carries the token, the PIN or the pairing code', async () => {
    const confirm = vi.fn(async () => true)
    const r = rig(confirm)
    const outputs: unknown[] = []
    outputs.push(await r.handlers['directorLine.setProvider']({ kind: 'TELEGRAM', secret: TOKEN }))
    outputs.push(await r.handlers['directorLine.setSip'](SIP))
    outputs.push(await r.handlers['directorLine.setEnabled']({ enabled: true }))
    outputs.push(await r.handlers['directorLine.setPin']({ pin: PIN }))
    outputs.push(await r.handlers['directorLine.setPolicy']({ policy: policyWithCalls() }))
    outputs.push(await r.handlers['directorLine.get']({}))
    outputs.push(await r.handlers['directorLine.sendTestMessage']({}))
    outputs.push(await r.handlers['directorLine.setVoicePolicy']({ ...VOICE_POLICY_NO_PIN, requirePin: true, ringSeconds: 45 }))
    outputs.push(await r.handlers['directorLine.callMe']({}))
    outputs.push(await r.handlers['directorLine.hangUpCall']({}))
    outputs.push(await r.handlers['directorLine.unpair']({}))

    const view = await r.handlers['directorLine.get']({})
    expect(view.enabled).toBe(true)
    expect(view.messageProvider).toMatchObject({ kind: 'TELEGRAM', configured: true, tokenSuffix: TOKEN.slice(-4) })
    expect(view.voice).toMatchObject({ configured: true, identity: 'sip:nexus-test@sip.linphone.org', passwordSet: true, operatorIdentity: null, mediaEncryption: 'zrtp' }) // the unpair above removed the phone's authority
    expect(view.voice.policy.ringSeconds).toBe(45)
    expect(await r.handlers['directorLine.callMe']({})).toEqual({ result: 'NOT_CONFIGURED' })
    expect(view.pinConfigured).toBe(true)
    expect(view.policy.events.ETA_SLIPPED.call).toBe(true)

    // The pairing code is returned once, by startPairing, and by nothing else.
    const pairing = await r.handlers['directorLine.startPairing']({ channel: 'TELEGRAM' })
    expect(pairing.displayCode).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){2}$/)
    expect(new Date(pairing.expiresAt).getTime()).toBeGreaterThan(Date.now())
    const code = pairing.displayCode.replace(/-/g, '')
    outputs.push(await r.handlers['directorLine.get']({}))
    outputs.push(await r.handlers['directorLine.unpair']({ channel: 'TELEGRAM' }))

    const text = JSON.stringify(outputs)
    for (const secret of [TOKEN, SIP_PASSWORD, PIN, code, pairing.displayCode]) expect(text, secret).not.toContain(secret)
    expect(JSON.stringify(await r.handlers['directorLine.setPin']({ pin: PIN }))).toBe('{"configured":true}')
    expect(confirm.mock.calls.length).toBeGreaterThanOrEqual(7)
    await r.handlers['directorLine.setVoicePolicy'](VOICE_POLICY_NO_PIN)
    expect((confirm.mock.calls.at(-1) as unknown as string[])[0]).toBe('Change what a call may do')
    await r.close()
  })

  it('narrowing, unpairing and disabling need no question; pairing is refused before the question when the line is not ready', async () => {
    const confirm = vi.fn(async () => true)
    const r = rig(confirm)
    await expect(r.handlers['directorLine.startPairing']({ channel: 'TELEGRAM' })).rejects.toThrow(/Turn the Director Line on/)
    expect(confirm).not.toHaveBeenCalled()
    await r.handlers['directorLine.setEnabled']({ enabled: false })
    expect(await r.handlers['directorLine.unpair']({})).toEqual({ removed: 0 })
    const narrower = structuredClone(DEFAULT_COMMUNICATION_POLICY)
    narrower.events.PROGRAM_COMPLETE.call = false
    narrower.requirePinForStatus = true
    await r.handlers['directorLine.setPolicy']({ policy: narrower })
    expect(confirm).not.toHaveBeenCalled()
    await r.close()
  })

  it('names exactly the policy changes that widen what NEXUS does on its own', () => {
    const base = DEFAULT_COMMUNICATION_POLICY
    expect(policyWidens(base, base)).toEqual([])
    const quiet = structuredClone(base); quiet.quietHours.enabled = false
    const critical = structuredClone(base); critical.quietHours.criticalBreaksQuiet = true
    const pin = structuredClone(base); pin.requirePinForStatus = false
    expect(policyWidens(base, quiet)).toHaveLength(1)
    expect(policyWidens(base, critical)).toHaveLength(1)
    expect(policyWidens(base, pin)).toHaveLength(1)
    expect(policyWidens(base, policyWithCalls())).toHaveLength(1)
  })
})

describe('director line input schemas', () => {
  it('bound the token and the PIN and refuse unknown fields', () => {
    const set = ipcInputs['directorLine.setProvider']
    expect(set.safeParse({ kind: 'TELEGRAM', secret: TOKEN }).success).toBe(true)
    expect(set.safeParse({ kind: 'TELEGRAM', secret: null }).success).toBe(true)
    expect(set.safeParse({ kind: 'TELEGRAM', secret: 'short' }).success).toBe(false)
    expect(set.safeParse({ kind: 'TELEGRAM', secret: 'x'.repeat(257) }).success).toBe(false)
    expect(set.safeParse({ kind: 'TELEGRAM', secret: 'has a space in it' }).success).toBe(false)
    expect(set.safeParse({ kind: 'TWILIO_VOICE', secret: TOKEN }).success).toBe(false) // voice is SIP since 0.9.1
    expect(set.safeParse({ kind: 'TELEGRAM', secret: TOKEN, extra: { relayBaseUrl: 'https://relay.example' } }).success).toBe(false)
    expect(set.safeParse({ kind: 'TELEGRAM', secret: TOKEN, surprise: 1 }).success).toBe(false)
    const pin = ipcInputs['directorLine.setPin']
    for (const ok of ['123456', '123456789012']) expect(pin.safeParse({ pin: ok }).success, ok).toBe(true)
    for (const bad of ['12345', '1234567890123', '12345a', ' 123456']) expect(pin.safeParse({ pin: bad }).success, bad).toBe(false)
    expect(ipcInputs['directorLine.setPolicy'].safeParse({ policy: DEFAULT_COMMUNICATION_POLICY }).success).toBe(true)
    expect(ipcInputs['directorLine.setPolicy'].safeParse({ policy: { ...DEFAULT_COMMUNICATION_POLICY, maxCallAttempts: 50 } }).success).toBe(false)
  })

  it('bound the SIP account: both addresses must normalise, the password is 1 to 128 characters or null', () => {
    const set = ipcInputs['directorLine.setSip']
    expect(set.safeParse(SIP).success).toBe(true)
    expect(set.safeParse({ ...SIP, password: null }).success).toBe(true)
    expect(set.safeParse({ ...SIP, identity: 'sip:Nexus@SIP.Linphone.org', operatorIdentity: '<sip:me@sip.linphone.org>' }).success).toBe(true)
    expect(set.safeParse({ ...SIP, identity: 'not an address' }).success).toBe(false)
    expect(set.safeParse({ ...SIP, operatorIdentity: '+33612345678' }).success).toBe(false)
    expect(set.safeParse({ ...SIP, password: '' }).success).toBe(false)
    expect(set.safeParse({ ...SIP, password: 'x'.repeat(129) }).success).toBe(false)
    expect(set.safeParse({ ...SIP, mediaEncryption: 'rot13' }).success).toBe(false)
    expect(set.safeParse({ ...SIP, stunServer: 'stun.example.org:3478' }).success).toBe(true)
    expect(set.safeParse({ ...SIP, stunServer: 'a b' }).success).toBe(false)
    expect(set.safeParse({ ...SIP, surprise: 1 }).success).toBe(false)
    const policy = ipcInputs['directorLine.setVoicePolicy']
    expect(policy.safeParse(VOICE_POLICY_NO_PIN).success).toBe(true)
    for (const bad of [{ ringSeconds: 9 }, { ringSeconds: 61 }, { maxPlacedCallsPerDay: 25 }, { maxPlacedCallsPerDay: -1 }, { minMinutesBetweenPlacedCalls: 241 }, { ringSeconds: 30.5 }]) {
      expect(policy.safeParse({ ...VOICE_POLICY_NO_PIN, ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('setSip refuses the same address for NEXUS and the phone, and an unchanged password needs a stored one', async () => {
    const r = rig(async () => true)
    await expect(r.handlers['directorLine.setSip']({ ...SIP, operatorIdentity: 'sip:NEXUS-test@sip.linphone.org' })).rejects.toThrow(/must differ/)
    await expect(r.handlers['directorLine.setSip']({ ...SIP, password: null })).rejects.toThrow(/password is needed/)
    expect(await r.secrets.get('sip.password')).toBeNull()
    await r.handlers['directorLine.setSip'](SIP)
    const kept = await r.handlers['directorLine.setSip']({ ...SIP, password: null, ice: false })
    expect(kept.voice).toMatchObject({ passwordSet: true, ice: false })
    expect(await r.secrets.get('sip.password')).toBe(SIP_PASSWORD)
    await r.close()
  })
})

describe('director line handlers: what the questions say, and when they are asked', () => {
  const texts = (confirm: { mock: { calls: unknown[] } }): string[][] => confirm.mock.calls.map((c) => c as unknown as string[])

  it('setSip says how the voice is encrypted, whether calls that are not are refused, and which STUN server is asked', async () => {
    const confirm = vi.fn(async () => true)
    const r = rig(confirm)
    await r.handlers['directorLine.setSip']({ ...SIP, mediaEncryption: 'srtp', mediaEncryptionMandatory: false, stunServer: 'stun.example.org', ice: true })
    const detail = texts(confirm)[0]?.[2] as string
    expect(detail).toContain('SRTP (the keys are known to the SIP server)')
    expect(detail).toContain('NOT refused')
    expect(detail).toContain('The STUN server stun.example.org')
    await r.handlers['directorLine.setSip']({ ...SIP, mediaEncryption: 'zrtp', mediaEncryptionMandatory: true, stunServer: null, ice: false })
    const second = texts(confirm)[1]?.[2] as string
    expect(second).toContain('ZRTP')
    expect(second).toContain('are refused')
    expect(second).not.toContain('NOT refused')
    expect(second).toContain('No STUN server is used')
    await r.close()
  })

  it('turning the PIN off does not promise more than the SIP server gives', async () => {
    const confirm = vi.fn(async () => true)
    const r = rig(confirm)
    await r.handlers['directorLine.setVoicePolicy'](VOICE_POLICY_NO_PIN)
    const detail = texts(confirm)[0]?.[2] as string
    expect(detail).not.toMatch(/only when the SIP service itself establishes/)
    expect(detail).toContain('The server decides whose call that is')
    expect(detail).toContain('NEXUS cannot tell them from you')
    expect(detail).toContain('still needs the PIN')
    await r.close()
  })

  it('more calls a day than 6, or calls closer than 10 minutes, are asked about; fewer and wider are not', async () => {
    const confirm = vi.fn(async () => true)
    const r = rig(confirm)
    const base = { requirePin: true, ringSeconds: 30, maxPlacedCallsPerDay: 6, minMinutesBetweenPlacedCalls: 10 }
    await r.handlers['directorLine.setVoicePolicy'](base)
    await r.handlers['directorLine.setVoicePolicy']({ ...base, maxPlacedCallsPerDay: 3, minMinutesBetweenPlacedCalls: 30 })
    expect(confirm).not.toHaveBeenCalled()
    await r.handlers['directorLine.setVoicePolicy']({ ...base, maxPlacedCallsPerDay: 7 })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(texts(confirm)[0]?.[0]).toBe('Change how often NEXUS calls')
    expect(texts(confirm)[0]?.[2]).toContain('7 times a day')
    // from 7 (now stored) to 8 is a widening again; back to 7 or below is not
    await r.handlers['directorLine.setVoicePolicy']({ ...base, maxPlacedCallsPerDay: 5 })
    expect(confirm).toHaveBeenCalledTimes(1)
    await r.handlers['directorLine.setVoicePolicy']({ ...base, minMinutesBetweenPlacedCalls: 5 })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(texts(confirm)[1]?.[2]).toContain('5 minutes apart')
    await r.handlers['directorLine.setVoicePolicy']({ ...base, minMinutesBetweenPlacedCalls: 5, maxPlacedCallsPerDay: 6 })
    expect(confirm).toHaveBeenCalledTimes(2)
    // declined: nothing changes
    const no = rig(vi.fn(async () => false))
    await expect(no.handlers['directorLine.setVoicePolicy']({ ...base, maxPlacedCallsPerDay: 24 })).rejects.toThrow(/Nothing was changed/)
    expect((await no.runtime.settingsView()).voice.policy.maxPlacedCallsPerDay).toBe(6)
    await r.close()
    await no.close()
  })

  it('confirming a call code shows the code, applies it to that code only, and is refused when there is none', async () => {
    const confirm = vi.fn(async () => true)
    const applied: string[] = []
    let sas: string | null = null
    const view = (): unknown => ({ voice: { callSecurity: sas === null ? null : { signalling: 'TLS', media: 'ZRTP', endToEnd: false, peerVerified: false, sas } } })
    const handlers = createDirectorLineHandlers({
      directorLine: { settingsView: async () => view(), confirmCallSas: async (code: string) => (applied.push(code), code === sas) } as unknown as Parameters<typeof createDirectorLineHandlers>[0]['directorLine'],
      confirm,
    })
    await expect(handlers['directorLine.confirmCallSas']({})).rejects.toThrow(/no call with a ZRTP verification code/)
    expect(confirm).not.toHaveBeenCalled()
    sas = 'QX7R'
    await handlers['directorLine.confirmCallSas']({})
    const asked = texts(confirm)[0] as string[]
    expect(asked[0]).toBe('Verify the call')
    expect(asked[1]).toBe('The telephone shows the same four characters?')
    expect(asked[2]).toContain('QX7R')
    expect(asked[3]).toBe('They match')
    expect(applied).toEqual(['QX7R'])
    // the call changed while the question was open
    const changing = createDirectorLineHandlers({
      directorLine: { settingsView: async () => view(), confirmCallSas: async () => false } as unknown as Parameters<typeof createDirectorLineHandlers>[0]['directorLine'],
      confirm: async () => true,
    })
    await expect(changing['directorLine.confirmCallSas']({})).rejects.toThrow(/Nothing was verified/)
    // and without a way to ask, nothing is verified
    const mute = createDirectorLineHandlers({
      directorLine: { settingsView: async () => view(), confirmCallSas: async (c: string) => (applied.push(`mute ${c}`), true) } as unknown as Parameters<typeof createDirectorLineHandlers>[0]['directorLine'],
    })
    await expect(mute['directorLine.confirmCallSas']({})).rejects.toThrow(/Nothing was changed/)
    expect(applied).toEqual(['QX7R'])
  })
})
