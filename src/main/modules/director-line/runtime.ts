import {
  DEFAULT_COMMUNICATION_POLICY,
  normalizeSipIdentity,
  type CommunicationPolicy,
  type ConnectionStatus,
  type OperatorChannelKind,
  type OperatorIdentity,
  type VoiceMediaEncryption,
} from '@shared/director-line'
import type { DirectorLineView } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { Database } from '../persistence/database'
import { DirectorLine, type DirectorLineActions, type DirectorLineReads, type RefusalNote } from './line'
import { PairingService } from './pairing'
import type { HttpFetch, OperatorChannelProvider, SendResult } from './provider'
import { SqliteCallStore, SqliteDeliveryStore, SqliteDirectorLineSettings, SqliteIdentityStore, SqliteOffsetStore, SqliteOutboxStore, SqlitePairingStateStore, SqlitePlacedCallStore, SqlitePolicyStore, SqliteSeenStore, SqliteVoiceConfigStore } from './sqlite-stores'
import type { PolicyStore } from './stores'
import { TelegramProvider } from './telegram'
import { defaultServerFor, sanitizeVoicePolicy, type SipAccount, type SipConfig, type VoiceHost } from './voice-config'
import { DirectorVoiceLine, type PlaceResult, type VoiceLinePolicy } from './voice-line'
import type { VoiceProviderState } from './voice-provider'

/**
 * The Director Line as the application runs it: SQLite stores, the Telegram provider, the voice line (standard SIP, 0.9.1), one DirectorLine,
 * and the settings actions. The application makes one call, `createDirectorLineRuntime`, and keeps the result.
 *
 * Nothing here grants authority. The native confirmations for the settings that need one are in front of these
 * methods (ipc/v9-handlers.ts); a remote message reaches only the functions injected as `reads` and `actions`.
 */

export type SecretName = 'telegram.botToken' | 'sip.password'

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
  kind: 'TELEGRAM'
  /** The bot token. null removes the provider's credentials. */
  secret: string | null
}

/** What Settings sends to set up the voice line. The password is only ever in this input and in protected storage. */
export interface DirectorLineSipInput {
  identity: string
  /** null keeps the stored password. */
  password: string | null
  operatorIdentity: string
  mediaEncryption: VoiceMediaEncryption
  mediaEncryptionMandatory: boolean
  stunServer: string | null
  ice: boolean
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
  /** The voice line's provider and speech engines, supplied by the application. Absent: voice is not available. */
  voice?: VoiceHost
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
  setSip(input: DirectorLineSipInput): Promise<void>
  removeSip(): Promise<void>
  setVoicePolicy(policy: VoiceLinePolicy): Promise<void>
  /** Rings the operator now and resolves when the call was answered or was not. */
  callMe(): Promise<PlaceResult | 'NOT_CONFIGURED'>
  hangUpCall(): Promise<void>
  /** The person compared the ZRTP code (`sas`, as shown to them) with the telephone's. False when that is no longer the code of the call in progress. */
  confirmCallSas(sas: string): Promise<boolean>
  /** The connection to the Internet changed: the voice line registers again. */
  networkChanged(): void
}

const FLUSH_INTERVAL_MS = 60_000
const SEEN_RETENTION_MS = 7 * 24 * 3600 * 1000
const HEALTH_CACHE_MS = 20_000

