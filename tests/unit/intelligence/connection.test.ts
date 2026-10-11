import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatGPTConnection, type ProtectedStorage } from '@main/modules/intelligence/connection'

const dirs: string[] = []
const connections: ChatGPTConnection[] = []
const credentials = {
  clientId: 'oaiapp_test',
  issuer: 'https://auth.openai.com',
  subject: 'subject',
  email: null,
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  idToken: 'test-id',
  scopes: ['chatgpt.tokens.use.direct'],
  expiresAt: Date.now() + 3600000,
}
const protection: ProtectedStorage = {
  available: () => true,
  encrypt: (v) => Buffer.from(v),
  decrypt: (v) => v.toString(),
}
function setup(
  options: {
    expired?: boolean
    storage?: ProtectedStorage
    transport?: typeof fetch
    open?: (url: string) => Promise<void>
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-connection-test-'))
  dirs.push(dir)
  const path = join(dir, 'chatgpt-credentials.protected')
  writeFileSync(
    path,
    JSON.stringify({
      hostId: 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      active: 'one',
      profiles: [
        {
          id: 'one',
          registration: { ...credentials, accessToken: '', refreshToken: null, idToken: '' },
          credentials: options.expired
            ? { ...credentials, expiresAt: 0, refreshToken: null }
            : credentials,
          model: 'model-test',
          includedOnlyConfirmed: true,
        },
      ],
    }),
  )
  const connection = new ChatGPTConnection(
    dir,
    options.storage ?? protection,
    options.open,
    options.transport ?? vi.fn(),
  )
  connections.push(connection)
  return { connection, path }
}
afterEach(() => {
  for (const c of connections.splice(0)) c.dispose()
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + '\\nexus-connection-test-'))
      throw new Error('Unexpected cleanup path')
    rmSync(dir, { recursive: true, force: true })
  }
})
describe('protected ChatGPT connection owner', () => {
  it('aborts in-flight inference and settles before shutdown completes', async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const transport: typeof fetch = vi.fn(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          started()
          const signal = options?.signal
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const { connection } = setup({ transport })
    const work = connection.provider()!.complete('Return JSON', {})
    const rejected = expect(work).rejects.toThrow('Runtime stopping')
    await ready
    connection.dispose()
    await connection.idle()
    await rejected
    expect(transport).toHaveBeenCalledTimes(1)
  })
  describe('a token the provider refuses', () => {
    const sse = (): Response =>
      new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{"ok":true}' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    const fresh = { access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'Bearer', expires_in: 3600 }
    /** Answers inference by the bearer token it is sent, and the token endpoint with `refresh`. */
    const provider = (accepted: string[], refresh: () => Response) => {
      const calls: string[] = []
      const transport = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url).includes('/oauth/token')) {
          calls.push('refresh')
          return refresh()
        }
        const bearer = String((options?.headers as Record<string, string>).Authorization).slice('Bearer '.length)
        calls.push(`inference:${bearer}`)
        return accepted.includes(bearer) ? sse() : json(401, { error: { code: 'invalid_token' } })
      }) as unknown as typeof fetch
      return { transport, calls }
    }

    it('is refreshed once and the request sent once more: one 401 does not ask for a sign-in', async () => {
      const { transport, calls } = provider(['fresh-access'], () => json(200, fresh))
      const { connection, path } = setup({ transport })
      await expect(connection.provider()!.complete('Return JSON', {})).resolves.toEqual({ ok: true })
      expect(calls).toEqual(['inference:test-access', 'refresh', 'inference:fresh-access'])
      expect(connection.status().state).toBe('SIGNED_IN_PLAN_USAGE')
      expect(connection.status().capacity?.state).not.toBe('AUTH_REQUIRED')
      expect(JSON.parse(readFileSync(path, 'utf8')).profiles[0].credentials.accessToken).toBe('fresh-access')
      // The next request uses the new token and asks for nothing.
      await connection.provider()!.complete('Return JSON', {})
      expect(calls.slice(3)).toEqual(['inference:fresh-access'])
    })

    it('whose refresh is refused too reads as needing a sign-in, not as connected', async () => {
      const { transport, calls } = provider([], () => json(400, { error: 'refresh_token_invalidated' }))
      const { connection } = setup({ transport })
      await expect(connection.provider()!.complete('Return JSON', {})).rejects.toThrow()
      expect(calls).toEqual(['inference:test-access', 'refresh'])
      expect(connection.status().state).toBe('AUTH_REQUIRES_RECONNECT')
      expect(connection.provider()).toBeUndefined()
    })

    it('refused again after a refresh is not sent a third time, and the card asks for a sign-in', async () => {
      const { transport, calls } = provider([], () => json(200, fresh))
      const { connection } = setup({ transport })
      await expect(connection.provider()!.complete('Return JSON', {})).rejects.toThrow()
      expect(calls).toEqual(['inference:test-access', 'refresh', 'inference:fresh-access'])
      expect(connection.status().state).toBe('AUTH_REQUIRES_RECONNECT')
      expect(connection.status().capacity?.state).toBe('AUTH_REQUIRED')
    })

    it('a refusal that is not about the token (a 429) is not retried', async () => {
      const calls: string[] = []
      const transport = vi.fn(async () => {
        calls.push('inference')
        return json(429, { error: { code: 'rate_limit_exceeded' } })
      }) as unknown as typeof fetch
      const { connection } = setup({ transport })
      await expect(connection.provider()!.complete('Return JSON', {})).rejects.toThrow()
      expect(calls).toEqual(['inference'])
    })
  })
  it('allows withdrawing inference consent after restart without a catalog', () => {
    const { connection } = setup()
    expect(connection.status().models).toEqual([])
    expect(connection.provider()).toBeDefined()
    expect(connection.configure('model-test', false).includedOnlyConfirmed).toBe(false)
    expect(connection.provider()).toBeUndefined()
    expect(() => connection.configure('model-test', true)).toThrow('refreshed catalog')
  })
  it('latches storage failures and keeps the previous protected file intact', async () => {
    const { connection, path } = setup({
      storage: {
        ...protection,
        encrypt: () => {
          throw new Error('disk denied')
        },
      },
    })
    const before = readFileSync(path)
    expect(() => connection.configure('model-test', false)).toThrow('could not be saved')
    expect(connection.status().state).toBe('STORAGE_UNAVAILABLE')
    expect(connection.provider()).toBeUndefined()
    expect(readFileSync(path)).toEqual(before)
    await expect(connection.models()).rejects.toThrow('storage unavailable')
  })
  it('reports expired credentials without refresh capability as reconnect required', () => {
    expect(setup({ expired: true }).connection.status().state).toBe('AUTH_REQUIRES_RECONNECT')
  })
  it('never returns credential values through renderer status', () => {
    const json = JSON.stringify(setup().connection.status())
    for (const secret of ['test-access', 'test-refresh', 'test-id'])
      expect(json).not.toContain(secret)
  })
  it('retains registration but removes authorization when remote revocation fails', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('offline'))
    const { connection, path } = setup({ transport })
    const status = await connection.disconnect()
    expect(status.state).toBe('AUTH_REQUIRES_RECONNECT')
    expect(status.error).toContain('not confirmed')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.profiles[0].credentials).toBeNull()
    expect(saved.profiles[0].registration.clientId).toBe('oaiapp_test')
    expect(connection.provider()).toBeUndefined()
  })
  it('releases failed browser startup and shuts down its loopback listener', async () => {
    let callback = ''
    const open = vi.fn(async (url: string) => {
      callback = new URL(url).searchParams.get('redirect_uri')!
      throw new Error('browser unavailable: SENTINEL_SECRET_AUTHORIZATION_URL')
    })
    const { connection } = setup({ open })
    await expect(connection.connect()).rejects.toThrow('browser unavailable')
    expect(connection.status().error ?? '').not.toContain('SENTINEL_SECRET_AUTHORIZATION_URL')
    expect(connection.status().state).not.toBe('CONNECTING')
    await expect(fetch(callback)).rejects.toThrow()
    connection.configure('model-test', false)
    connection.dispose()
    await expect(connection.connect()).rejects.toThrow('shutting down')
  })
})

