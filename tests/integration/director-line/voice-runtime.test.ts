import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReportEvent } from '@shared/director-line'
import { openDatabase, type Database } from '@main/modules/persistence'
import { fakeUpdate, type HttpFetch } from '@main/modules/director-line/provider'
import { createDirectorLineRuntime, MemorySecretStore, type DirectorLineRuntime, type DirectorLineSipInput } from '@main/modules/director-line/runtime'
import type { SipAccount, VoiceHost } from '@main/modules/director-line/voice-config'
import type { CallEndReason, DirectorVoiceProvider, PlacedCall, SpeechToTextProvider, TextToSpeechProvider, VoiceCall, VoiceProviderState } from '@main/modules/director-line/voice-provider'

// 0.9.1: the voice line inside the Director Line runtime, with a fake SIP provider and fake speech engines.

const TOKEN = '123456789:AAFakeFakeFakeFakeFakeFake_WXYZ'
const NEXUS = 'sip:nexus-test@sip.linphone.org'
const PHONE = 'sip:owner-test@sip.linphone.org'
const PASSWORD = 'correct-horse-battery-staple-7'
const SIP: DirectorLineSipInput = { identity: NEXUS, password: PASSWORD, operatorIdentity: PHONE, mediaEncryption: 'zrtp', mediaEncryptionMandatory: true, stunServer: null, ice: true }

