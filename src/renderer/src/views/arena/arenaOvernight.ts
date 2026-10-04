import type { Preset } from '@shared/domain'
import type { IpcInput } from '@shared/ipc'
import { OVERNIGHT_CONFIRMATION_TEXT, type OvernightStatus } from '@shared/overnight'
import type {
  ArenaBudgetPreset,
  ConcreteStrategy,
  TrialState,
  UsageOverview,
  UsageStatus,
} from '@shared/v3'
import { clockText, exactResetAt } from '../../lib/usageModel'
import {
  buildPolicy,
  validateOvernight,
  type OvernightForm,
  type OvernightValidation,
} from '../projects/overnight'

/** The campaign fields of the Arena dialog, as the overnight form needs them. */
export interface ArenaCampaignDraft {
  name: string
  caseIds: readonly string[]
  strategies: readonly ConcreteStrategy[]
  repetitions: number
  modelPreset: Preset
  budgetPreset: ArenaBudgetPreset
}

/** Another overnight workload owns the power state and the failsafe; only one may run at a time. */
export const OVERNIGHT_BUSY_TEXT =
  'Another overnight workload is already running. Wait for it to finish or cancel it before starting an overnight campaign.'

export function overnightBusy(active: readonly OvernightStatus[] | undefined): string | null {
  return active && active.length > 0 ? OVERNIGHT_BUSY_TEXT : null
}

/**
 * Policy validation without the mission fields (agents, repairs, prompt): the duration, the failsafe, the
 * delay and the authorization box. `canStart` is true only when the box is ticked and the policy is valid.
 */
export function validateArenaOvernight(form: OvernightForm): OvernightValidation {
  const v = validateOvernight(form, 'campaign')
  const errors = { ...v.errors }
  delete errors.prompt
  return { errors, policyValid: v.policyValid, canStart: v.policyValid && form.authorized }
}

/** The one-line explanation next to the start button. */
export function arenaOvernightReadiness(
  validation: OvernightValidation,
  campaignError: string | null,
  busy: string | null,
): string {
  if (busy) return busy
  if (campaignError) return campaignError
  if (!validation.policyValid) return Object.values(validation.errors)[0] ?? 'Check the policy.'
  if (!validation.canStart)
    return validation.errors.authorization ?? 'Tick the authorization to start.'
  return 'Ready. NEXUS will also ask Windows for a confirmation.'
}

export function buildArenaOvernightInput(
  form: OvernightForm,
  campaign: ArenaCampaignDraft,
): IpcInput<'overnight.startArena'> {
  return {
    campaign: {
      name: campaign.name.trim(),
      caseIds: [...campaign.caseIds],
      strategies: [...campaign.strategies],
      repetitions: campaign.repetitions,
      modelPreset: campaign.modelPreset,
      budgetPreset: campaign.budgetPreset,
    },
    policy: buildPolicy(form),
    confirmed: true,
    confirmation: OVERNIGHT_CONFIRMATION_TEXT,
  }
}

/** Trials that hold a worker right now (provisioning, running or being evaluated). */
export function activeTrialCount(counts: Partial<Record<TrialState, number>>): number {
  return (counts.provisioning ?? 0) + (counts.running ?? 0) + (counts.evaluating ?? 0)
}

export function trialProgressText(finished: number, total: number): string {
  return `${finished} of ${total} trial${total === 1 ? '' : 's'} finished`
}

const USAGE_BLOCKED: readonly UsageStatus[] = ['QUOTA_PAUSED', 'WAITING_FOR_RESET', 'PROBING']

/**
 * When the Claude usage limit resets, as the usage service reported it. Null while the limit is not
 * blocking; 'Not reported' when it is blocking and the runtime gave no time. Never a guess.
 */
export function usageResetText(
  overview: UsageOverview | null | undefined,
  now: number,
): string | null {
  if (!overview || !USAGE_BLOCKED.includes(overview.status)) return null
  const at = exactResetAt(overview)
  return at ? clockText(at, now) : 'Not reported'
}
