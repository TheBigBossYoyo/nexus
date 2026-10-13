import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '@main/modules/persistence'
import { SqliteCallStore, SqliteDirectorLineSettings, SqliteVoiceConfigStore, MAX_CALL_RECORDS } from '@main/modules/director-line/sqlite-stores'
import { defaultVoiceLineConfig, sanitizeVoiceLineConfig } from '@main/modules/director-line/voice-config'
import { DEFAULT_VOICE_LINE_POLICY, type CallRecord } from '@main/modules/director-line/voice-line'

const open: Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close()
})
function memory(): Database {
  const db = openDatabase(':memory:')
  open.push(db)
  return db
}

const call = (n: number, over: Partial<CallRecord> = {}): CallRecord => ({
  callId: `call-${n}`,
  direction: 'INBOUND',
  startedAt: `2026-10-14T08:${String(n % 60).padStart(2, '0')}:00.000Z`,
  endedAt: `2026-10-14T08:${String(n % 60).padStart(2, '0')}:30.000Z`,
  outcome: 'CONVERSATION',
  endReason: 'REMOTE_HUNG_UP',
  authenticated: true,
  security: { signalling: 'TLS', media: 'ZRTP', endToEnd: true },
  medianAnswerMs: 1234,
  ...over,
})

describe('the voice line configuration store', () => {
  it('starts with the defaults and round-trips what is saved', () => {
    const db = memory()
    const store = new SqliteVoiceConfigStore(db)
    expect(store.get()).toEqual({ sip: null, policy: DEFAULT_VOICE_LINE_POLICY, languages: ['en', 'fr'], recordTranscripts: false })
    const config = {
      ...defaultVoiceLineConfig(),
      sip: { identity: 'sip:nexus@sip.linphone.org', server: 'sip:sip.linphone.org;transport=tls', transport: 'tls' as const, mediaEncryption: 'zrtp' as const, mediaEncryptionMandatory: true, stunServer: null, ice: true, displayName: 'NEXUS Director' },
    }
    store.set(config)
    store.set({ ...config, policy: { ...config.policy, ringSeconds: 45 } })
    expect(new SqliteVoiceConfigStore(db).get()).toEqual({ ...config, policy: { ...config.policy, ringSeconds: 45 } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM director_line_voice').get()).toEqual({ n: 1 })
  })

  it('reads whatever is stored: a field that is missing or wrong takes its default, a row that is not JSON is the defaults', () => {
    const db = memory()
    db.prepare('INSERT INTO director_line_voice (id, config_json) VALUES (1, ?)').run(JSON.stringify({ sip: { identity: 'Sip:Nexus@SIP.linphone.org', mediaEncryption: 'rot13', ice: 'yes' }, policy: { ringSeconds: 999, requirePin: 'no' }, languages: [] }))
    const config = new SqliteVoiceConfigStore(db).get()
    expect(config.sip).toEqual({
      identity: 'sip:nexus@sip.linphone.org', server: 'sip:sip.linphone.org;transport=tls', transport: 'tls', mediaEncryption: 'zrtp', mediaEncryptionMandatory: true, stunServer: null, ice: true, displayName: 'NEXUS Director',
    })
    expect(config.policy).toEqual({ ...DEFAULT_VOICE_LINE_POLICY, ringSeconds: 60 })
    expect(config.languages).toEqual(['en', 'fr'])
    db.prepare('UPDATE director_line_voice SET config_json = ? WHERE id = 1').run('{{{ not json')
    expect(new SqliteVoiceConfigStore(db).get()).toEqual(defaultVoiceLineConfig())
    expect(sanitizeVoiceLineConfig({ sip: { identity: 'not an address' } }).sip).toBeNull()
  })

  it('a 0.9.0 settings row that says TWILIO_VOICE is read as nothing', () => {
    const db = memory()
    db.prepare("INSERT INTO director_line_settings (id, enabled, message_provider, voice_provider, relay_base_url) VALUES (1, 1, 'TELEGRAM', 'TWILIO_VOICE', 'https://relay.example.invalid')").run()
    const row = new SqliteDirectorLineSettings(db).read()
    expect(row).toEqual({ enabled: true, messageProvider: 'TELEGRAM', telegramOffset: null })
    expect(new SqliteVoiceConfigStore(db).get().sip).toBeNull()
  })
})

describe('the call record store', () => {
  it('keeps when, which way, how it ended and what was negotiated, newest first', () => {
    const store = new SqliteCallStore(memory())
    store.add(call(1))
    store.add(call(2, { direction: 'OUTBOUND', outcome: 'NO_ANSWER', endReason: null, authenticated: false, security: null, medianAnswerMs: null }))
    store.add(call(3, { security: { signalling: 'TLS', media: 'DTLS_SRTP', endToEnd: false }, medianAnswerMs: 900.4 }))
    const recent = store.recent(5)
    expect(recent.map((c) => c.callId)).toEqual(['call-3', 'call-2', 'call-1'])
    expect(recent[0]).toEqual(call(3, { security: { signalling: 'TLS', media: 'DTLS_SRTP', endToEnd: false }, medianAnswerMs: 900 }))
    expect(recent[1]).toEqual(call(2, { direction: 'OUTBOUND', outcome: 'NO_ANSWER', endReason: null, authenticated: false, security: null, medianAnswerMs: null }))
    expect(store.recent(2)).toHaveLength(2)
  })

  it('never keeps more than the newest 200', () => {
    const store = new SqliteCallStore(memory())
    for (let n = 1; n <= MAX_CALL_RECORDS + 25; n += 1) store.add(call(n))
    expect(store.count()).toBe(MAX_CALL_RECORDS)
    const newest = store.recent(1)[0]
    expect(newest?.callId).toBe(`call-${MAX_CALL_RECORDS + 25}`)
    expect(store.recent(1000).at(-1)?.callId).toBe('call-26')
  })

  it('has no column that could hold what was said', () => {
    const db = memory()
    const cols = (db.prepare('PRAGMA table_info(director_line_calls)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['seq', 'call_id', 'direction', 'started_at', 'ended_at', 'outcome', 'end_reason', 'authenticated', 'signalling', 'media', 'end_to_end', 'median_answer_ms'])
  })
})
