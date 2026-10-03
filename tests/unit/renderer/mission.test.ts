import { describe, expect, it } from 'vitest'
import {
  buildCreateRunInput,
  validateMission,
  type MissionDraft,
} from '../../../src/renderer/src/views/projects/mission'

const base: MissionDraft = {
  projectId: 'p1',
  prompt: '  add a health endpoint  ',
  mode: 'build',
  preset: 'balanced',
  maxAgents: null,
  requirePlanApproval: true,
  maxIterations: 3,
}

describe('mission composer input', () => {
  it('trims the prompt and omits untouched overrides', () => {
    expect(buildCreateRunInput(base)).toEqual({
      projectId: 'p1',
      mode: 'build',
      preset: 'balanced',
      prompt: 'add a health endpoint',
      requirePlanApproval: true,
    })
  })

  it('sends max agents only when overridden and iterations only for LOOP', () => {
    const input = buildCreateRunInput({ ...base, mode: 'loop', maxAgents: 6, maxIterations: 5 })
    expect(input.maxParallelAgents).toBe(6)
    expect(input.maxIterations).toBe(5)
    expect(buildCreateRunInput({ ...base, maxIterations: 5 }).maxIterations).toBeUndefined()
  })

  it('validates against the IPC schema with readable messages', () => {
    expect(validateMission(base)).toBeNull()
    expect(validateMission({ ...base, prompt: '   ' })).toMatch(/describe/i)
    expect(validateMission({ ...base, prompt: 'x'.repeat(20_001) })).toMatch(/too long/i)
    expect(validateMission({ ...base, maxAgents: 0 })).toMatch(/1 to 16/)
    expect(validateMission({ ...base, maxAgents: 2.5 })).toMatch(/whole number/)
    expect(validateMission({ ...base, mode: 'loop', maxIterations: 51 })).toMatch(/1 to 50/)
  })
})
