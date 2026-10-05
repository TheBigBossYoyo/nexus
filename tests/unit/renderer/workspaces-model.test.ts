import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_POLICY,
  dependencyOrder,
  type CrossRepoDependency,
  type WorkspaceDetail,
  type WorkspaceMission,
  type WorkspaceSummary,
} from '../../../src/shared/workspace'
import {
  activeMissions,
  captureText,
  changeRows,
  compatibilityInfo,
  edgeRows,
  goalPreview,
  graphLayout,
  graphSummary,
  healthInfo,
  linePath,
  missionActions,
  missionNotice,
  missionStateInfo,
  NODE_H,
  NODE_W,
  RELEASE_STATEMENT,
  toggleAllowed,
  versionChange,
  versionRows,
  workspaceCountsText,
  workspaceHealth,
  workspacesWithActiveMissions,
  acceptConsequence,
  missionsLine,
} from '../../../src/renderer/src/views/workspaces/workspacesModel'
import {
  buildConsumerInput,
  buildContractInput,
  buildDependencyInput,
  buildMemoryInput,
  buildPolicy,
  buildWorkspaceInput,
  emptyContractForm,
  emptyDependencyForm,
  emptyMemoryForm,
  policyEquals,
  policyToForm,
  splitBranches,
  validateConsumerForm,
  validateContractForm,
  validateDependencyForm,
  validateGoal,
  validateMemoryForm,
  validatePolicyForm,
  validateWorkspaceForm,
} from '../../../src/renderer/src/views/workspaces/workspaceForm'

const repo = (key: string, health: 'ok' | 'attention' | 'unknown' = 'ok') =>
  ({
    id: `r-${key}`,
    workspaceId: 'w',
    key,
    health: { level: health, reason: '' },
  }) as unknown as WorkspaceDetail['repositories'][number]
const edge = (
  from: string,
  to: string,
  source: 'manifest' | 'contract' | 'user' = 'manifest',
): CrossRepoDependency => ({
  id: `${from}>${to}`,
  workspaceId: 'w',
  fromRepositoryId: `r-${from}`,
  toRepositoryId: `r-${to}`,
  kind: 'package_dependency',
  provenance: {
    source,
    file: source === 'user' ? null : 'package.json',
    detail: `${from} uses ${to}`,
  },
  createdAt: '2026-10-01T00:00:00Z',
})
const detailOf = (
  keys: string[],
  edges: [string, string, ('manifest' | 'contract' | 'user')?][],
) => {
  const dependencies = edges.map(([f, t, s]) => edge(f, t, s))
  return {
    repositories: keys.map((k) => repo(k)),
    dependencies,
    order: dependencyOrder(
      keys,
      edges.map(([f, t]) => ({ from: f, to: t })),
    ),
  }
}

describe('graph layout', () => {
  it('puts providers on the left and consumers to the right, from order.levels', () => {
    const d = detailOf(
      ['shared-sdk', 'backend', 'desktop', 'website', 'docs'],
      [
        ['backend', 'shared-sdk'],
        ['desktop', 'shared-sdk'],
        ['desktop', 'backend'],
        ['website', 'backend'],
      ],
    )
    const g = graphLayout(d)
    expect(g.ok).toBe(true)
    if (!g.ok) return
    const level = (k: string) => g.nodes.find((n) => n.key === k)?.level
    expect(level('shared-sdk')).toBe(0)
    expect(level('docs')).toBe(0)
    expect(level('backend')).toBe(1)
    expect(level('desktop')).toBe(2)
    expect(level('website')).toBe(2)
    expect(g.levels).toBe(3)
    const x = (k: string) => g.nodes.find((n) => n.key === k)!.x
    expect(x('shared-sdk')).toBeLessThan(x('backend'))
    expect(x('backend')).toBeLessThan(x('desktop'))
    expect(g.nodes).toHaveLength(5)
  })

  it('draws each edge from the dependent to the provider, left of the dependent to right of the provider', () => {
    const g = graphLayout(detailOf(['a', 'b'], [['b', 'a']]))
    expect(g.ok).toBe(true)
    if (!g.ok) return
    const a = g.nodes.find((n) => n.key === 'a')!
    const b = g.nodes.find((n) => n.key === 'b')!
    expect(g.lines).toEqual([
      {
        from: 'b',
        to: 'a',
        x1: b.x,
        y1: b.y + NODE_H / 2,
        x2: a.x + NODE_W,
        y2: a.y + NODE_H / 2,
        source: 'manifest',
      },
    ])
    expect(linePath(g.lines[0]!)).toMatch(/^M [\d.]+ [\d.]+ C /)
  })

  it('has no layout for a cycle and names it', () => {
    const d = detailOf(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
    )
    const g = graphLayout(d)
    expect(g).toEqual({ ok: false, cycle: ['a', 'b'] })
    expect(graphSummary(d)).toContain('cycle')
    expect(workspaceHealth(d).level).toBe('attention')
  })

  it('keeps repositories the order did not place and fits the picture to the tallest level', () => {
    const d = detailOf(['a', 'b', 'c'], [])
    const g = graphLayout({ ...d, order: { ok: true, order: ['a'], levels: [['a']] } })
    expect(g.ok && g.nodes.map((n) => n.key).sort()).toEqual(['a', 'b', 'c'])
    const flat = graphLayout(d)
    expect(flat.ok && flat.levels).toBe(1)
    expect(flat.ok && flat.height).toBeGreaterThanOrEqual(3 * NODE_H)
  })

  it('summarizes levels in text', () => {
    expect(graphSummary(detailOf(['a', 'b'], [['b', 'a']]))).toBe(
      'Level 1 (providers): a. Level 2: b.',
    )
  })

  it('handles an empty workspace', () => {
    const g = graphLayout(detailOf([], []))
    expect(g.ok && g.nodes).toEqual([])
  })
})

