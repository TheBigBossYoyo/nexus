import type { Preset } from '@shared/domain'
import type { IpcInput } from '@shared/ipc'
import {
  DEFAULT_OVERNIGHT_POLICY,
  OVERNIGHT_CONFIRMATION_TEXT,
  OvernightPolicySchema,
  type EndAction,
  type EndConditions,
  type OvernightPolicy,
} from '@shared/overnight'

/** Overnight is a composer mode only; it starts an ordinary `mission` run through overnight.start. */
export const OVERNIGHT_MODE = 'overnight' as const

export const OVERNIGHT_MODE_INFO =
  'Unattended mission with a time limit, automatic quota waiting and an end-of-run power action you authorize in advance. Tool approvals are always denied while nobody is there.'

export type OvernightPlanning = 'auto' | 'single' | 'consensus'

export const END_ACTION_LABEL: Record<EndAction, string> = {
  NONE: 'None',
  SHUTDOWN: 'Shut down PC',
  SLEEP: 'Sleep',
  HIBERNATE: 'Hibernate',
}

/** Upper-case label used by the run banner. */
export const END_ACTION_BANNER: Record<EndAction, string> = {
  NONE: 'NONE',
  SHUTDOWN: 'SHUT DOWN PC',
  SLEEP: 'SLEEP',
  HIBERNATE: 'HIBERNATE',
}

export const CONDITION_LABEL: Record<keyof EndConditions, string> = {
  success: 'Success',
  failure: 'Failure',
  blocker: 'Blocker',
  quotaExhausted: 'Quota exhausted',
  timeout: 'Timeout',
  cancellation: 'Cancellation',
}

export const CONDITION_TESTID: Record<keyof EndConditions, string> = {
  success: 'overnight-on-success',
  failure: 'overnight-on-failure',
  blocker: 'overnight-on-blocker',
  quotaExhausted: 'overnight-on-quota',
  timeout: 'overnight-on-timeout',
  cancellation: 'overnight-on-cancellation',
}

export const CONDITION_KEYS = Object.keys(CONDITION_LABEL) as (keyof EndConditions)[]

export const NORMAL_SHUTDOWN_NOTE =
  'Normal shutdown at the end of the run: an application with unsaved data may prevent it. This setting does not apply to the failsafe.'
export const FORCED_SHUTDOWN_NOTE =
  'Forced shutdown: Windows closes applications without waiting. Unsaved work in other applications may be lost.'
export const FAILSAFE_TIMER_NOTE =
  'If the failsafe fires, Windows closes applications without waiting, whatever is chosen above: unsaved work in other applications may be lost.'
export const TOOL_APPROVALS_NOTE =
  'Tool approvals (for example sensitive shell commands) are always denied while the run is unattended.'

/** The failsafe stays this far behind the mission deadline unless the user edits it. */
export const FAILSAFE_MARGIN_MINUTES = 60

export interface OvernightForm {
  maxDurationMinutes: number
  /** Null follows the execution preset. */
  maxAgents: number | null
  preset: Preset
  planning: OvernightPlanning
  /** What 'auto' resolves to (from planning.recommend); 'single' when there is no recommendation. */
  recommendedPlanning: 'single' | 'consensus' | null
  maxRepairs: number
  autoApprovePlanChanges: boolean
  endAction: EndAction
  shutdownOn: EndConditions
  failsafeEnabled: boolean
  /** Null while the user has not edited it: follows duration + 60 minutes. */
  failsafeAfterMinutes: number | null
  finalDelaySeconds: number
  forceCloseApplications: boolean
  quotaPolicy: OvernightPolicy['quotaPolicy']
  saveFinalReport: boolean
  commitCompletedWork: boolean
  /** The authorization box. */
  authorized: boolean
}

export function defaultFailsafeMinutes(maxDurationMinutes: number): number {
  return maxDurationMinutes + FAILSAFE_MARGIN_MINUTES
}

export function effectiveFailsafeMinutes(
  form: Pick<OvernightForm, 'failsafeAfterMinutes' | 'maxDurationMinutes'>,
): number {
  return form.failsafeAfterMinutes ?? defaultFailsafeMinutes(form.maxDurationMinutes)
}

export function defaultOvernightForm(): OvernightForm {
  const d = DEFAULT_OVERNIGHT_POLICY
  return {
    maxDurationMinutes: d.maxDurationMinutes,
    maxAgents: null,
    preset: 'balanced',
    planning: 'auto',
    recommendedPlanning: null,
    maxRepairs: 3,
    autoApprovePlanChanges: d.autoApprovePlanChanges,
    endAction: d.endAction,
    shutdownOn: { ...d.shutdownOn },
    failsafeEnabled: d.failsafeEnabled,
    failsafeAfterMinutes: null,
    finalDelaySeconds: d.finalDelaySeconds,
    // Never on by default.
    forceCloseApplications: false,
    quotaPolicy: d.quotaPolicy,
    saveFinalReport: d.saveFinalReport,
    commitCompletedWork: d.commitCompletedWork,
    authorized: false,
  }
}

