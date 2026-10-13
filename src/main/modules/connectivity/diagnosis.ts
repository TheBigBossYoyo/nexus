import type { ConnectivityEvidence, ConnectivityState, NetworkOutage, ProbeResult } from '@shared/connectivity'
import { reasonCodeName } from './wlan-reasons'

const probeText = (p: ProbeResult): string => `${p.target} ${p.ok ? 'answered' : `did not answer (${p.code ?? 'no code'})`}`
const quote = (s: string): string => JSON.stringify(s)

/** What the probes showed in one state, in the words of the facts. It names no cause outside the machine's own observations. */
function observed(state: ConnectivityState, e: ConnectivityEvidence): string {
  const failedProviders = Object.entries(e.providers).filter(([, p]) => !p.ok)
  switch (state) {
    case 'ONLINE':
      return 'Everything probed answered.'
    case 'WLAN_DISCONNECTED':
      return `No Wi-Fi interface was associated (${e.wlanInterfaces === 0 ? 'the machine reported no Wi-Fi interface' : `interface state: ${e.wlanState ?? 'unknown'}`}), no wired link with an address was seen, and no probe answered.`
    case 'WLAN_ASSOCIATED_NO_INTERNET':
      return `A link was up${e.profileName !== null ? ` (saved profile ${quote(e.profileName)})` : ''}, but name lookup failed${e.dns?.code ? ` (${e.dns.code})` : ''} and no probed address answered.`
    case 'DNS_FAILURE':
      return `Name lookup failed${e.dns?.code ? ` (${e.dns.code})` : ''} while a connection by address succeeded.`
    case 'INTERNET_UNREACHABLE':
      return `Names resolved, but no connection to the probed endpoints succeeded (${e.endpoints.map(probeText).join('; ') || 'none probed'}).`
    case 'PROVIDER_UNREACHABLE':
      return `The Internet endpoints answered, but the provider ${failedProviders.map(([, p]) => probeText(p)).join('; ')}.`
    case 'PROVIDER_QUOTA_WAIT':
      return `The provider answered; the usage service reported this account as limited${e.quota?.resetAt != null ? ` until ${new Date(e.quota.resetAt).toISOString()}` : ''}.`
    case 'RESEARCH_ONLY_UNAVAILABLE':
      return `The provider answered, but the general Internet endpoints did not (${e.endpoints.map(probeText).join('; ') || 'none probed'}).`
  }
}

/**
 * The text of an outage record, made only from the facts in it: the times, the states passed through, what the
 * probes showed, the reason codes Windows gave, the reconnect attempts. Where the facts end it says so. It never
 * names a router, a provider of Internet service or any other cause the machine had no evidence about.
 */
export function diagnoseOutage(outage: NetworkOutage): string {
  const parts: string[] = []
  const began = new Date(outage.startedAt).toISOString()
  parts.push(outage.endedAt === null ? `The network was first seen down at ${began} and was still down at the last check.` : `The network was seen down from ${began} to ${new Date(outage.endedAt).toISOString()} (${Math.max(0, Math.round((outage.endedAt - outage.startedAt) / 1000))} s).`)
  const states = [...new Set(outage.states.map((s) => s.state))]
  parts.push(`States seen: ${states.join(', ')}.`)
  const first = outage.states[0]?.state
  if (first !== undefined) parts.push(`At the start: ${observed(first, outage.evidenceAtStart)}`)
  if (outage.reasonCodes.length > 0) parts.push(`Windows reported WLAN reason code ${outage.reasonCodes.map((c) => `${reasonCodeName(c)} (${c})`).join(', ')}.`)
  if (outage.attempts.length > 0) {
    const text = outage.attempts.map((a) => `${a.profileName !== null ? quote(a.profileName) : 'no profile'}: ${a.outcome}`).join('; ')
    parts.push(`Reconnect attempts by NEXUS: ${outage.attempts.length} (${text}).`)
  } else parts.push('NEXUS made no reconnect attempt.')
  parts.push('The cause beyond these observations was not determined.')
  return parts.join(' ')
}
