import { describe, expect, it } from 'vitest'
import { SECURITY_EVENT_SEVERITIES, AUTONOMY_PROFILES, type BoundaryRequestView, type GrantScope } from '../../../src/shared/autonomy'
import {
  NEVER_POSSIBLE_LINE,
  PROFILE_LABEL,
  PROFILE_SENTENCE,
  SEVERITY_WORDS,
  boundaryCountLabel,
  boundaryCountShort,
  decidedWords,
  decisionButtons,
  enrollmentLine,
  grantEndedWords,
  groupRequests,
  occurrencesLabel,
  resolveErrorText,
  severityWords,
  sortRecent,
} from '../../../src/renderer/src/views/autonomy/autonomyModel'

function req(id: string, extra: Partial<BoundaryRequestView> = {}): BoundaryRequestView {
  return {
    id,
    projectId: 'p1',
    runId: 'r1',
    taskId: null,
    agentId: null,
    capability: 'GIT_PUSH',
    resource: { kind: 'GIT_REMOTE', value: 'origin' },
    action: 'git push origin main',
    reason: 'Pushing changes a shared remote.',
    dedupeKey: id,
    state: 'PENDING',
    occurrences: 1,
    createdAt: '2026-10-11T10:00:00.000Z',
    lastSeenAt: '2026-10-11T10:00:00.000Z',
    decidedAt: null,
    decidedScope: null,
    grantId: null,
    capabilityLabel: 'Push to a Git remote',
    resourceLabel: 'origin',
    projectName: 'Alpha',
    missionTitle: 'Fix login',
    scopes: ['ONCE', 'MISSION', 'PROJECT'],
    followUp: null,
    ...extra,
  }
}

describe('boundaryCountLabel', () => {
  it('is absent for none and worded for one and many', () => {
    expect(boundaryCountLabel(0)).toBeNull()
    expect(boundaryCountLabel(-1)).toBeNull()
    expect(boundaryCountLabel(1)).toBe('1 boundary decision required')
    expect(boundaryCountLabel(3)).toBe('3 boundary decisions required')
    expect(boundaryCountShort(0)).toBeNull()
    expect(boundaryCountShort(2)).toBe('2 boundary decisions')
  })
})

describe('groupRequests', () => {
  it('groups by project, then mission, oldest waiting first, missionless last', () => {
    const groups = groupRequests([
      req('a3', { projectId: 'p2', projectName: 'Beta', runId: 'r9', createdAt: '2026-10-11T08:00:00.000Z' }),
      req('a1', { createdAt: '2026-10-11T09:00:00.000Z', runId: null, missionTitle: null }),
      req('a2', { createdAt: '2026-10-11T10:00:00.000Z', runId: 'r2', missionTitle: 'Second' }),
      req('a4', { createdAt: '2026-10-11T09:30:00.000Z', runId: 'r2', missionTitle: 'Second' }),
    ])
    expect(groups.map((g) => g.projectName)).toEqual(['Beta', 'Alpha'])
    const alpha = groups[1]!
    expect(alpha.count).toBe(3)
    expect(alpha.missions.map((m) => m.key)).toEqual(['r2', ''])
    expect(alpha.missions[0]!.requests.map((r) => r.id)).toEqual(['a4', 'a2'])
  })
  it('is empty for nothing', () => {
    expect(groupRequests([])).toEqual([])
  })
})

describe('decisionButtons', () => {
  const labels = (scopes: GrantScope[]) => decisionButtons(scopes).map((b) => b.label)
  it('offers only the scopes listed, narrowest first, and always Deny last', () => {
    expect(labels(['ONCE', 'MISSION', 'PROJECT'])).toEqual(['Allow once', 'Allow for this mission', 'Always allow for this project', 'Deny'])
    expect(labels(['ONCE'])).toEqual(['Allow once', 'Deny'])
    expect(labels(['MISSION', 'ONCE'])).toEqual(['Allow once', 'Allow for this mission', 'Deny'])
    expect(labels([])).toEqual(['Deny'])
  })
  it('maps to the contract decisions', () => {
    expect(decisionButtons(['ONCE', 'MISSION', 'PROJECT']).map((b) => b.decision)).toEqual(['ALLOW_ONCE', 'ALLOW_MISSION', 'ALLOW_PROJECT', 'DENY'])
  })
})

describe('words', () => {
  it('words a decided request without enum names', () => {
    expect(decidedWords({ state: 'GRANTED', decidedScope: 'ONCE' })).toBe('Allowed once')
    expect(decidedWords({ state: 'GRANTED', decidedScope: 'MISSION' })).toBe('Allowed for this mission')
    expect(decidedWords({ state: 'GRANTED', decidedScope: 'PROJECT' })).toBe('Always allowed for this project')
    expect(decidedWords({ state: 'DENIED', decidedScope: null })).toBe('Denied')
    expect(decidedWords({ state: 'PENDING', decidedScope: null })).toBe('Waiting for you')
    expect(decidedWords({ state: 'EXPIRED', decidedScope: null })).toBe('Expired')
  })
  it('has words for every severity, none of them the raw name', () => {
    for (const s of SECURITY_EVENT_SEVERITIES) {
      expect(SEVERITY_WORDS[s]).toBeTruthy()
      expect(SEVERITY_WORDS[s]).not.toMatch(/_/)
    }
    expect(severityWords('SOMETHING_NEW')).toBe('Other event')
  })
  it('says how often a need was met only when more than once', () => {
    expect(occurrencesLabel(1)).toBeNull()
    expect(occurrencesLabel(4)).toBe('Met 4 times')
  })
  it('says why a grant is not in force', () => {
    expect(grantEndedWords({ revokedAt: null, consumedAt: null }, true)).toBeNull()
    expect(grantEndedWords({ revokedAt: 'x', consumedAt: null }, false)).toBe('Taken back')
    expect(grantEndedWords({ revokedAt: null, consumedAt: 'x' }, false)).toBe('Used')
    expect(grantEndedWords({ revokedAt: null, consumedAt: null }, false)).toBe('Ended')
  })
  it('shows the readable message of a failed answer', () => {
    expect(resolveErrorText(new Error('You declined the confirmation.'))).toBe('You declined the confirmation.')
    expect(resolveErrorText(undefined)).toMatch(/still waiting/)
  })
})

describe('sortRecent', () => {
  it('puts the latest decision first', () => {
    const out = sortRecent([req('x', { decidedAt: '2026-10-11T10:00:00.000Z' }), req('y', { decidedAt: '2026-10-11T11:00:00.000Z' })])
    expect(out.map((r) => r.id)).toEqual(['y', 'x'])
  })
})

describe('profile wording', () => {
  it('has a label and one sentence per profile, and claims no sandbox or safety', () => {
    for (const p of AUTONOMY_PROFILES) {
      expect(PROFILE_LABEL[p]).not.toMatch(/_/)
      expect(PROFILE_SENTENCE[p].match(/\./g)!.length).toBeLessThanOrEqual(2)
      expect(PROFILE_SENTENCE[p]).not.toMatch(/\bsafe|secure|sandbox/i)
    }
    expect(NEVER_POSSIBLE_LINE).toMatch(/credentials/)
    expect(NEVER_POSSIBLE_LINE).toMatch(/not a sandbox/)
  })
  it('words the enrollment line for the project page', () => {
    expect(enrollmentLine(null)).toBe('Not enrolled: NEXUS asks before sensitive actions.')
    expect(enrollmentLine('BALANCED')).toMatch(/^Balanced profile/)
  })
})
