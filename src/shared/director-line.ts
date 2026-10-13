/**
 * Director Line: the user talks to NEXUS while away from the PC, and NEXUS reports back. These are the types only.
 *
 * Two notions are kept apart on purpose. `providerAuthenticated` says the PROVIDER vouches for a delivery (a
 * webhook signature, a TLS connection to api.telegram.org). It says nothing about which human wrote the text.
 * `trust` says whether the text comes from the paired human. Only a paired identity (and, for voice, a correct PIN)
 * yields USER_AUTHORITY, and even then USER_AUTHORITY means "these are the user's words", never "this widens
 * what NEXUS may do": the line has no path to the capability broker, to settings or to power.
 */

export const OPERATOR_CHANNEL_KINDS = ['TELEGRAM', 'TWILIO_SMS', 'TWILIO_VOICE', 'WHATSAPP', 'EMAIL', 'SIP_VOICE'] as const
export type OperatorChannelKind = (typeof OPERATOR_CHANNEL_KINDS)[number]

export type PairingMethod = 'PAIRING_CODE' | 'PHONE_AND_PIN' | 'CONFIGURED'

export interface OperatorIdentity {
  channel: OperatorChannelKind
  /** The provider's stable id: a Telegram chat id, an E.164 number. Never a display name. */
  providerUserId: string
  label: string
  pairedAt: string
  pairedVia: PairingMethod
}

export type MessageTrust = 'USER_AUTHORITY' | 'UNTRUSTED_EXTERNAL'

export interface OperatorMessage {
  direction: 'INBOUND' | 'OUTBOUND'
  channel: OperatorChannelKind
  providerMessageId: string
  /** The provider's chat/user id the message came from or goes to. */
  providerUserId: string
  text: string
  receivedAt: string
  /** The provider vouched for the delivery. Not a statement about the human. */
  providerAuthenticated: boolean
  /** Whether the paired human wrote it. Decided by the line, never by the text. */
  trust: MessageTrust
}

