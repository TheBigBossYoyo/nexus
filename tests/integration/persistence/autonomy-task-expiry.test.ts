import { describe, expect, it } from 'vitest'
import { AutonomyService } from '@main/modules/autonomy/service'
import { makeProject, openMemory } from './fixtures'

// 0.9.1, measured in a real mission: a worker started the notes server in the shell and fetched it with curl, was
// refused, checked the application with the app tools instead and completed its task. Its request stayed pending,
// and with the tasks done the mission's progress read "Waiting for your decision on a boundary request" while the
// final checks ran.
function setup() {
  const { repos } = openMemory()
  const project = repos.projects.insert(makeProject())
  const autonomy = new AutonomyService({ repos, runActive: () => true })
  autonomy.enroll(project.id, 'AUTONOMOUS_PROJECT')
  const listeners: ((event: { type: string; runId: string; taskId?: string | null }) => void)[] = []
  autonomy.watch({ subscribe: (l) => void listeners.push(l) })
  const emit = (event: { type: string; runId: string; taskId?: string | null }) => listeners.forEach((l) => l(event))
  const fetchLocal = (taskId: string, command: string) =>
    autonomy
      .gateFor({ projectId: project.id, runId: 'run-1', taskId, role: 'worker', provider: null, cwd: null })
      ?.resolve({ agentId: 'a', toolName: 'Bash', input: { command }, toolUseId: 't' }, command, [
        { capability: 'EXTERNAL_HOST_NETWORK', resource: { kind: 'ANY', value: '' }, why: 'network operation (curl) to the local port 5051', inBoundary: false },
      ])
  return { autonomy, emit, fetchLocal }
}

describe('a boundary request of a task that completed', () => {
  it('points the agent at the app tools, and expires when its task completes (not when another does)', () => {
    const h = setup()
    const decision = h.fetchLocal('task-1', 'PORT=5051 node server.js & curl localhost:5051/api/notes')
    expect(decision).toMatchObject({ behavior: 'deny', reason: expect.stringContaining('mcp__nexus__app_launch') })
    h.fetchLocal('task-2', 'curl localhost:5051/')
    expect(h.autonomy.pending()).toHaveLength(2)
    h.emit({ type: 'task.completed', runId: 'run-1', taskId: 'task-1' })
    expect(h.autonomy.pending().map((r) => r.taskId)).toEqual(['task-2'])
    h.emit({ type: 'task.completed', runId: 'run-2', taskId: 'task-2' })
    expect(h.autonomy.pending()).toHaveLength(1)
  })
})