const root = join(process.cwd(), 'test-results', 'director-line-wiring')
const dirs: string[] = []
const open: Database[] = []
const running: DirectorLineRuntime[] = []
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => undefined)
  for (const db of open.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function fakeCall(direction: 'INBOUND' | 'OUTBOUND', remote: string) {
  let ended: (r: CallEndReason) => void = () => undefined
  const log: string[] = []
  const call: VoiceCall = {
    id: `call-${Math.random().toString(36).slice(2, 8)}`,
    direction,
    remoteIdentity: remote,
    identityAssurance: 'TRANSPORT_AUTHENTICATED',
    format: { sampleRate: 16000 },
    answer: async () => void log.push('answer'),
    hangUp: async () => void log.push('hangUp'),
    sendAudio: () => undefined,
    clearAudio: () => undefined,
    drained: async () => undefined,
    onAudio: () => undefined,
    onDigit: () => undefined,
    onEnded: (l) => (ended = l),
    security: () => ({ signalling: 'TLS', media: 'ZRTP', endToEnd: true }),
  }
  return { call, log, remoteHangUp: () => ended('REMOTE_HUNG_UP') }
}

interface Spy {
  created: number
  started: number
  stopped: number
  networkChanged: number
  accounts: (SipAccount | null)[]
  placed: string[]
  nextPlaced: () => PlacedCall
  state: VoiceProviderState
  announce: (state: VoiceProviderState, detail?: string) => void
  ring: (call: VoiceCall) => void
}

function fakeVoice(over: { stt?: boolean; tts?: boolean; available?: boolean } = {}): { host: VoiceHost; spy: Spy } {
  const spy: Spy = {
    created: 0, started: 0, stopped: 0, networkChanged: 0, accounts: [], placed: [], nextPlaced: () => ({ outcome: 'NO_ANSWER' }), state: 'STOPPED',
    announce: () => undefined, ring: () => undefined,
  }
  const stt: SpeechToTextProvider = { kind: 'fake-stt', local: true, open: () => ({ push: () => undefined, close: () => undefined }) }
  const tts: TextToSpeechProvider = { kind: 'fake-tts', local: false, speak: async () => undefined }
  const host: VoiceHost = {
    available: over.available ?? true,
    ...(over.available === false ? { unavailableReason: 'The SIP helper was not built.' } : {}),
    create(account) {
      spy.created += 1
      const provider: DirectorVoiceProvider = {
        kind: 'fake-sip',
        start: async (on) => {
          spy.started += 1
          spy.ring = on.incoming
          spy.announce = (state, detail) => { spy.state = state; on.state(state, detail) }
          spy.accounts.push(await account())
          spy.announce('REGISTERED')
        },
        stop: async () => { spy.stopped += 1; spy.state = 'STOPPED' },
        state: () => spy.state,
        placeCall: async (to) => (spy.placed.push(to), spy.nextPlaced()),
      }
      return { provider, networkChanged: () => { spy.networkChanged += 1 } }
    },
    stt: over.stt === false ? null : stt,
    tts: over.tts === false ? null : tts,
    turns: null,
    directorVoice: () => null,
    generalFacts: async () => 'facts',
  }
  return { host, spy }
}

/** A Bot API that has no update and records what is sent. */
function telegramApi(): { fetch: HttpFetch; sent: { chat: string; text: string }[] } {
  const sent: { chat: string; text: string }[] = []
  const fetch: HttpFetch = async (url, init) => {
    const method = url.split('/').pop()
    if (method === 'getUpdates') {
      await new Promise<void>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (method === 'sendMessage') {
      const body = JSON.parse(init.body ?? '{}') as { chat_id: unknown; text: unknown }
      sent.push({ chat: String(body.chat_id), text: String(body.text) })
    }
    return { status: 200, json: async () => ({ ok: true, result: method === 'getMe' ? { username: 'bot' } : { message_id: 1 } }) }
  }
  return { fetch, sent }
}

function rig(opts: { voice?: VoiceHost | null; db?: Database; secrets?: MemorySecretStore; file?: boolean; log?: string[]; api?: ReturnType<typeof telegramApi> } = {}) {
  let db = opts.db
  let dir: string | null = null
  if (!db) {
    if (opts.file) {
      mkdirSync(root, { recursive: true })
      dir = mkdtempSync(join(root, 'voice-'))
      dirs.push(dir)
      db = openDatabase(join(dir, 'nexus.db'))
    } else db = openDatabase(':memory:')
    open.push(db)
  }
  const secrets = opts.secrets ?? new MemorySecretStore()
  const api = opts.api ?? telegramApi()
  const notified: string[] = []
  const logs = opts.log ?? []
  const runtime = createDirectorLineRuntime({
    db,
    secrets,
    fetch: api.fetch,
    reads: { getStatus: async () => ({ snapshots: [], facts: { paused: false, online: true, pendingBoundaryRequests: 0 } }), getOvernightReport: async () => null, getLatestChecks: async () => null },
    actions: { pauseAfterCurrentTask: async () => undefined, resume: async () => undefined, submitIntent: async () => ({ accepted: true }) },
    isOnline: () => true,
    localNotify: async (_title, text) => void notified.push(text),
    recordNote: () => undefined,
    // Noon in Paris: well outside the quiet hours.
    now: () => new Date('2026-10-14T10:00:00.000Z'),
    machineTimeZone: 'Europe/Paris',
    log: (line) => void logs.push(line),
    telegram: { sleep: async () => new Promise((r) => setTimeout(r, 5)) },
    ...(opts.voice === null ? {} : opts.voice ? { voice: opts.voice } : {}),
  })
  running.push(runtime)
  return { db, dir, secrets, api, runtime, notified, logs }
}

/** Everything the database wrote to disk, as one string of bytes. */
function diskBytes(db: Database, dir: string): string {
  db.pragma('wal_checkpoint(TRUNCATE)')
  return readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('\n')
}

async function pairTelegram(r: ReturnType<typeof rig>): Promise<void> {
  await r.runtime.setProvider({ kind: 'TELEGRAM', secret: TOKEN })
  await r.runtime.setEnabled(true)
  const { displayCode } = await r.runtime.startPairing('TELEGRAM')
  await r.runtime.line.handleUpdate(fakeUpdate({ text: displayCode, providerUserId: '1001', providerMessageId: 'pair-1' }))
  r.api.sent.length = 0
}

const event = (kind: ReportEvent['kind'], subjectId: string, text: string): ReportEvent => ({ kind, subjectId, text, at: '2026-10-14T10:00:00.000Z' })

describe('the voice line is built only when everything is there', () => {
  it('needs the line on, an account with its password, a paired phone, an available helper and both speech engines', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await r.runtime.setSip(SIP) // configured, but the Director Line is off
    expect(spy.created).toBe(0)
    expect((await r.runtime.settingsView()).voice).toMatchObject({ configured: true, state: 'STOPPED', stateDetail: 'The Director Line is off.', operatorIdentity: PHONE })

    await r.runtime.setEnabled(true)
    expect(spy.created).toBe(1)
    expect(spy.started).toBe(1)
    expect(spy.accounts[0]).toMatchObject({ identity: NEXUS, password: PASSWORD, server: 'sip:sip.linphone.org;transport=tls', transport: 'tls', mediaEncryption: 'zrtp', mediaEncryptionMandatory: true, stunServer: null, ice: true, displayName: 'NEXUS Director' })
    const view = (await r.runtime.settingsView()).voice
    expect(view).toMatchObject({ available: true, unavailableReason: null, configured: true, identity: NEXUS, passwordSet: true, operatorIdentity: PHONE, state: 'REGISTERED', inCall: false })
    expect(view.speech).toEqual({ stt: { kind: 'fake-stt', local: true }, tts: { kind: 'fake-tts', local: false } })

    // Nobody paired: the line goes away. Paired again: it comes back.
    await r.runtime.unpair('SIP_VOICE')
    expect(spy.stopped).toBe(1)
    expect((await r.runtime.settingsView()).voice.stateDetail).toMatch(/SIP address is not set/)
    await r.runtime.setSip({ ...SIP, password: null })
    expect(spy.created).toBe(2)
  })

  it('is not built without a speech engine, without an available helper, or without a host at all, and says why', async () => {
    for (const [over, reason] of [
      [{ stt: false }, /No speech engine is installed/],
      [{ tts: false }, /No speech engine is installed/],
      [{ available: false }, /SIP helper was not built/],
    ] as const) {
      const { host, spy } = fakeVoice(over)
      const r = rig({ voice: host })
      await r.runtime.setEnabled(true)
      await r.runtime.setSip(SIP)
      expect(spy.created, JSON.stringify(over)).toBe(0)
      const voice = (await r.runtime.settingsView()).voice
      expect(voice.stateDetail ?? voice.unavailableReason).toMatch(reason)
      expect(voice.configured).toBe(true)
    }
    const none = rig({ voice: null })
    await none.runtime.setEnabled(true)
    await none.runtime.setSip(SIP)
    expect((await none.runtime.settingsView()).voice).toMatchObject({ available: false, configured: true, state: 'STOPPED' })
    expect(await none.runtime.callMe()).toBe('NOT_CONFIGURED')
  })

  it('turning the Director Line off stops it; turning it on starts it again; a changed account is rebuilt', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await r.runtime.setSip(SIP)
    await r.runtime.setEnabled(true)
    expect(spy.created).toBe(1)
    await r.runtime.setSip({ ...SIP, mediaEncryption: 'none' }) // the account changed
    expect(spy.created).toBe(2)
    expect(spy.stopped).toBe(1)
    expect(spy.accounts.at(-1)).toMatchObject({ mediaEncryption: 'none' })
    await r.runtime.setSip({ ...SIP, mediaEncryption: 'none', password: null }) // nothing changed
    expect(spy.created).toBe(2)
    await r.runtime.setSip({ ...SIP, mediaEncryption: 'none', password: 'a-new-password' }) // a new password
    expect(spy.created).toBe(3)
    expect(spy.accounts.at(-1)?.password).toBe('a-new-password')
    await r.runtime.setEnabled(false)
    expect(spy.stopped).toBe(3)
    expect((await r.runtime.settingsView()).voice.state).toBe('STOPPED')
    await r.runtime.setEnabled(true)
    expect(spy.created).toBe(4)
  })

  it('tells the provider of a change of network', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    r.runtime.networkChanged() // nothing is running: nothing happens
    await r.runtime.setSip(SIP)
    await r.runtime.setEnabled(true)
    r.runtime.networkChanged()
    expect(spy.networkChanged).toBe(1)
  })
})

