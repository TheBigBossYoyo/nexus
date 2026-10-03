import { describe, expect, it } from 'vitest'
import { AGENT_ROLES } from '@shared/domain'
import type { AgentPurpose } from '@shared/domain'
import { rolePrompt } from '@main/modules/context/prompts'

const PURPOSES: AgentPurpose[] = [
  'plan',
  'implement',
  'diagnose',
  'review',
  'verify',
  'research',
  'audit',
  'synthesis',
  'ask',
]

describe('rolePrompt', () => {
  it('embeds the shared engineering principles in every role', () => {
    for (const role of AGENT_ROLES) {
      const p = rolePrompt(role, 'implement')
      expect(p, role).toContain('Investigate before claiming')
      expect(p, role).toContain('Never claim anything about code you did not inspect')
      expect(p, role).toContain('speculative abstractions')
      expect(p, role).toContain('never delete, skip, or weaken a legitimate test')
      expect(p, role).toContain('Clean up temporary files')
      expect(p, role).toContain('mcp__nexus__report_blocker')
      expect(p, role).toContain('Do not spawn subagents')
      expect(p, role).toContain('Windows')
    }
  })

  it('names the real nexus MCP tools', () => {
    const p = rolePrompt('worker', 'implement')
    for (const t of [
      'mcp__nexus__send_message',
      'mcp__nexus__report_blocker',
      'mcp__nexus__record_decision',
      'mcp__nexus__propose_memory',
    ]) {
      expect(p).toContain(t)
    }
  })

  it('produces a distinct prompt for each role and works for every purpose', () => {
    const texts = new Set(AGENT_ROLES.map((r) => rolePrompt(r, 'implement')))
    expect(texts.size).toBe(AGENT_ROLES.length)
    for (const role of AGENT_ROLES) {
      for (const purpose of PURPOSES) expect(rolePrompt(role, purpose).length).toBeGreaterThan(200)
    }
  })

  it('planner is read-only, returns a MissionPlan and explains conflict-relevant fields', () => {
    const p = rolePrompt('planner', 'plan')
    expect(p).toContain('read-only')
    expect(p).toContain('MissionPlan')
    expect(p).toContain('suggestedFiles')
    expect(p).toContain('acyclic')
    expect(p).toContain('at least one')
    expect(p).toMatch(/test/i)
  })

  it('worker commits in its worktree and never pushes or switches branches', () => {
    const p = rolePrompt('worker', 'implement')
    expect(p).toContain('git commit')
    expect(p).toContain('Never push')
    expect(p).toContain('switch or create branches')
    expect(p).toContain('interface_change')
    expect(p).toContain('Run the relevant tests')
  })

  it('debugger diagnoses before editing and adds a regression test', () => {
    const p = rolePrompt('debugger', 'diagnose')
    expect(p).toContain('BEFORE editing')
    expect(p).toContain('root cause')
    expect(p).toContain('regression test')
  })

  it('reviewer uses the adversarial framing and requires evidence', () => {
    const p = rolePrompt('reviewer', 'review')
    expect(p).toContain('Assume this implementation may contain subtle defects')
    expect(p).toContain('Do not invent issues')
    expect(p).toContain('implementer')
    expect(p).toContain('evidence')
    expect(p).toContain('Severity')
  })

  it('verifier has final authority and must not modify the implementation', () => {
    const p = rolePrompt('verifier', 'verify')
    expect(p).toContain('final authority')
    expect(p).toContain('Do NOT modify the implementation')
    expect(p).toContain('evidence')
  })

  it('read-only roles say they do not modify files', () => {
    for (const role of ['researcher', 'security_reviewer', 'architect'] as const) {
      expect(rolePrompt(role, 'research')).toMatch(/read-only/i)
    }
    expect(rolePrompt('architect', 'research')).toContain('file impact map')
  })

  it('adds purpose text for audit/synthesis only', () => {
    expect(rolePrompt('reviewer', 'audit')).toContain('Purpose: AUDIT')
    expect(rolePrompt('researcher', 'synthesis')).toContain('Purpose: SYNTHESIS')
    expect(rolePrompt('worker', 'implement')).not.toContain('Purpose:')
  })
})
