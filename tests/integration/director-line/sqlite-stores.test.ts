import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_COMMUNICATION_POLICY, type DeliveryAttempt, type OperatorIdentity } from '@shared/director-line'
import { openDatabase, type Database } from '@main/modules/persistence'
import { PairingService } from '@main/modules/director-line/pairing'
import {
  SqliteDeliveryStore, SqliteDirectorLineSettings, SqliteIdentityStore, SqliteOffsetStore, SqliteOutboxStore, SqlitePairingStateStore,
  SqlitePolicyStore, SqliteSeenStore,
} from '@main/modules/director-line/sqlite-stores'
import type { OutboxItem } from '@main/modules/director-line/stores'

const root = join(process.cwd(), 'test-results', 'director-line-wiring')
const dirs: string[] = []
const open: Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
function memory(): Database {
  const db = openDatabase(':memory:')
  open.push(db)
  return db
}
function fileDb(): { db: Database; dir: string } {
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'stores-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'nexus.db'))
  open.push(db)
  return { db, dir }
}

describe('SQLite director line stores', () => {
  it('identities round-trip, replace on the same key, and remove', async () => {
    const store = new SqliteIdentityStore(memory())
    const a: OperatorIdentity = { channel: 'TELEGRAM', providerUserId: '1001', label: 'user', pairedAt: '2026-10-13T10:00:00.000Z', pairedVia: 'PAIRING_CODE' }
    await store.put(a)
    await store.put({ ...a, label: 'Renamed' })
    await store.put({ channel: 'TWILIO_VOICE', providerUserId: '+33612345678', label: 'Phone', pairedAt: '2026-10-13T11:00:00.000Z', pairedVia: 'PHONE_AND_PIN' })
    expect(await store.list()).toEqual([{ ...a, label: 'Renamed' }, expect.objectContaining({ channel: 'TWILIO_VOICE', providerUserId: '+33612345678' })])
    await store.remove('TELEGRAM', '1001')
    expect((await store.list()).map((i) => i.channel)).toEqual(['TWILIO_VOICE'])
  })

  it('pairing state round-trips whole, including the code, the pin hash and the counters', async () => {
    const store = new SqlitePairingStateStore(memory())
    expect(await store.load()).toEqual({ installSalt: null, code: null, pin: null, attempts: {} })
    const state = {
      installSalt: 'ab12',
      code: { channel: 'TELEGRAM' as const, hash: 'h1', expiresAt: '2026-10-13T12:10:00.000Z', wrongAttempts: 3 },
      pin: { hash: 'ph' },
      attempts: { 'chat:TELEGRAM:9': { count: 2, lockedUntil: null }, 'pin:+1': { count: 0, lockedUntil: '2026-10-13T13:00:00.000Z' } },
    }
    await store.save(state)
    expect(await store.load()).toEqual(state)
    await store.save({ ...state, code: null, pin: null })
    expect(await store.load()).toEqual({ ...state, code: null, pin: null })
  })

  it('the seen set is atomic, survives a restart (a second store object), and prunes by age', async () => {
    const db = memory()
    const first = new SqliteSeenStore(db)
    expect(await first.addIfAbsent('telegram:1', '2026-10-13T10:00:00.000Z')).toBe(true)
    expect(await first.addIfAbsent('telegram:1', '2026-10-13T10:00:01.000Z')).toBe(false)
    // Concurrent attempts on one key: exactly one wins.
    const results = await Promise.all(Array.from({ length: 20 }, () => new SqliteSeenStore(db).addIfAbsent('race', '2026-10-13T10:00:00.000Z')))
    expect(results.filter(Boolean)).toHaveLength(1)
    const restarted = new SqliteSeenStore(db)
    expect(await restarted.addIfAbsent('telegram:1', '2026-10-13T11:00:00.000Z')).toBe(false)
    await restarted.addIfAbsent('late', '2026-10-13T12:00:00.000Z')
    await restarted.prune('2026-10-13T10:30:00.000Z')
    expect(await restarted.addIfAbsent('telegram:1', '2026-10-13T12:30:00.000Z')).toBe(true)
    expect(await restarted.addIfAbsent('late', '2026-10-13T12:30:00.000Z')).toBe(false)
  })

  it('the outbox round-trips, updates in place, orders by age and removes', async () => {
    const store = new SqliteOutboxStore(memory())
    const item = (id: string, createdAt: string): OutboxItem => ({
      id, createdAt, state: 'PENDING', callAttempts: 0, messageAttempts: 0, nextAttemptAt: null, quietNoted: false,
      event: { kind: 'MISSION_BLOCKED', at: createdAt, subjectId: 's', text: 'blocked', minutes: 40 },
    })
    await store.put(item('b', '2026-10-13T10:05:00.000Z'))
    await store.put(item('a', '2026-10-13T10:00:00.000Z'))
    await store.put({ ...item('a', '2026-10-13T10:00:00.000Z'), callAttempts: 1, messageAttempts: 2, nextAttemptAt: '2026-10-13T11:00:00.000Z', quietNoted: true })
    const list = await store.list()
    expect(list.map((i) => i.id)).toEqual(['a', 'b'])
    expect(list[0]).toMatchObject({ callAttempts: 1, messageAttempts: 2, nextAttemptAt: '2026-10-13T11:00:00.000Z', quietNoted: true, state: 'PENDING' })
    expect(list[0]!.event).toEqual({ kind: 'MISSION_BLOCKED', at: '2026-10-13T10:00:00.000Z', subjectId: 's', text: 'blocked', minutes: 40 })
    await store.remove('a')
    expect((await store.list()).map((i) => i.id)).toEqual(['b'])
  })

  it('deliveries round-trip; last is the newest; list is newest first and bounded', async () => {
    const store = new SqliteDeliveryStore(memory())
    expect(await store.last()).toBeNull()
    const at = (n: number): DeliveryAttempt => ({
      channel: n % 2 ? 'TELEGRAM' : 'LOCAL_NOTIFICATION', at: `2026-10-13T10:0${n}:00.000Z`, outcome: n === 3 ? 'FAILED' : 'SENT',
      providerReference: n === 3 ? null : `ref${n}`, errorClass: n === 3 ? 'NETWORK' : null, reportId: `r${n}`,
    })
    for (const n of [1, 2, 3]) await store.add(at(n))
    expect(await store.last()).toEqual(at(3))
    expect(await store.list(2)).toEqual([at(3), at(2)])
    expect(await store.list(10)).toHaveLength(3)
  })

  it('the policy and the settings row round-trip; the offset survives a second store object', async () => {
    const db = memory()
    const policy = new SqlitePolicyStore(db)
    expect(await policy.get()).toBeNull()
    const p = structuredClone(DEFAULT_COMMUNICATION_POLICY)
    p.quietHours.timeZone = 'Europe/Paris'
    await policy.set(p)
    await policy.set(p)
    expect(await new SqlitePolicyStore(db).get()).toEqual(p)

    const settings = new SqliteDirectorLineSettings(db)
    expect(settings.read()).toEqual({ enabled: false, messageProvider: null, telegramOffset: null })
    settings.setEnabled(true)
    settings.setMessageProvider('TELEGRAM')
    const offset = new SqliteOffsetStore(settings)
    expect(await offset.get()).toBeNull()
    await offset.set(4242)
    expect(await new SqliteOffsetStore(new SqliteDirectorLineSettings(db)).get()).toBe(4242)
    expect(new SqliteDirectorLineSettings(db).read()).toEqual({ enabled: true, messageProvider: 'TELEGRAM', telegramOffset: 4242 })
  })

  it('nothing secret reaches the database in the clear: neither the PIN nor the pairing code, in any table or in the file', async () => {
    const { db, dir } = fileDb()
    const pairing = new PairingService({ state: new SqlitePairingStateStore(db), identities: new SqliteIdentityStore(db) })
    const pin = '7391846'
    await pairing.setPin(pin)
    const { code, displayCode } = await pairing.startPairing('TELEGRAM')

    const all: string[] = []
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      all.push(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()))
    }
    const text = all.join('\n')
    expect(text).not.toContain(pin)
    expect(text).not.toContain(code)
    expect(text).not.toContain(displayCode)
    // The hashes are there, which is the point.
    expect(text).toMatch(/[0-9a-f]{64}/)

    // And in the bytes of the files (after the log is folded in).
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    for (const file of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, file)).toString('latin1')
      expect(bytes, file).not.toContain(pin)
      expect(bytes, file).not.toContain(code)
      expect(bytes, file).not.toContain(displayCode)
    }
  })
})