export function resolvePlanning(
  form: Pick<OvernightForm, 'planning' | 'recommendedPlanning'>,
): 'single' | 'consensus' {
  if (form.planning === 'auto') return form.recommendedPlanning ?? 'single'
  return form.planning
}

export function buildPolicy(form: OvernightForm): OvernightPolicy {
  return {
    ...DEFAULT_OVERNIGHT_POLICY,
    maxDurationMinutes: form.maxDurationMinutes,
    endAction: form.endAction,
    shutdownOn: { ...form.shutdownOn },
    finalDelaySeconds: form.finalDelaySeconds,
    forceCloseApplications: form.forceCloseApplications,
    failsafeEnabled: form.failsafeEnabled,
    failsafeAfterMinutes: effectiveFailsafeMinutes(form),
    saveFinalReport: form.saveFinalReport,
    commitCompletedWork: form.commitCompletedWork,
    quotaPolicy: form.quotaPolicy,
    autoApprovePlanChanges: form.autoApprovePlanChanges,
  }
}

export type OvernightField =
  'duration' | 'maxAgents' | 'maxRepairs' | 'failsafe' | 'finalDelay' | 'authorization' | 'prompt'

export interface OvernightValidation {
  errors: Partial<Record<OvernightField, string>>
  /** Every policy and run field is acceptable (ignores the authorization box and the prompt). */
  policyValid: boolean
  /** Ready to open the confirmation dialog. */
  canStart: boolean
}

function whole(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max
}

export function validateOvernight(form: OvernightForm, prompt = ''): OvernightValidation {
  const errors: OvernightValidation['errors'] = {}
  if (!whole(form.maxDurationMinutes, 1, 24 * 60))
    errors.duration = 'Max duration must be between 1 minute and 24 hours.'
  if (form.maxAgents !== null && !whole(form.maxAgents, 1, 16))
    errors.maxAgents = 'Max agents must be a whole number from 1 to 16.'
  if (!whole(form.maxRepairs, 1, 50))
    errors.maxRepairs = 'Max repairs must be a whole number from 1 to 50.'
  if (!whole(form.finalDelaySeconds, 10, 3600))
    errors.finalDelay = 'Delay must be between 10 and 3600 seconds.'
  const failsafe = effectiveFailsafeMinutes(form)
  if (form.failsafeEnabled) {
    if (!whole(failsafe, 2, 48 * 60))
      errors.failsafe = 'The failsafe must be between 2 minutes and 48 hours.'
    else if (!errors.duration && failsafe <= form.maxDurationMinutes) {
      errors.failsafe = `The failsafe must be greater than the max duration (${form.maxDurationMinutes} min).`
    }
  }
  if (
    !errors.duration &&
    !errors.finalDelay &&
    !errors.failsafe &&
    !OvernightPolicySchema.safeParse(buildPolicy(form)).success
  ) {
    errors.duration = 'The policy is not valid.'
  }
  const policyValid = Object.keys(errors).length === 0
  if (!form.authorized) errors.authorization = 'Tick the authorization to start.'
  if (prompt.trim().length === 0) errors.prompt = 'Describe the mission first.'
  else if (prompt.length > 20_000)
    errors.prompt = 'The prompt is too long (limit 20,000 characters).'
  return { errors, policyValid, canStart: policyValid && form.authorized && !errors.prompt }
}

/** Splits minutes into the hours/minutes inputs and back. */
export function splitMinutes(total: number): { hours: number; minutes: number } {
  const t = Math.max(0, Math.floor(total))
  return { hours: Math.floor(t / 60), minutes: t % 60 }
}
export const joinMinutes = (hours: number, minutes: number): number =>
  Math.round(hours) * 60 + Math.round(minutes)

export function formatMinutes(total: number): string {
  const { hours, minutes } = splitMinutes(total)
  if (hours === 0) return `${minutes} min`
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM in local time, with a day hint when it is not today. */
export function formatWallClock(at: number | string, now: number = Date.now()): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '—'
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = new Date(now)
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  )
  if (dayDiff === 0) return clock
  if (dayDiff === 1) return `${clock} tomorrow`
  if (dayDiff === -1) return `${clock} yesterday`
  return `${clock} (${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())})`
}

