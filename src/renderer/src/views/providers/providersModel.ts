import {
  enableBlocker,
  PROVIDER_NAMES,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderPolicy,
  type ProviderSession,
  type ProviderStatus,
  type ProviderUsage,
} from '@shared/provider'
import type { Tone } from '../../lib/status'

/** DOM-free model of the Providers page: every sentence the page shows is decided here and tested. */

export interface ProviderHeadline {
  tone: Tone
  label: string
  detail: string | null
}

/** One state per provider, in the order a user needs to act on it. */
export function providerHeadline(status: ProviderStatus, enabled: boolean): ProviderHeadline {
  if (status.installed === 'not_installed')
    return { tone: 'neutral', label: 'Not installed', detail: status.supportDetail }
  if (!status.supported || !status.capabilities.sessions)
    return { tone: 'neutral', label: 'Detected, not supported', detail: status.supportDetail }
  if (status.auth === 'auth_required')
    return {
      tone: 'warning',
      label: 'Authentication required',
      detail: `Sign in with the ${status.displayName} command line tool. NEXUS never handles its credentials.`,
    }
  if (status.health === 'unavailable')
    return { tone: 'danger', label: 'Unavailable', detail: status.healthDetail }
  if (status.health === 'degraded')
    return { tone: 'warning', label: 'Failing', detail: status.healthDetail }
  if (!status.required && !enabled)
    return {
      tone: 'neutral',
      label: 'Available, not enabled',
      detail: 'NEXUS sends nothing to this provider until you enable it.',
    }
  if (status.health === 'healthy')
    return { tone: 'success', label: 'Connected', detail: status.authDetail }
  return {
    tone: 'active',
    label: status.auth === 'authenticated' ? 'Signed in, not yet used' : 'Detected',
    detail:
      status.auth === 'authenticated'
        ? 'Detection sends no prompt. Use "Test" to run one minimal session.'
        : status.healthDetail,
  }
}

export const CONFINEMENT_LABEL: Record<ProviderCapabilities['confinement'], string> = {
  nexus_policy: 'NEXUS permission policy on every tool call',
  provider_sandbox:
    "The provider's own read-only sandbox; NEXUS checks afterwards that nothing changed",
  none: 'Not applicable',
}

export function capabilityRows(c: ProviderCapabilities): { label: string; value: string }[] {
  const yes = (b: boolean): string => (b ? 'Yes' : 'No')
  return [
    { label: 'Runs sessions', value: yes(c.sessions) },
    {
      label: 'May change files',
      value: c.writes ? 'Yes' : c.sessions ? 'No: review, research and critique only' : 'No',
    },
    { label: 'Confinement', value: CONFINEMENT_LABEL[c.confinement] },
    {
      label: 'Structured output',
      value:
        c.structuredOutput === 'native'
          ? 'Enforced by the runtime'
          : c.structuredOutput === 'prompted'
            ? 'Asked for in the prompt and parsed'
            : 'No',
    },
    { label: 'NEXUS agent tools', value: yes(c.nexusTools) },
    { label: 'Resume a session', value: yes(c.resume) },
    {
      label: 'Usage report',
      value: c.usageReport ? 'Plan windows without a prompt' : 'Not exposed by this runtime',
    },
  ]
}

/** What switching a provider on means, in the words shown under the switch: what is sent, and what it may do. */
export function enableConsent(
  status: Pick<ProviderStatus, 'displayName' | 'capabilities'>,
): string {
  const name = status.displayName
  const does = status.capabilities.writes
    ? `${name} may change files in the worktrees NEXUS gives it.`
    : `${name} never changes files: it reviews, researches and criticises.`
  return `Off: nothing is ever sent to ${name}. On: for the uses enabled under Routing, prompts with code and diffs from your repositories are sent to ${name}, under your ${name} sign-in and quota. ${does}`
}

/** The one safety fact of a provider, shown under its state. */
export function safetyLine(
  status: Pick<ProviderStatus, 'displayName' | 'required' | 'capabilities'>,
): string {
  if (!status.capabilities.sessions) return 'NEXUS cannot run sessions with this provider.'
  if (status.capabilities.writes)
    return status.required
      ? 'Plans, writes and verifies under the NEXUS permission policy.'
      : 'May change files, in worktrees only.'
  return 'Read-only: reviews and research, never edits files. Its tool calls are confined by its own sandbox, not by the NEXUS permission policy.'
}

