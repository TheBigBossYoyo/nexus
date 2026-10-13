import type { VoiceMediaEncryption } from '@shared/director-line'
import type { DirectorVoice } from './director-voice'
import { DEFAULT_VOICE_LINE_POLICY, type VoiceLinePolicy } from './voice-line'
import { normalizeSipIdentity, type DirectorVoiceProvider, type SpeechToTextProvider, type TextToSpeechProvider, type TurnDetectionProvider } from './voice-provider'

/**
 * 0.9.1: the configuration of the voice line that is not secret, and what the runtime is given to build the line.
 * The SIP password is not here: it lives in protected storage only (secret name `sip.password`) and is handed to
 * the provider at the moment it registers.
 */

export interface SipConfig {
  /** NEXUS's own SIP address, `sip:user@domain`. */
  identity: string
  /** The server to register with, `sip:<domain>;transport=tls` unless the owner's account says otherwise. */
  server: string
  transport: 'tls' | 'tcp' | 'udp'
  mediaEncryption: VoiceMediaEncryption
  /** When true, a call whose media is not encrypted is refused. */
  mediaEncryptionMandatory: boolean
  stunServer: string | null
  ice: boolean
  displayName: string
}

export interface VoiceLineConfig {
  sip: SipConfig | null
  policy: VoiceLinePolicy
  languages: string[]
  /** A stored flag only: nothing records transcripts yet. */
  recordTranscripts: boolean
}

export const DEFAULT_VOICE_LANGUAGES: readonly string[] = ['en', 'fr']

export function defaultVoiceLineConfig(): VoiceLineConfig {
  return { sip: null, policy: { ...DEFAULT_VOICE_LINE_POLICY }, languages: [...DEFAULT_VOICE_LANGUAGES], recordTranscripts: false }
}

export function defaultServerFor(identity: string): string {
  return `sip:${identity.slice(identity.indexOf('@') + 1)};transport=tls`
}

/** What the SIP helper registers with. Built only when the owner has set both the address and the password. */
export interface SipAccount {
  identity: string
  password: string
  displayName: string
  server: string
  transport: SipConfig['transport']
  mediaEncryption: VoiceMediaEncryption
  mediaEncryptionMandatory: boolean
  stunServer: string | null
  ice: boolean
}

/** What the application supplies for the voice line. Absent or `available: false`: the line is never built. */
export interface VoiceHost {
  available: boolean
  unavailableReason?: string
  /** The provider asks `account` each time it registers, so a password changed in Settings applies at the next registration. */
  create(account: () => Promise<SipAccount | null>): { provider: DirectorVoiceProvider; networkChanged?(): void }
  stt: SpeechToTextProvider | null
  tts: TextToSpeechProvider | null
  turns: TurnDetectionProvider | null
  directorVoice: () => DirectorVoice | null
  generalFacts: () => Promise<string>
}

const ENCRYPTIONS: readonly string[] = ['none', 'srtp', 'zrtp', 'dtls']
const TRANSPORTS: readonly string[] = ['tls', 'tcp', 'udp']

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback

export function sanitizeVoicePolicy(raw: unknown): VoiceLinePolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoiceLinePolicy>
  const d = DEFAULT_VOICE_LINE_POLICY
  return {
    requirePin: typeof r.requirePin === 'boolean' ? r.requirePin : d.requirePin,
    ringSeconds: clampInt(r.ringSeconds, 10, 60, d.ringSeconds),
    maxPlacedCallsPerDay: clampInt(r.maxPlacedCallsPerDay, 0, 24, d.maxPlacedCallsPerDay),
    minMinutesBetweenPlacedCalls: clampInt(r.minMinutesBetweenPlacedCalls, 0, 240, d.minMinutesBetweenPlacedCalls),
  }
}

function sanitizeSip(raw: unknown): SipConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<SipConfig>
  const identity = typeof r.identity === 'string' ? normalizeSipIdentity(r.identity) : null
  if (identity === null) return null
  return {
    identity,
    server: typeof r.server === 'string' && r.server.length > 0 && r.server.length <= 300 ? r.server : defaultServerFor(identity),
    transport: TRANSPORTS.includes(r.transport as string) ? (r.transport as SipConfig['transport']) : 'tls',
    mediaEncryption: ENCRYPTIONS.includes(r.mediaEncryption as string) ? (r.mediaEncryption as VoiceMediaEncryption) : 'zrtp',
    mediaEncryptionMandatory: typeof r.mediaEncryptionMandatory === 'boolean' ? r.mediaEncryptionMandatory : true,
    stunServer: typeof r.stunServer === 'string' && r.stunServer.length > 0 && r.stunServer.length <= 253 ? r.stunServer : null,
    ice: typeof r.ice === 'boolean' ? r.ice : true,
    displayName: typeof r.displayName === 'string' && r.displayName.trim() !== '' ? r.displayName.trim().slice(0, 60) : 'NEXUS Director',
  }
}

/** Reads what was stored, whatever its shape: a field that is missing or invalid takes its default. */
export function sanitizeVoiceLineConfig(raw: unknown): VoiceLineConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoiceLineConfig>
  const languages = Array.isArray(r.languages) ? r.languages.filter((l): l is string => typeof l === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l)).slice(0, 8) : []
  return {
    sip: sanitizeSip(r.sip),
    policy: sanitizeVoicePolicy(r.policy),
    languages: languages.length > 0 ? languages : [...DEFAULT_VOICE_LANGUAGES],
    recordTranscripts: r.recordTranscripts === true,
  }
}
