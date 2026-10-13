import {
  DEFAULT_COMMUNICATION_POLICY,
  type CommunicationPolicy,
  type ConnectionStatus,
  type OperatorChannelKind,
  type OperatorIdentity,
} from '@shared/director-line'
import type { DirectorLineView } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { Database } from '../persistence/database'
import { DirectorLine, type DirectorLineActions, type DirectorLineReads, type RefusalNote } from './line'
import { PairingService } from './pairing'
import type { HttpFetch, OperatorChannelProvider, SendResult } from './provider'
import { SqliteDeliveryStore, SqliteDirectorLineSettings, SqliteIdentityStore, SqliteOffsetStore, SqliteOutboxStore, SqlitePairingStateStore, SqlitePolicyStore, SqliteSeenStore } from './sqlite-stores'
import type { PolicyStore } from './stores'
import { TelegramProvider } from './telegram'
import { TwilioVoiceProvider, type TwilioCredentials } from './voice'

/**
 * The Director Line as the application runs it: SQLite stores, the Telegram and Twilio providers, one DirectorLine,
 * and the settings actions. The application makes one call, `createDirectorLineRuntime`, and keeps the result.
 *
 * Nothing here grants authority. The native confirmations for the settings that need one are in front of these
 * methods (ipc/v9-handlers.ts); a remote message reaches only the functions injected as `reads` and `actions`.
 */

export type SecretName = 'telegram.botToken' | 'twilio.credentials' | 'relay.pollBearer' | 'relay.privateKey'

/** Protected storage (Electron safeStorage in the application). Injected: this module never touches Electron. */
export interface SecretStore {
  get(name: SecretName): Promise<string | null>
  set(name: SecretName, value: string): Promise<void>
  delete(name: SecretName): Promise<void>
}

/** For tests. Holds secrets in memory only. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>()
  async get(name: SecretName): Promise<string | null> { return this.values.get(name) ?? null }
  async set(name: SecretName, value: string): Promise<void> { this.values.set(name, value) }
  async delete(name: SecretName): Promise<void> { this.values.delete(name) }
}

export interface DirectorLineProviderInput {
  kind: 'TELEGRAM' | 'TWILIO_VOICE'
  /** The bot token, or the Twilio API key secret. null removes the provider's credentials. */
  secret: string | null
  extra?: { fromNumber?: string; operatorNumber?: string; accountSid?: string; apiKeySid?: string; relayBaseUrl?: string }
}

export interface DirectorLineRuntimeDeps {
  db: Database
  secrets: SecretStore
  fetch: HttpFetch
  reads: DirectorLineReads
  actions: DirectorLineActions
  isOnline: () => Promise<boolean> | boolean
  localNotify: (title: string, text: string) => Promise<void>
  recordNote: (note: RefusalNote) => void
  now?: () => Date
  log?: (line: string) => void
  /** Test hooks: the long-poll wait, the pause between rounds, the API base, the machine's time zone. */
  telegram?: { pollTimeoutSeconds?: number; sleep?: (ms: number) => Promise<void>; baseUrl?: string }
  voice?: { sleep?: (ms: number) => Promise<void>; baseUrl?: string; maxWaitMs?: number; pollIntervalMs?: number }
  machineTimeZone?: string
}

export interface DirectorLineRuntime {
  line: DirectorLine
  pairing: PairingService
  start(): Promise<void>
  stop(): Promise<void>
  flush(): Promise<void>
  settingsView(): Promise<DirectorLineView>
  setEnabled(on: boolean): Promise<void>
  setProvider(input: DirectorLineProviderInput): Promise<void>
  setPolicy(policy: CommunicationPolicy): Promise<void>
  startPairing(channel: OperatorChannelKind): Promise<{ displayCode: string; expiresAt: string }>
  setPin(pin: string): Promise<void>
  unpair(channel?: OperatorChannelKind): Promise<number>
  sendTestMessage(): Promise<{ ok: boolean; errorClass: string | null }>
  testCall(): Promise<{ ok: boolean; errorClass: string | null }>
}

