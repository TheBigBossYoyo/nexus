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
