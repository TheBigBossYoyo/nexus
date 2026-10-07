import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from 'node:crypto'
import { z } from 'zod'
import { readBoundedJSON } from './transport'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export interface PlanCredentials {
  clientId: string
  issuer: string
  subject: string
  email: string | null
  accessToken: string
  refreshToken: string | null
  idToken: string
  scopes: string[]
  expiresAt: number
}
export interface CredentialVault {
  read(): Promise<PlanCredentials | null>
  write(value: PlanCredentials | null): Promise<void>
}
export interface OAuthAttempt {
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  clientId: string | null
  expectedSubject: string | null
  expiresAt: number
}
const Tokens = z.object({
  access_token: z.string().min(1).max(32000),
  refresh_token: z.string().min(1).max(32000).optional(),
  id_token: z.string().min(1).max(32000).optional(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().positive().max(86400),
  scope: z.string().max(4000).optional(),
})
const Claims = z.object({
  iss: z.literal(ISSUER),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string(),
  email: z.string().optional(),
  azp: z.string().optional(),
  nbf: z.number().optional(),
})
const unusable = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

export function beginOAuth(
  hostId: string,
  port: number,
  previous: PlanCredentials | null,
  now = Date.now(),
): { attempt: OAuthAttempt; url: string } {
  if (
    !/^urn:uuid:[0-9a-f-]{36}$/i.test(hostId) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Invalid OAuth host or callback')
  const random = () => randomBytes(32).toString('base64url')
  const attempt: OAuthAttempt = {
    state: random(),
    nonce: random(),
    verifier: random(),
    redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    clientId: previous?.clientId ?? null,
    expectedSubject: previous?.subject ?? null,
    expiresAt: now + 600000,
  }
  const url = new URL(`${ISSUER}/api/accounts/authorize`)
  url.search = new URLSearchParams({
    client_id: attempt.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: hostId,
    ...(!previous ? { agent_name_hint: 'NEXUS' } : {}),
    ...(previous?.idToken ? { id_token_hint: previous.idToken } : {}),
    ...(previous?.email ? { login_hint: previous.email } : {}),
    response_type: 'code',
    redirect_uri: attempt.redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
  }).toString()
  return { attempt, url: url.toString() }
}

export function validateIdToken(
  token: string,
  jwks: { keys: JsonWebKey[] },
  clientId: string,
  nonce: string,
  now = Date.now(),
) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid ID token')
  const header = z
    .object({ alg: z.literal('RS256'), kid: z.string().min(1) })
    .parse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')))
  const keys = jwks.keys.filter(
    (key) =>
      key.kid === header.kid &&
      key.kty === 'RSA' &&
      (!key.use || key.use === 'sig') &&
      (!key.alg || key.alg === 'RS256'),
  )
  if (
    keys.length !== 1 ||
    !verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: keys[0]!, format: 'jwk' }),
      Buffer.from(parts[2]!, 'base64url'),
    )
  )
    throw new Error('ID token signature invalid')
  const claims = Claims.parse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')))
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (
    !audience.includes(clientId) ||
    (audience.length > 1 && claims.azp !== clientId) ||
    (claims.azp && claims.azp !== clientId) ||
    claims.nonce !== nonce ||
    claims.exp <= now / 1000 ||
    claims.iat > now / 1000 + 60 ||
    (claims.nbf !== undefined && claims.nbf > now / 1000 + 60)
  )
    throw new Error('ID token claims invalid')
  return claims
}