describe('removal and the old Twilio rows', () => {
  it('removing the account stops the line, deletes the password and the pairing', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await r.runtime.setEnabled(true)
    await r.runtime.setSip(SIP)
    expect(await r.secrets.get('sip.password')).toBe(PASSWORD)
    await r.runtime.removeSip()
    expect(spy.stopped).toBe(1)
    expect(await r.secrets.get('sip.password')).toBeNull()
    expect((await r.runtime.pairing.listPaired()).filter((i) => i.channel === 'SIP_VOICE')).toEqual([])
    expect((await r.runtime.settingsView()).voice).toMatchObject({ configured: false, identity: null, passwordSet: false, operatorIdentity: null })
    expect(await r.runtime.callMe()).toBe('NOT_CONFIGURED')
  })

  it('a 0.9.0 database that says TWILIO_VOICE reads as not configured, and nothing acts on its paired number', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    r.db.prepare("INSERT INTO director_line_settings (id, enabled, message_provider, voice_provider) VALUES (1, 1, 'TELEGRAM', 'TWILIO_VOICE')").run()
    r.db.prepare("INSERT INTO director_line_identities (channel, provider_user_id, label, paired_at, paired_via) VALUES ('TWILIO_VOICE', '+33612345678', 'Phone', '2026-10-01T00:00:00.000Z', 'PHONE_AND_PIN')").run()
    await r.secrets.set('telegram.botToken', TOKEN)
    await r.runtime.start()
    expect(spy.created).toBe(0)
    const view = await r.runtime.settingsView()
    expect(view.voice).toMatchObject({ configured: false, identity: null, passwordSet: false, operatorIdentity: null })
    expect(JSON.stringify(view)).not.toContain('TWILIO')
    expect(await r.runtime.callMe()).toBe('NOT_CONFIGURED')
  })
})