describe('edge rows', () => {
  it('shows keys, kind, provenance source, detail and file; only user edges are removable', () => {
    const d = detailOf(
      ['a', 'b'],
      [
        ['b', 'a', 'user'],
        ['a', 'b', 'manifest'],
      ],
    )
    const rows = edgeRows(d)
    expect(rows.map((r) => `${r.from}>${r.to}`)).toEqual(['a>b', 'b>a'])
    const user = rows.find((r) => r.source === 'user')!
    expect(user).toMatchObject({
      sourceLabel: 'Added by you',
      removable: true,
      file: '—',
      kind: 'Package dependency',
      detail: 'b uses a',
    })
    expect(rows.find((r) => r.source === 'manifest')).toMatchObject({
      removable: false,
      file: 'package.json',
      sourceLabel: 'Manifest',
    })
  })
})

describe('repositories and policy toggles', () => {
  it('describes health with text', () => {
    expect(healthInfo({ level: 'ok', reason: '' }).label).toBe('Healthy')
    expect(healthInfo({ level: 'attention', reason: 'x' }).label).toBe('Needs attention')
    expect(healthInfo({ level: 'unknown', reason: 'x' }).label).toBe('Unknown')
  })

  it('rolls repository health up', () => {
    expect(
      workspaceHealth({ repositories: [], order: { ok: true, order: [], levels: [] } }).level,
    ).toBe('unknown')
    const base = { order: { ok: true, order: [], levels: [] } as WorkspaceDetail['order'] }
    expect(workspaceHealth({ ...base, repositories: [repo('a'), repo('b')] }).level).toBe('ok')
    expect(
      workspaceHealth({ ...base, repositories: [repo('a'), repo('b', 'attention')] }).text,
    ).toContain('b')
    expect(workspaceHealth({ ...base, repositories: [repo('a', 'unknown')] }).level).toBe('unknown')
  })

  it('toggles an allowed repository without duplicates, sorted', () => {
    expect(toggleAllowed(['b'], 'a', true)).toEqual(['a', 'b'])
    expect(toggleAllowed(['a', 'b'], 'a', true)).toEqual(['a', 'b'])
    expect(toggleAllowed(['a', 'b'], 'a', false)).toEqual(['b'])
  })
})

