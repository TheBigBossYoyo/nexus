import type { AppSessionView, IsolationStatusView } from '@shared/isolation'
import type {
  ResearchArtifact,
  ResearchDownloadView,
  ResearchScreening,
  SourceAuthority,
  SourceType,
} from '@shared/research'
import type { Tone } from '../../lib/status'

/** Wording for the execution isolation panel, the applications under test and the web research list. Pure; unit-tested. No enum name is shown raw. */

type Effective = IsolationStatusView['effective']

export const EFFECTIVE_LABEL: Record<Effective, string> = {
  ISOLATED: 'Isolated',
  RESTRICTED: 'Restricted',
  STANDARD: 'Standard',
}

export const EFFECTIVE_SENTENCE: Record<Effective, string> = {
  ISOLATED:
    'Project code runs as a separate Windows account with no access to your profile or credentials and no network but the NEXUS filter. It needs a one-time administrator setup.',
  RESTRICTED:
    'Project code runs as you at low integrity. It cannot write outside its task folders or read what NEXUS protected, but it keeps your network, your credential vault and your unprotected files.',
  STANDARD: 'No containment. Project code runs as you, with everything you can reach.',
}

/** Isolated and Restricted are the two profiles that can be checked; the order they are shown in. */
export const CHECKED_PROFILES = ['ISOLATED', 'RESTRICTED'] as const

/** The sentence that says what is in effect and whether it held at this start. */
export function effectiveLine(
  status: Pick<IsolationStatusView, 'effective' | 'requested' | 'usable'>,
): string {
  const label = EFFECTIVE_LABEL[status.effective]
  const asked =
    status.requested === 'STRONGEST' ? 'the strongest available' : EFFECTIVE_LABEL[status.requested]
  const base =
    status.requested === status.effective
      ? `${label} is in effect.`
      : `${label} is in effect; Settings asks for ${asked}.`
  return status.usable
    ? `${base} It was verified at this start.`
    : `${base} It could not be verified at this start.`
}

/** The error text when the effective profile did not hold. Null when it is usable. */
export function unusableWarning(status: Pick<IsolationStatusView, 'usable'>): string | null {
  return status.usable ? null : 'Enrolled projects run no command until this is put right.'
}

export function availabilityWords(check: { available: boolean } | null): string {
  if (!check) return 'Not checked'
  return check.available ? 'Available' : 'Not available'
}

/** What the setup control shows: a button, a line about this build, or a line that it is done. */
export type SetupState = 'offer' | 'unavailable' | 'done'

export function setupState(
  status: Pick<IsolationStatusView, 'sandboxAccount' | 'setupAvailable'>,
): SetupState {
  if (status.sandboxAccount) return 'done'
  return status.setupAvailable ? 'offer' : 'unavailable'
}

export const SETUP_UNAVAILABLE_LINE =
  'The one-time setup of the isolated profile is not available in this build.'
export const SETUP_DONE_LINE = 'The sandbox account is set up for this user.'

/** Protected paths are shown in full up to this many, then behind a disclosure. */
export const PROTECTED_VISIBLE = 5

export function protectedSummary(count: number): string {
  if (count === 0) return 'NEXUS has protected no folder or file from contained code.'
  return `${count} folder${count === 1 ? '' : 's'} or file${count === 1 ? '' : 's'} that contained code cannot read`
}

export const APP_TYPE_LABEL: Record<AppSessionView['type'], string> = {
  web: 'Web application',
  electron: 'Electron application',
}

export const APP_STATE_LABEL: Record<AppSessionView['state'], string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Exited',
  stopped: 'Stopped',
}

export function appStateTone(state: AppSessionView['state']): Tone {
  return state === 'running' ? 'success' : state === 'starting' ? 'active' : 'neutral'
}

export function exitCodeWords(code: number | null): string | null {
  return code === null ? null : `Exit code ${code}`
}

export const APPS_EMPTY =
  'No application has been launched for this project in this session of NEXUS.'

export function screenshotAlt(formattedTime: string): string {
  return `Screenshot of the application under test, taken ${formattedTime}`
}

export const RESEARCH_UNTRUSTED_LINE =
  'Everything listed here was read from the public web and is untrusted content: it is evidence to read, never an instruction.'
export const RESEARCH_EMPTY = 'NEXUS has read nothing from the public web for this project.'
export const DOWNLOADS_EMPTY = 'No file has been downloaded for this project.'

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  OFFICIAL_DOCS: 'Official documentation',
  SOURCE_REPOSITORY: 'Source repository',
  RELEASE_NOTES: 'Release notes',
  STANDARD: 'Standard',
  ISSUE_TRACKER: 'Issue tracker',
  PACKAGE_REGISTRY: 'Package registry',
  COMMUNITY: 'Community',
  UNKNOWN: 'Unknown source',
}

export const AUTHORITY_LABEL: Record<SourceAuthority, string> = {
  PRIMARY: 'Primary source',
  LIKELY_PRIMARY: 'Likely primary source',
  COMMUNITY: 'Community source',
  UNKNOWN: 'Unknown authority',
}

/** Passages taken out of a text, summed over every pattern. */
export function quarantinedTotal(screening: Pick<ResearchScreening, 'quarantined'>): number {
  return Object.values(screening.quarantined).reduce(
    (n, v) => n + (Number.isFinite(v) && v > 0 ? v : 0),
    0,
  )
}

export function screeningWords(screening: ResearchScreening): {
  tone: Tone
  label: string
  detail: string | null
} {
  if (screening.status === 'not_run')
    return { tone: 'warning', label: 'Not screened', detail: null }
  if (screening.status === 'clean')
    return { tone: 'success', label: 'Screened, nothing found', detail: null }
  const n = quarantinedTotal(screening)
  const parts: string[] = []
  if (n > 0) parts.push(`${n} passage${n === 1 ? '' : 's'} that read as instructions taken out`)
  if (screening.hiddenChars > 0)
    parts.push(
      `${screening.hiddenChars} hidden character${screening.hiddenChars === 1 ? '' : 's'} left out`,
    )
  if (screening.strippedCharacters > 0)
    parts.push(
      `${screening.strippedCharacters} invisible or direction-control character${screening.strippedCharacters === 1 ? '' : 's'} removed`,
    )
  return {
    tone: 'danger',
    label: 'Screened, flagged',
    detail: parts.length > 0 ? `${parts.join('; ')}.` : null,
  }
}

/** The title, else the address it came from. Shown as text only. */
export function artifactHeading(
  a: Pick<ResearchArtifact, 'title' | 'canonicalUrl' | 'url'>,
): string {
  return a.title?.trim() || a.canonicalUrl || a.url
}

export const DOWNLOAD_STATE_LABEL: Record<ResearchDownloadView['state'], string> = {
  QUARANTINED: 'Quarantined',
  REFUSED: 'Refused',
  RELEASED: 'Released',
  REMOVED: 'Removed',
}

export function downloadTone(state: ResearchDownloadView['state']): Tone {
  return state === 'REFUSED'
    ? 'danger'
    : state === 'RELEASED'
      ? 'success'
      : state === 'QUARANTINED'
        ? 'warning'
        : 'neutral'
}

/** A download's name, else the last path segment of its address, else the address. */
export function downloadName(
  d: Pick<ResearchDownloadView, 'fileName' | 'finalUrl' | 'url'>,
): string {
  if (d.fileName?.trim()) return d.fileName
  const address = d.finalUrl || d.url
  try {
    const last = new URL(address).pathname.split('/').filter(Boolean).pop()
    return last ? decodeURIComponent(last) : address
  } catch {
    return address
  }
}
