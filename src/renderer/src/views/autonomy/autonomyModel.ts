import type {
  AutonomyProfile,
  BoundaryDecision,
  BoundaryRequestState,
  BoundaryRequestView,
  CapabilityGrant,
  GrantScope,
  SecurityEventSeverity,
} from '@shared/autonomy'
import { PROFILE_LABEL, actionWasShortened, cleanAgentText } from '@shared/autonomy'
import type { Tone } from '../../lib/status'

/** Wording and grouping for the 0.8 boundary inbox and the Autonomy settings. Pure; unit-tested. No enum name is shown raw. */

/** One term throughout: the item is a boundary request, what the user gives is a decision. "1 boundary request waiting for your decision"; null when there is none, so nothing is shown. */
export function boundaryCountLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  return `${count} boundary request${count === 1 ? '' : 's'} waiting for your decision`
}

/** The short form for the status bar. */
export function boundaryCountShort(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  return `${count} boundary request${count === 1 ? '' : 's'}`
}

/** The same names the runtime writes into a request's reason (one table in the shared code). */
export { PROFILE_LABEL }

/** What a boundary request is, said once at the top of the Autonomy settings. */
export const BOUNDARY_REQUEST_DEFINITION =
  "A boundary request is a question NEXUS asks when an agent needs something outside the project's profile. It waits in the boundary inbox while other work goes on, and you answer when you like."

/** The line under the title of the boundary inbox. */
export const INBOX_HEADER_LINE =
  'Answer each one: allow it once, for this mission, always for this project, or deny it. When you answer, NEXUS starts the waiting work again by itself.'

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
  'Whatever the profile, no agent can, through NEXUS, read provider credentials, reach the NEXUS runtime and its keys, use your own browser profile, change this policy, or shut down or suspend the machine. A profile is a set of permissions NEXUS checks; it is not a sandbox. Code that runs as you (Restricted, Standard) is not stopped by this policy; only the containment bounds it.'

/** The heading and the lead of what holds while nobody is there. */
export const UNATTENDED_TITLE = 'While you are away'
export const UNATTENDED_LEAD =
  'A mission runs in the NEXUS runtime, not in this window. Closing the window, locking the screen or leaving it overnight changes nothing about what NEXUS may do in this project.'
export const UNATTENDED_ANSWER_LINE =
  'When you answer a request NEXUS starts the waiting work again by itself: allowed, the action is carried out; denied, the task finishes without it.'

/** The four headings of what holds while nobody is there. */
export const UNATTENDED_HEADINGS = {
  proceeds: 'Goes on without you',
  waits: 'Waits for your decision',
  never: 'Never done by an agent',
  presence: 'Only with you at the machine',
} as const

/** The one line that closes the disclosure: all four lists counted. */
export function unattendedSummary(policy: { proceeds: readonly unknown[]; waits: readonly unknown[]; never: readonly unknown[]; needsPresence: readonly unknown[] }): string {
  return `${policy.proceeds.length} go on, ${policy.waits.length} wait for your decision, ${policy.never.length} never happen, ${policy.needsPresence.length} need you at the machine`
}

/** The compact line on the project page. */
export function enrollmentLine(profile: AutonomyProfile | null): string {
  return profile === null
    ? 'Not enrolled: NEXUS asks before sensitive actions.'
    : `${PROFILE_LABEL[profile]} profile: actions inside it run without asking.`
}

export const SCOPE_WORDS: Record<GrantScope, string> = {
  ONCE: 'Once',
  MISSION: 'For this mission',
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

const lowerFirst = (text: string) => (text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text)

/**
 * What each answer a request offers reaches, one sentence per answer, in the order of the buttons. Allow once is
 * bound to the command shown whatever the resource says; the wider answers cover the capability on the resource,
 * or on any resource when the request names none.
 */
export function answerCoverage(
  request: Pick<BoundaryRequestView, 'scopes' | 'capabilityLabel' | 'resourceLabel' | 'resource'>,
): { decision: BoundaryDecision['decision']; text: string }[] {
  const label = lowerFirst(request.capabilityLabel)
  const anything = request.resource.kind === 'ANY'
  const what = anything ? `any ${label}` : `${label} on ${request.resourceLabel}`
  const out: { decision: BoundaryDecision['decision']; text: string }[] = []
  if (request.scopes.includes('ONCE')) out.push({ decision: 'ALLOW_ONCE', text: 'Allow once: only the command shown above, one time.' })
  if (request.scopes.includes('MISSION')) out.push({ decision: 'ALLOW_MISSION', text: `Allow for this mission: ${what} in this mission.` })
  if (request.scopes.includes('PROJECT')) out.push({ decision: 'ALLOW_PROJECT', text: `Always allow for this project: ${what}, in this and every later mission.` })
  out.push({ decision: 'DENY', text: 'Deny: it is not done, the agent is told so and goes on without it, and it is not asked again in this mission.' })
  return out
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

/**
 * The action as it is shown: what an agent wrote, without the characters that reorder or hide text (the runtime
 * removes them too; this is the second line of defence), and the sentence that goes with a shortened one.
 */
export function actionShown(request: Pick<BoundaryRequestView, 'action'> & { actionTruncated?: boolean }): { text: string; note: string | null } {
  const shortened = request.actionTruncated ?? actionWasShortened(request.action)
  return { text: cleanAgentText(request.action), note: shortened ? 'Shortened; allow once covers exactly the command that was attempted.' : null }
}

/** The longest a decided command is shown in the list of recent answers. */
export const RECENT_COMMAND_MAX = 160

/** The command of a decided request as one cleaned line, cut with an ellipsis. */
export function recentCommand(request: Pick<BoundaryRequestView, 'action'> & { actionTruncated?: boolean }): string {
  const line = actionShown(request).text.replace(/\s+/g, ' ').trim()
  return line.length > RECENT_COMMAND_MAX ? `${line.slice(0, RECENT_COMMAND_MAX - 1)}…` : line
}

/** The fixed sentences under a decided request: what happened when nothing was restarted, and where a lasting grant is taken back. */
export function recentNotes(request: Pick<BoundaryRequestView, 'state' | 'decidedScope' | 'followUp'>): string[] {
  const notes: string[] = []
  if (!request.followUp) {
    if (request.state === 'EXPIRED') notes.push('Expired with the mission: nothing was done.')
    else if (request.state === 'DENIED') notes.push('Denied: nothing was done.')
  }
  if (request.state === 'GRANTED' && request.decidedScope === 'PROJECT') notes.push('Take it back in Settings > Autonomy.')
  return notes
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

/** Who asked, in a short line made only of what NEXUS knows; unknown parts are left out. */
export function whoAsked(request: BoundaryRequestView): string {
  const role = request.agentRole?.toLowerCase() ?? null
  const task = request.taskTitle ? `on "${request.taskTitle}"` : null
  const mission = request.missionTitle ? `in mission "${request.missionTitle}"` : null
  const parts = [role ?? (task || mission ? 'An agent' : null), task, mission].filter((p): p is string => p !== null)
  return parts.join(' ')
}

/** Where the mission page of the request is, only when the run is known to exist. */
export function missionLink(request: BoundaryRequestView): { runId: string; projectId: string; taskId: string | null } | null {
  if (request.runId === null || request.missionTitle === null) return null
  return { runId: request.runId, projectId: request.projectId, taskId: request.taskId }
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