describe('compatibility presentation', () => {
  it('gives every level a label, an icon and a meaning', () => {
    for (const level of ['identical', 'compatible', 'breaking', 'unknown'] as const) {
      const i = compatibilityInfo(level)
      expect(i.label.length).toBeGreaterThan(0)
      expect(i.meaning.length).toBeGreaterThan(0)
    }
    expect(compatibilityInfo('breaking')).toMatchObject({
      label: 'Breaking',
      tone: 'danger',
      icon: 'alert',
    })
    expect(compatibilityInfo('unknown').meaning).toContain('not known')
  })

  it('turns changes into rows with before and after', () => {
    const rows = changeRows([
      {
        path: 'POST /orders',
        change: 'removed',
        before: 'object',
        after: null,
        breaking: true,
        why: 'Removed',
      },
      {
        path: 'Order.note',
        change: 'added',
        before: null,
        after: 'string',
        breaking: false,
        why: 'New',
      },
    ])
    expect(rows[0]).toMatchObject({
      change: 'Removed',
      beforeAfter: 'object → (none)',
      breakingLabel: 'Breaking',
    })
    expect(rows[1]).toMatchObject({
      change: 'Added',
      beforeAfter: '(none) → string',
      breakingLabel: 'Not breaking',
    })
  })

  it('lists versions newest first with short hashes and surface counts', () => {
    const rows = versionRows([
      {
        id: 'a',
        version: 1,
        hash: 'a'.repeat(64),
        commit: null,
        surface: [],
        parseError: 'bad yaml',
        capturedAt: 't',
      },
      {
        id: 'b',
        version: 2,
        hash: 'b'.repeat(64),
        commit: 'c'.repeat(40),
        surface: [{}, {}],
        parseError: null,
        capturedAt: 't',
      },
    ])
    expect(rows.map((r) => r.version)).toEqual([2, 1])
    expect(rows[0]).toMatchObject({ hash: 'bbbbbbbbbb', commit: 'cccccccc', elements: 2 })
    expect(rows[1]).toMatchObject({ commit: '—', parseError: 'bad yaml' })
  })

  it('says whether a capture recorded something', () => {
    expect(captureText(true, 3)).toBe('Captured version 3.')
    expect(captureText(false, 3)).toContain('nothing new')
  })
})

describe('mission actions and notices', () => {
  it('offers only the actions that apply', () => {
    expect(missionActions('DRAFT')).toMatchObject({
      start: true,
      pause: false,
      resume: false,
      cancel: true,
    })
    expect(missionActions('AWAITING_APPROVAL')).toMatchObject({
      decidePlan: true,
      pause: false,
      resume: false,
      cancel: true,
    })
    expect(missionActions('ACTIVE')).toMatchObject({ pause: true, resume: false, cancel: true })
    expect(missionActions('PAUSED')).toMatchObject({ pause: false, resume: true })
    expect(missionActions('BLOCKED')).toMatchObject({ resume: true, cancel: true })
    // The engine resumes a usage wait by itself; offering Resume there would only produce an error.
    expect(missionActions('WAITING_FOR_QUOTA')).toMatchObject({ resume: false, cancel: true })
    expect(missionActions('COMPLETED')).toMatchObject({
      pause: false,
      resume: false,
      cancel: false,
      prepareRelease: true,
    })
    for (const s of ['FAILED', 'CANCELLED'] as const)
      expect(missionActions(s)).toMatchObject({
        start: false,
        pause: false,
        resume: false,
        cancel: false,
        prepareRelease: false,
      })
  })

  it('labels every state and gives each a notice', () => {
    for (const s of [
      'DRAFT',
      'PLANNING',
      'AWAITING_APPROVAL',
      'ACTIVE',
      'VERIFYING',
      'PAUSED',
      'WAITING_FOR_QUOTA',
      'BLOCKED',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ] as const) {
      expect(missionStateInfo(s).label.length).toBeGreaterThan(0)
      expect(
        missionNotice({ state: s, blockedReason: null, error: null, resumeState: null }),
      ).not.toBeNull()
    }
  })

  it('says quota is not a failure, blocked shows its reason and what resume does, approval says nothing runs', () => {
    const q = missionNotice({
      state: 'WAITING_FOR_QUOTA',
      blockedReason: null,
      error: null,
      resumeState: null,
    })
    expect(q?.text).toContain('not a failure')
    const b = missionNotice({
      state: 'BLOCKED',
      blockedReason: 'backend has uncommitted changes',
      error: null,
      resumeState: 'ACTIVE',
    })
    expect(b?.text).toContain('backend has uncommitted changes')
    expect(b?.text).toContain('Resume')
    expect(
      missionNotice({
        state: 'AWAITING_APPROVAL',
        blockedReason: null,
        error: null,
        resumeState: null,
      })?.text,
    ).toContain('Nothing runs in any repository until you accept')
    expect(
      missionNotice({ state: 'FAILED', blockedReason: null, error: 'boom', resumeState: null })
        ?.text,
    ).toBe('boom')
  })

  it('finds active missions and previews goals', () => {
    const m = (state: WorkspaceMission['state']) => ({ state }) as WorkspaceMission
    expect(
      activeMissions([
        m('DRAFT'),
        m('ACTIVE'),
        m('PAUSED'),
        m('COMPLETED'),
        m('AWAITING_APPROVAL'),
      ]),
    ).toHaveLength(3)
    expect(goalPreview('first line\nsecond')).toBe('first line')
    expect(goalPreview('x'.repeat(200), 10)).toHaveLength(10)
  })
})