/** Runtime-only OAuth coordinator; one-use callback and single-flight rotating refresh. */
export class ChatGPTSession {
  private mutationTail: Promise<void> = Promise.resolve()
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
  private refreshInFlight: Promise<string> | null = null
  private usedAttempts = new WeakSet<OAuthAttempt>()
  constructor(
    private readonly vault: CredentialVault,
    private readonly transport: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async exchange(attempt: OAuthAttempt, callback: URL): Promise<void> {
    return this.exclusive(() => this.exchangeUnlocked(attempt, callback))
  }
  private async exchangeUnlocked(attempt: OAuthAttempt, callback: URL): Promise<void> {
    if (this.usedAttempts.has(attempt)) throw new Error('Sign-in attempt already consumed')
    const state = Buffer.from(callback.searchParams.get('state') ?? '')
    const expected = Buffer.from(attempt.state)
    if (
      callback.origin + callback.pathname !== attempt.redirectUri ||
      attempt.expiresAt <= this.now() ||
      state.length !== expected.length ||
      !timingSafeEqual(state, expected)
    )
      throw new Error('Sign-in could not be verified')
    this.usedAttempts.add(attempt)
    if (callback.searchParams.has('error')) throw new Error('Sign-in was declined or failed')
    const clientId = callback.searchParams.get('client_id') ?? attempt.clientId
    const code = callback.searchParams.get('code')
    if (
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      !code ||
      (attempt.clientId && clientId !== attempt.clientId)
    )
      throw new Error('Invalid client registration callback')
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: RESOURCE,
    })
    if (!tokens.id_token || tokens.scope === undefined)
      throw new Error('Missing identity or granted scopes')
    const jwksResponse = await this.transport(`${ISSUER}/.well-known/jwks.json`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    })
    if (!jwksResponse.ok) throw new Error('Identity verification unavailable')
    const jwks = z
      .object({ keys: z.array(z.record(z.string(), z.unknown())).max(100) })
      .parse(await readBoundedJSON(jwksResponse, 256000))
    const identity = validateIdToken(
      tokens.id_token,
      jwks as { keys: JsonWebKey[] },
      clientId,
      attempt.nonce,
      this.now(),
    )
    if (attempt.expectedSubject && identity.sub !== attempt.expectedSubject)
      throw new Error('Sign-in returned a different account')
    await this.vault.write({
      clientId,
      issuer: identity.iss,
      subject: identity.sub,
      email: identity.email ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token,
      scopes: tokens.scope.split(/\s+/),
      expiresAt: this.now() + tokens.expires_in * 1000,
    })
  }

  async accessToken(): Promise<string> {
    const current = await this.vault.read()
    if (!current) throw new Error('AUTH_REQUIRED')
    if (!current.scopes.includes('chatgpt.tokens.use.direct'))
      throw new Error('SIGNED_IN_NO_PLAN_USAGE')
    if (current.expiresAt > this.now() + 60000) return current.accessToken
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.exclusive(() => this.refresh())
    try {
      return await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }
  private async refresh(): Promise<string> {
    const current = await this.vault.read()
    if (!current?.refreshToken) throw new Error('AUTH_REQUIRES_RECONNECT')
    if (!current.scopes.includes('chatgpt.tokens.use.direct'))
      throw new Error('SIGNED_IN_NO_PLAN_USAGE')
    if (current.expiresAt > this.now() + 60000) return current.accessToken
    const tokens = await this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: current.clientId,
      refresh_token: current.refreshToken,
      resource: RESOURCE,
    })
    if (!tokens.refresh_token) {
      await this.vault.write(null)
      throw new Error('AUTH_REQUIRES_RECONNECT')
    }
    const updated = {
      ...current,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scopes: tokens.scope === undefined ? current.scopes : tokens.scope.split(/\s+/),
      expiresAt: this.now() + tokens.expires_in * 1000,
    }
    await this.vault.write(updated)
    if (!updated.scopes.includes('chatgpt.tokens.use.direct'))
      throw new Error('SIGNED_IN_NO_PLAN_USAGE')
    return updated.accessToken
  }
  private async tokenRequest(fields: Record<string, string>) {
    const response = await this.transport(TOKEN_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    })
    const body = await readBoundedJSON(response, 256000)
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body)
      if (
        fields.grant_type === 'refresh_token' &&
        error.success &&
        unusable.has(error.data.error)
      ) {
        await this.vault.write(null)
        throw new Error('AUTH_REQUIRES_RECONNECT')
      }
      throw new Error('OAuth request failed; credentials preserved')
    }
    return Tokens.parse(body)
  }
}
