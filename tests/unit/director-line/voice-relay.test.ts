import { describe, expect, it } from 'vitest'
import type { HttpFetch } from '@main/modules/director-line/provider'
import { generateRelayKeyPair, openEnvelope, OperatorRelayClient, sealEnvelope, type EnvelopePayload } from '@main/modules/director-line/relay'
import { MemorySeenStore } from '@main/modules/director-line/stores'
import { buildReportTwiml, TwilioVoiceProvider, xmlEscape } from '@main/modules/director-line/voice'

const payload: EnvelopePayload = { kind: 'VOICE_INPUT', provider: 'TWILIO', providerAuthenticated: true, from: '+33612345678', callSid: ['CA', '0'.repeat(32)].join(''), digits: '482915', speech: 'status' }

describe('operator envelope', () => {
  it('round-trips, and the relay-side key cannot open it', async () => {
    const keys = generateRelayKeyPair()
    const other = generateRelayKeyPair()
    const env = sealEnvelope(keys.publicKey, payload)
    expect(JSON.stringify(env)).not.toContain('482915')
    const opened = await openEnvelope(keys.privateKey, env, { seen: new MemorySeenStore() })
    expect(opened).toMatchObject({ ok: true, payload })
    expect(await openEnvelope(other.privateKey, env, { seen: new MemorySeenStore() })).toEqual({ ok: false, reason: 'AUTH_FAILED' })
  })

  it('refuses a replayed envelope, also after a restart with the same seen-set', async () => {
    const keys = generateRelayKeyPair()
    const seen = new MemorySeenStore()
    const env = sealEnvelope(keys.publicKey, payload)
    expect((await openEnvelope(keys.privateKey, env, { seen })).ok).toBe(true)
    expect(await openEnvelope(keys.privateKey, env, { seen })).toEqual({ ok: false, reason: 'REPLAY' })
  })

  it('refuses a stale envelope and one from the future beyond the window', async () => {
    const keys = generateRelayKeyPair()
    const now = Date.now()
    const old = sealEnvelope(keys.publicKey, payload, { now: () => now - 10 * 60_000 })
    const future = sealEnvelope(keys.publicKey, payload, { now: () => now + 10 * 60_000 })
    expect(await openEnvelope(keys.privateKey, old, { seen: new MemorySeenStore(), now: () => now })).toEqual({ ok: false, reason: 'STALE' })
    expect(await openEnvelope(keys.privateKey, future, { seen: new MemorySeenStore(), now: () => now })).toEqual({ ok: false, reason: 'STALE' })
  })

  it('refuses a tampered envelope: changed ciphertext, changed timestamp (re-dating a replay), changed id', async () => {
    const keys = generateRelayKeyPair()
    const env = sealEnvelope(keys.publicKey, payload)
    const flip = Buffer.from(env.ct, 'base64')
    flip[0] = flip[0]! ^ 1
    const seen = new MemorySeenStore()
    expect((await openEnvelope(keys.privateKey, { ...env, ct: flip.toString('base64') }, { seen })).ok).toBe(false)
    expect(await openEnvelope(keys.privateKey, { ...env, ts: env.ts + 1000 }, { seen })).toEqual({ ok: false, reason: 'AUTH_FAILED' })
    expect(await openEnvelope(keys.privateKey, { ...env, id: 'f'.repeat(32) }, { seen })).toEqual({ ok: false, reason: 'AUTH_FAILED' })
    // Junk did not consume the replay slot of the genuine one.
    expect((await openEnvelope(keys.privateKey, env, { seen })).ok).toBe(true)
  })

  it('refuses malformed input', async () => {
    const keys = generateRelayKeyPair()
    for (const bad of [null, 'x', {}, { v: 2 }, { v: 1, id: 'zz', ts: 1, epk: '', iv: '', ct: '', tag: '' }]) expect((await openEnvelope(keys.privateKey, bad, { seen: new MemorySeenStore() })).ok).toBe(false)
  })
})

describe('relay client', () => {
  it('polls over an outbound https request, opens, acknowledges junk too, and refuses plain http', async () => {
    const keys = generateRelayKeyPair()
    const good = sealEnvelope(keys.publicKey, payload)
    const forged = sealEnvelope(generateRelayKeyPair().publicKey, payload)
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const fetch: HttpFetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body })
      return { status: 200, json: async () => ({ envelopes: [good, forged, good] }) }
    }
    expect(() => new OperatorRelayClient({ baseUrl: 'http://relay.example', fetch, getAuth: async () => null, seen: new MemorySeenStore() })).toThrow()
    const client = new OperatorRelayClient({ baseUrl: 'https://relay.example/', fetch, getAuth: async () => ({ bearer: 'poll-credential', privateKey: keys.privateKey }), seen: new MemorySeenStore() })
    const result = await client.pollOnce()
    expect(result.payloads).toHaveLength(1)
    expect(result.rejected).toBe(2) // the forged one and the replayed one
    expect(calls[0]).toMatchObject({ url: 'https://relay.example/v1/operator-envelopes', method: 'GET' })
    expect(calls[1]!.url).toBe('https://relay.example/v1/operator-envelopes/ack')
  })

  it('reports an error class, never a message', async () => {
    const keys = generateRelayKeyPair()
    const client = new OperatorRelayClient({ baseUrl: 'https://relay.example', fetch: async () => { throw new Error('https://relay.example/secret-path failed') }, getAuth: async () => ({ bearer: 'b', privateKey: keys.privateKey }), seen: new MemorySeenStore() })
    expect(await client.pollOnce()).toEqual({ payloads: [], rejected: 0, errorClass: 'NETWORK' })
  })
})

