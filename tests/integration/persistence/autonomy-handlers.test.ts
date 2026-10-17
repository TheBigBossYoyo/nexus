import { describe, expect, it } from 'vitest'
import { AutonomyService } from '@main/modules/autonomy/service'
import { createAutonomyHandlers } from '@main/modules/ipc/v8-handlers'
import { makeAgent, makeProject, makeRun, makeTask, openMemory } from './fixtures'

// What gives lasting authority is confirmed natively by the runtime. With no way to ask, it is not given; and
// what the user is asked to confirm says plainly how far it reaches.

function setup(confirm?: (title: string, message: string, detail: string) => Promise<boolean>) {
  const { repos, db } = openMemory()
  const project = repos.projects.insert(makeProject())
  const autonomy = new AutonomyService({ repos, runActive: () => true })
  const asked: { title: string; message: string; detail: string }[] = []
  const handlers = createAutonomyHandlers({
    autonomy,
    projectName: (id) => repos.projects.get(id)?.name ?? null,
    ...(confirm
      ? {
          confirm: (title: string, message: string, detail: string) => {
            asked.push({ title, message, detail })
            return confirm(title, message, detail)
          },
        }
      : {}),
  })
  const push = (action: string, input: Record<string, unknown> = { command: action }, resource: { kind: 'ANY' | 'GIT_REMOTE'; value: string } = { kind: 'ANY', value: '' }) =>
    autonomy.gateFor({ projectId: project.id, runId: 'run-1', taskId: 'task-1', role: 'worker', provider: null, cwd: null })?.resolve({ agentId: 'a', toolName: 'Bash', input, toolUseId: 't' }, action, [{ capability: 'GIT_PUSH', resource, why: 'pushes', inBoundary: false }])
  return { repos, db, project, autonomy, handlers, asked, push }
}

