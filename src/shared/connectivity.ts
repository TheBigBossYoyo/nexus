/**
 * 0.9: network resilience for unattended work. A network interruption is a wait, not a mission failure: what
 * needs the network waits, what does not goes on. These are the types that module shares with the runtime and
 * the Settings panel (docs/NETWORK_RESILIENCE.md). Times are epoch milliseconds, like the rest of the runtime.
 */
import type { ProgressWait } from './progress'

export const CONNECTIVITY_STATES = [
  'ONLINE',
  'WLAN_DISCONNECTED',
  'WLAN_ASSOCIATED_NO_INTERNET',
  'DNS_FAILURE',
  'INTERNET_UNREACHABLE',
  'PROVIDER_UNREACHABLE',
  'PROVIDER_QUOTA_WAIT',
  'RESEARCH_ONLY_UNAVAILABLE',
] as const
export type ConnectivityState = (typeof CONNECTIVITY_STATES)[number]

/** The state of a Wi-Fi interface as Windows reports it (WLAN_INTERFACE_STATE), folded to what NEXUS acts on. */
export type WlanInterfaceState = 'connected' | 'disconnected' | 'connecting' | 'disconnecting' | 'not_ready' | 'ad_hoc' | 'unknown'

/** The outcome of one probe (a DNS lookup, a TCP or HTTPS connect). `code` is the error code when it failed; never a response body. */
export interface ProbeResult {
  /** What was asked: a host name, or an address. */
  target: string
  ok: boolean
  code: string | null
  ms: number | null
}

export interface WlanInterfaceEvidence {
  guid: string
  state: WlanInterfaceState
  /** The saved Windows profile this interface is connected through. A profile NAME, never a key. */
  profileName: string | null
  /** The last WLAN reason code Windows reported for this interface, when one was seen. */
  lastReasonCode: number | null
}

export interface ConnectivityEvidence {
  /** When the probes ran. */
  at: number
  /** How many Wi-Fi interfaces the machine has. 0 means none, or Windows' WLAN service is not running. */
  wlanInterfaces: number
  wlanAssociated: boolean
  /** The saved profile the associated interface uses; null when none is associated. */
  profileName: string | null
  wlanState: WlanInterfaceState | null
  lastReasonCode: number | null
  /** A link on another adapter than Wi-Fi (Ethernet, a USB tether) with an address. A heuristic; see docs. */
  wiredLinkUp: boolean
  /** Null when it was not run (no link). */
  dns: ProbeResult | null
  /** The two independent well-known endpoints, by name. */
  endpoints: ProbeResult[]
  /** The same kind of check by literal address, so that a DNS failure can be told from a dead link. */
  addresses: ProbeResult[]
  providers: Record<string, ProbeResult>
  quota: { limited: boolean; resetAt: number | null } | null
}

export interface ConnectivitySnapshot {
  state: ConnectivityState
  /** When the state began to hold (first seen, for a state that had to be confirmed). */
  since: number
  evidence: ConnectivityEvidence
}

export type ReconnectOutcome = 'CONNECTED' | 'NOT_CONNECTED' | 'REQUEST_FAILED' | 'SKIPPED_USER_DISCONNECT' | 'SKIPPED_NO_CANDIDATE' | 'SKIPPED_NO_INTERFACE'

export interface ReconnectAttempt {
  at: number
  /** The saved profile that was asked for; null when nothing was asked for. */
  profileName: string | null
  outcome: ReconnectOutcome
  /** The WLAN reason code from the request, when Windows gave one. */
  reasonCode: number | null
  detail: string | null
}

/** One interruption, from the first moment the network was seen to be down to the moment it was seen to be back. */
export interface NetworkOutage {
  id: string
  startedAt: number
  /** Null while the outage is open. */
  endedAt: number | null
  states: Array<{ state: ConnectivityState; at: number }>
  attempts: ReconnectAttempt[]
  reasonCodes: number[]
  /** What the probes showed when the outage was first confirmed. The diagnosis is made from this and from the lists above. */
  evidenceAtStart: ConnectivityEvidence
  /** The evidence of the last probe before it ended; null while open. */
  evidenceAtEnd: ConnectivityEvidence | null
}

