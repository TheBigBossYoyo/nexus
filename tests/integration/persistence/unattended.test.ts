import { describe, expect, it } from 'vitest'
import { AUTONOMY_CAPABILITIES, UNATTENDED_NEEDS_PRESENCE, profileCapabilities, unattendedPolicy, type AutonomyProfile } from '@shared/autonomy'
import { AutonomyService } from '@main/modules/autonomy/service'
import { createAutonomyHandlers } from '@main/modules/ipc/v8-handlers'
import { makeProject, openMemory } from './fixtures'

// 0.8: what holds while nobody is there. Authority is what is stored (the enrollment, the grants), read by the
// runtime. No window is part of any decision, so none of these tests has one. What gives lasting authority is
// confirmed natively by the runtime; with nobody to confirm, it does not happen.

function setup(confirm?: (title: string) => Promise<boolean>) {
  const { repos } = openMemory()
  const project = repos.projects.insert(makeProject())
  const autonomy = new AutonomyService({ repos, runActive: () => true })
  const asked: string[] = []
  const handlers = createAutonomyHandlers({
    autonomy,
    projectName: (id) => repos.projects.get(id)?.name ?? null,
    ...(confirm
      ? {
          confirm: (title: string) => {
            asked.push(title)
            return confirm(title)
          },
        }
      : {}),
  })
  return { repos, project, autonomy, handlers, asked }
}

describe('the unattended policy', () => {
  it('is the profile, said as what goes on, what waits, what never happens and what needs the user present', () => {
    for (const profile of ['AUTONOMOUS_PROJECT', 'BALANCED', 'LOCKED_DOWN'] as AutonomyProfile[]) {
      const policy = unattendedPolicy(profile)
      const granted = profileCapabilities(profile)
      expect(policy.proceeds).toEqual([...granted].map((c) => AUTONOMY_CAPABILITIES[c].label))
      // Everything else an agent can ask for waits as a request or never happens: nothing is left unsaid.
      const all = Object.values(AUTONOMY_CAPABILITIES).map((c) => c.label)
      expect([...policy.proceeds, ...policy.waits, ...policy.never].sort()).toEqual([...all].sort())
      expect(policy.needsPresence).toEqual([...UNATTENDED_NEEDS_PRESENCE])
    }
    const auto = unattendedPolicy('AUTONOMOUS_PROJECT')
    for (const label of ['Edit the task worktree', 'Run tests', 'Run builds', 'Install project dependencies from the approved registries', 'Research the public web', 'Launch the project application', 'Drive an isolated browser', 'Use local Git (status, diff, branch, commit, worktree)']) expect(auto.proceeds, label).toContain(label)
    for (const label of ['Push to a Git remote', 'Publish a package', 'Deploy to an environment', 'Run something as administrator', 'Use a credential or an account', 'Spend separately billed provider credits', 'Change Windows configuration (registry, services, scheduled tasks, environment)', 'Read files outside the enrolled project']) expect(auto.waits, label).toContain(label)
    for (const label of ['Read provider credentials', 'Reach the NEXUS runtime, its database or its keys', "Use the user's own browser profile", 'Change the NEXUS security policy, a profile or a grant']) expect(auto.never, label).toContain(label)
    // Locked down goes on with less and asks about more; it never drops something into "never" or out of it.
    expect(unattendedPolicy('LOCKED_DOWN').never).toEqual(auto.never)
    expect(unattendedPolicy('LOCKED_DOWN').waits).toContain('Research the public web')
  })

  it('is part of what the window is told about a project, and is the same whoever asks and whenever', () => {
    const h = setup()
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    const overview = h.autonomy.overview(h.project.id)
    expect(overview.unattended).toEqual(unattendedPolicy('AUTONOMOUS_PROJECT'))
    expect(h.autonomy.overview(h.project.id, 'LOCKED_DOWN').unattended).toEqual(unattendedPolicy('LOCKED_DOWN'))
  })

  it('what gives lasting authority does not happen with nobody to confirm it', async () => {
    const h = setup(async () => false)
    await expect(h.handlers['autonomy.enroll']({ projectId: h.project.id, profile: 'AUTONOMOUS_PROJECT' })).rejects.toThrow(/confirmation was declined/)
    expect(h.autonomy.enrollment(h.project.id)).toBeNull()
    expect(h.asked).toEqual(['Enable autonomous work'])
  })

  it('a request met unattended waits, stored; allowing it for the mission or for the whole project is confirmed natively (0.9, review L-1)', async () => {
    let answer = false
    const h = setup(async () => answer)
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    const gate = h.autonomy.gateFor({ projectId: h.project.id, runId: 'run-1', taskId: 'task-1', role: 'worker', provider: null, cwd: null })
    const ask = () => gate?.resolve({ agentId: 'a', toolName: 'Bash', input: {}, toolUseId: 't' }, 'git push origin HEAD', [{ capability: 'GIT_PUSH', resource: { kind: 'ANY', value: '' }, why: 'pushes', inBoundary: false }])
    // Met three times while nobody is there: one stored request, and each attempt is refused at once.
    for (let i = 0; i < 3; i += 1) expect(ask()?.behavior).toBe('deny')
    expect(h.autonomy.pending()).toHaveLength(1)
    expect(h.autonomy.pending()[0]).toMatchObject({ capability: 'GIT_PUSH', occurrences: 3, state: 'PENDING' })
    const id = h.autonomy.pending()[0]?.id ?? ''
    // For the whole project: asked natively, and without a yes nothing changes.
    await expect(h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_PROJECT' })).rejects.toThrow(/confirmation was declined/)
    expect(h.autonomy.pending()).toHaveLength(1)
    // For the mission: asked natively too, and said as what it is. Without a yes nothing changes.
    await expect(h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_MISSION' })).rejects.toThrow(/confirmation was declined/)
    expect(h.autonomy.pending()).toHaveLength(1)
    expect(ask()?.behavior).toBe('deny')
    const before = h.asked.length
    answer = true
    expect(await h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_MISSION' })).toMatchObject({ state: 'GRANTED' })
    expect(h.asked.length).toBe(before + 1)
    expect(h.asked.at(-1)).toBe('Allow for this mission')
    expect(ask()?.behavior).toBe('allow')
  })
})