describe('the password', () => {
  it('is in the secret store and handed to the provider, and nowhere else: not in the view, the database file, the logs or a provider detail', async () => {
    const { host, spy } = fakeVoice()
    const logs: string[] = []
    const r = rig({ voice: host, file: true, log: logs })
    await r.runtime.setEnabled(true)
    await r.runtime.setSip(SIP)
    expect(spy.accounts[0]?.password).toBe(PASSWORD)
    // A call that fails inside the provider, and one declined: nothing of it carries the password either.
    spy.nextPlaced = () => { throw new Error(`boom ${PASSWORD}`) }
    await r.runtime.setProvider({ kind: 'TELEGRAM', secret: TOKEN })
    await r.runtime.callMe().catch(() => undefined)
    const stranger = fakeCall('INBOUND', 'sip:mallory@evil.test')
    spy.ring(stranger.call)
    await settle()
    // The provider reports a detail that contains the password; the view never repeats it.
    spy.announce('REJECTED', `registration refused for password ${PASSWORD}\nsecond line`)

    const view = await r.runtime.settingsView()
    expect(view.voice.state).toBe('REJECTED')
    expect(view.voice.stateDetail).toContain('registration refused')
    expect(JSON.stringify(view)).not.toContain(PASSWORD)
    expect(view.voice.stateDetail).not.toContain('\n')
    expect(view.voice.lastCalls[0]).toMatchObject({ outcome: 'DECLINED_UNPAIRED' })
    for (const { name } of r.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      expect(JSON.stringify(r.db.prepare(`SELECT * FROM "${name}"`).all()), name).not.toContain(PASSWORD)
    }
    expect(diskBytes(r.db, r.dir as string)).not.toContain(PASSWORD)
    expect(logs.join('\n')).not.toContain(PASSWORD)
    expect(logs.length).toBeGreaterThan(0)
  })
})