const FLUSH_INTERVAL_MS = 60_000
const SEEN_RETENTION_MS = 7 * 24 * 3600 * 1000
const HEALTH_CACHE_MS = 20_000

function suffix(secret: string | null): string | null {
  return secret && secret.length >= 8 ? secret.slice(-4) : null
}

function parseCredentials(json: string | null): TwilioCredentials | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<TwilioCredentials>
    if (typeof v.accountSid === 'string' && typeof v.apiKeySid === 'string' && typeof v.apiKeySecret === 'string' && typeof v.fromNumber === 'string') return { accountSid: v.accountSid, apiKeySid: v.apiKeySid, apiKeySecret: v.apiKeySecret, fromNumber: v.fromNumber }
  } catch {
    // unreadable: treated as not configured
  }
  return null
}

function machineZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function createDirectorLineRuntime(deps: DirectorLineRuntimeDeps): DirectorLineRuntime {
  const { db, secrets } = deps
  const now = deps.now ?? (() => new Date())
  const zone = deps.machineTimeZone ?? machineZone()
  const settings = new SqliteDirectorLineSettings(db)
  const identities = new SqliteIdentityStore(db)
  const seen = new SqliteSeenStore(db)
  const deliveries = new SqliteDeliveryStore(db)
  const storedPolicy = new SqlitePolicyStore(db)
  const defaultPolicy = (): CommunicationPolicy => ({ ...DEFAULT_COMMUNICATION_POLICY, quietHours: { ...DEFAULT_COMMUNICATION_POLICY.quietHours, timeZone: zone } })
  // Until the owner saves a policy, the quiet hours are evaluated in the machine's own zone (the module default is UTC).
  const policy: PolicyStore = { get: async () => (await storedPolicy.get()) ?? defaultPolicy(), set: (p) => storedPolicy.set(p) }

  const pairing = new PairingService({ state: new SqlitePairingStateStore(db), identities, now })

  // A wait that stop() can cut short, so that a backoff never delays the end of the poll.
  const sleepers = new Set<() => void>()
  const sleep =
    deps.telegram?.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          sleepers.delete(done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        sleepers.add(done)
      }))

  const telegram = new TelegramProvider({
    getToken: () => secrets.get('telegram.botToken'),
    fetch: deps.fetch,
    offsetStore: new SqliteOffsetStore(settings),
    sleep,
    pollTimeoutSeconds: deps.telegram?.pollTimeoutSeconds,
    baseUrl: deps.telegram?.baseUrl,
    log: deps.log,
  })
  const notConfigured: SendResult = { ok: false, providerReference: null, errorClass: 'NOT_CONFIGURED', retryable: false }
  // The one message provider the line sees. It sends nothing while the Director Line is off or Telegram is not the chosen provider.
  const messageProvider: OperatorChannelProvider = {
    kind: 'TELEGRAM',
    capabilities: telegram.capabilities,
    start: (handler) => telegram.start(handler),
    stop: () => telegram.stop(),
    send: async (message) => {
      const s = settings.read()
      return s.enabled && s.messageProvider === 'TELEGRAM' ? telegram.send(message) : notConfigured
    },
    health: () => telegram.health(),
  }
  const voice = new TwilioVoiceProvider({
    getCredentials: async () => {
      const s = settings.read()
      return s.enabled && s.voiceProvider === 'TWILIO_VOICE' ? parseCredentials(await secrets.get('twilio.credentials')) : null
    },
    fetch: deps.fetch,
    sleep: deps.voice?.sleep,
    baseUrl: deps.voice?.baseUrl,
    maxWaitMs: deps.voice?.maxWaitMs,
    pollIntervalMs: deps.voice?.pollIntervalMs,
  })

  const line = new DirectorLine({
    messageProvider,
    voiceProvider: voice,
    pairing,
    seen,
    outbox: new SqliteOutboxStore(db),
    deliveries,
    policy,
    reads: deps.reads,
    actions: deps.actions,
    localNotify: deps.localNotify,
    isOnline: deps.isOnline,
    recordNote: deps.recordNote,
    now,
    log: deps.log,
  })

  let started = false
  let starting: Promise<void> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let healthCache: { at: number; status: ConnectionStatus; reason: string } | null = null
  let offReason = 'Not started.'

  async function doStart(): Promise<void> {
    const s = settings.read()
    if (!s.enabled) { offReason = 'The Director Line is off.'; return }
    if (s.messageProvider !== 'TELEGRAM' || !(await secrets.get('telegram.botToken'))) { offReason = 'No bot token is stored, so nothing is polled.'; return }
    await seen.prune(new Date(now().getTime() - SEEN_RETENTION_MS).toISOString())
    await line.start()
    started = true
    healthCache = null
    flushTimer = setInterval(() => { void line.flush().catch(() => deps.log?.('director-line: flush failed')) }, FLUSH_INTERVAL_MS)
    flushTimer.unref?.()
  }

  async function start(): Promise<void> {
    if (started) return
    starting ??= doStart().finally(() => { starting = null })
    await starting
  }

  async function stop(): Promise<void> {
    if (starting) await starting.catch(() => undefined)
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
    const wasStarted = started
    started = false
    healthCache = null
    if (!wasStarted) return
    const ending = line.stop()
    for (const wake of [...sleepers]) wake()
    await ending
  }

  async function messageStatus(): Promise<{ status: ConnectionStatus; reason: string; configured: boolean; suffix: string | null }> {
    const s = settings.read()
    const token = s.messageProvider === 'TELEGRAM' ? await secrets.get('telegram.botToken') : null
    if (!token) return { status: 'UNCONFIGURED', reason: 'No bot token is stored. Paste the token from BotFather.', configured: false, suffix: null }
    const base = { configured: true, suffix: suffix(token) }
    if (!s.enabled) return { ...base, status: 'STOPPED', reason: 'The Director Line is off.' }
    if (!started) return { ...base, status: 'STOPPED', reason: offReason }
    if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) return { ...base, status: healthCache.status, reason: healthCache.reason }
    let result: { status: ConnectionStatus; reason: string }
    if (!(await deps.isOnline())) result = { status: 'ERROR', reason: 'No Internet connection; waiting for it.' }
    else {
      try {
        const h = await telegram.health()
        result = h.status === 'OK' ? { status: 'CONNECTED', reason: h.detail ? `Connected as ${h.detail}.` : 'Connected.' } : { status: 'ERROR', reason: `Telegram could not be used (${h.errorClass ?? h.status}).` }
      } catch {
        result = { status: 'ERROR', reason: 'Telegram could not be reached.' }
      }
    }
    healthCache = { at: Date.now(), ...result }
    return { ...base, ...result }
  }

  function operatorOf(list: OperatorIdentity[], kind: OperatorChannelKind | null): OperatorIdentity | null {
    return list.find((i) => i.channel === (kind ?? 'TELEGRAM')) ?? null
  }

  async function settingsView(): Promise<DirectorLineView> {
    const s = settings.read()
    const msg = await messageStatus()
    const creds = s.voiceProvider === 'TWILIO_VOICE' ? parseCredentials(await secrets.get('twilio.credentials')) : null
    const paired = await pairing.listPaired()
    const operator = operatorOf(paired, s.messageProvider)
    const voiceNumber = paired.find((i) => i.channel === 'TWILIO_VOICE') ?? null
    let voiceReason: string | null = null
    if (!creds) voiceReason = 'Voice is ready but not configured. Calls cost money on your own Twilio account; NEXUS never signs up for one.'
    else if (!voiceNumber) voiceReason = 'No phone number to call is set.'
    else if (!s.enabled) voiceReason = 'The Director Line is off.'
    return {
      enabled: s.enabled,
      messageProvider: { kind: s.messageProvider, configured: msg.configured, tokenSuffix: msg.suffix, status: msg.status },
      voiceProvider: { kind: s.voiceProvider, configured: creds !== null, tokenSuffix: suffix(creds?.apiKeySecret ?? null), status: creds ? 'STOPPED' : 'UNCONFIGURED' },
      pairedOperator: operator ? { channel: operator.channel, label: operator.label, pairedAt: operator.pairedAt, pairedVia: operator.pairedVia } : null,
      pinConfigured: await pairing.hasPin(),
      policy: (await policy.get()) ?? defaultPolicy(),
      lastDelivery: await line.lastDelivery(),
      statusReason: msg.reason,
      voiceReason,
      machineTimeZone: zone,
    }
  }

  return {
    line,
    pairing,
    start,
    stop,
    flush: () => line.flush(),
    settingsView,

    async setEnabled(on) {
      settings.setEnabled(on)
      if (on) await start()
      else await stop()
    },

    async setProvider(input) {
      if (input.kind === 'TELEGRAM') {
        if (input.extra?.relayBaseUrl) settings.setRelayBaseUrl(input.extra.relayBaseUrl)
        if (input.secret === null) {
          await secrets.delete('telegram.botToken')
          settings.setMessageProvider(null)
          settings.setOffset(null)
          await stop()
          return
        }
        // A different bot has its own update numbering: the old offset would skip or repeat its updates.
        if ((await secrets.get('telegram.botToken')) !== input.secret) settings.setOffset(null)
        await secrets.set('telegram.botToken', input.secret)
        settings.setMessageProvider('TELEGRAM')
        if (settings.read().enabled) await start()
        return
      }
      if (input.secret === null) {
        await secrets.delete('twilio.credentials')
        settings.setVoiceProvider(null)
        await pairing.unpair('TWILIO_VOICE')
        return
      }
      const existing = parseCredentials(await secrets.get('twilio.credentials'))
      const next = {
        accountSid: input.extra?.accountSid ?? existing?.accountSid,
        apiKeySid: input.extra?.apiKeySid ?? existing?.apiKeySid,
        fromNumber: input.extra?.fromNumber ?? existing?.fromNumber,
      }
      if (!next.accountSid || !next.apiKeySid || !next.fromNumber) throw new NexusError('invalid_input', 'Twilio needs the account SID, the API key SID, the API key secret and the number to call from.')
      const credentials: TwilioCredentials = { accountSid: next.accountSid, apiKeySid: next.apiKeySid, fromNumber: next.fromNumber, apiKeySecret: input.secret }
      await secrets.set('twilio.credentials', JSON.stringify(credentials))
      settings.setVoiceProvider('TWILIO_VOICE')
      if (input.extra?.operatorNumber) await pairing.pairPhoneFromSettings('TWILIO_VOICE', input.extra.operatorNumber, 'Phone')
    },

    async setPolicy(next) {
      await storedPolicy.set(next)
    },

    async startPairing(channel) {
      if (channel !== 'TELEGRAM') throw new NexusError('invalid_input', 'Only the message channel is paired with a code. A phone number is entered with the voice provider.')
      const s = settings.read()
      if (!s.enabled || s.messageProvider !== 'TELEGRAM' || !(await secrets.get('telegram.botToken'))) throw new NexusError('invalid_state', 'Turn the Director Line on and store a bot token before pairing.')
      try {
        const { displayCode, expiresAt } = await pairing.startPairing(channel)
        return { displayCode, expiresAt }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('ALREADY_PAIRED')) throw new NexusError('invalid_state', 'A phone is already paired. Unpair it first.')
        throw e
      }
    },

    setPin: (pin) => pairing.setPin(pin),
    unpair: (channel) => pairing.unpair(channel),

    async sendTestMessage() {
      const r = await line.sendTestMessage()
      return { ok: r.ok, errorClass: r.errorClass }
    },
    testCall: () => line.testCall(),
  }
}
