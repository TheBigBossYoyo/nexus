import { describe, expect, it, vi } from 'vitest'
import type { Run, Task } from '@shared/domain'
import type { BrokerExecRequest, BrokerExecResult } from '@main/modules/privilege/broker-client'
import { PrivilegedPolicyEngine } from '@main/modules/privilege/policy'
import { PrivilegedReviewPipeline } from '@main/modules/privilege/review'
import { PrivilegeService, type BrokerHandle } from '@main/modules/privilege/service'
import { MemoryPrivilegeStore } from '@main/modules/privilege/store'
import { createPrivilegedTools } from '@main/modules/privilege/tools'
import type { ExtensionSession } from '@main/modules/research/tools'
import { PRIVILEGED_CAPABILITIES } from '@shared/privilege'

// 0.9.1 (second review, L9): a privileged_request that does not match the schema reaches the service through the
// tool, and leaves one REJECTED_BY_POLICY receipt with the session's requester. The service itself is in service.test.ts.

const SC = 'C:\\Windows\\System32\\sc.exe'

class FakeBroker implements BrokerHandle {
  alive = true
  elevated = true
  readonly exec = vi.fn(async (_req: BrokerExecRequest): Promise<BrokerExecResult> => ({ kind: 'result', exitCode: 0, durationMs: 1, timedOut: false, executable: SC, stagedSha256: null, leftoverEnded: 0, leftover: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }))
  async end(): Promise<void> {
    this.alive = false
  }
}

async function setup(opts: { noService?: boolean } = {}) {
  const store = new MemoryPrivilegeStore()
  const broker = new FakeBroker()
  const service: PrivilegeService = new PrivilegeService({
    store,
    policy: new PrivilegedPolicyEngine(() => ({ systemRoot: 'C:\\Windows', programFiles: 'C:\\Program Files', programFilesX86: 'C:\\Program Files (x86)', nexusScriptsDir: null, fixtureDir: 'C:\\nowhere', trustedHash: () => null, projectRoots: ['C:\\work'], sessionCapabilities: service.sessionCapabilities() })),
    review: new PrivilegedReviewPipeline({ providers: async () => ({ technical: { complete: async () => ({ verdict: 'APPROVE', risk: 'LOW', reason: 'ok', restrictions: [] }) } }) }),
    startBroker: async () => ({ ok: true, client: broker }),
  })
  await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
  const session: ExtensionSession = {
    run: { id: 'run-1', projectId: 'p1', prompt: 'RaceDeck telemetry\nthe rest of the mission' } as unknown as Run,
    task: { id: 'task-1', title: 'Install the toolchain' } as unknown as Task,
    agentId: 'agent-1',
    role: 'worker',
    cwd: 'C:\\work',
  }
  const tool = createPrivilegedTools({ service: () => (opts.noService ? null : service) })(session)
  if (tool === null) throw new Error('the worker has no privileged tool')
  return { service, store, broker, call: tool.call }
}

const valid = { capability: 'PROJECT_SERVICE_CONTROL', goal: 'Query a service', whyRequired: 'w', whyElevation: 'e', whyNoUnelevatedAlternative: 'n', executable: SC, args: ['query', 'x'] }

describe('privileged_request with arguments that do not match the schema', () => {
  const malformed: [string, unknown][] = [
    ['null', null],
    ['not an object', 'run sc.exe please'],
    ['an array', [1, 2]],
    ['a number', 42],
    ['an unknown key', { ...valid, shell: 'cmd /c whoami' }],
    ['missing fields', { capability: 'PROJECT_SERVICE_CONTROL' }],
    ['wrong types', { ...valid, args: 'query x', env: ['A'], timeoutMs: 'soon' }],
    ['an unknown capability', { ...valid, capability: 'ADMIN_SHELL' }],
  ]

  it.each(malformed)('%s gives exactly one REJECTED_BY_POLICY receipt with the session\'s requester', async (_name, args) => {
    const { store, broker, call } = await setup()
    const answer = await call({ name: 'privileged_request', args })
    expect(answer.startsWith('Not done')).toBe(true)
    expect(answer).toMatch(/REJECTED_BY_POLICY/)
    expect(store.receiptRows).toHaveLength(1)
    const r = store.receiptRows[0]
    expect(r).toMatchObject({
      outcome: 'REJECTED_BY_POLICY',
      projectId: 'p1',
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      role: 'WORKER',
      missionTitle: 'RaceDeck telemetry',
      taskTitle: 'Install the toolchain',
      provenance: 'agent tool call (worker)',
      reviews: [],
      precheck: { verdict: 'DENIED', forbidden: null },
    })
    expect(r?.precheck.reason).toMatch(/did not match the schema/)
    expect(r?.precheck.reason.length).toBeLessThanOrEqual(1600)
    expect(broker.exec).not.toHaveBeenCalled()
  })

  it('names an unknown capability MALFORMED_REQUEST and keeps a known one', async () => {
    const unknown = await setup()
    await unknown.call({ name: 'privileged_request', args: { ...valid, capability: 'ADMIN_SHELL' } })
    expect(unknown.store.receiptRows[0]?.capability).toBe('MALFORMED_REQUEST')
    const known = await setup()
    await known.call({ name: 'privileged_request', args: { capability: 'PROJECT_SERVICE_CONTROL' } })
    expect(known.store.receiptRows[0]?.capability).toBe('PROJECT_SERVICE_CONTROL')
  })

  it('records nothing for what is not a call of this tool', async () => {
    const { store, broker, call } = await setup()
    for (const input of [null, 'privileged_request', { name: 'research_search', args: { query: 'x' } }, { name: 'nope', args: valid }, { args: valid }]) {
      expect(await call(input)).toMatch(/^Not done: (Not a tool call\.|This session has no such tool\.)$/)
    }
    expect(store.receiptRows).toHaveLength(0)
    expect(broker.exec).not.toHaveBeenCalled()
  })

  it('without a privilege service, answers Not done and records nothing', async () => {
    const { store, broker, call } = await setup({ noService: true })
    expect(await call({ name: 'privileged_request', args: { capability: 'PROJECT_SERVICE_CONTROL' } })).toMatch(/^Not done: Invalid arguments for privileged_request/)
    expect(await call({ name: 'privileged_request', args: valid })).toBe('Not done: privilege sessions are not available in this build.')
    expect(store.receiptRows).toHaveLength(0)
    expect(broker.exec).not.toHaveBeenCalled()
  })

  it('a request that matches the schema is submitted as before', async () => {
    const { service, call } = await setup()
    const submit = vi.spyOn(service, 'submit')
    const rejectMalformed = vi.spyOn(service, 'rejectMalformed')
    await call({ name: 'privileged_request', args: valid })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ ...valid, env: {}, secretArgs: [], timeoutMs: 300_000 })
    expect(rejectMalformed).not.toHaveBeenCalled()
  })

  it('answers Not done when the service fails to refuse it', async () => {
    const { service, call } = await setup()
    vi.spyOn(service, 'rejectMalformed').mockRejectedValue(new Error('queue broken'))
    expect(await call({ name: 'privileged_request', args: null })).toBe('Not done: the request did not match the schema and was refused.')
  })
})
