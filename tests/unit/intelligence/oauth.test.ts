import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  beginOAuth,
  ChatGPTSession,
  validateIdToken,
  type CredentialVault,
  type PlanCredentials,
} from '@main/modules/intelligence/oauth'

const now = 1790000000000
const host = 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const credentials: PlanCredentials = {
  clientId: 'oaiapp_test',
  issuer: 'https://auth.openai.com',
  subject: 'subject',
  email: null,
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  idToken: 'old-id',
  scopes: ['chatgpt.tokens.use.direct'],
  expiresAt: now - 1,
}
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'RS256', use: 'sig' }
function token(nonce: string, overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      sub: 'subject',
      aud: 'oaiapp_test',
      exp: now / 1000 + 3600,
      iat: now / 1000,
      nonce,
      ...overrides,
    }),
  ).toString('base64url')
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`
}
function vault(initial: PlanCredentials | null) {
  let value = initial
  return {
    read: async () => value,
    write: async (next: PlanCredentials | null) => {
      value = next
    },
  } satisfies CredentialVault
}
describe('SIWC authentication boundary', () => {
  it('creates fresh PKCE/state/nonce and preserves issued registration on reconnect', () => {
    const first = beginOAuth(host, 1455, null, now)
    const returning = beginOAuth(host, 1455, credentials, now)
    expect(new URL(first.url).searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(new URL(returning.url).searchParams.has('agent_name_hint')).toBe(false)
    expect(new URL(returning.url).searchParams.get('id_token_hint')).toBe('old-id')
    expect(
      new URL(beginOAuth(host, 1455, { ...credentials, idToken: '' }, now).url).searchParams.has(
        'id_token_hint',
      ),
    ).toBe(false)
    expect(first.attempt.state).not.toBe(returning.attempt.state)
    expect(first.attempt.verifier).not.toBe(returning.attempt.verifier)
  })
  it('validates signature, audience, nonce, issuer, lifetime and multi-audience azp', () => {
    expect(validateIdToken(token('n'), { keys: [jwk] }, 'oaiapp_test', 'n', now).sub).toBe(
      'subject',
    )
    for (const override of [
      { aud: 'wrong' },
      { nonce: 'wrong' },
      { iss: 'https://evil.invalid' },
      { exp: now / 1000 },
      { aud: ['oaiapp_test', 'other'] },
      { nbf: now / 1000 + 3600 },
    ]) {
      expect(() =>
        validateIdToken(token('n', override), { keys: [jwk] }, 'oaiapp_test', 'n', now),
      ).toThrow()
    }
    expect(() => validateIdToken(token('n'), { keys: [] }, 'oaiapp_test', 'n', now)).toThrow()
  })
  it('rejects invalid callback without burning valid sign-in; identity alone does not authorize inference', async () => {
    const v = vault(null)
    const { attempt } = beginOAuth(host, 1455, null, now)
    const transport: typeof fetch = async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('jwks.json')
            ? { keys: [jwk] }
            : {
                access_token: 'a',
                id_token: token(attempt.nonce),
                expires_in: 3600,
                scope: 'openid',
                token_type: 'Bearer',
              },
        ),
      )
    const session = new ChatGPTSession(v, transport, () => now)
    const callback = new URL(
      `${attempt.redirectUri}?state=${attempt.state}&code=c&client_id=oaiapp_test`,
    )
    await expect(session.exchange(attempt, new URL(attempt.redirectUri))).rejects.toThrow(
      'verified',
    )
    await session.exchange(attempt, callback)
    await expect(session.accessToken()).rejects.toThrow('SIGNED_IN_NO_PLAN_USAGE')
    await expect(session.exchange(attempt, callback)).rejects.toThrow('consumed')
  })
  it('serializes concurrent rotating refresh and stores the replacement atomically', async () => {
    const v = vault(credentials)
    let calls = 0
    const session = new ChatGPTSession(
      v,
      async () => {
        calls++
        return new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        )
      },
      () => now,
    )
    expect(await Promise.all(Array.from({ length: 20 }, () => session.accessToken()))).toEqual(
      Array(20).fill('new-access'),
    )
    expect(calls).toBe(1)
    expect((await v.read())?.refreshToken).toBe('new-refresh')
  })
  it('preserves tokens after temporary failure and clears terminal invalidation', async () => {
    for (const code of ['temporarily_unavailable', 'invalid_grant']) {
      const v = vault(credentials)
      const session = new ChatGPTSession(
        v,
        async () => new Response(JSON.stringify({ error: code }), { status: 400 }),
        () => now,
      )
      await expect(session.accessToken()).rejects.toThrow()
      expect(await v.read()).toEqual(code === 'invalid_grant' ? null : credentials)
    }
  })
})
