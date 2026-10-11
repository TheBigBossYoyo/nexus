import { DEFAULT_PROVIDER_POLICY } from '@shared/provider'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcInputs, type AppInfo, type IpcChannel, type IpcInput } from '@shared/ipc'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT } from '@shared/overnight'
import { DEFAULT_WORKSPACE_POLICY } from '@shared/workspace'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { RunEvent } from '@shared/events'
import type { PushMessage } from '@shared/events'
import { NexusError } from '@shared/result'
import { completeWith } from '@main/modules/agent-runtime/fake-runtime'
import type { AgentRuntime } from '@main/modules/agent-runtime/types'
import { createIpcHandlers, dispatchIpc, type IpcContext } from '@main/modules/ipc/handlers'
import {
  createHarness,
  fileWorker,
  keyOf,
  plan,
  plannedTask,
  scenarioScript,
  type Harness,
} from '../../scenarios/harness'

const APP_INFO: AppInfo = {
  version: '0.0.0-test',
  dataDir: 'data',
  dbPath: 'data/nexus.db',
  worktreesDir: 'data/worktrees',
  platform: 'win32',
  gitVersion: '2.50.0',
  sdkVersion: 'fake',
  isPackaged: false,
}

/** One minimal valid input per channel. Typed so that adding a channel without an entry fails to compile. */
const VALID_INPUTS: { [C in IpcChannel]: IpcInput<C> } = {
  'chatgpt.status': {},
  'director.invoke': { projectId: 'p1', objective: 'Plan the next release', level: 2 },
  'compilation.projectSending': { projectId: 'p1' },
  'compilation.decide': { projectId: 'p1', specId: 's1', accept: [0] },
  'compilation.setProjectSending': { projectId: 'p1', allowed: false },
  'director.history': { projectId: 'p1' },
  'director.learning': { projectId: 'p1' },
  'director.escalate': {
    projectId: 'p1',
    objective: 'Review evidence',
    level: 3,
    reasons: ['CONFLICTING_EVIDENCE'],
  },
  'director.records': { projectId: 'p1' },
  'director.dismissEscalation': { projectId: 'p1', escalationId: 'es1' },
  'director.routing': { projectId: 'p1' },
  'director.advisoryUsage': { days: 7 },
  'chatgpt.connect': {},
  'chatgpt.select': { profileId: 'p1' },
  'chatgpt.models': {},
  'chatgpt.configure': { model: 'test', includedOnlyConfirmed: false },
  'chatgpt.disconnect': {},
  'chatgpt.cancelConnect': {},
  'chatgpt.recoverStorage': { discard: false },
  'chatgpt.manageUsage': {},
  'compilation.preview': { projectId: 'p1', raw: 'Fix typo', mode: 'EXACT' },
  'compilation.history': { projectId: 'p1' },
  'compilation.admission': { kind: 'PROGRAM', entityId: 'p1' },
  'compilation.validate': { projectId: 'p1', specId: 's1', raw: 'Fix typo', mode: 'EXACT' },
  'overnight.start': {
    projectId: 'p1',
    preset: 'balanced',
    prompt: 'do it',
    policy: DEFAULT_OVERNIGHT_POLICY,
    confirmed: true,
    confirmation: OVERNIGHT_CONFIRMATION_TEXT,
  },
  'overnight.startArena': {
    campaign: {
      name: 'c',
      caseIds: ['case-1'],
      strategies: ['SINGLE'],
      repetitions: 1,
      modelPreset: 'balanced',
      budgetPreset: 'eco',
    },
    policy: DEFAULT_OVERNIGHT_POLICY,
    confirmed: true,
    confirmation: OVERNIGHT_CONFIRMATION_TEXT,
  },
  'overnight.startProgram': {
    programId: 'pg1',
    policy: DEFAULT_OVERNIGHT_POLICY,
    confirmed: true,
    confirmation: OVERNIGHT_CONFIRMATION_TEXT,
  },
  'program.list': {},
  'program.get': { programId: 'pg1' },
  'program.presets': {},
  'program.create': { projectId: 'p1', name: 'Program', goal: 'A goal', preset: 'balanced' },
  'program.start': { programId: 'pg1' },
  'program.pause': { programId: 'pg1' },
  'program.resume': { programId: 'pg1' },
  'program.cancel': { programId: 'pg1' },
  'program.decidePlan': { programId: 'pg1', revisionId: 'rev1', accept: true },
  'program.replan': { programId: 'pg1', note: 'Add a milestone' },
  'backlog.list': {},
  'backlog.setStatus': { itemId: 'b1', status: 'accepted' },
  'background.settings': {},
  'background.setSettings': { settings: { enabled: false, kinds: [] } },
  'background.jobs': { projectId: 'p1' },
  'background.start': { projectId: 'p1', kind: 'test_gap_analysis' },
  'background.cancel': { jobId: 'j1' },
  'expertise.list': { projectId: 'p1' },
  'workspace.list': {},
  'workspace.get': { workspaceId: 'w1' },
  'workspace.create': { name: 'Platform' },
  'workspace.setPolicy': { workspaceId: 'w1', policy: DEFAULT_WORKSPACE_POLICY },
  'workspace.remove': { workspaceId: 'w1' },
  'workspace.enroll': { workspaceId: 'w1' },
  'workspace.refresh': { repositoryId: 'r1' },
  'workspace.unenroll': { repositoryId: 'r1' },
  'workspace.setRole': { repositoryId: 'r1', role: 'service' },
  'workspace.discover': { workspaceId: 'w1' },
  'workspace.addDependency': {
    workspaceId: 'w1',
    from: 'backend',
    to: 'shared-sdk',
    kind: 'package_dependency',
    detail: 'package.json',
  },
  'workspace.removeDependency': { dependencyId: 'd1' },
  'workspace.addService': { repositoryId: 'r1', name: 'API', description: 'The HTTP API' },
  'workspace.registerContract': {
    workspaceId: 'w1',
    key: 'order',
    name: 'Order',
    kind: 'json_schema',
    provider: 'shared-sdk',
    path: 'contracts/order.schema.json',
  },
  'workspace.addConsumer': { contractId: 'c1', repository: 'backend' },
  'workspace.captureContract': { contractId: 'c1' },
  'workspace.addMemory': {
    workspaceId: 'w1',
    kind: 'contract',
    title: 't',
    content: 'c',
    evidence: 'e',
    repositories: ['backend', 'shared-sdk'],
  },
  'workspace.createMission': { workspaceId: 'w1', goal: 'Change the contract' },
  'workspace.mission': { missionId: 'm1' },
  'workspace.startMission': { missionId: 'm1' },
  'workspace.decidePlan': { missionId: 'm1', accept: true },
  'workspace.pauseMission': { missionId: 'm1' },
  'workspace.resumeMission': { missionId: 'm1' },
  'workspace.cancelMission': { missionId: 'm1' },
  'workspace.createProgram': {
    workspaceId: 'w1',
    program: {
      name: 'Currency',
      goal: 'Multi-currency orders',
      milestones: [{ title: 'Contract', goal: 'Add the currency field' }],
    },
  },
  'workspace.startProgram': { programId: 'wp1' },
  'workspace.resumeProgram': { programId: 'wp1' },
  'workspace.cancelProgram': { programId: 'wp1' },
  'workspace.prepareRelease': { missionId: 'm1' },
  'workspace.publishRelease': { trainId: 't1' },
  'workspace.cancelRelease': { trainId: 't1' },
  'providers.overview': {},
  'providers.refresh': {},
  'providers.setPolicy': { policy: DEFAULT_PROVIDER_POLICY },
  'providers.probe': { provider: 'codex' },
  'providers.sessions': { runId: 'r1' },
  'control.overview': {},
  'control.enqueue': { item: { type: 'program', programId: 'p1' } },
  'control.setPriority': { itemId: 'i1', priority: 'P0' },
  'control.move': { itemId: 'i1', where: 'top' },
  'control.pause': { itemId: 'i1' },
  'control.resume': { itemId: 'i1' },
  'control.cancel': { itemId: 'i1' },
  'control.setLimits': { limits: { maxAgents: 6, maxActiveItems: 4, resumeOnBoot: 'hold' } },
  'control.createSchedule': {
    schedule: {
      name: 'Nightly',
      rule: { kind: 'daily', time: '22:00' },
      action: { type: 'program', programId: 'p1' },
      priority: 'P2',
      enabled: true,
    },
  },
  'control.setScheduleEnabled': { scheduleId: 's1', enabled: false },
  'control.removeSchedule': { scheduleId: 's1' },
  'control.decisions': { itemId: 'i1' },
  'runtime.status': {},
  'runtime.workers': {},
  'runtime.workerSelfTest': {},
  'runtime.tray': {},
  'runtime.setDispatchPaused': { paused: true },
  'runtime.stop': {},
  'desktop.connection': {},
  'desktop.reconnect': {},
  'security.decisions': { limit: 50 },
  'autonomy.status': {},
  'autonomy.overview': { projectId: 'p1' },
  'autonomy.enroll': { projectId: 'p1', profile: 'AUTONOMOUS_PROJECT' },
  'autonomy.unenroll': { projectId: 'p1' },
  'autonomy.pending': {},
  'autonomy.recent': {},
  'autonomy.resolve': { requestId: 'r1', decision: 'DENY' },
  'autonomy.revokeGrant': { grantId: 'g1' },
  'autonomy.audit': { limit: 20 },
  'knowledge.health': { projectId: 'p1' },
  'knowledge.tree': {
    projectId: 'p1',
    space: { kind: 'workspace', id: 'w1' },
    parentId: 'n1',
    includeHistory: true,
    offset: 0,
  },
  'knowledge.node': { projectId: 'p1', nodeId: 'n1' },
  'knowledge.search': { projectId: 'p1', query: 'parser' },
  'knowledge.refresh': { projectId: 'p1' },
  'knowledge.confirm': { projectId: 'p1', nodeId: 'n1' },
  'knowledge.writeNote': { projectId: 'p1', title: 'Note', body: 'A statement.' },
  'knowledge.promote': { projectId: 'p1', nodeId: 'n1' },
  'knowledge.archive': { projectId: 'p1', nodeId: 'n1', reason: 'obsolete' },
  'knowledge.supersede': { projectId: 'p1', olderId: 'n1', newerId: 'n2', reason: 'replaced' },
  'tokens.overview': { days: 7 },
  'tokens.agent': { agentId: 'a1' },
  'tokens.run': { runId: 'r1' },
  'overnight.startWorkspaceMission': {
    missionId: 'm1',
    policy: DEFAULT_OVERNIGHT_POLICY,
    confirmed: true,
    confirmation: OVERNIGHT_CONFIRMATION_TEXT,
  },
  'overnight.get': { runId: 'r1' },
  'overnight.active': {},
  'overnight.cancelPower': { runId: 'r1' },
  'overnight.changeEndAction': { runId: 'r1', endAction: 'NONE' },
  'overnight.extend': { runId: 'r1', minutes: 30 },
  'overnight.cancelMission': { runId: 'r1' },
  'overnight.report': { runId: 'r1' },
  'overnight.audit': { runId: 'r1' },
  'overnight.checkpoints': { runId: 'r1' },
  'usage.overview': {},
  'usage.totals': {},
  'usage.breakdown': { by: 'model' },
  'usage.limitHistory': {},
  'usage.run': { runId: 'r1' },
  'usage.efficiency': {},
  'usage.refresh': {},
  'usage.resumeNow': {},
  'usage.endWait': {},
  'arena.cases': {},
  'arena.status': {},
  'arena.cleanup': { campaignId: 'c1' },
  'arena.importCase': {},
  'arena.trustCase': { caseVersionId: 'v1' },
  'arena.campaigns': {},
  'arena.createCampaign': {
    name: 'c',
    caseIds: ['case-a'],
    strategies: ['SINGLE', 'BUILD'],
    repetitions: 1,
    modelPreset: 'balanced',
    budgetPreset: 'eco',
  },
  'arena.campaign': { campaignId: 'c1' },
  'arena.trials': { campaignId: 'c1' },
  'arena.trial': { trialId: 't1' },
  'arena.start': { campaignId: 'c1' },
  'arena.pause': { campaignId: 'c1' },
  'arena.resume': { campaignId: 'c1' },
  'arena.cancel': { campaignId: 'c1' },
  'arena.results': {},
  'policy.overview': {},
  'policy.snapshot': { snapshotId: 's1' },
  'policy.compare': { a: 's1', b: 's2' },
  'policy.learn': {},
  'policy.promote': { candidateId: 'c1' },
  'policy.reject': { candidateId: 'c1' },
  'policy.rollback': {},
  'policy.pin': { snapshotId: null },
  'policy.setConfig': { exploration: 'off' },
  'policy.decisions': {},
  'policy.preview': { projectId: 'p1', prompt: 'fix it' },
  'policy.run': { runId: 'r1' },
  'speculative.list': { runId: 'r1' },
  'home.summary': {},
  'activity.recent': {},
  'app.info': {},
  'app.openDataDir': {},
  'auth.status': {},
  'auth.models': {},
  'settings.get': {},
  'settings.update': { settings: DEFAULT_SETTINGS },
  'projects.list': {},
  'projects.open': { path: 'C:\\somewhere' },
  'projects.get': { projectId: 'p1' },
  'projects.reprofile': { projectId: 'p1' },
  'projects.update': { projectId: 'p1', respectProjectClaudeConfig: true },
  'projects.remove': { projectId: 'p1' },
  'runs.list': {},
  'runs.get': { runId: 'r1' },
  'runs.create': { projectId: 'p1', mode: 'build', preset: 'balanced', prompt: 'do it' },
  'runs.approvePlan': { runId: 'r1' },
  'runs.replan': { runId: 'r1', feedback: 'again' },
  'runs.pause': { runId: 'r1' },
  'runs.resume': { runId: 'r1' },
  'runs.cancel': { runId: 'r1' },
  'runs.summary': { runId: 'r1' },
  'runs.diff': { runId: 'r1' },
  'runs.recoverable': {},
  'runs.recover': { runId: 'r1', action: 'resume' },
  'runs.cleanup': { runId: 'r1' },
  'tasks.retry': { taskId: 't1' },
  'tasks.cancel': { taskId: 't1' },
  'tasks.setPriority': { taskId: 't1', priority: 5 },
  'tasks.add': {
    runId: 'r1',
    title: 'T',
    description: 'D',
    role: 'worker',
    dependsOn: [],
    suggestedFiles: [],
    acceptanceCriteria: ['c'],
    complexity: 'small',
  },
  'tasks.instruct': { taskId: 't1', instruction: 'go' },
  'tasks.resolveBlocker': { taskId: 't1', note: '' },
  'tasks.diff': { taskId: 't1' },
  'tasks.reviews': { taskId: 't1' },
  'tasks.verifications': { taskId: 't1' },
  'criteria.update': { criterionId: 'c1', text: 'new' },
  'agents.get': { agentId: 'a1' },
  'agents.stop': { agentId: 'a1' },
  'agents.output': { agentId: 'a1' },
  'agents.tools': { agentId: 'a1' },
  'messages.list': { runId: 'r1' },
  'events.list': { runId: 'r1' },
  'reviews.list': { runId: 'r1' },
  'verifications.list': { runId: 'r1' },
  'decisions.list': { runId: 'r1' },
  'approvals.pending': {},
  'approvals.resolve': { approvalId: 'ap1', approve: true },
  'memory.list': {},
  'memory.add': { scope: 'global', title: 't', content: 'c', tags: [] },
  'memory.setStatus': { memoryId: 'm1', status: 'approved' },
  'memory.delete': { memoryId: 'm1' },
  'graph.revisions': { runId: 'r1' },
  'graph.proposals': { runId: 'r1' },
  'planning.candidates': { runId: 'r1' },
  'planning.recommend': { projectId: 'p1', prompt: 'Refactor everything' },
  'routing.list': { runId: 'r1' },
  'performance.summary': { projectId: 'p1' },
  'intelligence.list': { projectId: 'p1', query: 'router', includeStale: false },
  'intelligence.refresh': { projectId: 'p1' },
  'context.packs': { taskId: 't1', agentId: 'a1' },
}

