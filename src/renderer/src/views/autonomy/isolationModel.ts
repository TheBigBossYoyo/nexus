import type { AppSessionView, IsolationStatusView } from '@shared/isolation'
import type {
  ResearchArtifact,
  ResearchBackend,
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
    'Project code runs as a separate Windows account with no access to your profile or credentials, on a desktop of its own, and with no network connection of its own but the NEXUS filter. Windows still looks up names for it, so a name it asks for can be seen outside. It needs a one-time administrator setup.',
  RESTRICTED:
    'Project code runs as you at low integrity. It cannot write outside its task folders or read what NEXUS protected, but it keeps your network, your credential vault, your unprotected files and, being you, what is on your screen.',
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
export function unusableWarning(status: Pick<IsolationStatusView, 'usable'>, setupOffered = false): string | null {
  // No screen chooses the containment, so only the setup is named, and only when it is on offer.
  if (status.usable) return null
  return `Project code cannot run in an enrolled project until its containment is verified.${setupOffered ? ' Run the setup below.' : ''}`
}

/** The live line of the Autonomy settings: where the code of an enrolled project runs now, or that it runs nowhere. */
export function projectCodeLine(status: Pick<IsolationStatusView, 'effective' | 'usable'>): { label: string; consequence: string } {
  return status.usable
    ? { label: `Project code of an enrolled project currently runs: ${EFFECTIVE_LABEL[status.effective]}`, consequence: EFFECTIVE_SENTENCE[status.effective] }
    : { label: `Project code of an enrolled project currently runs: ${EFFECTIVE_LABEL[status.effective]}, not verified`, consequence: 'Not verified at this start: enrolled projects run no command.' }
}

/**
 * Said where a project is enrolled and its code runs Restricted: that profile keeps a task's writes in its
 * folders, and is no containment against code that means harm.
 */
export const RESTRICTED_ADVICE =
  'Restricted is not a containment against hostile code: it runs as you. For work that goes on while you are away, set up the isolated profile.'

export function projectCodeAdvice(status: Pick<IsolationStatusView, 'effective' | 'usable'>): string | null {
  return status.usable && status.effective === 'RESTRICTED' ? RESTRICTED_ADVICE : null
}

/** What follows a setup that did not finish. The elevated script may have changed things before it stopped, so the sentence says what is true of a second run. */
export function setupRetryLine(detail: string): string {
  return /^Nothing was changed/.test(detail.trim()) ? 'You can try again.' : 'The setup can be run again: it repairs what it made before.'
}

export function availabilityWords(check: { available: boolean } | null): string {
  if (!check) return 'Not checked'
  return check.available ? 'Available' : 'Not available'
}

/** What the setup control shows: a button, a line about this build, or a line that it is done. */
export type SetupState = 'offer' | 'repair' | 'unavailable' | 'done'

export function setupState(
  status: Pick<IsolationStatusView, 'sandboxAccount' | 'setupAvailable'> & { isolated?: { available: boolean } | null },
): SetupState {
  // An account that is there while the isolated profile did not pass its check: the setup repairs what it made.
  if (status.sandboxAccount) return status.isolated?.available === false && status.setupAvailable ? 'repair' : 'done'
  return status.setupAvailable ? 'offer' : 'unavailable'
}

export const SETUP_REPAIR_LINE =
  'The sandbox account is set up, but the isolated profile did not pass its check at this start (the reason is above). Running the setup again repairs what it made; it asks for your confirmation and then for administrator rights.'

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

/** How a source was read. A page that needs script is rendered in NEXUS's own throwaway browser, never in yours. */
export const BACKEND_LABEL: Record<ResearchBackend, string> = {
  PROVIDER_NATIVE_SEARCH: 'Found by the provider search',
  PROVIDER_NATIVE_FETCH: 'Read by the provider',
  NEXUS_HTTP_FETCH: 'Read as a plain page',
  NEXUS_HTML_SEARCH: 'Found by the NEXUS search',
  NEXUS_RESEARCH_BROWSER: 'Rendered in the research browser',
}

export const RESEARCH_BROWSER_LINE =
  'A page that shows nothing without script is rendered in a separate, throwaway browser that NEXUS starts for that page: no profile of yours, no sign-in, read-only requests to the public web.'

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
