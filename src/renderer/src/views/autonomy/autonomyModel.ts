import type {
  AutonomyProfile,
  BoundaryDecision,
  BoundaryRequestState,
  BoundaryRequestView,
  CapabilityGrant,
  GrantScope,
  SecurityEventSeverity,
} from '@shared/autonomy'
import type { Tone } from '../../lib/status'

/** Wording and grouping for the 0.8 boundary inbox and the Autonomy settings. Pure; unit-tested. No enum name is shown raw. */

/** "1 boundary decision required"; null when there is none, so nothing is shown. */
export function boundaryCountLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  return `${count} boundary decision${count === 1 ? '' : 's'} required`
}

/** The short form for the status bar. */
export function boundaryCountShort(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  return `${count} boundary decision${count === 1 ? '' : 's'}`
}

export const PROFILE_LABEL: Record<AutonomyProfile, string> = {
  AUTONOMOUS_PROJECT: 'Autonomous project',
  BALANCED: 'Balanced',
  LOCKED_DOWN: 'Locked down',
}

export const PROFILE_SENTENCE: Record<AutonomyProfile, string> = {
  AUTONOMOUS_PROJECT:
    'NEXUS edits, builds, tests, installs dependencies, runs the project and researches the public web in this project without asking. Anything outside that waits for your decision.',
  BALANCED:
    'NEXUS edits, builds and tests without asking. Installing dependencies, downloading files, and starting or operating the project application need a decision from you.',
  LOCKED_DOWN:
    'NEXUS edits, builds and tests in the task worktree without asking. It uses no network, runs no application and drives no browser unless you decide otherwise.',
}

export const PROFILE_ORDER: readonly AutonomyProfile[] = [
  'AUTONOMOUS_PROJECT',
  'BALANCED',
  'LOCKED_DOWN',
]

export const NEVER_POSSIBLE_LINE =
  'Whatever the profile, no agent can read provider credentials, reach the NEXUS runtime and its keys, use your own browser profile, change this policy, or shut down or suspend the machine. A profile is a set of permissions NEXUS checks; it is not a sandbox.'

/** The heading and the lead of what holds while nobody is there. */
export const UNATTENDED_TITLE = 'While you are away'
export const UNATTENDED_LEAD =
  'A mission runs in the NEXUS runtime, not in this window. Closing the window, locking the screen or leaving it overnight changes nothing about what NEXUS may do in this project.'
export const UNATTENDED_ANSWER_LINE =
  'When you answer a request, allowed or denied, NEXUS starts the waiting work again by itself and resumes a mission that was paused only for it.'

/** The compact line on the project page. */
export function enrollmentLine(profile: AutonomyProfile | null): string {
  return profile === null
    ? 'Not enrolled: NEXUS asks before sensitive actions.'
    : `${PROFILE_LABEL[profile]} profile: actions inside it run without asking.`
}

export const SCOPE_WORDS: Record<GrantScope, string> = {
  ONCE: 'Once',
  MISSION: 'This mission',
  PROJECT: 'Always, for this project',
}

export const DECISION_BY_SCOPE: Record<
  GrantScope,
  Exclude<BoundaryDecision['decision'], 'DENY'>
> = {
  ONCE: 'ALLOW_ONCE',
  MISSION: 'ALLOW_MISSION',
  PROJECT: 'ALLOW_PROJECT',
}

const BUTTON_LABEL: Record<GrantScope, string> = {
  ONCE: 'Allow once',
  MISSION: 'Allow for this mission',
  PROJECT: 'Always allow for this project',
}

export interface DecisionButton {
  decision: BoundaryDecision['decision']
  label: string
  variant: 'primary' | 'default' | 'danger'
}

/** The answers a request offers: only the scopes the request lists, narrowest first, and always Deny. */
export function decisionButtons(scopes: readonly GrantScope[]): DecisionButton[] {
  const order: GrantScope[] = ['ONCE', 'MISSION', 'PROJECT']
  const buttons: DecisionButton[] = order
    .filter((s) => scopes.includes(s))
    .map((s) => ({
      decision: DECISION_BY_SCOPE[s],
      label: BUTTON_LABEL[s],
      variant: s === 'ONCE' ? ('primary' as const) : ('default' as const),
    }))
  buttons.push({ decision: 'DENY', label: 'Deny', variant: 'danger' })
  return buttons
}

export const REQUEST_STATE_WORDS: Record<BoundaryRequestState, string> = {
  PENDING: 'Waiting for you',
  GRANTED: 'Allowed',
  DENIED: 'Denied',
  EXPIRED: 'Expired',
}

export const REQUEST_STATE_TONE: Record<BoundaryRequestState, Tone> = {
  PENDING: 'waiting',
  GRANTED: 'success',
  DENIED: 'danger',
  EXPIRED: 'neutral',
}