describe('"call me" and events', () => {
  it('"call me" by Telegram places one call to the paired phone, and a call nobody answers is followed by one message', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await pairTelegram(r)
    await r.runtime.setSip(SIP)
    expect(spy.created).toBe(1)

    await r.runtime.line.handleUpdate(fakeUpdate({ text: 'call me', providerUserId: '1001', providerMessageId: 'm-2' }))
    expect(r.api.sent[0]).toEqual({ chat: '1001', text: 'Calling you now.' })
    await until(() => spy.placed.length === 1, 'the call')
    expect(spy.placed).toEqual([PHONE])
    await until(() => r.api.sent.length === 2, 'the message that follows a call nobody answered')
    expect(r.api.sent[1]?.text).toMatch(/no answer/)
    expect(r.api.sent).toHaveLength(2)
    await settle()
    expect((await r.runtime.settingsView()).voice.lastCalls[0]).toMatchObject({ direction: 'OUTBOUND', outcome: 'NO_ANSWER' })
  })

  it('"call me" says so when there is no voice line, when it is not registered, and when a call is on', async () => {
    const none = rig({ voice: null })
    await pairTelegram(none)
    await none.runtime.line.handleUpdate(fakeUpdate({ text: 'appelle-moi', providerUserId: '1001', providerMessageId: 'm-2' }))
    expect(none.api.sent[0]?.text).toBe('The voice line is not set up.')

    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await pairTelegram(r)
    await r.runtime.setSip(SIP)
    spy.announce('UNREACHABLE')
    await r.runtime.line.handleUpdate(fakeUpdate({ text: 'call me', providerUserId: '1001', providerMessageId: 'm-2' }))
    expect(r.api.sent[0]?.text).toBe('The voice line is not connected right now.')
    expect(spy.placed).toEqual([])
    expect(await r.runtime.callMe()).toBe('NOT_REGISTERED')

    spy.announce('REGISTERED')
    const incoming = fakeCall('INBOUND', PHONE)
    spy.ring(incoming.call)
    await until(() => incoming.log.includes('answer'), 'the call to be taken')
    expect((await r.runtime.settingsView()).voice.inCall).toBe(true)
    await r.runtime.line.handleUpdate(fakeUpdate({ text: 'call me', providerUserId: '1001', providerMessageId: 'm-3' }))
    expect(r.api.sent[1]?.text).toBe('The line is busy.')
    expect(await r.runtime.callMe()).toBe('LINE_BUSY')
    await r.runtime.hangUpCall()
    await settle()
    expect((await r.runtime.settingsView()).voice.inCall).toBe(false)
    expect(incoming.log).toContain('hangUp')
  })

  it('"Call me now" in Settings returns the result in a word and records an answered call', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await r.runtime.setEnabled(true)
    await r.runtime.setSip(SIP)
    const answered = fakeCall('OUTBOUND', PHONE)
    spy.nextPlaced = () => ({ outcome: 'ANSWERED', call: answered.call })
    expect(await r.runtime.callMe()).toBe('CONVERSATION')
    expect((await r.runtime.settingsView()).voice.inCall).toBe(true)
    answered.remoteHangUp()
    await until(() => !answered.log.includes('never'), 'a tick')
    await settle(60)
    const view = await r.runtime.settingsView()
    expect(view.voice.inCall).toBe(false)
    expect(view.voice.lastCalls[0]).toMatchObject({ direction: 'OUTBOUND', outcome: 'CONVERSATION', endReason: 'REMOTE_HUNG_UP', security: { signalling: 'TLS', media: 'ZRTP', endToEnd: true } })
  })

  it('an event with call: true places one call; unanswered, the report goes by message once and is not sent again', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await pairTelegram(r)
    await r.runtime.setSip(SIP)

    await r.runtime.line.report(event('PROGRAM_COMPLETE', 'prog-1', 'RaceDeck is finished'))
    expect(spy.placed).toEqual([PHONE])
    const mine = r.api.sent.filter((m) => m.text.includes('RaceDeck is finished'))
    expect(mine).toHaveLength(1)
    expect(mine[0]?.text).toMatch(/no answer/)
    await r.runtime.flush()
    await r.runtime.flush()
    expect(spy.placed).toHaveLength(1)
    expect(r.api.sent.filter((m) => m.text.includes('RaceDeck is finished'))).toHaveLength(1)
  })

  it('an event whose call is answered opens a conversation and sends no message', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await pairTelegram(r)
    await r.runtime.setSip(SIP)
    const answered = fakeCall('OUTBOUND', PHONE)
    spy.nextPlaced = () => ({ outcome: 'ANSWERED', call: answered.call })
    await r.runtime.line.report(event('CRITICAL_FAILURE', 'run-9', 'the run failed'))
    expect(spy.placed).toHaveLength(1)
    expect(r.api.sent).toEqual([])
    expect((await r.runtime.settingsView()).voice.inCall).toBe(true)
    answered.remoteHangUp()
    await settle(60)
  })

  it('an event with call: false places nothing; with no voice line the report goes by message once', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await pairTelegram(r)
    await r.runtime.setSip(SIP)
    await r.runtime.line.report(event('SECURITY_BOUNDARY_REQUIRED', 'b-1', 'a request waits'))
    expect(spy.placed).toEqual([])
    expect(r.api.sent.map((m) => m.text)).toEqual(['NEXUS: a request waits'])

    const none = rig({ voice: null })
    await pairTelegram(none)
    await none.runtime.line.report(event('PROGRAM_COMPLETE', 'prog-2', 'finished'))
    expect(none.api.sent.map((m) => m.text)).toEqual(['NEXUS: finished'])
  })

  it('with the message channel down, a call nobody answers is followed by a notification on the PC, once', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await r.runtime.setEnabled(true) // no bot token: nothing to send by message
    await r.runtime.setSip(SIP)
    await r.runtime.line.report(event('PROGRAM_COMPLETE', 'prog-3', 'finished at last'))
    expect(spy.placed).toHaveLength(1)
    expect(r.notified.filter((t) => t.includes('finished at last'))).toHaveLength(1)
    await r.runtime.flush()
    expect(r.notified.filter((t) => t.includes('finished at last'))).toHaveLength(1)
  })
})