describe('releases and summaries', () => {
  it('states that releases are prepared only', () => {
    expect(RELEASE_STATEMENT).toBe(
      'Prepared only. NEXUS does not publish; release the repositories yourself in this order.',
    )
    expect(versionChange({ currentVersion: '1.2.3', nextVersion: '2.0.0', bump: 'major' })).toBe(
      '1.2.3 → 2.0.0',
    )
    expect(versionChange({ currentVersion: '1.2.3', nextVersion: '1.2.3', bump: 'none' })).toBe(
      '1.2.3 (no change)',
    )
    expect(versionChange({ currentVersion: null, nextVersion: null, bump: 'patch' })).toBe(
      'no version → no version',
    )
  })

  it('counts and filters workspaces for the list and Home', () => {
    const s = (name: string, activeMissions: number): WorkspaceSummary => ({
      workspace: { name } as WorkspaceSummary['workspace'],
      repositories: 1,
      contracts: 2,
      activeMissions,
      activePrograms: 0,
    })
    expect(workspaceCountsText(s('a', 1))).toBe('1 repository · 2 contracts · 1 active mission')
    expect(
      workspacesWithActiveMissions([s('a', 0), s('b', 1), s('c', 3)]).map((r) => r.workspace.name),
    ).toEqual(['c', 'b'])
    expect(workspacesWithActiveMissions([s('a', 0)])).toEqual([])
  })
})