/** What a decided request ended as, in words: "Allowed once", "Allowed for this mission", "Denied". */
export function decidedWords(request: Pick<BoundaryRequestView, 'state' | 'decidedScope'>): string {
  if (request.state === 'GRANTED') {
    if (request.decidedScope === 'ONCE') return 'Allowed once'
    if (request.decidedScope === 'MISSION') return 'Allowed for this mission'
    if (request.decidedScope === 'PROJECT') return 'Always allowed for this project'
  }
  return REQUEST_STATE_WORDS[request.state]
}

export const SEVERITY_WORDS: Record<SecurityEventSeverity, string> = {
  NORMAL_AUTONOMOUS_ACTION: 'Normal action',
  POLICY_DENIAL: 'Refused by policy',
  INJECTION_DETECTED: 'Instruction found in untrusted content',
  BOUNDARY_REQUEST: 'Decision requested',
  ISOLATION_FAILURE: 'Containment failed',
  ESCAPE_ATTEMPT: 'Attempt to leave the containment',
  CREDENTIAL_ACCESS_ATTEMPT: 'Attempt to read credentials',
}

export const SEVERITY_TONE: Record<SecurityEventSeverity, Tone> = {
  NORMAL_AUTONOMOUS_ACTION: 'neutral',
  POLICY_DENIAL: 'warning',
  INJECTION_DETECTED: 'warning',
  BOUNDARY_REQUEST: 'waiting',
  ISOLATION_FAILURE: 'danger',
  ESCAPE_ATTEMPT: 'danger',
  CREDENTIAL_ACCESS_ATTEMPT: 'danger',
}

export function severityWords(severity: string): string {
  return (SEVERITY_WORDS as Record<string, string>)[severity] ?? 'Other event'
}

export function severityTone(severity: string): Tone {
  return (SEVERITY_TONE as Record<string, Tone>)[severity] ?? 'neutral'
}

export interface MissionGroup {
  key: string
  missionTitle: string | null
  requests: BoundaryRequestView[]
}

export interface ProjectGroup {
  projectId: string
  projectName: string
  missions: MissionGroup[]
  count: number
}

const byAge = (a: BoundaryRequestView, b: BoundaryRequestView) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
const oldest = (list: readonly BoundaryRequestView[]) => [...list].sort(byAge)[0]?.createdAt ?? ''

/**
 * Pending requests grouped by project, then by mission. The longest-waiting request orders its group (what has
 * waited longest is read first); inside a mission requests are oldest first; requests without a mission come last.
 */
export function groupRequests(requests: readonly BoundaryRequestView[]): ProjectGroup[] {
  const projects = new Map<string, BoundaryRequestView[]>()
  for (const r of requests) projects.set(r.projectId, [...(projects.get(r.projectId) ?? []), r])
  return [...projects.entries()]
    .map(([projectId, list]) => {
      const missions = new Map<string, BoundaryRequestView[]>()
      for (const r of list) {
        const key = r.runId ?? ''
        missions.set(key, [...(missions.get(key) ?? []), r])
      }
      const groups: MissionGroup[] = [...missions.entries()]
        .map(([key, items]) => ({
          key,
          missionTitle: items[0]?.missionTitle ?? null,
          requests: [...items].sort(byAge),
        }))
        .sort((a, b) =>
          a.key === ''
            ? 1
            : b.key === ''
              ? -1
              : oldest(a.requests).localeCompare(oldest(b.requests)) || a.key.localeCompare(b.key),
        )
      return {
        projectId,
        projectName: list[0]?.projectName ?? projectId,
        missions: groups,
        count: list.length,
        first: oldest(list),
      }
    })
    .sort((a, b) => a.first.localeCompare(b.first) || a.projectName.localeCompare(b.projectName))
    .map(({ first: _first, ...group }) => group)
}

/** Newest decision first. */
export function sortRecent(requests: readonly BoundaryRequestView[]): BoundaryRequestView[] {
  return [...requests].sort(
    (a, b) =>
      (b.decidedAt ?? b.lastSeenAt).localeCompare(a.decidedAt ?? a.lastSeenAt) ||
      a.id.localeCompare(b.id),
  )
}

export function occurrencesLabel(occurrences: number): string | null {
  return occurrences > 1 ? `Met ${occurrences} times` : null
}

/** Why a grant is no longer in force, or null when it is. */
export function grantEndedWords(
  grant: Pick<CapabilityGrant, 'revokedAt' | 'consumedAt'>,
  active: boolean,
): string | null {
  if (active) return null
  if (grant.revokedAt) return 'Taken back'
  if (grant.consumedAt) return 'Used'
  return 'Ended'
}

/** The text of a failed answer. A declined native confirmation arrives as invalid_state with a readable message; it is shown as is. */
export function resolveErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ''
  return message || 'The answer was not recorded. The request is still waiting.'
}
