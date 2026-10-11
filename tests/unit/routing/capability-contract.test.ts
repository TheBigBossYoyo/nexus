import { describe, expect, it } from 'vitest'
import { AGENT_ROLES } from '@shared/domain'
import { NO_CAPABILITIES, READ_ONLY_ROLES, capabilitiesAdmit } from '@shared/provider'
import { CLAUDE_CAPABILITIES, CODEX_CAPABILITIES } from '@main/modules/providers'

/**
 * Finding 13.3. What the real adapters declare, held against what admission asks. The defect this guards
 * against happened once: an adapter's flags and the admission rule were each right alone and wrong together, and
 * every test used a stand-in for one side.
 */
describe('the real provider adapters against the admission rule', () => {
  it('Claude is admitted in every role: the NEXUS policy authorizes each of its tool calls', () => {
    expect(CLAUDE_CAPABILITIES.toolAuthorization).toBe(true)
    for (const role of AGENT_ROLES) expect(capabilitiesAdmit(CLAUDE_CAPABILITIES, role), role).toBe(true)
  })

  it('Codex is admitted in the read-only roles only: its own sandbox confines it, and it may not write', () => {
    expect(CODEX_CAPABILITIES.toolAuthorization).toBe(false)
    expect(CODEX_CAPABILITIES.confinement).toBe('provider_sandbox')
    expect(CODEX_CAPABILITIES.writes).toBe(false)
    for (const role of AGENT_ROLES) expect(capabilitiesAdmit(CODEX_CAPABILITIES, role), role).toBe(READ_ONLY_ROLES.includes(role))
    // It is admitted somewhere: a rule that refused it everywhere was the defect.
    expect(AGENT_ROLES.some((role) => capabilitiesAdmit(CODEX_CAPABILITIES, role))).toBe(true)
  })

  it('a provider that declares nothing, or no confinement, is admitted nowhere', () => {
    for (const role of AGENT_ROLES) {
      expect(capabilitiesAdmit(NO_CAPABILITIES, role), role).toBe(false)
      expect(capabilitiesAdmit({ ...CLAUDE_CAPABILITIES, toolAuthorization: false, confinement: 'none' }, role), role).toBe(false)
    }
  })
})
