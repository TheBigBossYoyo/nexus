import { describe, expect, it } from 'vitest'
import { AGENT_STATES, RUN_STATES, SEVERITIES, TASK_STATES } from '@shared/domain'
import { agentStatus, runStatus, severityStatus, taskStatus, TONE_CLASSES } from '../../../src/renderer/src/lib/status'

describe('status mapping', () => {
  it('covers every state with a label and a known tone', () => {
    const tones = Object.keys(TONE_CLASSES)
    const all = [
      ...TASK_STATES.map(taskStatus),
      ...AGENT_STATES.map(agentStatus),
      ...RUN_STATES.map(runStatus),
      ...SEVERITIES.map(severityStatus),
    ]
    for (const s of all) {
      expect(s.label.length).toBeGreaterThan(0)
      expect(tones).toContain(s.tone)
    }
  })

  it('maps the key states to the intended families', () => {
    expect(taskStatus('running').tone).toBe('active')
    expect(taskStatus('review').tone).toBe('review')
    expect(taskStatus('completed').tone).toBe('success')
    expect(taskStatus('failed').tone).toBe('danger')
    expect(agentStatus('waiting').tone).toBe('waiting')
    expect(runStatus('awaiting_approval').tone).toBe('waiting')
    expect(runStatus('repairing').tone).toBe('warning')
    expect(severityStatus('critical').tone).toBe('danger')
  })

  it('throws on an unknown state instead of guessing', () => {
    expect(() => taskStatus('bogus' as never)).toThrow()
  })
})