const CHANNELS = Object.keys(ipcInputs) as IpcChannel[]

/** Inputs no channel accepts: wrong container types and values the schemas must refuse. */
const JUNK: unknown[] = [
  'junk',
  42,
  true,
  [],
  [1, 2],
  { __proto__: null, x: 1 },
  { unknownKey: 1 },
  { runId: { nested: true } },
  { taskId: 12 },
  { path: 7 },
]

type SpyHandlers = Record<IpcChannel, ReturnType<typeof vi.fn>>

function spyHandlers(): SpyHandlers {
  return Object.fromEntries(CHANNELS.map((c) => [c, vi.fn(() => null)])) as SpyHandlers
}

describe('IPC dispatch contract', () => {
  it('has a valid example input for every channel, and handlers for exactly the contract channels', async () => {
    for (const channel of CHANNELS) {
      expect(ipcInputs[channel].safeParse(VALID_INPUTS[channel]).success, channel).toBe(true)
    }
    const h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('x')]) }) })
    try {
      const handlers = createIpcHandlers(makeContext(h, []))
      expect(Object.keys(handlers).sort()).toEqual([...CHANNELS].sort())
    } finally {
      await h.dispose()
    }
  })

  it('rejects an unknown channel without invoking any handler', async () => {
    const spies = spyHandlers()
    for (const channel of [
      'nope',
      'runs.delete',
      '',
      'toString',
      '__proto__',
      'constructor',
      'runs.get ',
      'RUNS.GET',
      42,
      null,
      undefined,
      {},
      ['runs.get'],
    ]) {
      const result = await dispatchIpc(spies as never, channel, { runId: 'r1' })
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'Unknown IPC channel' },
      })
    }
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled()
  })

  it.each(CHANNELS)(
    '%s rejects malformed input and unknown extra keys without invoking its handler',
    async (channel) => {
      const spies = spyHandlers()
      const malformed: unknown[] = [
        ...JUNK,
        { ...VALID_INPUTS[channel], __extra__: 'surprise' },
        { ...VALID_INPUTS[channel], constructor: 1 },
      ]
      // A channel that takes no fields still must refuse any field; one with required fields refuses an empty object.
      if (!ipcInputs[channel].safeParse({}).success) malformed.push({}, null, undefined)
      // Right keys, wrong value types.
      for (const [key, value] of Object.entries(VALID_INPUTS[channel])) {
        const wrong =
          typeof value === 'string'
            ? 123
            : typeof value === 'number'
              ? 'NaN'
              : typeof value === 'boolean'
                ? 'yes'
                : { not: 'valid' }
        malformed.push({ ...VALID_INPUTS[channel], [key]: wrong })
      }
      for (const input of malformed) {
        const result = await dispatchIpc(spies as never, channel, input)
        expect(result.ok, `${channel} accepted ${JSON.stringify(input)}`).toBe(false)
        if (!result.ok) expect(result.error.code).toBe('invalid_input')
      }
      expect(spies[channel]).not.toHaveBeenCalled()
    },
  )

  it('invokes the handler with the parsed input for valid requests, and treats a missing input as {}', async () => {
    const spies = spyHandlers()
    for (const channel of CHANNELS) {
      const result = await dispatchIpc(spies as never, channel, VALID_INPUTS[channel])
      expect(result, channel).toEqual({ ok: true, value: null })
      expect(spies[channel], channel).toHaveBeenCalledTimes(1)
    }
    expect((await dispatchIpc(spies as never, 'projects.list', undefined)).ok).toBe(true)
    expect((await dispatchIpc(spies as never, 'projects.list', null)).ok).toBe(true)
    expect(spies['runs.get']).toHaveBeenCalledTimes(1)
    // Strings are limited: an over-long id and an out-of-range number are refused.
    expect((await dispatchIpc(spies as never, 'runs.get', { runId: 'x'.repeat(65) })).ok).toBe(
      false,
    )
    expect(
      (await dispatchIpc(spies as never, 'tasks.setPriority', { taskId: 't', priority: 1000 })).ok,
    ).toBe(false)
    expect((await dispatchIpc(spies as never, 'events.list', { runId: 'r', limit: 0 })).ok).toBe(
      false,
    )
    expect(
      (
        await dispatchIpc(spies as never, 'runs.create', {
          ...VALID_INPUTS['runs.create'],
          mode: 'chaos',
        })
      ).ok,
    ).toBe(false)
    expect(spies['runs.get']).toHaveBeenCalledTimes(1)
  })

  it('maps handler errors to { ok:false, error:{ code, message } }, keeping NexusError codes', async () => {
    const spies = spyHandlers()
    spies['runs.get']?.mockImplementation(() => {
      throw new NexusError('invalid_state', 'Run is not paused')
    })
    spies['runs.pause']?.mockImplementation(() =>
      Promise.reject(new NexusError('git_conflict', 'conflict!', { files: ['a'] })),
    )
    spies['runs.resume']?.mockImplementation(() => {
      throw new Error('boom: disk on fire')
    })
    spies['runs.cancel']?.mockImplementation(() => Promise.reject('a thrown string'))
    expect(await dispatchIpc(spies as never, 'runs.get', { runId: 'r' })).toEqual({
      ok: false,
      error: { code: 'invalid_state', message: 'Run is not paused' },
    })
    expect(await dispatchIpc(spies as never, 'runs.pause', { runId: 'r' })).toEqual({
      ok: false,
      error: { code: 'git_conflict', message: 'conflict!' },
    })
    expect(await dispatchIpc(spies as never, 'runs.resume', { runId: 'r' })).toEqual({
      ok: false,
      error: { code: 'internal', message: 'boom: disk on fire' },
    })
    expect(await dispatchIpc(spies as never, 'runs.cancel', { runId: 'r' })).toEqual({
      ok: false,
      error: { code: 'internal', message: 'a thrown string' },
    })
  })
})