describe('Twilio voice', () => {
  const creds = { accountSid: ['AC', 'a'.repeat(32)].join(''), apiKeySid: ['SK', 'b'.repeat(32)].join(''), apiKeySecret: 'k'.repeat(16), fromNumber: '+15005550006' }
  const callSid = ['CA', 'c'.repeat(32)].join('')

  function rig(statuses: string[], createStatus = 201) {
    const calls: Array<{ url: string; method: string; body: string; auth?: string }> = []
    let polls = 0
    const fetch: HttpFetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ?? '', auth: init.headers?.authorization })
      if (init.method === 'POST' && url.endsWith('/Calls.json')) return { status: createStatus, json: async () => ({ sid: callSid, status: 'queued' }) }
      if (init.method === 'GET' && url.includes(`/Calls/${callSid}.json`)) { const s = statuses[Math.min(polls, statuses.length - 1)]; polls += 1; return { status: 200, json: async () => ({ status: s }) } }
      return { status: 200, json: async () => ({}) }
    }
    const provider = new TwilioVoiceProvider({ getCredentials: async () => creds, fetch, sleep: async () => undefined, maxWaitMs: 9000, pollIntervalMs: 3000 })
    return { provider, calls }
  }

  it('places one call that speaks the report, with Record=false, and follows it to an answer', async () => {
    const { provider, calls } = rig(['queued', 'ringing', 'in-progress'])
    const r = await provider.placeCall({ to: '+33612345678', spokenText: 'RaceDeck is finished.' })
    expect(r).toMatchObject({ ok: true, finalState: 'ANSWERED', providerCallId: callSid, recorded: false })
    const create = calls[0]!
    expect(create.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Calls.json`)
    const form = new URLSearchParams(create.body)
    expect(form.get('Record')).toBe('false')
    expect(form.get('To')).toBe('+33612345678')
    expect(form.get('Twiml')).toBe('<Response><Say>RaceDeck is finished.</Say></Response>')
    expect(create.auth).toMatch(/^Basic /)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it.each([['busy', 'BUSY'], ['no-answer', 'NO_ANSWER'], ['failed', 'FAILED'], ['canceled', 'FAILED']] as const)('%s -> %s, not ok', async (twilio, ours) => {
    const { provider } = rig(['ringing', twilio])
    const r = await provider.placeCall({ to: '+33612345678', spokenText: 'x' })
    expect(r.ok).toBe(false)
    expect(r.finalState).toBe(ours)
  })

  it('cancels a call that keeps ringing instead of leaving it to be answered late', async () => {
    const { provider, calls } = rig(['ringing'])
    const r = await provider.placeCall({ to: '+33612345678', spokenText: 'x' })
    expect(r.finalState).toBe('NO_ANSWER')
    expect(calls.at(-1)).toMatchObject({ method: 'POST' })
    expect(calls.at(-1)!.url).toContain(`/Calls/${callSid}.json`)
    expect(new URLSearchParams(calls.at(-1)!.body).get('Status')).toBe('canceled')
  })

  it('is unconfigured without credentials and refuses a bad number, a network error leaks nothing', async () => {
    const none = new TwilioVoiceProvider({ getCredentials: async () => null, fetch: async () => { throw new Error('no') } })
    expect((await none.health()).status).toBe('UNCONFIGURED')
    expect(await none.placeCall({ to: '+33612345678', spokenText: 'x' })).toMatchObject({ ok: false, errorClass: 'NOT_CONFIGURED' })
    const { provider } = rig(['ringing'])
    expect(await provider.placeCall({ to: '0612345678', spokenText: 'x' })).toMatchObject({ ok: false, errorClass: 'REJECTED' })
    const failing = new TwilioVoiceProvider({ getCredentials: async () => creds, fetch: async () => { throw new Error(`failed with ${creds.apiKeySecret}`) } })
    const r = await failing.placeCall({ to: '+33612345678', spokenText: 'x' })
    expect(JSON.stringify(r)).not.toContain(creds.apiKeySecret)
    expect(r.errorClass).toBe('NETWORK')
  })

  it('TwiML escapes the text, so a report cannot inject markup, and a gather needs https', () => {
    expect(buildReportTwiml('</Say><Hangup/><Say>')).toBe('<Response><Say>&lt;/Say&gt;&lt;Hangup/&gt;&lt;Say&gt;</Say></Response>')
    expect(xmlEscape('a & b "c"\u202e')).toBe('a &amp; b &quot;c&quot;')
    expect(buildReportTwiml('x', 'https://relay.example/gather')).toContain('<Gather input="dtmf"')
    expect(() => buildReportTwiml('x', 'http://relay.example/gather')).toThrow()
  })
})
