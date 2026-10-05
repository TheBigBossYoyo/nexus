import { describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_POLICY, NO_CAPABILITIES, type ProviderCapabilities, type ProviderPolicy, type ProviderSession, type ProviderStatus } from '@shared/provider'
import { agentProvider, capabilityRows, enableConsent, enableSwitch, safetyLine, providerHeadline, sessionOutcome, sessionProviderLabel, usageLine, useAvailability, withEnabled } from '../../../src/renderer/src/views/providers/providersModel'

const READ_ONLY: ProviderCapabilities = { sessions: true, resume: true, structuredOutput: 'prompted', toolAuthorization: false, nexusTools: false, mcp: false, usageReport: false, confinement: 'provider_sandbox', writes: false }
const status = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({ id: 'codex', displayName: 'Codex', required: false, installed: 'installed', version: '0.130.0', auth: 'authenticated', authDetail: 'Logged in using ChatGPT', supported: true, supportDetail: null, health: 'unknown', healthDetail: null, models: [], capabilities: READ_ONLY, checkedAt: 'now', ...over })
const session = (over: Partial<ProviderSession> = {}): ProviderSession => ({ id: 's', runId: 'r', agentId: 'a', role: 'reviewer', label: null, requested: 'codex', provider: 'codex', model: 'gpt-5.5', runtimeVersion: null, authMode: null, reason: '', fallbackReason: null, sessionId: null, outcome: 'completed', error: null, inputTokens: 0, outputTokens: 0, createdAt: 'now', endedAt: null, ...over })
const ON: ProviderPolicy = { ...DEFAULT_PROVIDER_POLICY, enabled: { claude: true, codex: true, gemini: false }, crossModelReview: { enabled: true, reviewer: 'codex' } }

describe('providers page model', () => {
  it('gives each provider one honest state', () => {
    expect(providerHeadline(status({ installed: 'not_installed', supported: false, supportDetail: 'Not on PATH.' }), false)).toMatchObject({ label: 'Not installed', detail: 'Not on PATH.' })
    expect(providerHeadline(status({ supported: false, capabilities: NO_CAPABILITIES, supportDetail: 'No adapter.' }), false).label).toBe('Detected, not supported')
    const auth = providerHeadline(status({ auth: 'auth_required' }), false)
    expect(auth.label).toBe('Authentication required')
    expect(auth.detail).toContain('never handles its credentials')
    expect(providerHeadline(status({ health: 'unavailable', healthDetail: '3 failed sessions' }), true)).toMatchObject({ tone: 'danger', label: 'Unavailable' })
    expect(providerHeadline(status({ health: 'degraded' }), true).label).toBe('Failing')
    expect(providerHeadline(status(), false).label).toBe('Available, not enabled')
    // Signed in is not "connected" until a session actually worked.
    expect(providerHeadline(status(), true).label).toBe('Signed in, not yet used')
    expect(providerHeadline(status({ health: 'healthy' }), true)).toMatchObject({ tone: 'success', label: 'Connected', detail: 'Logged in using ChatGPT' })
    expect(providerHeadline(status({ id: 'claude', required: true, health: 'healthy', authDetail: 'Claude subscription' }), true)).toMatchObject({ label: 'Connected', detail: 'Claude subscription' })
  })

  it('states what a read-only provider can and cannot do, and never invents a usage figure', () => {
    const rows = Object.fromEntries(capabilityRows(READ_ONLY).map((r) => [r.label, r.value]))
    expect(rows['May change files']).toContain('No')
    expect(rows['Confinement']).toContain('sandbox')
    expect(rows['Usage report']).toBe('Not exposed by this runtime')
    expect(usageLine({ provider: 'codex', observed: { sessions: 1, inputTokens: 1, outputTokens: 1 }, windows: [], windowsSource: 'not_exposed' })).toContain('no estimate')
    expect(
      usageLine({
        provider: 'claude',
        observed: { sessions: 0, inputTokens: 0, outputTokens: 0 },
        windows: [
          { limitType: 'five_hour', utilizationPercent: 67.2, resetsAt: null },
          { limitType: 'seven_day', utilizationPercent: null, resetsAt: null },
        ],
        windowsSource: 'runtime',
      }),
    ).toBe('five hour: 67% · seven day: not reported')
  })

  it('the enable switch explains why it is off, and switching a provider off switches off its uses', () => {
    expect(enableSwitch(status({ id: 'claude', required: true }), DEFAULT_PROVIDER_POLICY).shown).toBe(false)
    expect(enableSwitch(status(), DEFAULT_PROVIDER_POLICY)).toEqual({ shown: true, checked: false, disabledReason: null })
    expect(enableSwitch(status({ auth: 'auth_required' }), DEFAULT_PROVIDER_POLICY).disabledReason).toContain('not signed in')
    // A provider that is on can always be switched off, whatever its state.
    expect(enableSwitch(status({ auth: 'auth_required' }), ON).disabledReason).toBeNull()
    const off = withEnabled(ON, 'codex', false)
    expect(off.enabled.codex).toBe(false)
    expect(off.crossModelReview.enabled).toBe(false)
    expect(withEnabled(DEFAULT_PROVIDER_POLICY, 'codex', true).crossModelReview.enabled).toBe(false)
  })

  it('says what enabling a provider sends and what the provider may do', () => {
    const consent = enableConsent(status())
    expect(consent).toContain('code and diffs from your repositories are sent to Codex')
    expect(consent).toContain('never changes files')
    expect(enableConsent(status({ capabilities: { ...READ_ONLY, writes: true } }))).toContain('may change files')
    expect(safetyLine(status())).toContain('Read-only')
    expect(safetyLine(status())).toContain('not by the NEXUS permission policy')
    expect(safetyLine(status({ capabilities: NO_CAPABILITIES }))).toContain('cannot run sessions')
    expect(safetyLine(status({ id: 'claude', required: true, capabilities: { ...READ_ONLY, writes: true } }))).toContain('NEXUS permission policy')
  })

  it('a use is offered only when it can work', () => {
    expect(useAvailability('review', 'codex', DEFAULT_PROVIDER_POLICY, [status()])).toMatchObject({ available: false, reason: 'Enable Codex first.' })
    expect(useAvailability('review', 'codex', ON, [status()]).available).toBe(true)
    expect(useAvailability('speculation', 'codex', ON, [status()]).reason).toContain('read-only')
    expect(useAvailability('speculation', 'codex', ON, [status({ capabilities: { ...READ_ONLY, writes: true } })]).available).toBe(true)
    expect(useAvailability('review', 'claude', ON, []).available).toBe(false)
  })

  it('labels sessions: who ran it, who was asked, how it ended', () => {
    expect(sessionProviderLabel(session())).toBe('Codex · gpt-5.5')
    expect(sessionProviderLabel(session({ provider: 'claude', model: null }))).toBe('Claude (instead of Codex)')
    expect(sessionOutcome(session({ outcome: 'refused' })).label).toBe('Refused by policy')
    expect(sessionOutcome(session({ outcome: 'running' })).tone).toBe('active')
    const sessions = [session({ agentId: 'x' }), session({ agentId: 'a', provider: 'claude', fallbackReason: 'Codex is unavailable; Claude does this instead.' })]
    expect(agentProvider(sessions, 'a')).toEqual({ label: 'Claude · gpt-5.5 (instead of Codex)', fallbackReason: 'Codex is unavailable; Claude does this instead.' })
    expect(agentProvider([], 'a')).toBeNull()
  })
})