export interface NetworkRecoveryPolicy {
  /** Off: NEXUS never asks Windows to connect anything. */
  enabled: boolean
  /** The profile that was connected when the work began. Null: the manager takes the one connected when it is told that work began. */
  primaryProfile: string | null
  /** Already-saved Windows WLAN profile names, in the order they are tried after the primary. Never a new network. */
  approvedBackupProfiles: string[]
  /** The most connect requests for one outage. */
  maxAttempts: number
  backoffInitialMs: number
  backoffMaxMs: number
}

export const DEFAULT_RECOVERY_POLICY: NetworkRecoveryPolicy = {
  enabled: true,
  primaryProfile: null,
  approvedBackupProfiles: [],
  maxAttempts: 6,
  backoffInitialMs: 10_000,
  backoffMaxMs: 120_000,
}

export const MAX_PROFILE_NAME_LENGTH = 255
export const MAX_APPROVED_BACKUPS = 8

/** A profile name Windows could have: 1 to 255 characters, no control characters. Anything else is not a name to pass on. */
export function isPlausibleProfileName(name: unknown): name is string {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' && name.length >= 1 && name.length <= MAX_PROFILE_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(name)
}

/** The policy as the Settings panel may send it: unknown fields dropped, numbers bounded, names checked, duplicates removed. */
export function normalizeRecoveryPolicy(input: unknown, base: NetworkRecoveryPolicy = DEFAULT_RECOVERY_POLICY): NetworkRecoveryPolicy {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const int = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback)
  const primary = o.primaryProfile === null ? null : isPlausibleProfileName(o.primaryProfile) ? o.primaryProfile : base.primaryProfile
  const backups: string[] = []
  const source = Array.isArray(o.approvedBackupProfiles) ? o.approvedBackupProfiles : base.approvedBackupProfiles
  for (const name of source) {
    if (isPlausibleProfileName(name) && name !== primary && !backups.includes(name) && backups.length < MAX_APPROVED_BACKUPS) backups.push(name)
  }
  const initial = int(o.backoffInitialMs, base.backoffInitialMs, 1_000, 600_000)
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    primaryProfile: primary,
    approvedBackupProfiles: backups,
    maxAttempts: int(o.maxAttempts, base.maxAttempts, 1, 20),
    backoffInitialMs: initial,
    backoffMaxMs: Math.max(initial, int(o.backoffMaxMs, base.backoffMaxMs, 1_000, 3_600_000)),
  }
}

export type WorkKind = 'LOCAL' | 'MODEL' | 'RESEARCH' | 'DEPENDENCY_INSTALL'
export const WORK_KINDS: readonly WorkKind[] = ['LOCAL', 'MODEL', 'RESEARCH', 'DEPENDENCY_INSTALL']

/**
 * Which kinds of work can go on in a state. LOCAL work (builds, tests, lint, local git, app launch, local
 * browser verification) never needs the network and always goes on. Model work needs the provider; research
 * and dependency installs need the Internet.
 */
export function workAllowed(state: ConnectivityState): Record<WorkKind, boolean> {
  switch (state) {
    case 'ONLINE':
      return { LOCAL: true, MODEL: true, RESEARCH: true, DEPENDENCY_INSTALL: true }
    case 'PROVIDER_UNREACHABLE':
    case 'PROVIDER_QUOTA_WAIT':
      return { LOCAL: true, MODEL: false, RESEARCH: true, DEPENDENCY_INSTALL: true }
    case 'RESEARCH_ONLY_UNAVAILABLE':
      return { LOCAL: true, MODEL: true, RESEARCH: false, DEPENDENCY_INSTALL: false }
    case 'WLAN_DISCONNECTED':
    case 'WLAN_ASSOCIATED_NO_INTERNET':
    case 'DNS_FAILURE':
    case 'INTERNET_UNREACHABLE':
      return { LOCAL: true, MODEL: false, RESEARCH: false, DEPENDENCY_INSTALL: false }
  }
}

