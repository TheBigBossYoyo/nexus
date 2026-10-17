import { describe, expect, it } from 'vitest'
import { AGENT_ROLES } from '@shared/domain'
import type { AgentPurpose } from '@shared/domain'
import { rolePrompt } from '@main/modules/context/prompts'
import { SECTION_LIMITS, criteriaSection, renderTaskSpec } from '@main/modules/context/render'

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

  it('describes every nexus tool to the roles that implement or design', () => {
    for (const role of ['worker', 'debugger', 'architect'] as const) {
      const p = rolePrompt(role, 'implement')
      expect(p, role).toContain('mcp__nexus__package_config_inspect')
      expect(p, role).toContain('mcp__nexus__privileged_request')
    }
  })

  it('describes only send_message and report_blocker to the read-only roles', () => {
    for (const role of ['verifier', 'reviewer', 'security_reviewer', 'researcher', 'planner'] as const) {
      const p = rolePrompt(role, 'verify')
      expect(p, role).toContain('mcp__nexus__report_blocker')
      expect(p, role).toContain('mcp__nexus__send_message')
      expect(p, role).not.toContain('mcp__nexus__record_decision')
      expect(p, role).not.toContain('mcp__nexus__propose_memory')
      expect(p, role).not.toContain('mcp__nexus__package_config_inspect')
      expect(p, role).not.toContain('mcp__nexus__privileged_request')
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

describe('what a plan may ask of a read-only task', () => {
  // Seen in the real campaign: a planner asked its verifier task for a `node -e` probe, which that role may not
  // run; the verifier reported a blocker and the mission, and the program above it, paused.
  it('the planner is told that a read-only role cannot run ad-hoc code', () => {
    const p = rolePrompt('planner', 'plan')
    expect(p).toContain('cannot run ad-hoc code')
    expect(p).toContain('node -e')
    expect(p).toContain('belongs in a test written by a worker task')
  })

  // 0.9.1, seen in a real mission: the planner asked a security_reviewer task to run the test, typecheck and lint
  // commands, which that role may not run; the reviewer reported a blocker and the mission paused.
  it('the planner is told which read-only roles run no project check', () => {
    const p = rolePrompt('planner', 'plan')
    expect(p).toContain('a security_reviewer, researcher or architect runs none of them')
    expect(p).toContain('never ask such a task to run the tests, the build, the lint or the type check')
  })

  // Seen in the same campaign on 0.7.1: a task's verifier failed a finished task on mission criteria that only
  // a later task could meet.
  it('mission criteria shown with a task say whose they are', () => {
    const both = criteriaSection({ acceptanceCriteria: ['the task does its part'] }, ['the mission does everything']) ?? ''
    expect(both).toContain('Task criteria:')
    expect(both).toContain('what belongs to another task is not a failure of this one')
    expect(criteriaSection({ acceptanceCriteria: [] }, ['the mission does everything'])).toBe('Mission criteria:\n- the mission does everything')
  })
})

describe('text the user wrote is read at the length it was accepted', () => {
  // Finding 6.6: a request and a task description are accepted up to 20,000 characters and feedback on a plan up
  // to 10,000; they were then cut to 8,000 and 6,000 where the sessions that answer for all of it read them.
  it('a long task description reaches its sessions whole, and what is longer than accepted is marked as cut', () => {
    const end = 'THE LAST SENTENCE OF THE DESCRIPTION'
    const description = `${'a'.repeat(19_000)} ${end}`
    expect(renderTaskSpec({ key: 't', title: 'T', description, suggestedFiles: [] })).toContain(end)
    const over = renderTaskSpec({ key: 't', title: 'T', description: 'b'.repeat(30_000), suggestedFiles: [] })
    expect(over).toMatch(/truncated: \d+ more characters omitted/)
    expect(SECTION_LIMITS.request).toBe(20_000)
    expect(SECTION_LIMITS.userFeedback).toBe(10_000)
  })
})
