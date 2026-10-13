import { describe, expect, it } from 'vitest'
import { SECURITY_EVENT_SEVERITIES, AUTONOMY_PROFILES, type BoundaryRequestView, type GrantScope } from '../../../src/shared/autonomy'
import {
  NEVER_POSSIBLE_LINE,
  PROFILE_LABEL,
  PROFILE_SENTENCE,
  SEVERITY_WORDS,
  actionShown,
  answerCoverage,
  boundaryCountLabel,
  boundaryCountShort,
  decidedWords,
  decisionButtons,
  enrollmentLine,
  grantEndedWords,
  groupRequests,
  occurrencesLabel,
  recentCommand,
  recentNotes,
  unattendedSummary,
  UNATTENDED_ANSWER_LINE,
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
    actionHash: null,
    actionTruncated: false,
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
    expect(boundaryCountLabel(1)).toBe('1 boundary request waiting for your decision')
    expect(boundaryCountLabel(3)).toBe('3 boundary requests waiting for your decision')
    expect(boundaryCountShort(0)).toBeNull()
    expect(boundaryCountShort(1)).toBe('1 boundary request')
    expect(boundaryCountShort(2)).toBe('2 boundary requests')
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

describe('answerCoverage', () => {
  it('says how far each offered answer reaches, narrow to wide, then Deny', () => {
    const lines = answerCoverage(req('a')).map((c) => c.text)
    expect(lines).toEqual([
      'Allow once: only the command shown above, one time.',
      'Allow for this mission: push to a Git remote on origin in this mission.',
      'Always allow for this project: push to a Git remote on origin, in this and every later mission.',
      'Deny: it is not done, the agent is told so and goes on without it, and it is not asked again in this mission.',
    ])
  })
  it('says "any" when the resource is not narrowed, and lists only the offered answers', () => {
    const lines = answerCoverage(req('a', { resource: { kind: 'ANY', value: '' }, scopes: ['ONCE', 'MISSION'] })).map((c) => c.text)
    expect(lines).toEqual([
      'Allow once: only the command shown above, one time.',
      'Allow for this mission: any push to a Git remote in this mission.',
      expect.stringMatching(/^Deny: /),
    ])
    expect(answerCoverage(req('a', { scopes: [] })).map((c) => c.decision)).toEqual(['DENY'])
  })
})

describe('recent answers', () => {
  it('shows the cleaned command on one line, cut with an ellipsis', () => {
    expect(recentCommand(req('a', { action: 'git push\norigin  main' }))).toBe('git push origin main')
    const cut = recentCommand(req('a', { action: 'x'.repeat(400) }))
    expect(cut.length).toBe(160)
    expect(cut.endsWith('…')).toBe(true)
  })
  it('says what happened when nothing was restarted, and where a lasting grant is taken back', () => {
    expect(recentNotes({ state: 'EXPIRED', decidedScope: null, followUp: null })).toEqual(['Expired with the mission: nothing was done.'])
    expect(recentNotes({ state: 'DENIED', decidedScope: null, followUp: null })).toEqual(['Denied: nothing was done.'])
    expect(recentNotes({ state: 'DENIED', decidedScope: null, followUp: 'Denied: 1 task started again.' })).toEqual([])
    expect(recentNotes({ state: 'GRANTED', decidedScope: 'PROJECT', followUp: 'Allowed: 1 task started again.' })).toEqual(['Take it back in Settings > Autonomy.'])
    expect(recentNotes({ state: 'GRANTED', decidedScope: 'ONCE', followUp: null })).toEqual([])
  })
})

describe('while you are away', () => {
  it('counts all four lists in one line and says what a denial does', () => {
    expect(unattendedSummary({ proceeds: [1, 2], waits: [1], never: [1, 2, 3], needsPresence: [1] })).toBe('2 go on, 1 wait for your decision, 3 never happen, 1 need you at the machine')
    expect(UNATTENDED_ANSWER_LINE).toContain('denied, the task finishes without it')
  })
  it('qualifies what no agent can do: through NEXUS only', () => {
    expect(NEVER_POSSIBLE_LINE).toContain('through NEXUS')
    expect(NEVER_POSSIBLE_LINE).toContain('A profile is a set of permissions NEXUS checks; it is not a sandbox.')
    expect(NEVER_POSSIBLE_LINE).toContain('only the containment bounds it')
  })
})

describe('actionShown', () => {
  it('removes bidirectional overrides and control characters other than tab and newline', () => {
    const hostile = `git push ${String.fromCharCode(0x202e, 0x2066, 0x2069)}origin${String.fromCharCode(7, 0)}\tmain\nnext`
    expect(actionShown(req('a', { action: hostile })).text).toBe('git push origin\tmain\nnext')
  })

  it('says that allow once covers exactly the command that was attempted when the text is shortened, and not otherwise', () => {
    expect(actionShown(req('a', { action: 'git push origin main' })).note).toBeNull()
    expect(actionShown(req('a', { action: 'git push origin ...…', actionTruncated: true })).note).toBe('Shortened; allow once covers exactly the command that was attempted.')
    expect(actionShown(req('a', { action: 'curl -H x [redacted]', actionTruncated: true })).note).toContain('allow once covers exactly')
  })
})
