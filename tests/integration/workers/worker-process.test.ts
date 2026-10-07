import { fork } from 'node:child_process'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentSessionHandle, SessionSpec, ToolDecision, ToolRequest } from '@main/modules/agent-runtime/types'
import { createRepositories, openDatabase } from '@main/modules/persistence'
import { killProcessTree } from '@main/modules/process'
import { forkLauncher, WorkerManager, type WorkerTimings } from '@main/modules/workers'
import { buildRuntime, processAlive, until, WORKER_ENTRY } from '../../helpers/runtime-process'

/**
 * The worker manager with real worker processes. Each session's prompt is a script (see
 * `workers/probe-script.ts`) that makes the worker speak, ask for a tool, wait, or die in a chosen way.
 */

function spec(agentId: string, prompt: string, overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    agentId,
    role: 'worker',
    cwd: process.cwd(),
    maxTurns: 10,
    systemPromptAppend: '',
    prompt,
    tools: ['Read', 'Bash'],
    authorize: async (): Promise<ToolDecision> => ({ behavior: 'allow' }),
    requestApproval: async () => true,
    loadProjectSettings: false,
    subscriptionMode: true,
    ...overrides,
  }
}

function collect(handle: AgentSessionHandle): { events: AgentEvent[]; done: Promise<AgentEvent[]> } {
  const events: AgentEvent[] = []
  const done = (async () => {
    for await (const event of handle.events) events.push(event)
    return events
  })()
  return { events, done }
}

const texts = (events: AgentEvent[]): string[] => events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text').map((e) => e.text)

const managers: WorkerManager[] = []

function manager(timings: Partial<WorkerTimings> = {}, maxWorkers = 2): { manager: WorkerManager; repos: ReturnType<typeof createRepositories> } {
  const repos = createRepositories(openDatabase(':memory:'))
  const created = new WorkerManager({
    workers: repos.workers,
    leases: repos.workerLeases,
    bootId: 'boot-test',
    launcher: forkLauncher({ entry: WORKER_ENTRY, killTree: killProcessTree }),
    config: () => ({ heartbeatMs: 100, fake: { script: 'probe' } }),
    maxWorkers: () => maxWorkers,
    timings: { heartbeatMs: 100, tickMs: 100, ...timings },
  })
  managers.push(created)
  return { manager: created, repos }
}

beforeAll(async () => {
  await buildRuntime()
}, 120_000)

afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown()
})

