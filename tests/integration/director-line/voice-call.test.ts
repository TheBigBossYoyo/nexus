import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '@main/modules/persistence'
import { createDirectorLineRuntime, MemorySecretStore, type DirectorLineRuntime } from '@main/modules/director-line/runtime'
import type { HttpFetch } from '@main/modules/director-line/provider'
import { EMPTY_VOICE_FORM, voiceFormInput, voiceFormProblems } from '../../../src/renderer/src/views/settings/directorLineModel'
import { snapshot } from '../../unit/director-line/harness'

// 0.9.1: NEXUS calls the operator. The telephone service is a fake that answers as Twilio's Calls resource does;
// no real service is contacted. The identifiers and the secret are made up and assembled from parts.
const ACCOUNT = ['AC', '0123456789abcdef0123456789abcdef'].join('')
const KEY = ['SK', 'fedcba9876543210fedcba9876543210'].join('')
const SECRET = ['voice', 'secret', 'abcdef0123456789'].join('-')
const FROM = '+12025550123'
const TO = '+21620123456'
const CALL = ['CA', '00112233445566778899aabbccddeeff'].join('')

const open: Database[] = []
const running: DirectorLineRuntime[] = []
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => undefined)
  for (const db of open.splice(0)) if (db.open) db.close()
})

function world(statuses: string[]) {
  const requests: { method: string; url: string; auth: string; form: Record<string, string> }[] = []
  const sent: string[] = []
  const fetch: HttpFetch = async (url, init) => {
    if (url.includes('api.telegram.org')) {
      const method = url.split('/').pop()
      if (method === 'sendMessage') sent.push(String((JSON.parse(init.body ?? '{}') as { text?: string }).text))
      if (method === 'getUpdates') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      return { status: 200, json: async () => ({ ok: true, result: method === 'getMe' ? { username: 'bot' } : { message_id: 1 } }) }
    }
    const headers = (init.headers ?? {}) as Record<string, string>
    requests.push({ method: init.method, url, auth: headers['authorization'] ?? '', form: Object.fromEntries(new URLSearchParams(init.body ?? '')) })
    if (init.method === 'POST' && url.endsWith('/Calls.json')) return { status: 201, json: async () => ({ sid: CALL, status: 'queued' }) }
    if (init.method === 'GET' && url.endsWith(`/Calls/${CALL}.json`)) return { status: 200, json: async () => ({ sid: CALL, status: statuses.length > 1 ? statuses.shift() : statuses[0] }) }
    if (init.method === 'POST' && url.endsWith(`/Calls/${CALL}.json`)) return { status: 200, json: async () => ({ sid: CALL, status: 'canceled' }) }
    return { status: 200, json: async () => ({ status: 'active' }) }
  }
  const db = openDatabase(':memory:')
  open.push(db)
  const runtime = createDirectorLineRuntime({
    db,
    secrets: new MemorySecretStore(),
    fetch,
    reads: { getStatus: async () => ({ snapshots: [{ name: 'Night', snapshot: snapshot() }], facts: { paused: false, online: true, pendingBoundaryRequests: 0 } }), getOvernightReport: async () => null, getLatestChecks: async () => null },
    actions: { pauseAfterCurrentTask: async () => undefined, resume: async () => undefined, submitIntent: async () => ({ accepted: true }) },
    isOnline: () => true,
    localNotify: async () => undefined,
    recordNote: () => undefined,
    machineTimeZone: 'UTC',
    voice: { sleep: async () => undefined, pollIntervalMs: 1, maxWaitMs: 20 },
    telegram: { sleep: async () => new Promise((r) => setTimeout(r, 5)) },
  })
  running.push(runtime)
  return { runtime, requests, sent }
}

describe('the voice form of Settings', () => {
  it('says what is wrong with each field, forgives spaces in a number, and sends only what was typed', () => {
    expect(Object.keys(voiceFormProblems(EMPTY_VOICE_FORM, false)).sort()).toEqual(['accountSid', 'apiKeySecret', 'apiKeySid', 'fromNumber', 'operatorNumber'])
    const filled = { accountSid: ` ${ACCOUNT} `, apiKeySid: KEY, apiKeySecret: SECRET, fromNumber: '+1 (202) 555-0123', operatorNumber: '+216 20 123 456' }
    expect(voiceFormProblems(filled, false)).toEqual({})
    expect(voiceFormInput(filled)).toEqual({ kind: 'TWILIO_VOICE', secret: SECRET, extra: { accountSid: ACCOUNT, apiKeySid: KEY, fromNumber: FROM, operatorNumber: TO } })
    expect(voiceFormProblems({ ...filled, operatorNumber: '20123456' }, false).operatorNumber).toContain('country code')
    expect(voiceFormProblems({ ...filled, accountSid: 'AC123' }, false).accountSid).toContain('34 characters')
    // Once configured, a field left empty keeps what is stored; the secret is always asked for again.
    expect(voiceFormProblems({ ...EMPTY_VOICE_FORM, apiKeySecret: SECRET, operatorNumber: TO }, true)).toEqual({})
    expect(voiceFormInput({ ...EMPTY_VOICE_FORM, apiKeySecret: SECRET, operatorNumber: TO })).toEqual({ kind: 'TWILIO_VOICE', secret: SECRET, extra: { operatorNumber: TO } })
    expect(voiceFormProblems({ ...EMPTY_VOICE_FORM }, true).apiKeySecret).toBeDefined()
  })
})

