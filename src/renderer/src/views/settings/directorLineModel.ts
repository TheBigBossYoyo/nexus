import { normalizeSipIdentity, type CallRecordView, type CommunicationPolicy, type ConnectionStatus, type PlaceCallResult, type ReportEventKind, type VoiceMediaEncryption } from '@shared/director-line'
import type { DirectorLineView, IpcInput } from '@shared/ipc'

/** Words and small pure helpers for the Director Line settings screen. */

type PolicyEventKind = Exclude<ReportEventKind, 'PROGRESS'>

export const EVENT_ORDER: readonly PolicyEventKind[] = [
  'MORNING_OVERNIGHT_REPORT', 'PROGRAM_COMPLETE', 'MISSION_BLOCKED', 'SECURITY_BOUNDARY_REQUIRED', 'CRITICAL_FAILURE', 'NETWORK_OFFLINE', 'ETA_SLIPPED',
]

export const EVENT_LABEL: Record<PolicyEventKind, string> = {
  MORNING_OVERNIGHT_REPORT: 'Morning overnight report',
  PROGRAM_COMPLETE: 'Program complete',
  MISSION_BLOCKED: 'Mission blocked',
  SECURITY_BOUNDARY_REQUIRED: 'Security boundary required',
  CRITICAL_FAILURE: 'Critical failure',
  NETWORK_OFFLINE: 'Network offline',
  ETA_SLIPPED: 'ETA slipped',
}

/** What the threshold of an event means, in a few words ("longer than", "by"). */
export const THRESHOLD_WORDS: Partial<Record<PolicyEventKind, { before: string; unit: string }>> = {
  MISSION_BLOCKED: { before: 'longer than', unit: 'min' },
  NETWORK_OFFLINE: { before: 'longer than', unit: 'min' },
  ETA_SLIPPED: { before: 'by at least', unit: '%' },
}

export const CLASS_LABEL = { PHONE: 'Phone call', MESSAGE: 'Message', LOCAL_NOTIFICATION: 'Notification on this PC' } as const

export const STATUS_WORDS: Record<ConnectionStatus, string> = {
  UNCONFIGURED: 'Not configured',
  STOPPED: 'Stopped',
  CONNECTING: 'Connecting',
  CONNECTED: 'Connected',
  ERROR: 'Problem',
}

export const CAN_AND_CANNOT =
  'A paired phone can ask for status, time remaining, blockers and test results, pause missions after the current task and resume them, and add tasks, which go through the same checks as a task typed here. It can never grant or approve a boundary request, push or publish, change settings, the sandbox or the autonomy profile, delete anything, run a command, or touch power. Those are decided at this PC.'

