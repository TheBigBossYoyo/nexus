import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ChatGPTStatus } from '@shared/chatgpt'
import { ChatGPTSession, beginOAuth, type PlanCredentials } from './oauth'
import { OpenAIPlanProvider, PlanInferenceError } from './openai'
import type { AdvisoryProvider } from './compiler'
import { CapacityRegistry } from '../capacity/registry'
import { readBoundedJSON } from './transport'
import type { ProviderUsageReceipt } from '@shared/capacity'

export interface ProtectedStorage {
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
  available(): boolean
}
const Credential = z.object({
  clientId: z.string().min(1),
  issuer: z.literal('https://auth.openai.com'),
  subject: z.string().min(1),
  email: z.string().nullable(),
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  idToken: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number().finite(),
})
const SavedSchema = z.object({
  hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/i),
  active: z.string().nullable(),
  profiles: z
    .array(
      z.object({
        id: z.string(),
        registration: Credential,
        credentials: Credential.nullable(),
        model: z.string().nullable(),
        includedOnlyConfirmed: z.boolean(),
      }),
    )
    .max(50),
})
type Saved = z.infer<typeof SavedSchema>
export class ChatGPTBusyError extends Error {
  constructor() {
    super('A ChatGPT operation is in progress. Try again after it finishes.')
    this.name = 'ChatGPTBusyError'
  }
}