export const OPERATOR_CALL_STATES = ['QUEUED', 'RINGING', 'ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'COMPLETED'] as const
export type OperatorCallState = (typeof OPERATOR_CALL_STATES)[number]

export interface OperatorCall {
  direction: 'INBOUND' | 'OUTBOUND'
  providerCallId: string
  state: OperatorCallState
  startedAt: string
  /** Always false by default. A recording is a separate, explicit, per-provider decision this module does not make. */
  recorded: boolean
}

export const OPERATOR_COMMAND_KINDS = [
  'STATUS', 'ETA', 'BLOCKERS', 'DETAILS', 'LATEST_TEST_RESULTS', 'PAUSE_AFTER_CURRENT_TASK', 'CONTINUE',
  'ADD_TASK_AFTER_CURRENT', 'CREATE_TASK', 'HELP', 'REFUSED_AT_MACHINE', 'UNKNOWN',
] as const
export type OperatorCommandKind = (typeof OPERATOR_COMMAND_KINDS)[number]

export type OperatorCommand =
  | { kind: 'STATUS' | 'ETA' | 'BLOCKERS' | 'LATEST_TEST_RESULTS' | 'PAUSE_AFTER_CURRENT_TASK' | 'CONTINUE' | 'HELP' | 'UNKNOWN' }
  | { kind: 'DETAILS'; subject: string }
  | { kind: 'ADD_TASK_AFTER_CURRENT'; text: string }
  | { kind: 'CREATE_TASK'; project: string; text: string }
  /** Something destructive or high-authority. Never executed through the line; `topic` is a fixed label, not the user's text. */
  | { kind: 'REFUSED_AT_MACHINE'; topic: RefusedTopic }

export const REFUSED_TOPICS = ['PUSH_OR_PUBLISH', 'DESTRUCTIVE', 'SANDBOX_OR_AUTONOMY', 'BOUNDARY_REQUEST', 'POWER', 'CREDENTIALS', 'RUN_COMMAND'] as const
export type RefusedTopic = (typeof REFUSED_TOPICS)[number]

/** What an operator-written task becomes before the ordinary creation path (Task Compiler + CapabilityBroker) sees it. */
export interface RawUserIntent {
  text: string
  projectHint: string | null
  /** DIRECTOR_LINE_VOICE: said on a live call, read back and confirmed there. */
  source: 'OPERATOR_REMOTE' | 'DIRECTOR_LINE_VOICE'
  /** For a task said on a call: what was said around it, as it was recognised, oldest first. The task itself is `text`. */
  transcript?: string[]
  channel: OperatorChannelKind
  operatorId: string
  messageId: string
  /** True when the task is to be queued behind the current program rather than started now. */
  afterCurrent: boolean
}

export type DeliveryOutcome = 'SENT' | 'FAILED' | 'NOT_CONFIGURED' | 'ANSWERED' | 'NO_ANSWER' | 'BUSY' | 'SUPPRESSED_QUIET_HOURS' | 'SUPPRESSED_POLICY' | 'DROPPED_STALE' | 'COLLAPSED'
export interface DeliveryAttempt {
  channel: OperatorChannelKind | 'LOCAL_NOTIFICATION'
  at: string
  outcome: DeliveryOutcome
  providerReference: string | null
  /** A class such as 'NETWORK', 'RATE_LIMITED', 'AUTH', 'PROVIDER'. Never a message that could carry a secret. */
  errorClass: string | null
  reportId: string
}

export const REPORT_EVENT_KINDS = [
  'MORNING_OVERNIGHT_REPORT', 'PROGRAM_COMPLETE', 'MISSION_BLOCKED', 'SECURITY_BOUNDARY_REQUIRED', 'NETWORK_OFFLINE', 'CRITICAL_FAILURE', 'ETA_SLIPPED', 'PROGRESS',
] as const
export type ReportEventKind = (typeof REPORT_EVENT_KINDS)[number]

export interface ReportEvent {
  kind: ReportEventKind
  at: string
  /** Groups events about the same piece of work, so that old ones can be collapsed: a run id, a program id. */
  subjectId: string
  /** Plain facts the line may put in a message. Composed by the runtime from its own data, never from model output. */
  text: string
  /** For MISSION_BLOCKED and NETWORK_OFFLINE: how long it has lasted when the event is raised. */
  minutes?: number
  /** For ETA_SLIPPED: how much later than first said. */
  slippedPercent?: number
  slippedMinutes?: number
  /** A resolved event (kind PROGRAM_COMPLETE, or a MISSION_BLOCKED with resolved true) supersedes earlier open ones. */
  resolved?: boolean
}

export type ChannelClass = 'PHONE' | 'MESSAGE' | 'LOCAL_NOTIFICATION'

export interface QuietHours {
  enabled: boolean
  /** Minutes after local midnight, 0..1439, in `timeZone`. A window may wrap midnight (22:00 to 07:00). */
  startMinute: number
  endMinute: number
  /** IANA zone such as 'Europe/Paris'. Evaluated with Intl at the moment of the event, so daylight saving is right. */
  timeZone: string
  /** Critical kinds ring through quiet hours when true. Default false for calls, true for messages is not offered: one switch. */
  criticalBreaksQuiet: boolean
}

export interface EventPolicy {
  enabled: boolean
  /** Whether a voice call is allowed for this event (still needs a configured voice provider). */
  call: boolean
  /** For MISSION_BLOCKED / NETWORK_OFFLINE: raise only after this many minutes. For ETA_SLIPPED: percent. */
  threshold?: number
  thresholdUnit?: 'MINUTES' | 'PERCENT'
}

export interface CommunicationPolicy {
  events: Record<Exclude<ReportEventKind, 'PROGRESS'>, EventPolicy>
  /** Order in which classes are tried. */
  precedence: ChannelClass[]
  quietHours: QuietHours
  /** Calls per report, fallback message not counted. Default 1. */
  maxCallAttempts: number
  /** Minimum minutes between remote PROGRESS messages. Default 45; never the UI's five-minute refresh. */
  minProgressIntervalMinutes: number
  /** Reports older than this when connectivity returns are dropped instead of sent. */
  staleAfterMinutes: number
  requirePinForStatus: boolean
}

export const DEFAULT_COMMUNICATION_POLICY: CommunicationPolicy = {
  events: {
    MORNING_OVERNIGHT_REPORT: { enabled: true, call: false },
    PROGRAM_COMPLETE: { enabled: true, call: true },
    MISSION_BLOCKED: { enabled: true, call: true, threshold: 30, thresholdUnit: 'MINUTES' },
    SECURITY_BOUNDARY_REQUIRED: { enabled: true, call: false },
    NETWORK_OFFLINE: { enabled: false, call: false, threshold: 60, thresholdUnit: 'MINUTES' },
    CRITICAL_FAILURE: { enabled: true, call: true },
    ETA_SLIPPED: { enabled: false, call: false, threshold: 25, thresholdUnit: 'PERCENT' },
  },
  precedence: ['PHONE', 'MESSAGE', 'LOCAL_NOTIFICATION'],
  quietHours: { enabled: true, startMinute: 22 * 60 + 30, endMinute: 7 * 60, timeZone: 'UTC', criticalBreaksQuiet: false },
  maxCallAttempts: 1,
  minProgressIntervalMinutes: 45,
  staleAfterMinutes: 12 * 60,
  requirePinForStatus: true,
}

export type ConnectionStatus = 'UNCONFIGURED' | 'STOPPED' | 'CONNECTING' | 'CONNECTED' | 'ERROR'

/** What Settings may show. There is deliberately no field that can hold a token, a PIN or a pairing code. */
export interface DirectorLineSettingsView {
  enabled: boolean
  messageProvider: { kind: OperatorChannelKind | null; configured: boolean; tokenSuffix: string | null; status: ConnectionStatus }
  voiceProvider: { kind: 'TWILIO_VOICE' | null; configured: boolean; tokenSuffix: string | null; status: ConnectionStatus }
  pairedOperator: Pick<OperatorIdentity, 'channel' | 'label' | 'pairedAt' | 'pairedVia'> | null
  pinConfigured: boolean
  policy: CommunicationPolicy
  lastDelivery: DeliveryAttempt | null
}

/** Proposed IPC channel names, for the runtime to register. Types are in docs/DIRECTOR_LINE.md. */
export const DIRECTOR_LINE_IPC = {
  get: 'directorLine.get',
  setEnabled: 'directorLine.setEnabled',
  setProvider: 'directorLine.setProvider',
  setPolicy: 'directorLine.setPolicy',
  startPairing: 'directorLine.startPairing',
  setPin: 'directorLine.setPin',
  unpair: 'directorLine.unpair',
  sendTestMessage: 'directorLine.sendTestMessage',
  testCall: 'directorLine.testCall',
} as const