const VERB: Record<Exclude<EndAction, 'NONE'>, { present: string; authorized: string }> = {
  SHUTDOWN: { present: 'shut down', authorized: 'shut down Windows' },
  SLEEP: { present: 'put to sleep', authorized: 'put Windows to sleep' },
  HIBERNATE: { present: 'hibernate', authorized: 'hibernate Windows' },
}

/** The closing sentence of the confirmation. */
export function authorizationSentence(endAction: EndAction): string {
  if (endAction === 'NONE') return 'This run takes no power action; the PC is left running.'
  return `This run is authorized to ${VERB[endAction].authorized} automatically.`
}

/**
 * What ticking the authorization allows, in the words of the chosen end action. Shown under the checkbox so
 * the fixed authorization sentence is never the only description of what is being agreed to.
 */
export function authorizationScope(form: Pick<OvernightForm, 'endAction' | 'finalDelaySeconds'>, noun: 'run' | 'campaign' = 'run'): string {
  if (form.endAction === 'NONE') return `With the end action "None", NEXUS takes no power action; the ${noun} runs unattended and the PC is left running.`
  const what = { SHUTDOWN: 'shut down this PC', SLEEP: 'put this PC to sleep', HIBERNATE: 'hibernate this PC' }[form.endAction]
  return `This allows NEXUS to ${what} ${form.finalDelaySeconds} s after the ${noun} ends, in the cases ticked above. You can cancel it while NEXUS counts down.`
}

/** What the form says before and after the box is ticked: it never claims an authorization that was not given. */
export function authorizationStatus(endAction: EndAction, authorized: boolean): string {
  if (authorized) return authorizationSentence(endAction)
  if (endAction === 'NONE') return 'Not authorized yet. This run takes no power action.'
  return `Not authorized yet: NEXUS will not ${VERB[endAction].authorized} unless you tick the box.`
}

function outcomeLine(label: string, form: OvernightForm, on: boolean): string {
  if (form.endAction === 'NONE') return `${label}: no power action`
  return `${label}: ${on ? END_ACTION_LABEL[form.endAction].toLowerCase() + ` after ${form.finalDelaySeconds} s` : 'leave the PC running'}`
}

/** Lines shown in the run-specific confirmation. Pure so the wording is tested. */
export function summarizeOvernight(form: OvernightForm, now: number = Date.now()): string[] {
  const lines: string[] = []
  lines.push(
    `Max duration: ${formatMinutes(form.maxDurationMinutes)} (until ${formatWallClock(now + form.maxDurationMinutes * 60_000, now)})`,
  )
  lines.push(`Max agents: ${form.maxAgents ?? 'from the preset'}`)
  lines.push(outcomeLine('On success', form, form.shutdownOn.success))
  lines.push(outcomeLine('On failure', form, form.shutdownOn.failure))
  lines.push(outcomeLine('On blocker', form, form.shutdownOn.blocker))
  lines.push(
    form.quotaPolicy === 'WAIT_AND_RETRY'
      ? `On quota exhausted: wait for the limit to reset and retry; if it cannot be waited out, ${outcomeLine('', form, form.shutdownOn.quotaExhausted).slice(2)}`
      : outcomeLine('On quota exhausted', form, form.shutdownOn.quotaExhausted),
  )
  lines.push(outcomeLine('On timeout', form, form.shutdownOn.timeout))
  lines.push(outcomeLine('On cancellation', form, form.shutdownOn.cancellation))
  if (form.endAction === 'NONE') {
    // Main arms no timer at all when no power action is wanted.
    lines.push('Failsafe shutdown: not armed (no power action)')
  } else if (form.failsafeEnabled) {
    const minutes = effectiveFailsafeMinutes(form)
    lines.push(
      `Failsafe shutdown: ${formatWallClock(now + minutes * 60_000, now)} (in ${formatMinutes(minutes)}), always closing applications without waiting`,
    )
  } else {
    lines.push('Failsafe shutdown: off')
  }
  lines.push(`Force close applications: ${form.forceCloseApplications ? 'yes' : 'no'}`)
  lines.push(authorizationSentence(form.endAction))
  return lines
}

export function buildOvernightStartInput(
  form: OvernightForm,
  projectId: string,
  prompt: string,
): IpcInput<'overnight.start'> {
  const input: IpcInput<'overnight.start'> = {
    projectId,
    preset: form.preset,
    prompt: prompt.trim(),
    policy: buildPolicy(form),
    confirmed: true,
    confirmation: OVERNIGHT_CONFIRMATION_TEXT,
    planningMode: resolvePlanning(form),
    maxIterations: form.maxRepairs,
  }
  if (form.maxAgents !== null) input.maxParallelAgents = form.maxAgents
  return input
}