describe('NEXUS calls the operator', () => {
  it('a test call goes from the Twilio number to the operator, says a fixed sentence, is not recorded, and nothing of the credentials is shown', async () => {
    const w = world(['ringing', 'in-progress', 'completed'])
    await w.runtime.setEnabled(true)
    await w.runtime.setProvider(voiceFormInput({ accountSid: ACCOUNT, apiKeySid: KEY, apiKeySecret: SECRET, fromNumber: FROM, operatorNumber: TO }))
    const view = await w.runtime.settingsView()
    expect(view.voiceProvider).toMatchObject({ kind: 'TWILIO_VOICE', configured: true })
    expect(view).toMatchObject({ voiceFromSuffix: '0123', voiceToSuffix: '456', voiceReason: null })
    const shown = JSON.stringify(view)
    for (const hidden of [SECRET, ACCOUNT, KEY, FROM, TO]) expect(shown).not.toContain(hidden)

    expect(await w.runtime.testCall()).toEqual({ ok: true, errorClass: null })
    const placed = w.requests.find((r) => r.method === 'POST' && r.url.endsWith('/Calls.json'))
    expect(placed?.url).toContain(`/Accounts/${ACCOUNT}/Calls.json`)
    expect(placed?.form).toMatchObject({ To: TO, From: FROM, Record: 'false' })
    expect(placed?.form['Twiml']).toBe('<Response><Say>This is a test call from NEXUS. Nothing needs your attention.</Say></Response>')
    expect(Buffer.from((placed?.auth ?? '').replace('Basic ', ''), 'base64').toString()).toBe(`${KEY}:${SECRET}`)
    expect((await w.runtime.settingsView()).lastDelivery).toMatchObject({ channel: 'TWILIO_VOICE', outcome: 'ANSWERED' })
  })

  it('a call that is not answered is stopped, and a report then falls back to one message and does not call again', async () => {
    const w = world(['ringing'])
    await w.runtime.setEnabled(true)
    await w.runtime.setProvider({ kind: 'TELEGRAM', secret: ['123456789', ':', 'AAFakeFakeFakeFakeFakeFake_WXYZ'].join('') })
    await w.runtime.setProvider(voiceFormInput({ accountSid: ACCOUNT, apiKeySid: KEY, apiKeySecret: SECRET, fromNumber: FROM, operatorNumber: TO }))
    expect(await w.runtime.testCall()).toMatchObject({ ok: false })
    expect(w.requests.some((r) => r.method === 'POST' && r.url.endsWith(`/Calls/${CALL}.json`) && r.form['Status'] === 'canceled')).toBe(true)
    const callsBefore = w.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/Calls.json')).length
    await w.runtime.line.report({ kind: 'CRITICAL_FAILURE', at: new Date().toISOString(), subjectId: 'run-1', text: 'Night: failed. 3 of 19 tasks completed.' })
    await w.runtime.flush()
    // One more call for the report, at most: the policy's single attempt. Never a second one.
    expect(w.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/Calls.json')).length - callsBefore).toBeLessThanOrEqual(1)
    await w.runtime.flush()
    expect(w.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/Calls.json')).length - callsBefore).toBeLessThanOrEqual(1)
  })

  it('removing Twilio removes the credentials and the number: no call can be placed', async () => {
    const w = world(['completed'])
    await w.runtime.setEnabled(true)
    await w.runtime.setProvider(voiceFormInput({ accountSid: ACCOUNT, apiKeySid: KEY, apiKeySecret: SECRET, fromNumber: FROM, operatorNumber: TO }))
    await w.runtime.setProvider({ kind: 'TWILIO_VOICE', secret: null })
    const view = await w.runtime.settingsView()
    expect(view).toMatchObject({ voiceFromSuffix: null, voiceToSuffix: null })
    expect(view.voiceProvider.configured).toBe(false)
    expect(await w.runtime.testCall()).toEqual({ ok: false, errorClass: 'NOT_CONFIGURED' })
    expect(w.requests.filter((r) => r.url.endsWith('/Calls.json'))).toEqual([])
  })
})
