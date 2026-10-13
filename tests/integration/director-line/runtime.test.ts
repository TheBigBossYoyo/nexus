import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMUNICATION_POLICY } from '@shared/director-line'
import { openDatabase, type Database } from '@main/modules/persistence'
import { createDirectorLineRuntime, MemorySecretStore, type DirectorLineRuntime } from '@main/modules/director-line/runtime'
import { SqliteDirectorLineSettings } from '@main/modules/director-line/sqlite-stores'
import type { HttpFetch } from '@main/modules/director-line/provider'
import { snapshot } from '../../unit/director-line/harness'

const TOKEN = '123456789:AAFakeFakeFakeFakeFakeFake_WXYZ'
const open: Database[] = []
const running: DirectorLineRuntime[] = []
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => undefined)
  for (const db of open.splice(0)) if (db.open) db.close()
})

interface TgUpdate { update_id: number; message: { message_id: number; date: number; text: string; chat: { id: number; type: 'private' }; from: { id: number; is_bot: false; first_name: string } } }

/** A Bot API that long-polls: getUpdates hangs until there is something past the offset, or until it is aborted. */
class FakeTelegramApi {
  updates: TgUpdate[] = []
  sent: { chat_id: string; text: string }[] = []
  getUpdatesCalls = 0
  inflight = 0
  maxInflight = 0
  private nextMessage = 1
  private wake: (() => void) | null = null

  push(chat: number, text: string, updateId: number): void {
    this.updates.push({ update_id: updateId, message: { message_id: this.nextMessage++, date: 1_790_000_000, text, chat: { id: chat, type: 'private' }, from: { id: chat, is_bot: false, first_name: 'Someone' } } })
    this.wake?.()
  }

  readonly fetch: HttpFetch = async (url, init) => {
    const method = url.split('/').pop()
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const ok = (result: unknown) => ({ status: 200, json: async () => ({ ok: true, result }) })
    if (method === 'getMe') return ok({ username: 'nexus_test_bot' })
    if (method === 'sendMessage') {
      this.sent.push({ chat_id: String(body.chat_id), text: String(body.text) })
      return ok({ message_id: 1000 + this.sent.length })
    }
    if (method !== 'getUpdates') return { status: 404, json: async () => ({ ok: false, error_code: 404 }) }
    this.getUpdatesCalls += 1
    this.inflight += 1
    this.maxInflight = Math.max(this.maxInflight, this.inflight)
    try {
      const offset = typeof body.offset === 'number' ? body.offset : 0
      for (;;) {
        const pending = this.updates.filter((u) => u.update_id >= offset)
        if (pending.length > 0) return ok(pending)
        await new Promise<void>((resolve, reject) => {
          this.wake = resolve
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          if (init.signal?.aborted) reject(new Error('aborted'))
        })
      }
    } finally {
      this.inflight -= 1
    }
  }
}

async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function rig(shared?: { db?: Database; secrets?: MemorySecretStore; api?: FakeTelegramApi }) {
  const db = shared?.db ?? openDatabase(':memory:')
  if (!shared?.db) open.push(db)
  const secrets = shared?.secrets ?? new MemorySecretStore()
  const api = shared?.api ?? new FakeTelegramApi()
  const getStatus = vi.fn(async () => ({ snapshots: [{ name: 'RaceDeck', snapshot: snapshot() }], facts: { paused: false, online: true, pendingBoundaryRequests: 0 } }))
  const runtime = createDirectorLineRuntime({
    db,
    secrets,
    fetch: api.fetch,
    reads: { getStatus, getOvernightReport: async () => 'report', getLatestChecks: async () => null },
    actions: { pauseAfterCurrentTask: async () => undefined, resume: async () => undefined, submitIntent: async () => ({ accepted: true }) },
    isOnline: () => true,
    localNotify: async () => undefined,
    recordNote: () => undefined,
    machineTimeZone: 'Europe/Paris',
    telegram: { sleep: async () => new Promise((r) => setTimeout(r, 5)) },
  })
  running.push(runtime)
  return { db, secrets, api, runtime, getStatus }
}