describe('the call policy', () => {
  it('is kept, bounded, and read by the line each time (no rebuild)', async () => {
    const { host, spy } = fakeVoice()
    const r = rig({ voice: host })
    await r.runtime.setEnabled(true)
    await r.runtime.setSip(SIP)
    expect((await r.runtime.settingsView()).voice.policy).toEqual({ requirePin: true, ringSeconds: 30, maxPlacedCallsPerDay: 6, minMinutesBetweenPlacedCalls: 10 })
    await r.runtime.setVoicePolicy({ requirePin: true, ringSeconds: 45, maxPlacedCallsPerDay: 0, minMinutesBetweenPlacedCalls: 5 })
    expect(spy.created).toBe(1)
    expect((await r.runtime.settingsView()).voice.policy).toEqual({ requirePin: true, ringSeconds: 45, maxPlacedCallsPerDay: 0, minMinutesBetweenPlacedCalls: 5 })
    // 0 calls a day: the operator's own request is held back by the day's limit and the report goes by message.
    expect(await r.runtime.callMe()).toBe('SUPPRESSED')
    expect(spy.placed).toEqual([])
    await r.runtime.setVoicePolicy({ requirePin: false, ringSeconds: 999, maxPlacedCallsPerDay: 99, minMinutesBetweenPlacedCalls: -4 })
    expect((await r.runtime.settingsView()).voice.policy).toEqual({ requirePin: false, ringSeconds: 60, maxPlacedCallsPerDay: 24, minMinutesBetweenPlacedCalls: 0 })
    // The configuration survives a restart on the same database.
    const again = rig({ db: r.db, secrets: r.secrets, voice: fakeVoice().host })
    expect((await again.runtime.settingsView()).voice).toMatchObject({ configured: true, identity: NEXUS, passwordSet: true, policy: { requirePin: false } })
  })
})