describe('autonomy handlers with no way to ask', () => {
  it('refuse a widening enrollment, with the text of a declined confirmation', async () => {
    const h = setup()
    await expect(h.handlers['autonomy.enroll']({ projectId: h.project.id, profile: 'AUTONOMOUS_PROJECT' })).rejects.toThrow(/confirmation was declined/)
    expect(h.autonomy.enrollment(h.project.id)).toBeNull()
  })

  it('refuse a grant for the project and a grant for the mission and leave the request pending; allowing the one action shown needs no confirmation (0.9, review L-1)', async () => {
    const h = setup()
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    h.push('git push origin HEAD')
    const id = h.autonomy.pending()[0]?.id ?? ''
    await expect(h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_PROJECT' })).rejects.toThrow(/confirmation was declined/)
    expect(h.autonomy.pending()).toHaveLength(1)
    expect(h.repos.capabilityGrants.list(h.project.id)).toEqual([])
    await expect(h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_MISSION' })).rejects.toThrow(/confirmation was declined/)
    expect(h.autonomy.pending()).toHaveLength(1)
    expect(h.repos.capabilityGrants.list(h.project.id)).toEqual([])
    expect(await h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_ONCE' })).toMatchObject({ state: 'GRANTED' })
  })

  it('work with an explicit confirmation that says yes', async () => {
    const h = setup(async () => true)
    await h.handlers['autonomy.enroll']({ projectId: h.project.id, profile: 'AUTONOMOUS_PROJECT' })
    h.push('git push origin HEAD')
    const id = h.autonomy.pending()[0]?.id ?? ''
    expect(await h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_PROJECT' })).toMatchObject({ state: 'GRANTED' })
  })
})

describe('the confirmation of an always-allow', () => {
  it('says that a request on any resource covers every such action in the project, and shows the action', async () => {
    const h = setup(async () => false)
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    h.push('git push origin release')
    const id = h.autonomy.pending()[0]?.id ?? ''
    await expect(h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_PROJECT' })).rejects.toThrow(/declined/)
    const detail = h.asked[0]?.detail ?? ''
    expect(detail).toContain('EVERY such action in the project')
    expect(detail).toContain('git push origin release')
  })

  it('names the resource when it is a narrow one', async () => {
    const h = setup(async () => false)
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    h.push('git push origin release', { command: 'git push origin release' }, { kind: 'GIT_REMOTE', value: 'origin' })
    const id = h.autonomy.pending()[0]?.id ?? ''
    await expect(h.handlers['autonomy.resolve']({ requestId: id, decision: 'ALLOW_PROJECT' })).rejects.toThrow(/declined/)
    expect(h.asked[0]?.detail).not.toContain('EVERY such action')
    expect(h.asked[0]?.detail).toContain('origin')
  })
})

describe('boundary requests of different actions', () => {
  it('the view says when the action shown was shortened, and the hash is stored', () => {
    const h = setup()
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    h.push(`${'git push origin '.padEnd(299, 'x')}…`)
    h.push('git push origin short')
    const views = h.autonomy.pending()
    expect(views.map((v) => v.actionTruncated)).toEqual([true, false])
    expect(views.every((v) => v.actionHash !== null && /^[0-9a-f]{64}$/.test(v.actionHash))).toBe(true)
  })

  it('the database keeps two pending requests of one need when the actions differ, and refuses a second one for the same action', () => {
    const h = setup()
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    h.push('git push origin a')
    h.push('git push origin b')
    h.push('git push origin a')
    const pending = h.repos.boundaryRequests.listPending(h.project.id)
    expect(pending).toHaveLength(2)
    expect(pending.map((p) => p.occurrences)).toEqual([2, 1])
    expect(() => h.repos.boundaryRequests.insert({ ...(pending[0] as (typeof pending)[number]), id: 'dup' })).toThrow()
    expect(h.repos.boundaryRequests.countForCapability(h.project.id, 'run-1', 'GIT_PUSH')).toBe(2)
  })
})

describe('who asked, in the view of a boundary request', () => {
  const ask = (h: ReturnType<typeof setup>, taskId: string, agentId: string) =>
    h.autonomy
      .gateFor({ projectId: h.project.id, runId: 'run-1', taskId, role: 'worker', provider: null, cwd: null })
      ?.resolve({ agentId, toolName: 'Bash', input: { command: 'git push' }, toolUseId: 't' }, 'git push', [{ capability: 'GIT_PUSH', resource: { kind: 'ANY', value: '' }, why: 'pushes', inBoundary: false }])

  it('carries the task title and the agent role from the repositories', () => {
    const h = setup()
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    const run = h.repos.runs.insert(makeRun(h.project.id))
    const task = h.repos.tasks.insert(makeTask(run.id, 'a', { title: `  ${'T'.repeat(300)}  `, role: 'worker' }))
    const agent = h.repos.agents.insert(makeAgent(run.id, task.id, { role: 'reviewer' }))
    ask(h, task.id, agent.id)
    const [view] = h.autonomy.pending()
    expect(view?.taskTitle).toBe('T'.repeat(120))
    expect(view?.agentRole).toBe('reviewer')
    h.autonomy.resolve({ requestId: view!.id, decision: 'DENY' })
    expect(h.autonomy.recent()[0]).toMatchObject({ taskTitle: 'T'.repeat(120), agentRole: 'reviewer' })
  })

  it('falls back to the role of the task, and gives null for rows that do not exist', () => {
    const h = setup()
    h.autonomy.enroll(h.project.id, 'AUTONOMOUS_PROJECT')
    const run = h.repos.runs.insert(makeRun(h.project.id))
    const task = h.repos.tasks.insert(makeTask(run.id, 'a', { role: 'verifier' }))
    ask(h, task.id, 'gone-agent')
    expect(h.autonomy.pending()[0]).toMatchObject({ taskTitle: 'Task a', agentRole: 'verifier' })
    h.push('git push origin other')
    const missing = h.autonomy.pending().find((v) => v.action.includes('other'))
    expect(missing).toMatchObject({ taskTitle: null, agentRole: null })
  })
})