/** Why the enable switch is disabled, or null. Claude is always on and has no switch. */
export function enableSwitch(
  status: ProviderStatus,
  policy: ProviderPolicy,
): { shown: boolean; checked: boolean; disabledReason: string | null } {
  if (status.required) return { shown: false, checked: true, disabledReason: null }
  const checked = policy.enabled[status.id]
  // A provider that is already on can always be switched off.
  return { shown: true, checked, disabledReason: checked ? null : enableBlocker(status) }
}

/** The policy after a switch is flipped. Switching a provider off also switches off the uses that need it. */
export function withEnabled(
  policy: ProviderPolicy,
  id: Exclude<ProviderId, 'claude'>,
  on: boolean,
): ProviderPolicy {
  const next: ProviderPolicy = { ...policy, enabled: { ...policy.enabled, [id]: on } }
  if (on) return next
  return {
    ...next,
    crossModelReview:
      policy.crossModelReview.reviewer === id
        ? { ...policy.crossModelReview, enabled: false }
        : policy.crossModelReview,
    heterogeneousSpeculation:
      policy.heterogeneousSpeculation.secondCandidate === id
        ? { ...policy.heterogeneousSpeculation, enabled: false }
        : policy.heterogeneousSpeculation,
  }
}

export interface UseOption {
  available: boolean
  reason: string | null
}

/** Whether a use can be switched on for a provider, and why not. */
export function useAvailability(
  kind: 'review' | 'speculation',
  id: ProviderId,
  policy: ProviderPolicy,
  statuses: readonly ProviderStatus[],
): UseOption {
  const status = statuses.find((s) => s.id === id)
  const name = PROVIDER_NAMES[id]
  if (id === 'claude')
    return { available: false, reason: 'This use needs a provider other than Claude.' }
  if (!policy.enabled[id]) return { available: false, reason: `Enable ${name} first.` }
  if (kind === 'speculation' && !status?.capabilities.writes)
    return {
      available: false,
      reason: `${name} is read-only in NEXUS and cannot write a candidate.`,
    }
  return { available: true, reason: null }
}

export function usageLine(usage: ProviderUsage): string {
  if (usage.windowsSource === 'not_exposed')
    return 'Plan usage: not exposed by this runtime. NEXUS shows no estimate.'
  if (usage.windows.length === 0) return 'Plan usage: the runtime reported no window.'
  return usage.windows
    .map(
      (w) =>
        `${w.limitType.replace(/_/g, ' ')}: ${w.utilizationPercent === null ? 'not reported' : `${Math.round(w.utilizationPercent)}%`}`,
    )
    .join(' · ')
}

export function sessionOutcome(session: ProviderSession): { tone: Tone; label: string } {
  switch (session.outcome) {
    case 'completed':
      return { tone: 'success', label: 'Completed' }
    case 'failed':
      return { tone: 'danger', label: 'Failed' }
    case 'refused':
      return { tone: 'warning', label: 'Refused by policy' }
    default:
      return { tone: 'active', label: 'Running' }
  }
}

/** "Codex · gpt-5.5", and for a fallback who was asked first. */
export function sessionProviderLabel(
  session: Pick<ProviderSession, 'provider' | 'requested' | 'model'>,
): string {
  const ran = `${PROVIDER_NAMES[session.provider]}${session.model ? ` · ${session.model}` : ''}`
  return session.requested !== session.provider
    ? `${ran} (instead of ${PROVIDER_NAMES[session.requested]})`
    : ran
}

/** The provider line of one agent in the mission inspector: its latest session. */
export function agentProvider(
  sessions: readonly ProviderSession[],
  agentId: string,
): { label: string; fallbackReason: string | null } | null {
  const latest = sessions.filter((s) => s.agentId === agentId).at(-1)
  return latest
    ? { label: sessionProviderLabel(latest), fallbackReason: latest.fallbackReason }
    : null
}