function makeContext(
  h: Harness,
  pushed: PushMessage[],
  overrides: Partial<IpcContext> = {},
): IpcContext {
  return {
    repos: h.repos,
    git: h.git,
    runtime: h.runtime,
    orchestrator: h.orchestrator,
    appInfo: () => Promise.resolve(APP_INFO),
    pickDirectory: () => Promise.resolve(null),
    openDataDir: () => Promise.resolve(),
    push: (m) => void pushed.push(m),
    ...overrides,
  }
}

describe('IPC against a real orchestrator with the fake runtime', () => {
  let h: Harness
  let pushed: PushMessage[]
  let call: <C extends IpcChannel>(
    channel: C,
    input?: IpcInput<C>,
  ) => Promise<
    { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
  >

  /** Calls a channel and returns its value, failing the test with the error otherwise. */
  async function value<T>(channel: IpcChannel, input?: unknown): Promise<T> {
    const result = await dispatchIpc(handlers, channel, input)
    if (!result.ok)
      throw new Error(`${channel} failed: ${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
  let handlers: ReturnType<typeof createIpcHandlers>

  beforeEach(async () => {
    pushed = []
    const worker = async (...args: Parameters<typeof fileWorker>): Promise<void> => {
      const [spec, ctx] = args
      for (let i = 1; i <= 5; i++) await ctx.emitText(`${keyOf(spec)} progress ${i}`)
      await fileWorker(spec, ctx)
    }
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('alpha'), plannedTask('beta', { dependencies: ['alpha'] })]),
        worker,
      }),
    })
    handlers = createIpcHandlers(makeContext(h, pushed))
    call = (channel, input) => dispatchIpc(handlers, channel, input ?? {}) as never
  })
  afterEach(async () => h?.dispose())
  it('blocks an unavailable Overnight compilation before native authorization or power arming', async () => {
    const start = vi.fn(),
      confirmPower = vi.fn(async () => true)
    const local = createIpcHandlers(
      makeContext(h, [], {
        overnight: { start } as unknown as NonNullable<IpcContext['overnight']>,
        confirmPower,
      }),
    )
    const result = await dispatchIpc(local, 'overnight.start', {
      ...VALID_INPUTS['overnight.start'],
      projectId: h.project.id,
      prompt: '  Add a leaderboard\n',
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    expect(start).not.toHaveBeenCalled()
    expect(confirmPower).not.toHaveBeenCalled()
    expect(h.repos.intelligenceArtifacts.listCompilations(h.project.id)[0]?.rawIntent).toBe(
      '  Add a leaderboard\n',
    )
  })
  it('passes only a validated exact specification to the Overnight supervisor', async () => {
    const start = vi.fn(async () => ({ run: { id: 'test' }, overnight: {} }))
    const local = createIpcHandlers(
      makeContext(h, [], {
        overnight: { start } as unknown as NonNullable<IpcContext['overnight']>,
      }),
    )
    const raw = '  Add a leaderboard\n'
    expect(
      (
        await dispatchIpc(local, 'overnight.start', {
          ...VALID_INPUTS['overnight.start'],
          projectId: h.project.id,
          prompt: raw,
          compilationMode: 'EXACT',
        })
      ).ok,
    ).toBe(true)
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: raw,
        compiledTaskSpec: expect.objectContaining({
          rawIntent: raw,
          mode: 'EXACT',
          status: 'READY',
        }),
      }),
    )
  })
  it('rejects a repository change between admission and run insertion', async () => {
    const expectedHead = await h.git.headCommit(h.project.rootPath)
    const head = vi
      .spyOn(h.git, 'headCommit')
      .mockResolvedValueOnce(expectedHead)
      .mockResolvedValueOnce('different-head')
    try {
      await expect(
        h.orchestrator.createRun({
          projectId: h.project.id,
          mode: 'build',
          preset: 'balanced',
          prompt: 'Snapshot-sensitive task',
          expectedHead,
        }),
      ).rejects.toThrow('changed after compilation')
      expect(h.repos.runs.listByProject(h.project.id)).toEqual([])
    } finally {
      head.mockRestore()
    }
  })

  it('projects.open → runs.create → runs.get → approvals.pending → summary, diffs, agent output and event paging', async () => {
    // projects.open profiles the real repository and registers it (or returns the existing project).
    const project = await value<{
      id: string
      rootPath: string
      profile: { isGitRepo: boolean; currentBranch: string | null }
    }>('projects.open', { path: h.repoDir })
    expect(project.profile.isGitRepo).toBe(true)
    expect(project.profile.currentBranch).toBe('main')
    expect(await value<unknown[]>('projects.list')).toContainEqual(
      expect.objectContaining({ id: project.id }),
    )
    expect(await value('projects.get', { projectId: project.id })).toMatchObject({ id: project.id })
    expect(await value('projects.open', {})).toBeNull() // the folder picker was cancelled

    const created = await value<{ id: string; state: string }>('runs.create', {
      compilationMode: 'EXACT',
      projectId: project.id,
      mode: 'build',
      preset: 'balanced',
      prompt: 'Create alpha and beta',
      maxParallelAgents: 2,
    })
    expect(created.state).toBe('planning')
    expect((await h.waitForState(created.id, ['completed', 'failed', 'paused'])).state).toBe(
      'completed',
    )
    expect(h.repos.runs.require(created.id).config.maxParallelAgents).toBe(2)

    const detail = await value<{
      run: { state: string }
      tasks: { id: string; key: string; state: string }[]
      dependencies: unknown[]
      agents: { id: string; role: string; taskId: string | null }[]
      criteria: unknown[]
      worktrees: unknown[]
      pendingApprovals: unknown[]
    }>('runs.get', { runId: created.id })
    expect(detail.run.state).toBe('completed')
    expect(detail.tasks.map((t) => [t.key, t.state])).toEqual([
      ['alpha', 'completed'],
      ['beta', 'completed'],
    ])
    expect(detail.dependencies).toHaveLength(1)
    expect(detail.agents.length).toBeGreaterThanOrEqual(7)
    expect(detail.criteria.length).toBeGreaterThanOrEqual(3)
    expect(detail.worktrees).toHaveLength(3)
    expect(detail.pendingApprovals).toEqual([])
    expect(await value('approvals.pending')).toEqual([])
    expect(await value<unknown[]>('runs.list', { projectId: project.id })).toHaveLength(1)

    // Summary is assembled from durable state and git.
    const summary = await value<Record<string, unknown>>('runs.summary', { runId: created.id })
    expect(summary).toMatchObject({
      runId: created.id,
      tasksTotal: 2,
      tasksCompleted: 2,
      tasksFailed: 0,
      reviewsTotal: 2,
      reviewsApproved: 2,
      verificationsPassed: 3,
      filesChanged: 2,
    })
    expect(summary['commits']).toBeGreaterThanOrEqual(2)
    expect(summary['agentSessions']).toBeGreaterThanOrEqual(7)
    expect(summary['costUsd']).toBeGreaterThan(0)

    // Run diff = integration branch against the base commit.
    const runDiff = await value<{
      scope: string
      files: { path: string; status: string }[]
      patch: string
      base: string
      head: string
    }>('runs.diff', { runId: created.id })
    expect(runDiff.scope).toBe('run')
    expect(runDiff.files.map((f) => f.path).sort()).toEqual(['alpha.txt', 'beta.txt'])
    expect(runDiff.files.every((f) => f.status === 'added')).toBe(true)
    expect(runDiff.patch).toContain('+alpha')
    expect(runDiff.head).toBe(h.repos.runs.require(created.id).integrationBranch)

    // Task diff shows exactly that task's change, also after it was merged.
    const alpha = detail.tasks.find((t) => t.key === 'alpha')
    const taskDiff = await value<{ scope: string; files: { path: string }[]; patch: string }>(
      'tasks.diff',
      { taskId: alpha?.id },
    )
    expect(taskDiff.scope).toBe('task')
    expect(taskDiff.files.map((f) => f.path)).toEqual(['alpha.txt'])
    expect(taskDiff.patch).toContain('+alpha')

    // Task-level records.
    expect(await value<unknown[]>('tasks.reviews', { taskId: alpha?.id })).toHaveLength(1)
    expect(
      (await value<{ kind: string }[]>('tasks.verifications', { taskId: alpha?.id }))
        .map((v) => v.kind)
        .sort(),
    ).toEqual(['checks', 'verifier'])
    expect(await value<unknown[]>('reviews.list', { runId: created.id })).toHaveLength(2)
    expect(
      (await value<unknown[]>('verifications.list', { runId: created.id })).length,
    ).toBeGreaterThanOrEqual(5)
    expect(await value('decisions.list', { runId: created.id })).toEqual([])
    expect(await value('messages.list', { runId: created.id })).toEqual([])

    // Agent output paging: ascending, gapless sequence numbers, resumable with afterSeq.
    const worker = detail.agents.find((a) => a.taskId === alpha?.id && a.role === 'worker')
    const all = await value<{ seq: number; content: string }[]>('agents.output', {
      agentId: worker?.id,
    })
    expect(all.map((o) => o.seq)).toEqual([1, 2, 3, 4, 5])
    expect(all[0]?.content).toBe('alpha progress 1')
    const page1 = await value<{ seq: number }[]>('agents.output', { agentId: worker?.id, limit: 2 })
    const page2 = await value<{ seq: number }[]>('agents.output', {
      agentId: worker?.id,
      afterSeq: 2,
      limit: 2,
    })
    const page3 = await value<{ seq: number }[]>('agents.output', {
      agentId: worker?.id,
      afterSeq: 4,
    })
    expect([...page1, ...page2, ...page3].map((o) => o.seq)).toEqual([1, 2, 3, 4, 5])
    expect(await value('agents.output', { agentId: worker?.id, afterSeq: 5 })).toEqual([])
    expect(
      (
        await value<{ toolName: string; status: string }[]>('agents.tools', { agentId: worker?.id })
      ).map((t) => [t.toolName, t.status]),
    ).toEqual([['Write', 'completed']])
    const agentDetail = await value<{
      agent: { id: string }
      sessions: unknown[]
      task: { key: string } | null
    }>('agents.get', { agentId: worker?.id })
    expect(agentDetail.agent.id).toBe(worker?.id)
    expect(agentDetail.sessions).toHaveLength(1)
    expect(agentDetail.task?.key).toBe('alpha')
    // Streaming output was pushed to the renderer as it happened.
    expect(
      h.pushes.filter((m) => m.kind === 'agent.output' && m.agentId === worker?.id),
    ).toHaveLength(5)

    // Event paging: stable ascending order, no gaps or duplicates across pages, same as an unpaged read.
    const everything = await value<RunEvent[]>('events.list', { runId: created.id })
    expect(everything.length).toBeGreaterThan(50)
    expect(everything.map((e) => e.seq)).toEqual(
      [...everything.map((e) => e.seq)].sort((a, b) => a - b),
    )
    const paged: RunEvent[] = []
    for (let after = 0; ;) {
      const page = await value<RunEvent[]>('events.list', {
        runId: created.id,
        afterSeq: after,
        limit: 7,
      })
      if (page.length === 0) break
      expect(page.length).toBeLessThanOrEqual(7)
      paged.push(...page)
      after = page.at(-1)?.seq ?? after
    }
    expect(paged.map((e) => e.id)).toEqual(everything.map((e) => e.id))
    expect(everything[0]?.type).toBe('run.created')
    expect(everything.at(-1)?.type).toBe('run.completed')
  })

  it('exercises the control channels: approvals, pause/resume/cancel, task controls, memory, settings, projects', async () => {
    const project = h.project
    // A run that waits for plan approval shows up in approvals.pending and is released through approvals.resolve.
    const waiting = await value<{ id: string }>('runs.create', {
      compilationMode: 'EXACT',
      projectId: project.id,
      mode: 'build',
      preset: 'balanced',
      prompt: 'Needs a plan review',
      requirePlanApproval: true,
    })
    await h.waitForState(waiting.id, 'awaiting_approval')
    const pending = await value<{ id: string; kind: string; runId: string }[]>('approvals.pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ kind: 'plan', runId: waiting.id })
    expect(
      (await value<{ pendingApprovals: unknown[] }>('runs.get', { runId: waiting.id }))
        .pendingApprovals,
    ).toHaveLength(1)

    const resolved = await value<{ status: string }>('approvals.resolve', {
      approvalId: pending[0]?.id,
      approve: true,
      note: 'looks good',
    })
    expect(resolved.status).toBe('approved')
    expect((await h.waitForState(waiting.id, ['completed', 'failed', 'paused'])).state).toBe(
      'completed',
    )
    expect(await value('approvals.pending')).toEqual([])
    // A second resolution is an invalid_state error, an unknown id is not_found.
    expect(
      await call('approvals.resolve', { approvalId: pending[0]?.id ?? '', approve: false }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    expect(await call('approvals.resolve', { approvalId: 'missing', approve: true })).toMatchObject(
      { ok: false, error: { code: 'not_found' } },
    )

    // Lifecycle errors keep their codes.
    expect(await call('runs.pause', { runId: waiting.id })).toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    })
    expect(await call('runs.resume', { runId: waiting.id })).toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    })
    expect(await call('runs.get', { runId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
    expect(
      await call('tasks.retry', { taskId: h.repos.tasks.listByRun(waiting.id)[0]?.id ?? '' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    expect(
      await call('tasks.cancel', { taskId: h.repos.tasks.listByRun(waiting.id)[0]?.id ?? '' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    expect(await call('runs.recover', { runId: 'missing', action: 'resume' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
    expect(await call('projects.open', { path: `${h.dir}\\does-not-exist` })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
    // Only absolute local paths are opened: UNC, device and relative paths are refused before any filesystem access.
    for (const bad of [
      '\\\\host\\share\\repo',
      '//host/share/repo',
      '\\\\?\\C:\\repo',
      '\\\\.\\pipe\\x',
      'relative/dir',
      '..\\other',
      '\\rooted-no-drive',
    ]) {
      expect(await call('projects.open', { path: bad }), bad).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
    }

    // Replan, pause and cancel through the channels.
    h.runtime.script = scenarioScript({ plan: plan([plannedTask('later')]) })
    const second = await value<{ id: string }>('runs.create', {
      compilationMode: 'EXACT',
      projectId: project.id,
      mode: 'build',
      preset: 'balanced',
      prompt: 'Another',
      requirePlanApproval: true,
    })
    await h.waitForState(second.id, 'awaiting_approval')
    expect(
      await value<{ state: string }>('runs.replan', {
        runId: second.id,
        feedback: 'smaller please',
        compilationMode: 'EXACT',
      }),
    ).toMatchObject({ state: 'planning' })
    await h.waitFor(
      () => h.repos.runs.require(second.id).state === 'awaiting_approval',
      'the revised plan',
    )
    expect(await value<{ state: string }>('runs.pause', { runId: second.id })).toMatchObject({
      state: 'paused',
    })
    expect(await value<{ state: string }>('runs.resume', { runId: second.id })).toMatchObject({
      state: 'awaiting_approval',
    })
    expect(await value<{ state: string }>('runs.cancel', { runId: second.id })).toMatchObject({
      state: 'cancelled',
    })
    expect(await value('runs.recoverable')).toEqual([])

    // Task controls on a finished run's task: priority, instruct, criteria.
    const task = h.repos.tasks.listByRun(waiting.id)[0]
    expect(await value('tasks.setPriority', { taskId: task?.id, priority: 7 })).toMatchObject({
      priority: 7,
    })
    expect(
      await value('tasks.instruct', {
        taskId: task?.id,
        instruction: 'for next time',
        compilationMode: 'EXACT',
      }),
    ).toMatchObject({ type: 'user_instruction', body: 'for next time' })
    expect(
      await value<unknown[]>('messages.list', { runId: waiting.id, taskId: task?.id }),
    ).toHaveLength(1)
    expect(
      await value<unknown[]>('messages.list', { runId: waiting.id, taskId: 'other' }),
    ).toHaveLength(0)
    const criterion = h.repos.criteria.listByRun(waiting.id)[0]
    expect(
      await value('criteria.update', {
        criterionId: criterion?.id,
        text: 'Edited criterion',
        compilationMode: 'EXACT',
      }),
    ).toMatchObject({ text: 'Edited criterion', status: 'pending' })
    expect(
      await call('tasks.add', {
        ...VALID_INPUTS['tasks.add'],
        runId: second.id,
        compilationMode: 'EXACT',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    expect(await value('runs.cleanup', { runId: waiting.id })).toBeNull()

    // Memory.
    const entry = await value<{ id: string; status: string; source: string }>('memory.add', {
      scope: 'project',
      projectId: project.id,
      title: 'Use pnpm',
      content: 'This repo uses pnpm',
      tags: ['tooling'],
    })
    expect(entry).toMatchObject({ status: 'approved', source: 'user' })
    expect(
      await call('memory.add', { scope: 'project', title: 't', content: 'c', tags: [] }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(
      await value<unknown[]>('memory.list', { projectId: project.id, query: 'pnpm' }),
    ).toHaveLength(1)
    expect(
      await value('memory.setStatus', { memoryId: entry.id, status: 'rejected' }),
    ).toMatchObject({ status: 'rejected' })
    expect(await value('memory.delete', { memoryId: entry.id })).toBeNull()
    expect(await value<unknown[]>('memory.list', { projectId: project.id })).toEqual([])

    // Settings and project metadata.
    const settings = await value<typeof DEFAULT_SETTINGS>('settings.get')
    const updated = await value<typeof DEFAULT_SETTINGS>('settings.update', {
      settings: { ...settings, appearance: { ...settings.appearance, theme: 'light' } },
    })
    expect(updated.appearance.theme).toBe('light')
    expect((await value<typeof DEFAULT_SETTINGS>('settings.get')).appearance.theme).toBe('light')
    expect(
      await value('projects.update', { projectId: project.id, respectProjectClaudeConfig: true }),
    ).toMatchObject({ respectProjectClaudeConfig: true })
    expect(await value('projects.reprofile', { projectId: project.id })).toMatchObject({
      id: project.id,
    })
    expect(await value('app.info')).toEqual(APP_INFO)
    expect(await value('app.openDataDir')).toBeNull()
    expect(await value<{ state: string }>('auth.status', {})).toMatchObject({
      state: 'authenticated',
    })
    expect(await value<{ value: string }[]>('auth.models')).toEqual([
      expect.objectContaining({ value: 'fake-model' }),
    ])
  })

  it('serves the v0.2 channels from durable state and passes planningMode/reviewMode into the run config', async () => {
    const project = await value<{ id: string }>('projects.open', { path: h.repoDir })
    const created = await value<{ id: string }>('runs.create', {
      compilationMode: 'EXACT',
      projectId: project.id,
      mode: 'build',
      preset: 'balanced',
      prompt: 'Create alpha and beta',
      planningMode: 'consensus',
      reviewMode: 'dual',
    })
    expect(h.repos.runs.require(created.id).config).toMatchObject({
      planningMode: 'consensus',
      reviewMode: 'dual',
    })
    expect((await h.waitForState(created.id, ['completed', 'failed', 'paused'])).state).toBe(
      'completed',
    )

    // Graph history: the approved plan is version 1; nothing was proposed.
    const revisions = await value<
      { version: number; proposalId: string | null; snapshot: { tasks: unknown[] } }[]
    >('graph.revisions', { runId: created.id })
    expect(revisions.map((r) => r.version)).toEqual([1])
    expect(revisions[0]?.snapshot.tasks).toHaveLength(2)
    expect(await value('graph.proposals', { runId: created.id })).toEqual([])
    // Consensus planning left its three candidates and the critique; every agent has one routing decision.
    const planning = await value<{
      candidates: { label: string; valid: boolean }[]
      critiques: unknown[]
    }>('planning.candidates', { runId: created.id })
    expect(planning.candidates.map((c) => c.valid)).toEqual([true, true, true])
    expect(planning.critiques).toHaveLength(1)
    const routed = await value<{ agentId: string | null }[]>('routing.list', { runId: created.id })
    expect(routed.map((d) => d.agentId).sort()).toEqual(
      h.repos.agents
        .listByRun(created.id)
        .map((a) => a.id)
        .sort(),
    )

    // Project open refreshed the repository facts; they can be listed, searched and refreshed again.
    const now = new Date().toISOString()
    h.repos.facts.upsert({
      id: 'f1',
      projectId: project.id,
      kind: 'hazard',
      subject: 'shared.txt',
      statement: 'Edited by several tasks at once',
      source: 'user',
      confidence: 'high',
      files: ['shared.txt'],
      fingerprint: 'x',
      stale: false,
      createdAt: now,
      verifiedAt: now,
    })
    h.repos.facts.upsert({
      id: 'f2',
      projectId: project.id,
      kind: 'hazard',
      subject: 'old.txt',
      statement: 'Obsolete hazard',
      source: 'user',
      confidence: 'low',
      files: [],
      fingerprint: 'y',
      stale: true,
      createdAt: now,
      verifiedAt: now,
    })
    const listed = await value<{ subject: string }[]>('intelligence.list', {
      projectId: project.id,
    })
    expect(listed.map((f) => f.subject)).toContain('shared.txt')
    expect(listed.map((f) => f.subject)).not.toContain('old.txt')
    expect(
      (
        await value<{ subject: string }[]>('intelligence.list', {
          projectId: project.id,
          includeStale: true,
        })
      ).map((f) => f.subject),
    ).toContain('old.txt')
    expect(
      (
        await value<{ subject: string }[]>('intelligence.list', {
          projectId: project.id,
          query: 'several tasks',
        })
      ).map((f) => f.subject),
    ).toEqual(['shared.txt'])
    expect(await value('intelligence.refresh', { projectId: project.id })).toEqual({
      facts: expect.any(Number),
      stale: expect.any(Number),
    })
    expect(await call('intelligence.refresh', { projectId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })

    // Performance: outcomes aggregate by role/model/category with the sample size and threshold.
    // The finished run measured both of its tasks (alpha and beta ran on the same model).
    expect(await value('performance.summary', {})).toMatchObject({
      totalOutcomes: 2,
      minSamples: 5,
      stats: [
        { role: 'worker', model: 'sonnet', category: 'implement', samples: 2, sufficient: false },
      ],
    })
    const task = h.repos.tasks.listByRun(created.id)[0]
    h.repos.taskOutcomes.upsertForTask({
      id: 'o1',
      projectId: project.id,
      runId: created.id,
      taskId: task?.id ?? '',
      role: 'worker',
      model: 'fake-model',
      tier: 'balanced',
      category: 'implement',
      complexity: 'small',
      risk: 'low',
      attempts: 1,
      firstPassVerified: true,
      completed: true,
      reviewRejections: 0,
      repairCount: 0,
      checksFailed: 0,
      humanInterventions: 0,
      elapsedMs: 1000,
      inputTokens: null,
      outputTokens: null,
      createdAt: now,
    })
    const summary = await value<{
      stats: { samples: number; sufficient: boolean; role: string }[]
      totalOutcomes: number
      minSamples: number
    }>('performance.summary', { projectId: project.id })
    // One outcome per task: the seeded row replaced the measured one of that task.
    expect(summary).toMatchObject({ totalOutcomes: 2, minSamples: 5 })
    expect(summary.stats.map((st) => [st.role, st.samples, st.sufficient])).toEqual([
      ['worker', 1, false],
      ['worker', 1, false],
    ])
    expect(
      (
        await value<{ totalOutcomes: number }>('performance.summary', {
          projectId: 'other-project',
        })
      ).totalOutcomes,
    ).toBe(0)

    // Planning recommendation uses the project's profile.
    expect(
      await value('planning.recommend', { projectId: project.id, prompt: 'Fix a typo' }),
    ).toMatchObject({ mode: 'single', reasons: expect.any(Array) })
    expect(await call('planning.recommend', { projectId: 'missing', prompt: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })

    // Context packs need an owner id.
    expect(await call('context.packs', {})).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect(
      (await value<{ taskId: string }[]>('context.packs', { taskId: task?.id })).map(
        (p) => p.taskId,
      ),
    ).toEqual([task?.id])
    expect(await value('context.packs', { agentId: 'nobody' })).toEqual([])
  })

  it('refuses to remove a project that has active runs, and removes one that has none', async () => {
    h.runtime.script = async (spec, ctx) => {
      if (spec.role === 'planner') await ctx.sleep(60_000)
      else await completeWith({ text: 'x' })(spec, ctx)
    }
    const run = await value<{ id: string }>('runs.create', {
      compilationMode: 'EXACT',
      projectId: h.project.id,
      mode: 'build',
      preset: 'balanced',
      prompt: 'slow',
    })
    expect(await call('projects.remove', { projectId: h.project.id })).toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    })
    await value('runs.cancel', { runId: run.id })
    expect(await value('projects.remove', { projectId: h.project.id })).toBeNull()
    expect(await value('projects.list')).toEqual([])
    // The repository on disk is untouched.
    expect((await h.git.status(h.repoDir)).clean).toBe(true)
  })

  it('maps unexpected (non-NexusError) failures to the internal code', async () => {
    const broken: AgentRuntime = Object.create(h.runtime) as AgentRuntime
    broken.getAccountInfo = () => Promise.reject(new Error('sdk exploded'))
    const local = createIpcHandlers(makeContext(h, [], { runtime: broken }))
    expect(await dispatchIpc(local, 'auth.status', { refresh: true })).toEqual({
      ok: false,
      error: { code: 'internal', message: 'sdk exploded' },
    })
  })
})
