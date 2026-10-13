import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMUNICATION_POLICY } from '@shared/director-line'
import { ipcInputs } from '@shared/ipc'
import { openDatabase } from '@main/modules/persistence'
import { createDirectorLineRuntime, MemorySecretStore } from '@main/modules/director-line/runtime'
import type { HttpFetch } from '@main/modules/director-line/provider'
import { createDirectorLineHandlers, policyWidens } from '@main/modules/ipc/v9-handlers'

const TOKEN = '987654321:AAHandlersHandlersHandlers_QRST'
const TWILIO_SECRET = 'twilio-handlers-secret-0123456789'
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

const TWILIO = { kind: 'TWILIO_VOICE' as const, secret: TWILIO_SECRET, extra: { accountSid: `AC${'c'.repeat(32)}`, apiKeySid: `SK${'d'.repeat(32)}`, fromNumber: '+15005550006', operatorNumber: '+33612345678' } }
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
  { name: 'setProvider twilio', run: (h) => h['directorLine.setProvider'](TWILIO) as Promise<unknown> },
  { name: 'setPolicy that enables calls', run: (h) => h['directorLine.setPolicy']({ policy: policyWithCalls() }) as Promise<unknown> },
  { name: 'setPin', run: (h) => h['directorLine.setPin']({ pin: PIN }) as Promise<unknown> },
  { name: 'testCall', run: (h) => h['directorLine.testCall']({}) as Promise<unknown> },
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
    expect(view.voiceProvider.configured).toBe(false)
    expect(view.policy).toEqual(DEFAULT_COMMUNICATION_POLICY)
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
    outputs.push(await r.handlers['directorLine.setProvider'](TWILIO))
    outputs.push(await r.handlers['directorLine.setEnabled']({ enabled: true }))
    outputs.push(await r.handlers['directorLine.setPin']({ pin: PIN }))
    outputs.push(await r.handlers['directorLine.setPolicy']({ policy: policyWithCalls() }))
    outputs.push(await r.handlers['directorLine.get']({}))
    outputs.push(await r.handlers['directorLine.sendTestMessage']({}))
    outputs.push(await r.handlers['directorLine.testCall']({}))
    outputs.push(await r.handlers['directorLine.unpair']({}))

    const view = await r.handlers['directorLine.get']({})
    expect(view.enabled).toBe(true)
    expect(view.messageProvider).toMatchObject({ kind: 'TELEGRAM', configured: true, tokenSuffix: TOKEN.slice(-4) })
    expect(view.voiceProvider).toMatchObject({ kind: 'TWILIO_VOICE', configured: true, tokenSuffix: TWILIO_SECRET.slice(-4) })
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
    for (const secret of [TOKEN, TWILIO_SECRET, PIN, code, pairing.displayCode]) expect(text, secret).not.toContain(secret)
    expect(JSON.stringify(await r.handlers['directorLine.setPin']({ pin: PIN }))).toBe('{"configured":true}')
    expect(confirm.mock.calls.length).toBeGreaterThanOrEqual(7)
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
    expect(set.safeParse({ kind: 'TELEGRAM', secret: TOKEN, extra: { relayBaseUrl: 'http://insecure.example' } }).success).toBe(false)
    expect(set.safeParse({ kind: 'TELEGRAM', secret: TOKEN, surprise: 1 }).success).toBe(false)
    const pin = ipcInputs['directorLine.setPin']
    for (const ok of ['123456', '123456789012']) expect(pin.safeParse({ pin: ok }).success, ok).toBe(true)
    for (const bad of ['12345', '1234567890123', '12345a', ' 123456']) expect(pin.safeParse({ pin: bad }).success, bad).toBe(false)
    expect(ipcInputs['directorLine.setPolicy'].safeParse({ policy: DEFAULT_COMMUNICATION_POLICY }).success).toBe(true)
    expect(ipcInputs['directorLine.setPolicy'].safeParse({ policy: { ...DEFAULT_COMMUNICATION_POLICY, maxCallAttempts: 50 } }).success).toBe(false)
  })
})