export function minuteToTime(minute: number): string {
  const m = Math.min(1439, Math.max(0, Math.floor(minute)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "HH:MM" to minutes after midnight, or null when it is not a time. */
export function timeToMinute(text: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(text)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  return h < 24 && m < 60 ? h * 60 + m : null
}

export function isValidTimeZone(zone: string): boolean {
  if (zone.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export function machineTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The seconds left before `expiresAt`, never negative. */
export function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
}

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function moved(order: CommunicationPolicy['precedence'], index: number, by: -1 | 1): CommunicationPolicy['precedence'] {
  const to = index + by
  if (to < 0 || to >= order.length) return order
  const next = [...order]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item!)
  return next
}

export function samePolicy(a: CommunicationPolicy, b: CommunicationPolicy): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function deliveryLine(outcome: string): string {
  switch (outcome) {
    case 'SENT': return 'sent'
    case 'ANSWERED': return 'call answered'
    case 'NO_ANSWER': return 'call not answered'
    case 'BUSY': return 'line busy'
    case 'FAILED': return 'failed'
    case 'NOT_CONFIGURED': return 'not configured'
    case 'SUPPRESSED_QUIET_HOURS': return 'held for quiet hours'
    case 'SUPPRESSED_POLICY': return 'not sent (policy)'
    case 'DROPPED_STALE': return 'dropped, too old'
    case 'COLLAPSED': return 'combined with a later report'
    default: return outcome.toLowerCase()
  }
}

// ---- Voice (Linphone / SIP), 0.9.1 -------------------------------------------------------------------------

type Voice = DirectorLineView['voice']

export const ENCRYPTION_LABEL: Record<VoiceMediaEncryption, string> = { zrtp: 'ZRTP', srtp: 'SRTP', dtls: 'DTLS', none: 'None' }
export const ENCRYPTION_ORDER: readonly VoiceMediaEncryption[] = ['zrtp', 'srtp', 'dtls', 'none']

export const ENCRYPTION_NOTE =
  'ZRTP and DTLS agree keys between the two ends. NEXUS shows what a call actually negotiated; it does not claim more.'

export const SIP_SETUP_STEPS: readonly string[] = [
  'Create two free accounts at sip.linphone.org by hand: one for your phone, one for NEXUS.',
  'Install the Linphone app on your phone and sign in with the first account. Allow notifications, so that a call from NEXUS rings.',
  'In the app, add a contact called "NEXUS Director" with the SIP address of the second account.',
  'Enter below the address and password of the second account (NEXUS), and the address of the first (your phone).',
]

export const PIN_OFF_NOTE =
  'The paired SIP address alone then opens the line, and only when the SIP service itself establishes who is calling. An address that a service only passes on still needs the PIN.'

export const NO_SPEECH_LINE = 'No speech engine is installed, so calls cannot be held yet.'

export interface SipForm {
  identity: string
  /** Empty keeps the stored password. */
  password: string
  operatorIdentity: string
  mediaEncryption: VoiceMediaEncryption
  mediaEncryptionMandatory: boolean
  stunServer: string
  ice: boolean
}

export const EMPTY_SIP_FORM: SipForm = { identity: '', password: '', operatorIdentity: '', mediaEncryption: 'zrtp', mediaEncryptionMandatory: true, stunServer: '', ice: true }

/** The form as it starts: what is stored (never the password), or the defaults. */
export function sipFormFromView(voice: Voice): SipForm {
  return {
    identity: voice.identity ?? '',
    password: '',
    operatorIdentity: voice.operatorIdentity ?? '',
    mediaEncryption: voice.mediaEncryption,
    mediaEncryptionMandatory: voice.mediaEncryptionMandatory,
    stunServer: voice.stunServer ?? '',
    ice: voice.ice,
  }
}

export type SipFormField = 'identity' | 'password' | 'operatorIdentity' | 'stunServer'

/** What is wrong with each field of the SIP form as it stands; an empty object when it can be saved. */
export function sipFormProblems(form: SipForm, passwordSet: boolean): Partial<Record<SipFormField, string>> {
  const problems: Partial<Record<SipFormField, string>> = {}
  const own = normalizeSipIdentity(form.identity)
  const phone = normalizeSipIdentity(form.operatorIdentity)
  if (own === null) problems.identity = "NEXUS's SIP address looks like sip:name@sip.linphone.org."
  if (phone === null) problems.operatorIdentity = "Your phone's SIP address looks like sip:name@sip.linphone.org."
  else if (own !== null && own === phone) problems.operatorIdentity = "Your phone's address must differ from NEXUS's own."
  if (form.password === '' ? !passwordSet : form.password.length > 128) problems.password = form.password === '' ? "NEXUS's SIP password is needed." : 'At most 128 characters.'
  const stun = form.stunServer.trim()
  if (stun !== '' && !/^[a-zA-Z0-9.:-]{1,253}$/.test(stun)) problems.stunServer = 'A host name, with a port if needed: stun.example.org:3478.'
  return problems
}

/** The form as the runtime takes it. */
export function sipFormInput(form: SipForm): IpcInput<'directorLine.setSip'> {
  return {
    identity: form.identity.trim(),
    password: form.password === '' ? null : form.password,
    operatorIdentity: form.operatorIdentity.trim(),
    mediaEncryption: form.mediaEncryption,
    mediaEncryptionMandatory: form.mediaEncryptionMandatory,
    stunServer: form.stunServer.trim() === '' ? null : form.stunServer.trim(),
    ice: form.ice,
  }
}

export interface VoicePolicyForm {
  requirePin: boolean
  ringSeconds: number
  maxPlacedCallsPerDay: number
  minMinutesBetweenPlacedCalls: number
}

export type VoicePolicyField = 'ringSeconds' | 'maxPlacedCallsPerDay' | 'minMinutesBetweenPlacedCalls'

const POLICY_LIMITS: Record<VoicePolicyField, { min: number; max: number; words: string }> = {
  ringSeconds: { min: 10, max: 60, words: 'Between 10 and 60 seconds.' },
  maxPlacedCallsPerDay: { min: 0, max: 24, words: 'Between 0 and 24. 0 means NEXUS never rings; it sends a message.' },
  minMinutesBetweenPlacedCalls: { min: 0, max: 240, words: 'Between 0 and 240 minutes.' },
}

export function voicePolicyProblems(form: VoicePolicyForm): Partial<Record<VoicePolicyField, string>> {
  const problems: Partial<Record<VoicePolicyField, string>> = {}
  for (const key of Object.keys(POLICY_LIMITS) as VoicePolicyField[]) {
    const v = form[key]
    const limit = POLICY_LIMITS[key]
    if (!Number.isInteger(v) || v < limit.min || v > limit.max) problems[key] = limit.words
  }
  return problems
}

export function sameVoicePolicy(a: VoicePolicyForm, b: VoicePolicyForm): boolean {
  return a.requirePin === b.requirePin && a.ringSeconds === b.ringSeconds && a.maxPlacedCallsPerDay === b.maxPlacedCallsPerDay && a.minMinutesBetweenPlacedCalls === b.minMinutesBetweenPlacedCalls
}

/** The status line of the voice block and the tone of its badge. */
export function voiceStatus(voice: Voice): { tone: 'success' | 'danger' | 'neutral'; text: string } {
  if (!voice.available) return { tone: 'neutral', text: `Not available on this build${voice.unavailableReason ? `: ${voice.unavailableReason}` : '.'}` }
  if (!voice.configured) return { tone: 'neutral', text: 'Not set up' }
  if (voice.inCall) return { tone: 'success', text: 'In a call' }
  switch (voice.state) {
    case 'CONNECTING': return { tone: 'neutral', text: 'Connecting' }
    case 'REGISTERED': return { tone: 'success', text: `Registered as ${voice.identity ?? 'NEXUS'}` }
    case 'UNREACHABLE': return { tone: 'danger', text: 'Unreachable' }
    case 'REJECTED': return { tone: 'danger', text: 'Rejected (wrong password)' }
    case 'STOPPED': return { tone: 'neutral', text: `Not running${voice.stateDetail ? `: ${voice.stateDetail}` : '.'}` }
  }
}

/** Why "Call me now" cannot be pressed, or null when it can. */
export function callMeDisabledReason(voice: Voice): string | null {
  if (!voice.available) return 'Voice is not available on this build.'
  if (!voice.configured) return 'The voice line is not set up.'
  if (voice.operatorIdentity === null) return "Your phone's SIP address is not set."
  if (voice.inCall) return 'You are in a call.'
  if (voice.state !== 'REGISTERED') return 'NEXUS is not registered with the SIP server.'
  return null
}

export function placeResultWords(result: PlaceCallResult): string {
  switch (result) {
    case 'CONVERSATION': return 'Your phone was answered.'
    case 'NO_ANSWER': return 'No answer. A message was sent instead.'
    case 'BUSY': return 'Your phone was busy.'
    case 'DECLINED': return 'The call was declined.'
    case 'FAILED': return 'The call could not be placed.'
    case 'NOT_PAIRED': return "Your phone's SIP address is not set."
    case 'LINE_BUSY': return 'A call is already in progress.'
    case 'NOT_REGISTERED': return 'NEXUS is not registered with the SIP server.'
    case 'SUPPRESSED': return 'Not called: the limit of calls for today is reached.'
    case 'NOT_CONFIGURED': return 'The voice line is not set up.'
  }
}

/** "Local" speech stays on the PC; anything else sends sound to the named provider. */
export function speechLine(speech: Voice['speech']): string {
  if (speech.stt === null || speech.tts === null) return NO_SPEECH_LINE
  const where = (e: { kind: string; local: boolean }): string => (e.local ? 'on this PC' : `sound goes to ${e.kind}`)
  return `Recogniser: ${speech.stt.kind} (${where(speech.stt)}). Voice: ${speech.tts.kind} (${where(speech.tts)}).`
}

/** What a call negotiated, as it was recorded: "TLS / ZRTP (end to end)". */
export function securityText(security: CallRecordView['security']): string {
  if (security === null) return 'not recorded'
  return `${security.signalling} / ${security.media.replace('_', '-')}${security.endToEnd ? ' (end to end)' : ''}`
}

const OUTCOME_WORDS: Record<CallRecordView['outcome'], string> = {
  CONVERSATION: 'conversation',
  DECLINED_UNPAIRED: 'declined (not the paired address)',
  DECLINED_BUSY: 'declined (already in a call)',
  NO_ANSWER: 'no answer',
  BUSY: 'busy',
  DECLINED: 'declined',
  FAILED: 'failed',
  SUPPRESSED: 'not placed (limit)',
}

export function callOutcomeWords(outcome: CallRecordView['outcome']): string {
  return OUTCOME_WORDS[outcome]
}

export function callDirectionWords(direction: CallRecordView['direction']): string {
  return direction === 'INBOUND' ? 'You called NEXUS' : 'NEXUS called you'
}

export function answerTimeWords(ms: number | null): string {
  return ms === null ? 'not measured' : `${(ms / 1000).toFixed(1)} s`
}