describe('a real worker process', () => {
  it('runs a session: text, a tool call decided by the runtime, a NEXUS tool, and a clean end', async () => {
    const { manager: m, repos } = manager()
    const asked: ToolRequest[] = []
    const handle = m.startSession(
      'claude',
      spec('agent-1', ['text:hello from the worker', 'tool:Bash:{"command":"powershell foo.ps1"}', 'tool:Read:{"file_path":"README.md"}', 'message:progress'].join('\n'), {
        authorize: async (request) => {
          asked.push(request)
          return request.toolName === 'Bash' ? { behavior: 'deny', reason: 'interpreter running agent-authored content' } : { behavior: 'allow' }
        },
        nexusTools: { sendMessage: async (input) => `recorded:${input.subject}`, reportBlocker: async () => 'ok', recordDecision: async () => 'ok', proposeMemory: async () => 'ok' },
      }),
    )
    const session = collect(handle)
    await until(
      () => texts(session.events),
      (t) => t.includes('message recorded:progress'),
      30_000,
      'the scripted turn',
    )
    const pid = m.overview().workers.find((w) => w.assignment?.agentId === 'agent-1')?.pid as number
    expect(pid).not.toBe(process.pid)
    expect(processAlive(pid)).toBe(true)
    expect(m.overview().workers[0]).toMatchObject({ state: 'RUNNING', capabilities: ['claude', 'codex'] })
    handle.end()
    const events = await session.done
    expect(texts(events)).toEqual(['hello from the worker', 'denied Bash', 'allowed Read', 'message recorded:progress'])
    expect(events.filter((e) => e.type === 'tool.denied')).toMatchObject([{ toolName: 'Bash', reason: 'interpreter running agent-authored content' }])
    expect(asked.map((r) => [r.agentId, r.toolName])).toEqual([
      ['agent-1', 'Bash'],
      ['agent-1', 'Read'],
    ])
    expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'completed' })
    expect(repos.workerLeases.listActive()).toEqual([])
    expect(repos.workerLeases.recent(5)[0]).toMatchObject({ state: 'RELEASED', agentId: 'agent-1' })
  }, 60_000)

  it('dies in the middle of a session: the session ends as crashed and a new worker takes the next one', async () => {
    const { manager: m, repos } = manager()
    const first = collect(m.startSession('claude', spec('agent-1', 'text:before the crash\nsleep:300\nexit:3')))
    const events = await first.done
    expect(texts(events)).toEqual(['before the crash'])
    expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
    const failed = repos.workers.listEnded(5)[0]
    expect(failed).toMatchObject({ state: 'FAILED', exitCode: 3 })
    expect(repos.workerLeases.recent(5)[0]).toMatchObject({ state: 'REVOKED' })

    const second = m.startSession('claude', spec('agent-1', 'text:after the crash'))
    const again = collect(second)
    await until(
      () => texts(again.events),
      (t) => t.includes('after the crash'),
      30_000,
      'the retry on a new worker',
    )
    const worker = m.overview().workers.find((w) => w.assignment?.agentId === 'agent-1')
    expect(worker?.id).not.toBe(failed?.id)
    second.end()
    expect((await again.done).at(-1)).toMatchObject({ type: 'session.ended', reason: 'completed' })
  }, 60_000)

  it('is killed from outside while its session waits: the lease is revoked and nothing is taken for done', async () => {
    const { manager: m, repos } = manager()
    const handle = m.startSession('claude', spec('agent-1', 'text:waiting on the model\nsleep:60000\ntext:never said'))
    const session = collect(handle)
    await until(
      () => texts(session.events),
      (t) => t.includes('waiting on the model'),
      30_000,
      'the session to start waiting',
    )
    const pid = m.overview().workers[0]?.pid as number
    process.kill(pid)
    const events = await session.done
    expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
    expect(texts(events)).toEqual(['waiting on the model'])
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false)
    expect(repos.workerLeases.listActive()).toEqual([])
    await until(
      () => processAlive(pid),
      (alive) => !alive,
      10_000,
      'the worker process to be gone',
    )
  }, 60_000)

  it('is killed while idle: it is recorded as failed and the next session gets another worker', async () => {
    const { manager: m, repos } = manager()
    const first = m.startSession('claude', spec('agent-1', 'text:one'))
    const one = collect(first)
    await until(
      () => texts(one.events),
      (t) => t.includes('one'),
      30_000,
      'the first session',
    )
    first.end()
    await one.done
    const idle = await until(
      () => m.overview().workers.find((w) => w.state === 'IDLE'),
      (w) => w !== undefined,
      10_000,
      'the worker to be idle',
    )
    process.kill(idle?.pid as number)
    await until(
      () => repos.workers.get(idle?.id as string)?.state,
      (state) => state === 'FAILED',
      10_000,
      'the idle worker to be recorded as failed',
    )
    const second = m.startSession('claude', spec('agent-2', 'text:two'))
    const two = collect(second)
    await until(
      () => texts(two.events),
      (t) => t.includes('two'),
      30_000,
      'the second session on a new worker',
    )
    expect(m.overview().workers.find((w) => w.assignment?.agentId === 'agent-2')?.id).not.toBe(idle?.id)
    second.end()
    await two.done
  }, 60_000)

  it('stops answering: after the heartbeat limit it is ended with its process, and the session ends as crashed', async () => {
    const { manager: m, repos } = manager({ heartbeatTimeoutMs: 1500 })
    const handle = m.startSession('claude', spec('agent-1', 'text:about to hang\nhang'))
    const session = collect(handle)
    await until(
      () => m.overview().workers[0]?.pid ?? null,
      (pid) => pid !== null,
      30_000,
      'the worker to start',
    )
    const pid = m.overview().workers[0]?.pid as number
    const events = await session.done
    expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
    expect(repos.workers.listEnded(5)[0]?.error).toContain('No heartbeat')
    expect(repos.workerLeases.recent(5)[0]).toMatchObject({ state: 'EXPIRED' })
    await until(
      () => processAlive(pid),
      (alive) => !alive,
      10_000,
      'the hung worker process to be ended',
    )
  }, 60_000)

  it('obeys stop in the middle of a wait, and the worker stays for the next session', async () => {
    const { manager: m } = manager()
    const handle = m.startSession('claude', spec('agent-1', 'text:long wait\nsleep:60000'))
    const session = collect(handle)
    await until(
      () => texts(session.events),
      (t) => t.includes('long wait'),
      30_000,
      'the session to wait',
    )
    const workerId = m.overview().workers[0]?.id
    await handle.stop()
    expect((await session.done).at(-1)).toMatchObject({ type: 'session.ended', reason: 'stopped' })
    const next = m.startSession('claude', spec('agent-2', 'text:next'))
    const second = collect(next)
    await until(
      () => texts(second.events),
      (t) => t.includes('next'),
      30_000,
      'the next session',
    )
    expect(m.overview().workers.find((w) => w.assignment?.agentId === 'agent-2')?.id).toBe(workerId)
    next.end()
    await second.done
  }, 60_000)

  it('refuses a tool call when the runtime cannot be asked, and ends itself when the runtime is gone', async () => {
    // A worker without a manager behind it: this test is its runtime, and then stops being one.
    const child = fork(WORKER_ENTRY, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    const messages: { t: string; [key: string]: unknown }[] = []
    child.on('message', (message) => messages.push(message as { t: string }))
    child.send({ t: 'init', workerId: 'w', config: { heartbeatMs: 100, fake: { script: 'probe' } } })
    await until(
      () => messages.some((m) => m.t === 'ready'),
      Boolean,
      30_000,
      'the worker to be ready',
    )
    child.send({ t: 'assign', leaseId: 'lease', provider: 'claude', spec: { agentId: 'a', role: 'worker', cwd: process.cwd(), maxTurns: 5, systemPromptAppend: '', prompt: 'tool:Bash:{"command":"echo hi"}\nsleep:60000', tools: ['Bash'], nexusTools: null, loadProjectSettings: false, subscriptionMode: true } })
    const call = await until(
      () => messages.find((m) => m.t === 'call'),
      (m) => m !== undefined,
      30_000,
      'the worker to ask for a decision',
    )
    // The runtime answers with a failure: the worker must not let the call through by itself.
    child.send({ t: 'callResult', id: call?.['id'], ok: false, error: 'policy engine unavailable' })
    const denied = await until(
      () => messages.find((m) => m.t === 'event' && (m['event'] as { type: string }).type === 'tool.denied'),
      (m) => m !== undefined,
      30_000,
      'the denial',
    )
    expect((denied?.['event'] as { reason: string }).reason).toContain('The runtime did not answer')

    const pid = child.pid as number
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    child.disconnect()
    expect(await exited).toBe(0)
    expect(processAlive(pid)).toBe(false)
  }, 60_000)
})
