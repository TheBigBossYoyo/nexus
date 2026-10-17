import type { ProgressSnapshot } from '@shared/progress'
import type { RefusedTopic } from '@shared/director-line'
import { fold } from './intent'

/**
 * Reply text, composed from templates over facts the runtime gives (ProgressSnapshot and a few flags). No model is
 * asked for a number, a percentage or a time. Everything that came from a project or a model is passed through
 * `inert` so it reaches the phone as plain text only.
 */

export interface NamedSnapshot {
  name: string
  snapshot: ProgressSnapshot
}

export interface StatusFacts {
  snapshots: NamedSnapshot[]
  facts: { paused: boolean; online: boolean; pendingBoundaryRequests: number }
}

export interface LatestChecks {
  /** One line per check: 'unit: 4,773 passed' . Composed by the runtime from recorded results. */
  lines: string[]
  at: string | null
}

// eslint-disable-next-line no-control-regex
const BIDI_AND_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Plain text only: control and bidi characters out, one line, capped. Markup is not interpreted by any channel here (no parse mode). */
export function inert(text: string, max = 200): string {
  const one = text.replace(BIDI_AND_CONTROL, '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Like inert, but keeps line breaks (a report has lines). Still plain text: no markup is interpreted by any channel. */
export function inertBlock(text: string, max = 1500): string {
  const kept = text.replace(/\r\n?/g, '\n').replace(BIDI_AND_CONTROL, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return kept.length > max ? `${kept.slice(0, max - 1)}…` : kept
}

const confidenceWord = (c: string): string => c.toLowerCase()

function oneLine(n: NamedSnapshot): string {
  const s = n.snapshot
  const parts = [`${inert(n.name, 60)}: ${Math.round(s.percent)}%, ${inert(s.stage, 80)}.`, inert(s.summary, 220)]
  if (s.blocker) parts.push(`Blocked: ${inert(s.blocker, 160)}.`)
  if (s.scopeChange) parts.push(inert(s.scopeChange, 120))
  return parts.join(' ')
}

export function composeStatus(f: StatusFacts): string {
  if (f.snapshots.length === 0) return 'NEXUS is idle: no mission or program is running.'
  const lines = f.snapshots.slice(0, 5).map(oneLine)
  const extra = f.snapshots.length > 5 ? [`${f.snapshots.length - 5} more not shown.`] : []
  const flags: string[] = []
  if (f.facts.paused) flags.push('Paused after the current task.')
  if (!f.facts.online) flags.push('The PC has no Internet right now.')
  if (f.facts.pendingBoundaryRequests > 0) flags.push(`${f.facts.pendingBoundaryRequests} request(s) wait for your decision at the machine.`)
  return ['NEXUS status', ...lines, ...extra, ...flags].join('\n')
}

export function composeEta(f: StatusFacts): string {
  if (f.snapshots.length === 0) return 'Nothing is running, so there is no time remaining.'
  const lines = f.snapshots.slice(0, 5).map((n) => {
    const e = n.snapshot.eta
    if (n.snapshot.wait === 'FINISHED') return `${inert(n.name, 60)}: finished.`
    if (e.lowSeconds === null) return `${inert(n.name, 60)}: no estimate yet. ${inert(n.snapshot.summary, 200)}`
    // The snapshot's own sentence keeps active time apart from waiting; the confidence is added, not the other way round.
    return `${inert(n.name, 60)}: ${inert(n.snapshot.summary, 220)} (confidence ${confidenceWord(e.confidence)}${e.uncertainty ? `; ${inert(e.uncertainty, 120)}` : ''})`
  })
  return ['Time remaining', ...lines].join('\n')
}

export function composeBlockers(f: StatusFacts): string {
  const blocked = f.snapshots.filter((n) => n.snapshot.blocker || n.snapshot.wait.startsWith('WAITING'))
  const lines = blocked.slice(0, 5).map((n) => `${inert(n.name, 60)}: ${n.snapshot.blocker ? inert(n.snapshot.blocker, 200) : inert(n.snapshot.summary, 200)}`)
  const flags: string[] = []
  if (f.facts.pendingBoundaryRequests > 0) flags.push(`${f.facts.pendingBoundaryRequests} request(s) wait for your decision at the machine.`)
  if (lines.length === 0 && flags.length === 0) return 'Nothing is blocking.'
  return ['Blockers', ...lines, ...flags].join('\n')
}

export function composeDetails(f: StatusFacts, subject: string): string {
  const key = fold(subject)
  const hit = f.snapshots.find((n) => fold(n.name).includes(key)) ?? null
  if (!hit) return `No running mission or program matches "${inert(subject, 40)}".`
  const s = hit.snapshot
  const t = s.tasks
  const lines = [
    `${inert(hit.name, 60)}: ${Math.round(s.percent)}%, ${inert(s.stage, 80)}.`,
    `Tasks: ${t.completed} done, ${t.running} running, ${t.waiting} waiting, ${t.failed} failed, ${t.remaining} remaining.`,
    inert(s.summary, 220),
  ]
  if (s.blocker) lines.push(`Blocked: ${inert(s.blocker, 200)}.`)
  if (s.lastEvent) lines.push(`Last: ${inert(s.lastEvent.text, 140)}.`)
  return lines.join('\n')
}

export function composeChecks(c: LatestChecks | null): string {
  if (!c || c.lines.length === 0) return 'No test results are recorded yet.'
  return ['Latest checks', ...c.lines.slice(0, 8).map((l) => inert(l, 160))].join('\n')
}

export const HELP_TEXT = [
  'NEXUS can answer: status, how long is left, what is blocking, details <project>, latest test results.',
  'It can: pause after the current task, continue, call you ("call me", when the voice line is set up).',
  'Blocked work: "answer: <what to do>" or "fix the blockers" gives your words to the blocked tasks, which start again.',
  'Tasks: "add a task to the mission: <task>", "after this add <task>", "create a task for <project>: <task>" (normal checks apply).',
  '"Stop the mission <name>" stops it after you reply yes. You can also just write what you want in a sentence.',
  'Pushing, deleting, permissions, the sandbox, credentials, power and commands are decided at the machine.',
].join('\n')

export const UNKNOWN_TEXT = 'I did not understand. Send "help" for what I can do.'
export const UNPAIRED_TEXT = 'This NEXUS is not paired with this chat.'
export const PAIRED_TEXT = 'Paired. Send "help" for what you can ask.'

const REFUSED_LABEL: Record<RefusedTopic, string> = {
  PUSH_OR_PUBLISH: 'Pushing, publishing and deploying',
  DESTRUCTIVE: 'Deleting or wiping',
  SANDBOX_OR_AUTONOMY: 'Changing the sandbox, the autonomy profile or a protection',
  BOUNDARY_REQUEST: 'Allowing or approving a request',
  POWER: 'Shutting down or changing power',
  CREDENTIALS: 'Anything about credentials',
  RUN_COMMAND: 'Running a command',
}

export function composeRefused(topic: RefusedTopic): string {
  return `${REFUSED_LABEL[topic]} must be decided at the machine. Nothing was done.`
}

/** The optional summarizer may rephrase, but only what it was given; its output is capped and loses any URL it was not given. */
export function constrainSummary(output: string, givenFacts: string, max = 600): string {
  const given = new Set(givenFacts.match(/https?:\/\/\S+/gi) ?? [])
  const cleaned = output
    .replace(BIDI_AND_CONTROL, '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, (u) => (given.has(u) ? u : '[link removed]'))
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}