/** All credential transitions and inference are serialized at the runtime owner. */
export class ChatGPTConnection {
  private saved: Saved = { hostId: `urn:uuid:${randomUUID()}`, active: null, profiles: [] }
  private sessions = new Map<string, ChatGPTSession>()
  private busy = false
  private connecting = false
  private disposed = false
  private abort = new AbortController()
  private activeWork = new Set<Promise<unknown>>()
  private stopCallback: (() => void) | undefined
  private storageFault: string | null = null
  private error: string | null = null
  private catalog: ChatGPTStatus['models'] = []
  private readonly path: string
  constructor(
    dataDir: string,
    private readonly protection: ProtectedStorage | undefined,
    private readonly openBrowser: ((url: string) => Promise<void>) | undefined,
    private readonly transport: typeof fetch = fetch,
    private readonly capacity: CapacityRegistry = new CapacityRegistry(),
  ) {
    this.path = join(dataDir, 'chatgpt-credentials.protected')
    if (!protection?.available()) {
      this.storageFault =
        'Protected credential storage is unavailable. Restart after restoring storage access.'
      return
    }
    if (existsSync(this.path)) {
      try {
        this.saved = SavedSchema.parse(JSON.parse(protection.decrypt(readFileSync(this.path))))
      } catch {
        this.storageFault =
          'Protected ChatGPT storage could not be read. Restore storage access before reconnecting.'
      }
    }
  }
  private commit(next: Saved) {
    if (this.storageFault || !this.protection?.available())
      throw new Error('Protected credential storage unavailable')
    try {
      const encrypted = this.protection.encrypt(JSON.stringify(next))
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      const descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(descriptor, encrypted)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      renameSync(temporary, this.path)
      this.saved = next // Memory changes only after the protected write succeeds.
    } catch {
      // Remote token rotation/revocation cannot be rolled back. Never reuse the old snapshot.
      this.storageFault =
        'Credential changes could not be saved. Restore protected storage and restart before reconnecting.'
      throw new Error(this.storageFault)
    }
  }
  private claim() {
    if (this.disposed) throw new Error('ChatGPT connection is shutting down')
    if (this.storageFault || !this.protection?.available())
      throw new Error('Protected credential storage unavailable')
    if (this.busy) throw new ChatGPTBusyError()
    this.busy = true
  }
  canInfer(): boolean {
    return (
      !this.disposed &&
      !this.busy &&
      !this.connecting &&
      !this.storageFault &&
      !!this.protection?.available()
    )
  }
  status(): ChatGPTStatus {
    const profile = this.saved.profiles.find((p) => p.id === this.saved.active)
    const state =
      this.storageFault || !this.protection?.available()
        ? 'STORAGE_UNAVAILABLE'
        : this.connecting
          ? 'CONNECTING'
          : !profile
            ? 'SIGNED_OUT'
            : !profile.credentials ||
                (profile.credentials.expiresAt <= Date.now() && !profile.credentials.refreshToken) ||
                // The provider refused the token and a fresh one: the card must not go on saying "connected".
                this.capacity.pool(this.capacity.binding(profile.registration)).state === 'AUTH_REQUIRED'
              ? 'AUTH_REQUIRES_RECONNECT'
              : profile.credentials.scopes.includes('chatgpt.tokens.use.direct')
                ? 'SIGNED_IN_PLAN_USAGE'
                : 'SIGNED_IN_NO_PLAN_USAGE'
    return {
      state,
      profiles: this.saved.profiles.map((p, i) => ({
        id: p.id,
        label: `${p.registration.email ?? 'ChatGPT account'} · Connection ${i + 1}`,
        connected: !!p.credentials,
      })),
      activeProfile: this.saved.active,
      model: profile?.model ?? null,
      models: this.catalog,
      error: this.storageFault ?? this.error,
      includedOnlyConfirmed: profile?.includedOnlyConfirmed ?? false,
      capacity: profile ? this.capacity.pool(this.capacity.binding(profile.registration)) : null,
    }
  }
  private session(id: string) {
    let session = this.sessions.get(id)
    if (!session) {
      session = new ChatGPTSession(
        {
          read: async () => this.saved.profiles.find((p) => p.id === id)?.credentials ?? null,
          write: async (credentials) => {
            const next = structuredClone(this.saved)
            const profile = next.profiles.find((p) => p.id === id)
            if (!profile) throw new Error('Unknown ChatGPT connection')
            profile.credentials = credentials ? Credential.parse(credentials) : null
            this.commit(next)
          },
        },
        this.transport,
      )
      this.sessions.set(id, session)
    }
    return session
  }
  async connect(profileId?: string): Promise<ChatGPTStatus> {
    this.claim()
    const server = createServer()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (timeout) clearTimeout(timeout)
      server.closeAllConnections()
      server.close()
      if (this.stopCallback === finish) {
        this.connecting = false
        this.busy = false
        this.stopCallback = undefined
      }
    }
    this.stopCallback = finish
    try {
      if (!this.openBrowser) throw new Error('System browser is unavailable in this runtime')
      const previous = profileId ? this.saved.profiles.find((p) => p.id === profileId) : undefined
      if (profileId && !previous) throw new Error('Unknown ChatGPT connection')
      if (!previous && this.saved.profiles.length >= 50) throw new Error('Connection limit reached')
      this.commit(this.saved) // Persist host identity before first authorization.
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Callback listener unavailable')
      const { attempt, url } = beginOAuth(
        this.saved.hostId,
        address.port,
        previous?.credentials ?? previous?.registration ?? null,
      )
      let validated: PlanCredentials | null = null
      let claimedCallback = false
      const pending = new ChatGPTSession(
        {
          read: async () => null,
          write: async (value) => {
            validated = value
          },
        },
        this.transport,
      )
      this.connecting = true
      this.error = null
      timeout = setTimeout(() => {
        this.error = 'Sign-in timed out. Try connecting again.'
        finish()
      }, 600000)
      timeout.unref()
      server.on('request', (request, response) => {
        if (
          request.method !== 'GET' ||
          !request.url ||
          request.url.length > 16000 ||
          request.headers.host !== `127.0.0.1:${address.port}`
        ) {
          response.writeHead(400).end()
          return
        }
        let callback: URL
        try {
          callback = new URL(request.url, attempt.redirectUri)
        } catch {
          response.writeHead(400).end()
          return
        }
        if (
          callback.origin + callback.pathname !== attempt.redirectUri ||
          callback.searchParams.get('state') !== attempt.state ||
          claimedCallback
        ) {
          response.writeHead(400).end('Invalid callback')
          return
        }
        claimedCallback = true
        if (timeout) clearTimeout(timeout)
        void pending
          .exchange(attempt, callback)
          .then(() => {
            if (this.disposed || finished) throw new Error('Connection closed')
            if (!validated) throw new Error('No validated credentials')
            const credentials = Credential.parse(validated)
            const next = structuredClone(this.saved)
            const profile: Saved['profiles'][number] = previous
              ? next.profiles.find((p) => p.id === previous.id)!
              : {
                  id: randomUUID(),
                  registration: credentials,
                  credentials: null,
                  model: null,
                  includedOnlyConfirmed: false,
                }
            profile.credentials = credentials
            profile.registration = {
              ...credentials,
              accessToken: '',
              refreshToken: null,
              idToken: '',
              scopes: [],
              expiresAt: 0,
            }
            profile.includedOnlyConfirmed = false
            if (!previous) next.profiles.push(profile)
            next.active = profile.id
            this.commit(next)
            this.capacity.reconnect(this.capacity.binding(profile.registration))
            this.catalog = []
            this.error = null
            response
              .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
              .end('Connected to NEXUS. Return to the application.')
          })
          .catch(() => {
            if (!finished) {
              this.error = 'Sign-in could not be completed. Try reconnecting.'
              response
                .writeHead(400, { 'Cache-Control': 'no-store' })
                .end('Sign-in failed. Return to NEXUS.')
            }
          })
          .finally(finish)
      })
      try {
        await this.openBrowser(url)
      } catch {
        throw new Error('Sign-in browser unavailable; authorization could not be opened')
      }
      return this.status()
    } catch (error) {
      finish()
      throw error
    }
  }
  select(profileId: string): ChatGPTStatus {
    this.claim()
    try {
      if (!this.saved.profiles.some((p) => p.id === profileId))
        throw new Error('Unknown ChatGPT connection')
      this.commit({ ...this.saved, active: profileId })
      this.catalog = []
      this.error = null
      return this.status()
    } finally {
      this.busy = false
    }
  }
  async models(): Promise<ChatGPTStatus> {
    this.claim()
    try {
      const profile = this.saved.profiles.find((p) => p.id === this.saved.active)
      if (!profile?.credentials) throw new Error('Connect a ChatGPT account first')
      this.catalog = await new OpenAIPlanProvider(
        () => this.session(profile.id).accessToken(),
        '',
        this.transport,
      ).models()
      return this.status()
    } finally {
      this.busy = false
    }
  }
  configure(model: string, includedOnlyConfirmed: boolean): ChatGPTStatus {
    this.claim()
    try {
      const next = structuredClone(this.saved)
      const profile = next.profiles.find((p) => p.id === next.active)
      if (!profile) throw new Error('Connect a ChatGPT account first')
      const withdrawing = !includedOnlyConfirmed && model === profile.model
      if (!withdrawing && !this.catalog.some((m) => m.slug === model))
        throw new Error('Choose a model from this account’s refreshed catalog')
      profile.model = model
      profile.includedOnlyConfirmed = includedOnlyConfirmed
      this.commit(next)
      return this.status()
    } finally {
      this.busy = false
    }
  }
  provider(): AdvisoryProvider | undefined {
    const selected = this.saved.profiles.find((p) => p.id === this.saved.active)
    if (
      this.storageFault ||
      !selected?.credentials?.scopes.includes('chatgpt.tokens.use.direct') ||
      !selected.model ||
      !selected.includedOnlyConfirmed
    )
      return undefined
    const id = selected.id,
      model = selected.model
    let receipt: ProviderUsageReceipt | null = null
    return {
      usage: () => (receipt ? structuredClone(receipt) : null),
      complete: (instructions, data, shape) => {
        const work = (async () => {
          this.claim()
          receipt = null
          try {
            const current = this.saved.profiles.find((p) => p.id === id)
            if (
              this.saved.active !== id ||
              !current?.includedOnlyConfirmed ||
              current.model !== model
            )
              throw new Error('Provider configuration changed; retry compilation')
            const binding = this.capacity.binding(current.registration)
            this.capacity.admit(binding)
            let used: string | null = null
            let rejected: string | null = null
            try {
              const provider = new OpenAIPlanProvider(
                async () => {
                  used = rejected === null ? await this.session(id).accessToken() : await this.session(id).accessTokenAfterRejection(rejected)
                  return used
                },
                model,
                this.transport,
                this.abort.signal,
              )
              let result: unknown
              try {
                try {
                  result = await provider.complete(instructions, data, shape)
                } catch (error) {
                  // A 401 says the token was not accepted: the request was not served. The token is refreshed once
                  // and the same request sent once more, before the pool is held for a sign-in in the browser.
                  if (!(error instanceof PlanInferenceError) || error.status !== 401 || used === null) throw error
                  rejected = used
                  result = await provider.complete(instructions, data, shape)
                }
              } finally {
                receipt = provider.usage()
              }
              this.capacity.success(binding)
              return result
            } catch (error) {
              if (error instanceof PlanInferenceError)
                this.capacity.failure(binding, error.status, error.code)
              // The refresh after a 401 was refused: the credentials are gone and only a sign-in brings them back.
              else if (rejected !== null) this.capacity.failure(binding, 401, null)
              else this.capacity.failure(binding, 0, null)
              throw error
            }
          } finally {
            this.busy = false
          }
        })()
        this.activeWork.add(work)
        return work.finally(() => this.activeWork.delete(work))
      },
    }
  }
  async manageUsage(): Promise<void> {
    if (!this.openBrowser) throw new Error('System browser unavailable')
    await this.openBrowser('https://chatgpt.com/settings/usage')
  }
  dispose(): void {
    this.disposed = true
    this.abort.abort(new Error('Runtime stopping'))
    this.stopCallback?.()
  }
  async idle(): Promise<void> {
    await Promise.allSettled([...this.activeWork])
    // Callers settle their durable compilation/Director outcome before SQLite closes.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  async disconnect(): Promise<ChatGPTStatus> {
    this.claim()
    try {
      const next = structuredClone(this.saved)
      const profile = next.profiles.find((p) => p.id === next.active)
      if (!profile) return this.status()
      let revoked = false
      if (profile.credentials?.refreshToken) {
        try {
          const discovery = await this.transport(
            'https://auth.openai.com/.well-known/openid-configuration',
            { redirect: 'error', signal: AbortSignal.timeout(15000) },
          )
          if (!discovery.ok) throw new Error('Discovery unavailable')
          const endpoint = z
            .object({ revocation_endpoint: z.string().url() })
            .parse(await readBoundedJSON(discovery, 256000)).revocation_endpoint
          if (new URL(endpoint).origin !== 'https://auth.openai.com')
            throw new Error('Untrusted revocation endpoint')
          const response = await this.transport(endpoint, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: profile.credentials.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: profile.registration.clientId,
            }),
          })
          revoked = response.status === 200
        } catch {
          /* Local disconnect still proceeds; status explains unconfirmed remote revocation. */
        }
      }
      profile.credentials = null
      profile.includedOnlyConfirmed = false
      this.commit(next)
      this.catalog = []
      this.error = revoked
        ? null
        : 'Disconnected locally. Remote revocation was not confirmed; you can disconnect NEXUS in ChatGPT Usage settings.'
      return this.status()
    } finally {
      this.busy = false
    }
  }
}
