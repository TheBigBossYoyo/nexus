import { describe, expect, it } from 'vitest'
import type { HttpFetch, RawProviderUpdate } from '@main/modules/director-line/provider'
import { MemoryOffsetStore, scrubSecrets, splitForTelegram, TelegramProvider } from '@main/modules/director-line/telegram'

// A value that looks like a bot token, assembled from parts so the repository's own credential scan does not flag it.
const TOKEN = ['123456789', ':', 'AAF', 'fakefakefakefakefakefakefake', '_x1'].join('')

interface Call { url: string; body: Record<string, unknown> }

function rig(responses: Array<unknown | ((call: Call) => unknown)>, options: { token?: string | null } = {}) {
  const calls: Call[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  let i = 0
  const fetch: HttpFetch = async (url, init) => {
    const call = { url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> }
    calls.push(call)
    const next = responses[Math.min(i, responses.length - 1)]
    i += 1
    const value = typeof next === 'function' ? (next as (c: Call) => unknown)(call) : next
    if (value instanceof Error) throw value
    const v = value as { status?: number; body: unknown }
    return { status: v.status ?? 200, json: async () => v.body }
  }
  const offsetStore = new MemoryOffsetStore()
  const provider = new TelegramProvider({ getToken: async () => (options.token === undefined ? TOKEN : options.token), fetch, offsetStore, sleep: async (ms) => { sleeps.push(ms) }, log: (l) => logs.push(l), pollTimeoutSeconds: 0 })
  return { provider, calls, sleeps, logs, offsetStore }
}

const msg = (updateId: number, chatId: number, text: string, extra: Record<string, unknown> = {}, chatType = 'private') => ({
  update_id: updateId,
  message: { message_id: updateId * 10, date: 1_700_000_000, text, chat: { id: chatId, type: chatType }, from: { id: chatId, is_bot: false, first_name: 'Y' }, ...extra },
})

describe('TelegramProvider: receiving', () => {
  it('polls getUpdates with offset and restricted allowed_updates, hands over private text, then confirms', async () => {
    const t = rig([{ body: { ok: true, result: [msg(5, 1001, 'status')] } }, { body: { ok: true, result: [] } }])
    const got: RawProviderUpdate[] = []
    t.provider.attach(async (u) => { got.push(u) })
    expect(await t.provider.pollOnce()).toBe('HANDLED')
    expect(await t.provider.pollOnce()).toBe('IDLE')
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ text: 'status', providerUserId: '1001', dedupeKey: 'telegram:5', providerAuthenticated: true, channel: 'TELEGRAM' })
    expect(t.calls[0]!.body.allowed_updates).toEqual(['message'])
    expect(t.calls[0]!.body).not.toHaveProperty('offset')
    expect(t.calls[1]!.body.offset).toBe(6)
    expect(await t.offsetStore.get()).toBe(6)
  })

  it('ignores group chats, channel posts, edited messages, inline and callback queries, bots, and non-text', async () => {
    const updates = [
      msg(1, -100123, 'status', {}, 'supergroup'),
      msg(2, -555, 'status', {}, 'group'),
      { update_id: 3, channel_post: { message_id: 1, chat: { id: -1, type: 'channel' }, text: 'status' } },
      { update_id: 4, edited_message: { message_id: 1, chat: { id: 1001, type: 'private' }, from: { id: 1001, is_bot: false }, text: 'status' } },
      { update_id: 5, inline_query: { id: 'x', from: { id: 1001 }, query: 'status' } },
      { update_id: 6, callback_query: { id: 'x', from: { id: 1001 }, data: 'status' } },
      msg(7, 1001, 'from a bot', { from: { id: 1001, is_bot: true } }),
      { update_id: 8, message: { message_id: 80, chat: { id: 1001, type: 'private' }, from: { id: 1001, is_bot: false }, photo: [] } },
      msg(9, 1001, 'sender differs from chat', { from: { id: 4242, is_bot: false } }),
      msg(10, 1001, 'real one'),
    ]
    const t = rig([{ body: { ok: true, result: updates } }])
    const got: string[] = []
    t.provider.attach(async (u) => { got.push(u.text) })
    await t.provider.pollOnce()
    expect(got).toEqual(['real one'])
    expect(await t.offsetStore.get()).toBe(11)
  })

  it('advances the offset only after hand-over: a failing hand-over leaves it where it was', async () => {
    const t = rig([{ body: { ok: true, result: [msg(20, 1001, 'a'), msg(21, 1001, 'b'), msg(22, 1001, 'c')] } }])
    const seen: string[] = []
    t.provider.attach(async (u) => { if (u.text === 'b') throw new Error('database locked'); seen.push(u.text) })
    await expect(t.provider.pollOnce()).rejects.toThrow('database locked')
    expect(seen).toEqual(['a'])
    expect(await t.offsetStore.get()).toBe(21) // a is confirmed, b is not and will come again
  })

  it('asks again from the persisted offset after a restart', async () => {
    const t = rig([{ body: { ok: true, result: [] } }])
    await t.offsetStore.set(77)
    t.provider.attach(async () => undefined)
    await t.provider.pollOnce()
    expect(t.calls[0]!.body.offset).toBe(77)
  })

  it('honours HTTP 429 retry_after', async () => {
    const t = rig([{ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } } }])
    t.provider.attach(async () => undefined)
    expect(await t.provider.pollOnce()).toBe('RATE_LIMITED')
    expect(t.sleeps).toEqual([7000])
  })

  it('the loop backs off after errors and stops when asked', async () => {
    const t = rig([new Error('boom')])
    const original = t.provider.stop.bind(t.provider)
    const wait = new Promise<void>((resolve) => { (t.provider as unknown as { o: { sleep: (ms: number) => Promise<void> } }).o.sleep = async (ms) => { t.sleeps.push(ms); void original(); resolve() } })
    await t.provider.start(async () => undefined)
    await wait
    await t.provider.stop()
    expect(t.sleeps[0]).toBeGreaterThanOrEqual(2000)
  })

  it('does nothing without a token', async () => {
    const none = rig([{ body: { ok: true, result: [] } }], { token: null })
    none.provider.attach(async () => undefined)
    expect(await none.provider.pollOnce()).toBe('UNCONFIGURED')
    expect(none.calls).toHaveLength(0)
  })
})