/** The states that are an interruption of the network. A quota wait is a provider wait: the network is fine. */
export function isNetworkOutageState(state: ConnectivityState): boolean {
  return state !== 'ONLINE' && state !== 'PROVIDER_QUOTA_WAIT'
}

/** Which progress wait a state is, when everything that is left needs what is missing. Null: nothing is missing. */
export function progressWaitFor(state: ConnectivityState): Extract<ProgressWait, 'WAITING_FOR_NETWORK' | 'WAITING_FOR_PROVIDER'> | null {
  switch (state) {
    case 'ONLINE':
      return null
    case 'PROVIDER_UNREACHABLE':
    case 'PROVIDER_QUOTA_WAIT':
      return 'WAITING_FOR_PROVIDER'
    default:
      return 'WAITING_FOR_NETWORK'
  }
}

/** What a run does about the network now: what waits, since when, what goes on locally. */
export interface NetworkWaitState {
  state: ConnectivityState
  /** Null while nothing the run still has to do is blocked. */
  since: number | null
  /** Set only when nothing that is left can go on; a run that can still do local work is not "waiting". */
  wait: Extract<ProgressWait, 'WAITING_FOR_NETWORK' | 'WAITING_FOR_PROVIDER'> | null
  waitingKinds: WorkKind[]
  continuingKinds: WorkKind[]
  /** One sentence, from these facts only. */
  text: string
}

const KIND_TEXT: Record<WorkKind, string> = { LOCAL: 'local work', MODEL: 'model work', RESEARCH: 'research', DEPENDENCY_INSTALL: 'dependency installs' }
const list = (kinds: WorkKind[]): string => kinds.map((k) => KIND_TEXT[k]).join(', ')

/** The wait of a run that still has `remaining` kinds of work to do, in the given connectivity state. */
export function describeNetworkWait(snapshot: Pick<ConnectivitySnapshot, 'state' | 'since'>, remaining: readonly WorkKind[]): NetworkWaitState {
  const allowed = workAllowed(snapshot.state)
  const kinds = WORK_KINDS.filter((k) => remaining.includes(k))
  const waitingKinds = kinds.filter((k) => !allowed[k])
  const continuingKinds = kinds.filter((k) => allowed[k])
  if (waitingKinds.length === 0) return { state: snapshot.state, since: null, wait: null, waitingKinds, continuingKinds, text: 'Nothing that is left is blocked by the network.' }
  const base = progressWaitFor(snapshot.state) ?? 'WAITING_FOR_NETWORK'
  // Research that cannot be done while the model can is a wait for the network (the Internet, not the provider).
  const wait = snapshot.state === 'RESEARCH_ONLY_UNAVAILABLE' ? 'WAITING_FOR_NETWORK' : base
  const cause = wait === 'WAITING_FOR_PROVIDER' ? 'the model provider' : 'the network'
  const whole = continuingKinds.length === 0
  return {
    state: snapshot.state,
    since: snapshot.since,
    wait: whole ? wait : null,
    waitingKinds,
    continuingKinds,
    text: whole ? `Waiting for ${cause}: ${list(waitingKinds)} cannot go on.` : `${list(waitingKinds)} wait for ${cause}; ${list(continuingKinds)} go on.`,
  }
}

/** What a Settings panel reads: the state now, the policy, what Windows has saved (names only), and the last outages. */
export interface ConnectivityStatusView {
  snapshot: ConnectivitySnapshot | null
  policy: NetworkRecoveryPolicy
  /** The saved profiles on this machine, names and whether each is open: what the panel may offer as backups. */
  savedProfiles: Array<{ name: string; security: 'open' | 'secured' | 'unknown'; autoConnect: boolean }>
  recentOutages: NetworkOutage[]
  keepAwake: { held: boolean; reason: string | null }
}
