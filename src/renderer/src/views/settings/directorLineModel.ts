import type { CommunicationPolicy, ConnectionStatus, ReportEventKind } from '@shared/director-line'

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

export const VOICE_COST_LINE = 'Phone calls cost money on your own Twilio account. NEXUS never signs up for a service and never spends on its own.'

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

/** A telephone number as Twilio wants it: a plus sign, the country code, the number, no spaces. */
export const E164 = /^\+[1-9]\d{6,14}$/

export interface VoiceForm {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  fromNumber: string
  operatorNumber: string
}

export const EMPTY_VOICE_FORM: VoiceForm = { accountSid: '', apiKeySid: '', apiKeySecret: '', fromNumber: '', operatorNumber: '' }

/** What is wrong with each field of the voice form as it stands; an empty object when it can be saved. Spaces in a number are forgiven. */
export function voiceFormProblems(form: VoiceForm, alreadyConfigured: boolean): Partial<Record<keyof VoiceForm, string>> {
  const problems: Partial<Record<keyof VoiceForm, string>> = {}
  const number = (v: string): string => v.replace(/[\s().-]/g, '')
  const needed = !alreadyConfigured
  if (form.accountSid.trim() === '' ? needed : !/^AC[0-9a-fA-F]{32}$/.test(form.accountSid.trim())) problems.accountSid = 'The account SID begins with AC and has 34 characters.'
  if (form.apiKeySid.trim() === '' ? needed : !/^SK[0-9a-fA-F]{32}$/.test(form.apiKeySid.trim())) problems.apiKeySid = 'The API key SID begins with SK and has 34 characters.'
  if (!/^\S{8,256}$/.test(form.apiKeySecret.trim())) problems.apiKeySecret = 'The secret of the API key, as Twilio showed it once.'
  if (form.fromNumber.trim() === '' ? needed : !E164.test(number(form.fromNumber))) problems.fromNumber = 'Your Twilio number, with + and the country code, for example +12025550123.'
  if (form.operatorNumber.trim() === '' ? needed : !E164.test(number(form.operatorNumber))) problems.operatorNumber = 'Your own phone number, with + and the country code, for example +21620123456.'
  return problems
}

/** The form as the runtime takes it. Only what was typed is sent; a field left empty keeps what is stored. */
export function voiceFormInput(form: VoiceForm): { kind: 'TWILIO_VOICE'; secret: string; extra: { accountSid?: string; apiKeySid?: string; fromNumber?: string; operatorNumber?: string } } {
  const number = (v: string): string => v.replace(/[\s().-]/g, '')
  const extra: { accountSid?: string; apiKeySid?: string; fromNumber?: string; operatorNumber?: string } = {}
  if (form.accountSid.trim() !== '') extra.accountSid = form.accountSid.trim()
  if (form.apiKeySid.trim() !== '') extra.apiKeySid = form.apiKeySid.trim()
  if (form.fromNumber.trim() !== '') extra.fromNumber = number(form.fromNumber)
  if (form.operatorNumber.trim() !== '') extra.operatorNumber = number(form.operatorNumber)
  return { kind: 'TWILIO_VOICE', secret: form.apiKeySecret.trim(), extra }
}