function suffix(secret: string | null): string | null {
  return secret && secret.length >= 8 ? secret.slice(-4) : null
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
  const voiceStore = new SqliteVoiceConfigStore(db)
  const calls = new SqliteCallStore(db)
  const placedCalls = new SqlitePlacedCallStore(db)

  // ---- The voice line (0.9.1) ---------------------------------------------------------------------------------
  let voiceLine: DirectorVoiceLine | null = null
  let voiceSignature: string | null = null
  let voiceNetworkChanged: (() => void) | undefined
  let voiceState: VoiceProviderState = 'STOPPED'
  let voiceDetailRaw: string | null = null
  /** Bumped when a new password is stored, so that the account is rebuilt with it. */
  let passwordVersion = 0
  /** Counts messages that took the place of a call, so that the outbox can tell whether the report was delivered. */
  let fallbackDelivered = 0
  let voiceChain: Promise<void> = Promise.resolve()

  const pairedSip = async (): Promise<string | null> => (await pairing.listPaired()).find((i) => i.channel === 'SIP_VOICE')?.providerUserId ?? null

  /** Why the voice line is not running, or null when it should be. */
  async function voiceUnwanted(): Promise<string | null> {
    const host = deps.voice
    const cfg = voiceStore.get()
    if (!settings.read().enabled) return 'The Director Line is off.'
    if (!host || !host.available) return host?.unavailableReason ?? 'Voice is not available on this build.'
    if (!cfg.sip || (await secrets.get('sip.password')) === null) return 'The voice line is not set up.'
    if ((await pairedSip()) === null) return "Your phone's SIP address is not set."
    if (!host.stt || !host.tts) return 'No speech engine is installed, so calls cannot be held yet.'
    return null
  }

  async function stopVoiceNow(): Promise<void> {
    const old = voiceLine
    voiceLine = null
    voiceSignature = null
    voiceNetworkChanged = undefined
    voiceState = 'STOPPED'
    voiceDetailRaw = null
    if (old) await old.stop().catch(() => deps.log?.('director-line: the voice line did not stop cleanly'))
  }

  async function syncVoiceNow(): Promise<void> {
    const reason = await voiceUnwanted()
    const host = deps.voice
    const cfg = voiceStore.get()
    if (reason !== null || !host || !host.stt || !host.tts || !cfg.sip) {
      await stopVoiceNow()
      return
    }
    const signature = JSON.stringify([cfg.sip, cfg.languages, passwordVersion])
    if (voiceLine && signature === voiceSignature) return
    await stopVoiceNow()
    const created = host.create(async () => {
      const current = voiceStore.get().sip
      const password = await secrets.get('sip.password')
      if (!current || password === null) return null
      const account: SipAccount = {
        identity: current.identity,
        password,
        displayName: current.displayName,
        server: current.server,
        transport: current.transport,
        mediaEncryption: current.mediaEncryption,
        mediaEncryptionMandatory: current.mediaEncryptionMandatory,
        stunServer: current.stunServer,
        // ICE needs a STUN server to gather anything but this PC's own addresses.
        ice: current.ice && current.stunServer !== null,
      }
      return account
    })
    voiceNetworkChanged = created.networkChanged ? () => created.networkChanged?.() : undefined
    const next = new DirectorVoiceLine({
      channel: 'SIP_VOICE',
      provider: created.provider,
      stt: host.stt,
      tts: host.tts,
      turns: host.turns,
      languages: cfg.languages,
      pairedIdentity: pairedSip,
      authenticate: (identity, pin) => pairing.authenticatePhone('SIP_VOICE', identity, pin),
      interpret: (text) => line.interpretSpoken(text),
      perform: (input) => line.performSpoken(input),
      generalFacts: host.generalFacts,
      directorVoice: host.directorVoice,
      policy: () => voiceStore.get().policy,
      // The line is rebuilt whenever the account's settings change, so this is the setting the call runs under.
      mediaEncryptionMandatory: cfg.sip.mediaEncryptionMandatory,
      placedCalls,
      // What replaces a call that did not take place: the Telegram message, or the notification on the PC.
      fallback: async (text) => {
        if (!(await line.sendToOperator(text))) throw new Error('nothing could deliver the message')
        fallbackDelivered += 1
      },
      record: (call) => {
        try {
          calls.add(call)
        } catch {
          deps.log?.('director-line: a call record could not be kept')
        }
      },
      onState: (state, detail) => {
        voiceState = state
        voiceDetailRaw = detail ?? null
      },
      now,
      ...(deps.log ? { log: deps.log } : {}),
    })
    voiceLine = next
    voiceSignature = signature
    voiceState = 'CONNECTING'
    voiceDetailRaw = null
    try {
      await next.start()
    } catch {
      deps.log?.('director-line: the voice line could not start')
      if (voiceLine === next) {
        voiceState = 'UNREACHABLE'
        voiceDetailRaw = 'The voice line could not start.'
      }
    }
  }

  /** Voice changes are applied one at a time, in the order they were asked for. */
  function syncVoice(): Promise<void> {
    const run = voiceChain.then(syncVoiceNow)
    voiceChain = run.catch(() => undefined)
    return run
  }

  async function callFromMessage(): Promise<string> {
    const vl = voiceLine
    if (!vl) return 'NOT_CONFIGURED'
    if ((await pairedSip()) === null) return 'NOT_PAIRED'
    if (vl.inCall) return 'LINE_BUSY'
    if (vl.state() !== 'REGISTERED') return 'NOT_REGISTERED'
    // The ring lasts up to a minute: the reply to the message does not wait for it. A call that is not answered is
    // followed by the message that says so, sent by the voice line.
    void vl.callOperator({ report: '', reason: 'OPERATOR_ASKED' }).catch(() => deps.log?.('director-line: the call could not be placed'))
    return 'CALLING'
  }

  async function callForEvent(report: string): Promise<{ result: PlaceResult | 'NOT_CONFIGURED'; fallbackSent: boolean }> {
    const vl = voiceLine
    if (!vl) return { result: 'NOT_CONFIGURED', fallbackSent: false }
    const before = fallbackDelivered
    const result = await vl.callOperator({ report, reason: 'EVENT' })
    return { result, fallbackSent: fallbackDelivered > before }
  }

  const line = new DirectorLine({
    messageProvider,
    callOperator: callFromMessage,
    callForEvent,
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

  let telegramOn = false
  let starting: Promise<void> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let healthCache: { at: number; status: ConnectionStatus; reason: string } | null = null
  let offReason = 'Not started.'

  async function doStart(): Promise<void> {
    const s = settings.read()
    if (!s.enabled) { offReason = 'The Director Line is off.'; await syncVoice(); return }
    if (!flushTimer) {
      flushTimer = setInterval(() => { void line.flush().catch(() => deps.log?.('director-line: flush failed')) }, FLUSH_INTERVAL_MS)
      flushTimer.unref?.()
    }
    if (!telegramOn) {
      if (s.messageProvider !== 'TELEGRAM' || !(await secrets.get('telegram.botToken'))) offReason = 'No bot token is stored, so nothing is polled.'
      else {
        await seen.prune(new Date(now().getTime() - SEEN_RETENTION_MS).toISOString())
        await line.start()
        telegramOn = true
        healthCache = null
      }
    }
    await syncVoice()
  }

  async function start(): Promise<void> {
    starting ??= doStart().finally(() => { starting = null })
    await starting
  }

  async function stopTelegram(): Promise<void> {
    const wasOn = telegramOn
    telegramOn = false
    healthCache = null
    if (!wasOn) return
    const ending = line.stop()
    for (const wake of [...sleepers]) wake()
    await ending
  }

  async function stop(): Promise<void> {
    if (starting) await starting.catch(() => undefined)
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
    await stopTelegram()
    await syncVoice()
  }

  async function messageStatus(): Promise<{ status: ConnectionStatus; reason: string; configured: boolean; suffix: string | null }> {
    const s = settings.read()
    const token = s.messageProvider === 'TELEGRAM' ? await secrets.get('telegram.botToken') : null
    if (!token) return { status: 'UNCONFIGURED', reason: 'No bot token is stored. Paste the token from BotFather.', configured: false, suffix: null }
    const base = { configured: true, suffix: suffix(token) }
    if (!s.enabled) return { ...base, status: 'STOPPED', reason: 'The Director Line is off.' }
    if (!telegramOn) return { ...base, status: 'STOPPED', reason: offReason }
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

  /** A detail from the provider, as a sentence: never longer than a line, and never with the password in it. */
  async function safeDetail(detail: string | null): Promise<string | null> {
    if (detail === null) return null
    const password = await secrets.get('sip.password')
    const text = password !== null && password.length > 0 ? detail.split(password).join('***') : detail
    return text.replace(/[\r\n]+/g, ' ').slice(0, 200)
  }

  async function settingsView(): Promise<DirectorLineView> {
    const s = settings.read()
    const msg = await messageStatus()
    const paired = await pairing.listPaired()
    const operator = operatorOf(paired, s.messageProvider)
    const cfg = voiceStore.get()
    const host = deps.voice
    const passwordSet = (await secrets.get('sip.password')) !== null
    const sipOperator = paired.find((i) => i.channel === 'SIP_VOICE')?.providerUserId ?? null
    const unwanted = await voiceUnwanted()
    const running = voiceLine !== null
    return {
      enabled: s.enabled,
      messageProvider: { kind: s.messageProvider, configured: msg.configured, tokenSuffix: msg.suffix, status: msg.status },
      pairedOperator: operator ? { channel: operator.channel, label: operator.label, pairedAt: operator.pairedAt, pairedVia: operator.pairedVia } : null,
      pinConfigured: await pairing.hasPin(),
      policy: (await policy.get()) ?? defaultPolicy(),
      lastDelivery: await line.lastDelivery(),
      statusReason: msg.reason,
      machineTimeZone: zone,
      voice: {
        available: host?.available === true,
        unavailableReason: host?.available === true ? null : (host?.unavailableReason ?? 'Voice is not available on this build.'),
        configured: cfg.sip !== null && passwordSet,
        identity: cfg.sip?.identity ?? null,
        passwordSet,
        operatorIdentity: sipOperator,
        state: running ? (voiceLine?.state() ?? voiceState) : 'STOPPED',
        stateDetail: running ? await safeDetail(voiceDetailRaw) : unwanted,
        inCall: voiceLine?.inCall === true,
        callSecurity: voiceLine?.currentSecurity() ?? null,
        mediaEncryption: cfg.sip?.mediaEncryption ?? 'zrtp',
        mediaEncryptionMandatory: cfg.sip?.mediaEncryptionMandatory ?? true,
        stunServer: cfg.sip?.stunServer ?? null,
        ice: cfg.sip?.ice ?? false,
        policy: cfg.policy,
        speech: {
          stt: host?.stt ? { kind: host.stt.kind, local: host.stt.local } : null,
          tts: host?.tts ? { kind: host.tts.kind, local: host.tts.local } : null,
        },
        lastCalls: calls.recent(5),
      },
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
      if (input.secret === null) {
        await secrets.delete('telegram.botToken')
        settings.setMessageProvider(null)
        settings.setOffset(null)
        await stopTelegram()
        return
      }
      // A different bot has its own update numbering: the old offset would skip or repeat its updates.
      if ((await secrets.get('telegram.botToken')) !== input.secret) settings.setOffset(null)
      await secrets.set('telegram.botToken', input.secret)
      settings.setMessageProvider('TELEGRAM')
      if (settings.read().enabled) await start()
    },

    async setPolicy(next) {
      await storedPolicy.set(next)
    },

    async startPairing(channel) {
      if (channel !== 'TELEGRAM') throw new NexusError('invalid_input', 'Only the message channel is paired with a code. The phone of the voice line is entered as its SIP address.')
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

    async unpair(channel) {
      const removed = await pairing.unpair(channel)
      if (channel === undefined || channel === 'SIP_VOICE') await syncVoice()
      return removed
    },

    async sendTestMessage() {
      const r = await line.sendTestMessage()
      return { ok: r.ok, errorClass: r.errorClass }
    },

    async setSip(input) {
      const identity = normalizeSipIdentity(input.identity)
      const operatorIdentity = normalizeSipIdentity(input.operatorIdentity)
      if (identity === null) throw new NexusError('invalid_input', "NEXUS's SIP address is not valid. It looks like sip:name@sip.linphone.org.")
      if (operatorIdentity === null) throw new NexusError('invalid_input', "Your phone's SIP address is not valid. It looks like sip:name@sip.linphone.org.")
      if (identity === operatorIdentity) throw new NexusError('invalid_input', "Your phone's SIP address must differ from NEXUS's own.")
      const stored = await secrets.get('sip.password')
      if (input.password === null && stored === null) throw new NexusError('invalid_input', "NEXUS's SIP password is needed.")
      if (input.password !== null && (input.password.length < 1 || input.password.length > 128)) throw new NexusError('invalid_input', 'The SIP password must be 1 to 128 characters.')
      if (input.password !== null) {
        await secrets.set('sip.password', input.password)
        passwordVersion += 1
      }
      const previous = voiceStore.get()
      const sip: SipConfig = {
        identity,
        server: previous.sip && previous.sip.identity === identity ? previous.sip.server : defaultServerFor(identity),
        transport: previous.sip?.transport ?? 'tls',
        mediaEncryption: input.mediaEncryption,
        mediaEncryptionMandatory: input.mediaEncryptionMandatory,
        stunServer: input.stunServer,
        ice: input.ice && input.stunServer !== null,
        displayName: previous.sip?.displayName ?? 'NEXUS Director',
      }
      voiceStore.set({ ...previous, sip })
      // One identity, replaced by a new one. Not touched when it is the same, so that nothing else is reset.
      if ((await pairedSip()) !== operatorIdentity) await pairing.pairVoiceIdentityFromSettings('SIP_VOICE', operatorIdentity, 'Phone')
      await syncVoice()
    },

    async removeSip() {
      await secrets.delete('sip.password')
      voiceStore.set({ ...voiceStore.get(), sip: null })
      if ((await pairedSip()) !== null) await pairing.unpair('SIP_VOICE')
      await syncVoice()
    },

    async setVoicePolicy(next) {
      voiceStore.set({ ...voiceStore.get(), policy: sanitizeVoicePolicy(next) })
    },

    async callMe() {
      const vl = voiceLine
      if (!vl) return 'NOT_CONFIGURED'
      if ((await pairedSip()) === null) return 'NOT_PAIRED'
      if (vl.inCall) return 'LINE_BUSY'
      // Not asked of a line that is not registered: that would send a message about it.
      if (vl.state() !== 'REGISTERED') return 'NOT_REGISTERED'
      return vl.callOperator({ report: '', reason: 'OPERATOR_ASKED' })
    },

    async hangUpCall() {
      await voiceLine?.hangUp()
    },

    async confirmCallSas(sas) {
      return voiceLine?.confirmCallSas(sas) ?? false
    },

    networkChanged() {
      try {
        voiceNetworkChanged?.()
      } catch {
        deps.log?.('director-line: the voice line could not be told of the network change')
      }
    },
  }
}