describe('leaving a state the connection used to be stuck in', () => {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('a sign-in waiting for the browser can be cancelled, and the connection is free at once', async () => {
    let callback = ''
    const open = vi.fn(async (url: string) => {
      callback = new URL(url).searchParams.get('redirect_uri')!
    })
    const { connection } = setup({ open })
    expect((await connection.connect()).state).toBe('CONNECTING')
    expect(() => connection.configure('model-test', false)).toThrow('in progress')
    const status = connection.cancelConnect()
    expect(status.state).toBe('SIGNED_IN_PLAN_USAGE')
    expect(status.error).toBeNull()
    // The listener is gone and the next operation is not refused as busy.
    await expect(fetch(callback)).rejects.toThrow()
    expect(connection.configure('model-test', false).includedOnlyConfirmed).toBe(false)
    // Cancelling when nothing waits changes nothing.
    expect(connection.cancelConnect().state).toBe('SIGNED_IN_PLAN_USAGE')
  })

  it('a failed write is left without a restart: the file as it was is loaded again', () => {
    let fail = true
    const { connection, path } = setup({
      storage: {
        ...protection,
        encrypt: (v) => {
          if (fail) throw new Error('disk denied')
          return Buffer.from(v)
        },
      },
    })
    const before = readFileSync(path)
    expect(() => connection.configure('model-test', false)).toThrow('could not be saved')
    expect(connection.status().state).toBe('STORAGE_UNAVAILABLE')
    fail = false
    const status = connection.recoverStorage(false)
    expect(status.state).toBe('SIGNED_IN_PLAN_USAGE')
    // What the failed write wanted is not applied: the confirmation is as the file has it.
    expect(status.includedOnlyConfirmed).toBe(true)
    expect(readFileSync(path)).toEqual(before)
    expect(connection.configure('model-test', false).includedOnlyConfirmed).toBe(false)
  })

  it('a file that cannot be read is discarded only when the user chose that', () => {
    const { connection, path } = setup()
    writeFileSync(path, 'not what was written')
    const broken = new ChatGPTConnection(resolve(path, '..'), protection, undefined, vi.fn())
    connections.push(broken)
    expect(broken.status().state).toBe('STORAGE_UNAVAILABLE')
    expect(() => broken.recoverStorage(false)).toThrow('cannot be read')
    expect(readFileSync(path, 'utf8')).toBe('not what was written')
    expect(broken.recoverStorage(true).state).toBe('SIGNED_OUT')
    expect(() => readFileSync(path)).toThrow()
    expect(connection).toBeDefined()
  })

  it('storage that is still unavailable is not recovered', () => {
    const { connection } = setup({ storage: { ...protection, available: () => false } })
    expect(() => connection.recoverStorage(true)).toThrow('still unavailable')
    expect(connection.status().state).toBe('STORAGE_UNAVAILABLE')
  })

  it('a saved model the account no longer offers is dropped with its confirmation when the catalog is read', async () => {
    const transport = vi.fn(async () => json(200, { models: [{ slug: 'model-new', display_name: 'New', visibility: 'list' }] })) as unknown as typeof fetch
    const { connection, path } = setup({ transport })
    expect(connection.provider()).toBeDefined()
    const status = await connection.models()
    expect(status.model).toBeNull()
    expect(status.includedOnlyConfirmed).toBe(false)
    expect(status.error).toContain('no longer offered')
    expect(connection.provider()).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8')).profiles[0].model).toBeNull()
    expect(connection.configure('model-new', true).model).toBe('model-new')
  })

  it('a refused request is not a capacity state and plans no wait; a limit named in the stream is one', async () => {
    const refused = vi.fn(async () => json(404, { error: { code: 'model_not_found' } })) as unknown as typeof fetch
    const a = setup({ transport: refused }).connection
    await expect(a.provider()!.complete('Return JSON', {})).rejects.toThrow('refused this request (404; model_not_found)')
    expect(a.status().capacity?.state).toBe('USAGE_UNKNOWN')
    expect(a.status().capacity?.nextProbeAt).toBeNull()
    const limited = vi.fn(async () =>
      new Response(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    ) as unknown as typeof fetch
    const b = setup({ transport: limited }).connection
    await expect(b.provider()!.complete('Return JSON', {})).rejects.toThrow()
    expect(b.status().capacity?.state).toBe('THROTTLED')
    const quota = vi.fn(async () => json(429, { error: { code: 'insufficient_quota' } })) as unknown as typeof fetch
    const c = setup({ transport: quota }).connection
    await expect(c.provider()!.complete('Return JSON', {})).rejects.toThrow()
    expect(c.status().capacity?.state).toBe('QUOTA_PAUSED')
    // An answer that is not JSON is no evidence about capacity either (finding 1.2).
    const garbled = vi.fn(async () =>
      new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'not json' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    ) as unknown as typeof fetch
    const d = setup({ transport: garbled }).connection
    await expect(d.provider()!.complete('Return JSON', {})).rejects.toThrow('not valid JSON')
    expect(d.status().capacity?.state).toBe('USAGE_UNKNOWN')
    expect(d.status().capacity?.nextProbeAt).toBeNull()
  })
})
