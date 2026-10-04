import type { IpcInput } from '@shared/ipc'
import type { ProgramPreset } from '@shared/program'

/** The New program form: state, validation and the IPC input. Pure. */

export interface ProgramForm {
  projectId: string | null
  name: string
  goal: string
  /** One per line. */
  successCriteria: string
  /** One per line. */
  constraints: string
  preset: ProgramPreset
  windowEnabled: boolean
  /** Days the window starts on; 0 = Sunday. */
  days: number[]
  start: string
  end: string
}

export const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6]

export const defaultProgramForm = (projectId: string | null): ProgramForm => ({
  projectId,
  name: '',
  goal: '',
  successCriteria: '',
  constraints: '',
  preset: 'balanced',
  windowEnabled: false,
  days: [...ALL_DAYS],
  start: '22:00',
  end: '07:00',
})

export const LIMITS = { name: 120, goal: 8000, lines: 10, line: 400 } as const

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export const splitLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

export const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** A window whose end is not after its start runs past midnight and ends the next day. */
export const runsPastMidnight = (start: string, end: string): boolean => TIME.test(start) && TIME.test(end) && minutesOf(end) <= minutesOf(start)

/** "22:00 to 07:00, ending the next day" or "09:00 to 17:00, the same day". Null when either time is invalid. */
export function windowDescription(start: string, end: string): string | null {
  if (!TIME.test(start) || !TIME.test(end)) return null
  if (start === end) return null
  return runsPastMidnight(start, end) ? `${start} to ${end}: this window runs past midnight and ends the next day.` : `${start} to ${end}: this window ends the same day.`
}

export type FormField = 'project' | 'name' | 'goal' | 'successCriteria' | 'constraints' | 'days' | 'start' | 'end'

export interface FormCheck {
  errors: Partial<Record<FormField, string>>
  ok: boolean
  /** The first reason the form cannot be submitted, shown next to the disabled buttons. */
  reason: string | null
}

const ORDER: FormField[] = ['project', 'name', 'goal', 'successCriteria', 'constraints', 'days', 'start', 'end']

export function validateProgramForm(form: ProgramForm): FormCheck {
  const errors: FormCheck['errors'] = {}
  if (!form.projectId) errors.project = 'Open a project first.'
  const name = form.name.trim()
  if (!name) errors.name = 'Give the program a name.'
  else if (name.length > LIMITS.name) errors.name = `At most ${LIMITS.name} characters.`
  const goal = form.goal.trim()
  if (!goal) errors.goal = 'Describe the goal.'
  else if (goal.length > LIMITS.goal) errors.goal = `At most ${LIMITS.goal} characters.`
  for (const [field, text, noun] of [
    ['successCriteria', form.successCriteria, 'success criteria'],
    ['constraints', form.constraints, 'constraints'],
  ] as const) {
    const lines = splitLines(text)
    if (lines.length > LIMITS.lines) errors[field] = `At most ${LIMITS.lines} ${noun}, one per line.`
    else if (lines.some((l) => l.length > LIMITS.line)) errors[field] = `Each line may have at most ${LIMITS.line} characters.`
  }
  if (form.windowEnabled) {
    if (form.days.length === 0) errors.days = 'Choose at least one day.'
    if (!TIME.test(form.start)) errors.start = 'Use a 24-hour time such as 22:00.'
    if (!TIME.test(form.end)) errors.end = 'Use a 24-hour time such as 07:00.'
    if (!errors.start && !errors.end && form.start === form.end) errors.end = 'The window would last 24 hours. Choose a different end.'
  }
  const first = ORDER.find((f) => errors[f])
  return { errors, ok: !first, reason: first ? (errors[first] ?? null) : null }
}

export function buildCreateInput(form: ProgramForm, start: boolean): IpcInput<'program.create'> {
  const criteria = splitLines(form.successCriteria)
  const constraints = splitLines(form.constraints)
  return {
    projectId: form.projectId ?? '',
    name: form.name.trim(),
    goal: form.goal.trim(),
    ...(criteria.length ? { successCriteria: criteria } : {}),
    ...(constraints.length ? { constraints } : {}),
    preset: form.preset,
    schedule: form.windowEnabled ? { windows: [{ days: [...form.days].sort((a, b) => a - b), start: form.start, end: form.end }] } : null,
    start,
  }
}