describe('forms', () => {
  it('validates and builds a workspace', () => {
    expect(validateWorkspaceForm({ name: ' ', description: '' }).ok).toBe(false)
    expect(validateWorkspaceForm({ name: 'RaceDeck', description: '' }).ok).toBe(true)
    expect(buildWorkspaceInput({ name: ' RaceDeck ', description: '  ' })).toEqual({
      name: 'RaceDeck',
    })
    expect(buildWorkspaceInput({ name: 'x', description: ' d ' })).toEqual({
      name: 'x',
      description: 'd',
    })
  })

  it('validates a goal', () => {
    expect(validateGoal('  ').ok).toBe(false)
    expect(validateGoal('Rename the order field').ok).toBe(true)
    expect(validateGoal('x'.repeat(8001)).ok).toBe(false)
  })

  it('requires a reason and two different repositories for a dependency', () => {
    const f = { ...emptyDependencyForm(), from: 'backend', to: 'shared-sdk' }
    expect(validateDependencyForm(f).errors.detail).toBeTruthy()
    expect(validateDependencyForm({ ...f, detail: 'uses it' }).ok).toBe(true)
    expect(validateDependencyForm({ ...f, to: 'backend', detail: 'x' }).errors.to).toContain(
      'itself',
    )
    expect(
      validateDependencyForm({ ...f, detail: 'x' }, [{ from: 'backend', to: 'shared-sdk' }]).errors
        .to,
    ).toContain('already')
    expect(validateDependencyForm(emptyDependencyForm()).reason).toBeTruthy()
    expect(buildDependencyInput('w', { ...f, detail: ' uses it ' })).toEqual({
      workspaceId: 'w',
      from: 'backend',
      to: 'shared-sdk',
      kind: 'package_dependency',
      detail: 'uses it',
    })
  })

  it('validates and builds a contract and its consumer', () => {
    const f = {
      ...emptyContractForm(),
      key: 'orders-api',
      name: 'Orders API',
      provider: 'backend',
      path: 'openapi.yaml',
    }
    expect(validateContractForm(f).ok).toBe(true)
    expect(validateContractForm({ ...f, key: 'Bad Key' }).errors.key).toBeTruthy()
    expect(validateContractForm(f, ['orders-api']).errors.key).toContain('exists')
    expect(validateContractForm({ ...f, provider: '' }).errors.provider).toBeTruthy()
    expect(buildContractInput('w', f)).toEqual({
      workspaceId: 'w',
      key: 'orders-api',
      name: 'Orders API',
      kind: 'openapi',
      provider: 'backend',
      path: 'openapi.yaml',
    })
    expect(validateConsumerForm({ repository: '', copyPath: '' }).ok).toBe(false)
    expect(validateConsumerForm({ repository: 'backend', copyPath: '' }, ['backend']).ok).toBe(
      false,
    )
    expect(buildConsumerInput('c1', { repository: 'desktop', copyPath: ' ' })).toEqual({
      contractId: 'c1',
      repository: 'desktop',
      copyPath: null,
    })
    expect(
      buildConsumerInput('c1', { repository: 'desktop', copyPath: 'vendor/api.yaml' }).copyPath,
    ).toBe('vendor/api.yaml')
  })

  it('requires at least two repositories for a workspace memory', () => {
    const f = {
      ...emptyMemoryForm(),
      title: 'Order ids',
      content: 'Ids are UUIDs',
      evidence: 'sdk/src/ids.ts',
    }
    expect(validateMemoryForm({ ...f, repositories: ['backend'] }).errors.repositories).toContain(
      'at least two',
    )
    expect(validateMemoryForm({ ...f, repositories: ['backend', 'desktop'] }).ok).toBe(true)
    expect(
      validateMemoryForm({ ...f, evidence: '', repositories: ['a', 'b'] }).errors.evidence,
    ).toBeTruthy()
    expect(
      buildMemoryInput('w', { ...f, repositories: ['desktop', 'backend'] }).repositories,
    ).toEqual(['backend', 'desktop'])
  })

  it('round-trips a policy and always publishes never', () => {
    const p = { ...DEFAULT_WORKSPACE_POLICY, allowedRepositories: ['backend', 'shared-sdk'] }
    const form = policyToForm(p)
    expect(form.protectedBranches).toBe('main, master, release')
    const built = buildPolicy(form)
    expect(built).not.toBeNull()
    expect(policyEquals(built!, p)).toBe(true)
    expect(built!.publishing).toBe('never')
    expect(
      buildPolicy({
        ...form,
        protectedBranches: ' main ,, dev, main',
        maxParallelRepositories: '3',
      }),
    ).toMatchObject({ protectedBranches: ['main', 'dev'], maxParallelRepositories: 3 })
  })

  it('rejects out-of-range policy numbers', () => {
    const form = policyToForm(DEFAULT_WORKSPACE_POLICY)
    expect(
      validatePolicyForm({ ...form, maxParallelRepositories: '5' }).errors.maxParallelRepositories,
    ).toBeTruthy()
    expect(validatePolicyForm({ ...form, maxParallelRepositories: '0' }).ok).toBe(false)
    expect(validatePolicyForm({ ...form, maxRepositoriesPerMission: '21' }).ok).toBe(false)
    expect(validatePolicyForm({ ...form, maxTasksPerMission: '1.5' }).ok).toBe(false)
    expect(validatePolicyForm({ ...form, maxTasksPerMission: '' }).ok).toBe(false)
    expect(buildPolicy({ ...form, maxTasksPerMission: '41' })).toBeNull()
    expect(splitBranches('a, b,a')).toEqual(['a', 'b'])
  })
})

describe('workspace page: what is working and what accepting a plan causes', () => {
  it('counts working missions apart from the ones that need the user', () => {
    const m = (state: Parameters<typeof missionsLine>[0][number]['state']) => ({ state })
    expect(missionsLine([])).toBeNull()
    expect(missionsLine([m('DRAFT'), m('COMPLETED'), m('CANCELLED')])).toBeNull()
    expect(missionsLine([m('ACTIVE')])).toBe('1 mission working.')
    expect(missionsLine([m('AWAITING_APPROVAL')])).toBe('1 needs you.')
    expect(
      missionsLine([
        m('PLANNING'),
        m('VERIFYING'),
        m('BLOCKED'),
        m('AWAITING_APPROVAL'),
        m('WAITING_FOR_QUOTA'),
      ]),
    ).toBe('2 missions working · 2 need you · 1 paused or waiting for usage.')
  })

  it('says what accepting a plan lets happen and what it never does', () => {
    const text = acceptConsequence([
      { repository: 'shared-sdk' },
      { repository: 'backend' },
      { repository: 'backend' },
    ])
    expect(text).toContain('change shared-sdk, backend on new nexus/ branches')
    expect(text).toContain('nothing is merged or published')
    expect(text).toContain('uses your Claude usage')
  })
})