describe('director line runtime', () => {
  it('enable, pair with the code, answer status from the injected reads, answer a stranger with the fixed reply only, disable, restart', async () => {
    const { db, secrets, api, runtime, getStatus } = rig()
    await runtime.setProvider({ kind: 'TELEGRAM', secret: TOKEN })
    await runtime.setEnabled(true)
    await until(() => api.getUpdatesCalls > 0, 'the first poll')

    const view = await runtime.settingsView()
    expect(view.enabled).toBe(true)
    expect(view.messageProvider).toEqual({ kind: 'TELEGRAM', configured: true, tokenSuffix: TOKEN.slice(-4), status: 'CONNECTED' })
    expect(JSON.stringify(view)).not.toContain(TOKEN)
    expect(view.pairedOperator).toBeNull()

    const { displayCode } = await runtime.startPairing('TELEGRAM')
    api.push(1001, displayCode, 1)
    await until(() => api.sent.length === 1, 'the pairing reply')
    expect(api.sent[0]!.chat_id).toBe('1001')
    expect(api.sent[0]!.text).toMatch(/^Paired./)
    expect((await runtime.settingsView()).pairedOperator).toMatchObject({ channel: 'TELEGRAM', label: 'Someone', pairedVia: 'PAIRING_CODE' })

    api.push(1001, 'status', 2)
    await until(() => api.sent.length === 2, 'the status reply')
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(api.sent[1]!.chat_id).toBe('1001')
    expect(api.sent[1]!.text).toContain('RaceDeck')

    api.push(9009, 'status', 3)
    await until(() => api.sent.length === 3, 'the reply to a stranger')
    expect(api.sent[2]).toEqual({ chat_id: '9009', text: 'This NEXUS is not paired with this chat.' })
    expect(getStatus).toHaveBeenCalledTimes(1)

    // Disable: nothing polls any more, and nothing is sent.
    await runtime.setEnabled(false)
    const calls = api.getUpdatesCalls
    api.push(1001, 'status', 4)
    await new Promise((r) => setTimeout(r, 80))
    expect(api.getUpdatesCalls).toBe(calls)
    expect(api.sent).toHaveLength(3)
    expect((await runtime.settingsView()).messageProvider.status).toBe('STOPPED')
    expect(await runtime.sendTestMessage()).toEqual({ ok: false, errorClass: 'NOT_CONFIGURED' })
    await runtime.start()
    expect(api.getUpdatesCalls).toBe(calls)

    // Restart with the same database: still paired, and what was already seen is not processed again.
    const second = rig({ db, secrets, api })
    await second.runtime.setEnabled(true)
    await until(() => api.sent.length === 4, 'the answer to the update that arrived while off')
    expect(api.sent[3]!.chat_id).toBe('1001')
    expect(second.getStatus).toHaveBeenCalledTimes(1)
    expect((await second.runtime.settingsView()).pairedOperator).not.toBeNull()
    // The server delivers everything again (the offset is lost): the durable seen-set refuses all of it.
    await second.runtime.stop()
    new SqliteDirectorLineSettings(db).setOffset(null)
    await second.runtime.start()
    await until(() => api.getUpdatesCalls > calls + 1, 'a poll after the reset')
    await new Promise((r) => setTimeout(r, 80))
    expect(api.sent).toHaveLength(4)
    expect(second.getStatus).toHaveBeenCalledTimes(1)
  })

  it('does nothing and says why when disabled or when there is no token; start is safe twice; stop ends the long poll promptly', async () => {
    const { api, runtime, secrets } = rig()
    await runtime.start()
    expect((await runtime.settingsView()).messageProvider.status).toBe('UNCONFIGURED')
    expect((await runtime.settingsView()).statusReason).toMatch(/token/i)

    await runtime.setEnabled(true) // on, but no token
    expect(api.getUpdatesCalls).toBe(0)
    expect((await runtime.settingsView()).statusReason).toMatch(/token/i)

    await runtime.setProvider({ kind: 'TELEGRAM', secret: TOKEN }) // starts: enabled and a token now
    await Promise.all([runtime.start(), runtime.start()])
    await until(() => api.getUpdatesCalls > 0, 'the poll')
    await new Promise((r) => setTimeout(r, 40))
    expect(api.maxInflight).toBe(1)

    const t0 = Date.now()
    await runtime.stop()
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(api.inflight).toBe(0)
    await runtime.stop() // twice is fine

    await runtime.setProvider({ kind: 'TELEGRAM', secret: null })
    expect(await secrets.get('telegram.botToken')).toBeNull()
    expect((await runtime.settingsView()).messageProvider).toMatchObject({ kind: null, configured: false, tokenSuffix: null, status: 'UNCONFIGURED' })
  })

  it('stores the bot token only through the SecretStore and never returns it', async () => {
    const { db, runtime, secrets } = rig()
    await runtime.setProvider({ kind: 'TELEGRAM', secret: TOKEN })
    expect(await secrets.get('telegram.botToken')).toBe(TOKEN)
    const view = await runtime.settingsView()
    expect(JSON.stringify(view)).not.toContain(TOKEN)
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()), name).not.toContain(TOKEN)
    }
    expect(view.voice).toMatchObject({ available: false, configured: false, identity: null, passwordSet: false, operatorIdentity: null, state: 'STOPPED', inCall: false, lastCalls: [] })
    expect(view.voice.unavailableReason).toMatch(/not available/i)
  })

  it('refuses a pairing before the line is on, and a code for the voice channel', async () => {
    const { runtime } = rig()
    await expect(runtime.startPairing('TELEGRAM')).rejects.toThrow(/Turn the Director Line on/)
    await expect(runtime.startPairing('SIP_VOICE')).rejects.toThrow(/message channel/)
  })

  it('quiet hours default to the machine zone until a policy is saved, and a saved policy is kept across a restart', async () => {
    const { db, runtime } = rig()
    expect((await runtime.settingsView()).policy.quietHours).toEqual({ ...DEFAULT_COMMUNICATION_POLICY.quietHours, timeZone: 'Europe/Paris' })
    const next = structuredClone(DEFAULT_COMMUNICATION_POLICY)
    next.quietHours.timeZone = 'America/New_York'
    next.minProgressIntervalMinutes = 90
    await runtime.setPolicy(next)
    const again = rig({ db })
    expect((await again.runtime.settingsView()).policy).toEqual(next)
  })

  it('a replaced token resets the Telegram offset; the pin is stored through pairing only', async () => {
    const { db, runtime } = rig()
    const settings = new SqliteDirectorLineSettings(db)
    await runtime.setProvider({ kind: 'TELEGRAM', secret: TOKEN })
    settings.setOffset(77)
    await runtime.setProvider({ kind: 'TELEGRAM', secret: TOKEN })
    expect(settings.read().telegramOffset).toBe(77)
    await runtime.setProvider({ kind: 'TELEGRAM', secret: `${TOKEN}x` })
    expect(settings.read().telegramOffset).toBeNull()
    await runtime.setPin('482915')
    expect((await runtime.settingsView()).pinConfigured).toBe(true)
  })
})