describe('TelegramProvider: sending', () => {
  it('sends plain text: no parse_mode, link previews off, message length respected', async () => {
    const t = rig([{ body: { ok: true, result: { message_id: 9 } } }])
    const r = await t.provider.send({ providerUserId: '1001', text: '*bold* <b>x</b> [a](https://example.org)' })
    expect(r).toEqual({ ok: true, providerReference: '9', errorClass: null, retryable: false })
    expect(t.calls[0]!.body).toEqual({ chat_id: '1001', text: '*bold* <b>x</b> [a](https://example.org)', link_preview_options: { is_disabled: true } })
    expect(t.calls[0]!.body).not.toHaveProperty('parse_mode')
  })

  it('splits long text and truncates with a note beyond three parts', async () => {
    const parts = splitForTelegram(`${'line\n'.repeat(3000)}`)
    expect(parts.length).toBeLessThanOrEqual(3)
    expect(parts.every((p) => p.length <= 4096)).toBe(true)
    expect(parts[parts.length - 1]).toContain('cut')
    expect(splitForTelegram('short')).toEqual(['short'])
  })

  it('refuses a chat id that is not numeric', async () => {
    const t = rig([{ body: { ok: true, result: {} } }])
    expect((await t.provider.send({ providerUserId: '1001/../x', text: 'hi' })).errorClass).toBe('REJECTED')
    expect(t.calls).toHaveLength(0)
  })

  it('classifies failures and marks 429 and network errors retryable', async () => {
    const a = rig([{ status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 3 } } }])
    expect(await a.provider.send({ providerUserId: '1', text: 'x' })).toMatchObject({ ok: false, errorClass: 'RATE_LIMITED', retryable: true })
    const b = rig([{ status: 401, body: { ok: false, error_code: 401 } }])
    expect(await b.provider.send({ providerUserId: '1', text: 'x' })).toMatchObject({ errorClass: 'AUTH', retryable: false })
    const c = rig([new Error('fetch failed')])
    expect(await c.provider.send({ providerUserId: '1', text: 'x' })).toMatchObject({ errorClass: 'NETWORK', retryable: true })
  })
})

describe('TelegramProvider: the token never leaks', () => {
  it('not through a failing transport whose message holds the full URL, not through logs, results, health or thrown errors', async () => {
    const leak = new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed, reason: connect ETIMEDOUT`)
    const t = rig([leak])
    const outputs: string[] = []
    outputs.push(JSON.stringify(await t.provider.send({ providerUserId: '1001', text: 'x' })))
    outputs.push(JSON.stringify(await t.provider.health()))
    t.provider.attach(async () => undefined)
    outputs.push(await t.provider.pollOnce())
    await t.provider.start(async () => undefined)
    await new Promise<void>((resolve) => { const o = (t.provider as unknown as { o: { sleep: (ms: number) => Promise<void> } }).o; o.sleep = async () => { void t.provider.stop(); resolve() } })
    await t.provider.stop()
    outputs.push(...t.logs)
    outputs.push(JSON.stringify(t.provider))
    for (const o of outputs) {
      expect(o).not.toContain(TOKEN)
      expect(o).not.toContain('fakefake')
      expect(o).not.toContain('api.telegram.org')
    }
    expect(t.logs.length).toBeGreaterThan(0)
  })

  it('a pollOnce before start throws a plain error', async () => {
    const t = rig([{ body: { ok: true, result: [] } }])
    await expect(t.provider.pollOnce()).rejects.toThrow('provider not started')
  })

  it('the provider object holds no token field', async () => {
    const t = rig([{ body: { ok: true, result: { username: 'nexus_bot' } } }])
    expect(await t.provider.health()).toEqual({ status: 'OK', errorClass: null, detail: '@nexus_bot' })
    expect(JSON.stringify(Object.values(t.provider))).not.toContain(TOKEN)
  })

  it('scrubSecrets removes the token, bot<token> paths and any URL', () => {
    const s = scrubSecrets(`GET https://api.telegram.org/bot${TOKEN}/sendMessage failed for ${TOKEN}`, TOKEN)
    expect(s).not.toContain(TOKEN)
    expect(s).not.toContain('api.telegram.org')
  })

  it('health reports unconfigured without a token and an error class on failure', async () => {
    expect((await rig([{ body: {} }], { token: null }).provider.health()).status).toBe('UNCONFIGURED')
    const bad = await rig([{ status: 404, body: { ok: false, error_code: 404 } }]).provider.health()
    expect(bad).toEqual({ status: 'ERROR', errorClass: 'AUTH', detail: null })
  })
})
