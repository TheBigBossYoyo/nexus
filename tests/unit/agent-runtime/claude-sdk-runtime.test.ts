import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '@main/modules/agent-runtime/async-queue'
import {
  ClaudeSdkRuntime,
  authStatusFromAccount,
  createNexusMcpServer,
} from '@main/modules/agent-runtime/claude-sdk-runtime'
import type { AgentEvent, NexusToolHandlers, SessionSpec, ToolDecision } from '@main/modules/agent-runtime/types'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof Sdk>()
  return { ...actual, query: vi.fn() }
})

interface FakeQuery {
  out: AsyncQueue<SDKMessage>
  fail(e: Error): void
  interrupt: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
  init: ReturnType<typeof vi.fn>
}

let created: FakeQuery[] = []
let initResult: unknown = { account: {}, models: [] }
let initError: Error | null = null

beforeEach(() => {
  created = []
  initResult = { account: {}, models: [] }
  initError = null
  vi.mocked(query).mockImplementation(((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const out = new AsyncQueue<SDKMessage>()
    let failure: Error | null = null
    const close = vi.fn(() => out.close())
    async function* gen() {
      for await (const m of out) yield m
      if (failure) throw failure
    }
    const init = vi.fn(async () => {
      if (initError) throw initError
      return initResult
    })
    const q = Object.assign(gen(), { interrupt: vi.fn(async () => undefined), close, initializationResult: init })
    created.push({
      out,
      fail: (e) => {
        failure = e
        out.close()
      },
      interrupt: q.interrupt,
      close,
      prompt: params.prompt,
      options: params.options,
      init,
    })
    return q
  }) as unknown as typeof query)
})

function makeSpec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    agentId: 'agent-1',
    role: 'worker',
    cwd: 'C:\\work',
    maxTurns: 10,
    systemPromptAppend: 'be careful',
    prompt: 'first prompt',
    tools: ['Read', 'Grep'],
    authorize: async () => ({ behavior: 'allow' }),
    requestApproval: async () => true,
    loadProjectSettings: false,
    subscriptionMode: true,
    ...over,
  }
}

function runtime(env: Record<string, string> = { PATH: 'p', ANTHROPIC_API_KEY: 'sk-secret' }) {
  return new ClaudeSdkRuntime({ executablePath: 'C:\\claude.exe', processEnv: env })
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

const initMsg = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-9',
  model: 'm',
  tools: ['Read'],
  apiKeySource: 'none',
} as unknown as SDKMessage
const resultMsg = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  duration_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  modelUsage: {},
} as unknown as SDKMessage

function firstCreated(): FakeQuery {
  const q = created[0]
  if (!q) throw new Error('query was not created')
  return q
}

describe('ClaudeSdkRuntime.startSession options', () => {
  it('builds isolated, restricted options', () => {
    runtime().startSession(makeSpec({ model: 'opus', effort: 'high', outputSchema: { type: 'object' } }))
    const o = firstCreated().options
    expect(o).toMatchObject({
      cwd: 'C:\\work',
      model: 'opus',
      effort: 'high',
      maxTurns: 10,
      includePartialMessages: true,
      permissionMode: 'default',
      tools: ['Read', 'Grep'],
      disallowedTools: ['Agent', 'Task'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'be careful' },
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      pathToClaudeCodeExecutable: 'C:\\claude.exe',
    })
    expect(o.resume).toBeUndefined()
    expect(o.env?.['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(o.env?.['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
    expect(o.mcpServers).toEqual({})
  })

  it('loads project settings and resumes on request, and keeps keys outside subscription mode', () => {
    runtime().resumeSession(makeSpec({ loadProjectSettings: true, subscriptionMode: false }), 'old-id')
    const o = firstCreated().options
    expect(o.settingSources).toEqual(['project'])
    expect(o.resume).toBe('old-id')
    expect(o.env?.['ANTHROPIC_API_KEY']).toBe('sk-secret')
  })

  it('passes external MCP servers through and adds the nexus server only with handlers', () => {
    const handlers: NexusToolHandlers = {
      sendMessage: async () => 'sent',
      reportBlocker: async () => 'r',
      recordDecision: async () => 'd',
      proposeMemory: async () => 'p',
    }
    runtime().startSession(
      makeSpec({
        nexusTools: handlers,
        mcpServers: {
          git: { type: 'stdio', command: 'node', args: ['x.js'] },
          web: { type: 'http', url: 'http://localhost:1/mcp' },
        },
      }),
    )
    const servers = firstCreated().options.mcpServers ?? {}
    expect(servers['git']).toEqual({ type: 'stdio', command: 'node', args: ['x.js'] })
    expect(servers['web']).toEqual({ type: 'http', url: 'http://localhost:1/mcp' })
    expect(servers['nexus']).toMatchObject({ type: 'sdk', name: 'nexus' })
  })

  it('rejects invalid or reserved MCP servers', () => {
    expect(() => runtime().startSession(makeSpec({ mcpServers: { nexus: { type: 'http', url: 'x' } } }))).toThrow(/reserved/)
    expect(() => runtime().startSession(makeSpec({ mcpServers: { a: { type: 'stdio' } } }))).toThrow(/command/)
  })
})

describe('session lifecycle', () => {
  it('feeds the prompt then follow-ups, and completes after end()', async () => {
    const h = runtime().startSession(makeSpec())
    const q = firstCreated()
    const it = q.prompt[Symbol.asyncIterator]()
    expect((await it.next()).value).toMatchObject({ type: 'user', message: { role: 'user', content: 'first prompt' }, parent_tool_use_id: null })
    h.send('follow up')
    expect((await it.next()).value).toMatchObject({ message: { content: 'follow up' } })

    q.out.push(initMsg)
    q.out.push(resultMsg)
    h.end()
    expect((await it.next()).done).toBe(true)
    q.out.close()

    const events = await collect(h.events)
    expect(events.map((e) => e.type)).toEqual(['session.started', 'turn.completed', 'session.ended'])
    expect(events.at(-1)).toEqual({ type: 'session.ended', reason: 'completed', error: null })
    expect(h.sessionId()).toBe('sess-9')
  })

  it('reports a crash when the stream throws, without throwing into the caller', async () => {
    const rt = runtime()
    const h = rt.startSession(makeSpec())
    const other = rt.startSession(makeSpec({ agentId: 'agent-2' }))
    created[0]?.fail(new Error('process exited with code 1'))
    const events = await collect(h.events)
    expect(events.at(-1)).toEqual({ type: 'session.ended', reason: 'crashed', error: 'process exited with code 1' })
    expect(events.filter((e) => e.type === 'session.ended')).toHaveLength(1)
    // The sibling session is unaffected.
    expect(created[1]?.close).not.toHaveBeenCalled()
    await other.stop()
  })

  it('reports a crash when the stream ends without end() or stop()', async () => {
    const h = runtime().startSession(makeSpec())
    firstCreated().out.close()
    const events = await collect(h.events)
    expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
  })

  it('reports a crash when query() itself throws', async () => {
    vi.mocked(query).mockImplementationOnce(() => {
      throw new Error('Native CLI binary for win32-x64 not found')
    })
    const h = runtime().startSession(makeSpec())
    const events = await collect(h.events)
    expect(events).toEqual([{ type: 'session.ended', reason: 'crashed', error: 'Native CLI binary for win32-x64 not found' }])
    await h.stop()
  })

  it('stop() is idempotent and ends with reason stopped', async () => {
    const rt = runtime()
    const h = rt.startSession(makeSpec())
    await Promise.all([h.stop(), h.stop()])
    await h.stop()
    const events = await collect(h.events)
    expect(events).toEqual([{ type: 'session.ended', reason: 'stopped', error: null }])
    expect(firstCreated().close).toHaveBeenCalled()
  })

  it('interrupt() calls query.interrupt and keeps the session alive', async () => {
    const h = runtime().startSession(makeSpec())
    await h.interrupt()
    expect(firstCreated().interrupt).toHaveBeenCalledTimes(1)
    await h.stop()
  })

  it('shutdown() stops every live session', async () => {
    const rt = runtime()
    const a = rt.startSession(makeSpec())
    const b = rt.startSession(makeSpec({ agentId: 'b' }))
    await rt.shutdown()
    expect((await collect(a.events)).at(-1)).toMatchObject({ reason: 'stopped' })
    expect((await collect(b.events)).at(-1)).toMatchObject({ reason: 'stopped' })
  })
})

describe('policy enforcement', () => {
  const hookInput = (toolName: string, id = 'tu1', input: Record<string, unknown> = {}) =>
    ({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: id }) as never
  const signal = new AbortController().signal

  function start(spec: Partial<SessionSpec>) {
    const h = runtime().startSession(makeSpec(spec))
    const o = firstCreated().options
    const hook = o.hooks?.PreToolUse?.[0]?.hooks[0]
    if (!hook || !o.canUseTool) throw new Error('policy callbacks missing')
    const callHook = (name: string, id = 'tu1', input: Record<string, unknown> = {}) => hook(hookInput(name, id, input), id, { signal })
    return { h, hook: callHook, canUse: o.canUseTool }
  }

  const decisionOf = (out: unknown) => (out as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }).hookSpecificOutput

  it('allows, denies with a reason, and emits tool.denied', async () => {
    const authorize = async (r: { toolName: string }): Promise<ToolDecision> =>
      r.toolName === 'Read' ? { behavior: 'allow' } : { behavior: 'deny', reason: 'read only' }
    const { h, hook } = start({ authorize })
    expect(decisionOf(await hook('Read')).permissionDecision).toBe('allow')
    const denied = decisionOf(await hook('Write', 'tu2'))
    expect(denied).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'read only' })
    await h.stop()
    const events = await collect(h.events)
    expect(events).toContainEqual({ type: 'tool.denied', toolUseId: 'tu2', toolName: 'Write', reason: 'read only' })
  })

  it('denies when authorize throws or returns garbage', async () => {
    const thrower = start({
      authorize: async () => {
        throw new Error('db down')
      },
    })
    expect(decisionOf(await thrower.hook('Bash')).permissionDecision).toBe('deny')
    const garbage = start({ authorize: async () => ({ behavior: 'maybe' }) as unknown as ToolDecision })
    expect(decisionOf(await garbage.hook('Bash')).permissionDecision).toBe('deny')
    const viaCanUse = await thrower.canUse('Bash', {}, { signal, toolUseID: 'tuX', requestId: 'r' } as never)
    expect(viaCanUse?.behavior).toBe('deny')
  })

  it('always allows nexus MCP tools without consulting authorize', async () => {
    const authorize = vi.fn(async (): Promise<ToolDecision> => ({ behavior: 'deny', reason: 'no' }))
    const { hook, canUse } = start({ authorize })
    expect(decisionOf(await hook('mcp__nexus__send_message')).permissionDecision).toBe('allow')
    expect((await canUse('mcp__nexus__report_blocker', {}, { signal, toolUseID: 't', requestId: 'r' } as never))?.behavior).toBe('allow')
    expect(authorize).not.toHaveBeenCalled()
  })

  it('routes ask through requestApproval once, honouring the answer', async () => {
    const authorize = vi.fn(async (): Promise<ToolDecision> => ({ behavior: 'ask', reason: 'risky', risk: 'high' }))
    const requestApproval = vi.fn(async () => true)
    const { hook, canUse } = start({ authorize, requestApproval })
    expect(decisionOf(await hook('Bash', 'tu1', { command: 'x' })).permissionDecision).toBe('ask')
    const result = await canUse('Bash', { command: 'x' }, { signal, toolUseID: 'tu1', requestId: 'r' } as never)
    expect(result?.behavior).toBe('allow')
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(requestApproval).toHaveBeenCalledWith(
      { agentId: 'agent-1', toolName: 'Bash', input: { command: 'x' }, toolUseId: 'tu1' },
      'risky',
      'high',
    )
  })

  it('denies when approval is refused, throws, or is cancelled', async () => {
    const ask = async (): Promise<ToolDecision> => ({ behavior: 'ask', reason: 'r', risk: 'low' })
    const refused = start({ authorize: ask, requestApproval: async () => false })
    expect((await refused.canUse('Bash', {}, { signal, toolUseID: 'a', requestId: 'r' } as never))?.behavior).toBe('deny')

    const broken = start({
      authorize: ask,
      requestApproval: async () => {
        throw new Error('ui gone')
      },
    })
    expect((await broken.canUse('Bash', {}, { signal, toolUseID: 'b', requestId: 'r' } as never))?.behavior).toBe('deny')

    const ac = new AbortController()
    const hung = start({ authorize: ask, requestApproval: () => new Promise<boolean>(() => undefined) })
    const pending = hung.canUse('Bash', {}, { signal: ac.signal, toolUseID: 'c', requestId: 'r' } as never)
    ac.abort()
    expect((await pending)?.behavior).toBe('deny')
  })
})

describe('nexus MCP server', () => {
  async function connect(handlers: NexusToolHandlers) {
    const config = createNexusMcpServer(handlers) as unknown as { instance: McpServer }
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await config.instance.connect(serverSide)
    const client = new Client({ name: 't', version: '1' })
    await client.connect(clientSide)
    return client
  }

  const handlers = (over: Partial<NexusToolHandlers> = {}): NexusToolHandlers => ({
    sendMessage: async () => 'msg-1',
    reportBlocker: async () => 'blk-1',
    recordDecision: async () => 'dec-1',
    proposeMemory: async () => 'mem-1',
    ...over,
  })

  it('exposes the four tools and maps arguments onto handlers', async () => {
    const sendMessage = vi.fn(async () => 'msg-1')
    const proposeMemory = vi.fn(async () => 'mem-1')
    const client = await connect(handlers({ sendMessage, proposeMemory }))
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(['propose_memory', 'record_decision', 'report_blocker', 'send_message'])

    const r = await client.callTool({ name: 'send_message', arguments: { type: 'question', subject: 's', body: 'b' } })
    expect(r.isError).toBeFalsy()
    expect(sendMessage).toHaveBeenCalledWith({ type: 'question', subject: 's', body: 'b', toTask: null, toRole: null, severity: null })

    await client.callTool({ name: 'propose_memory', arguments: { title: 't', content: 'c', evidence: 'e' } })
    expect(proposeMemory).toHaveBeenCalledWith({ title: 't', content: 'c', evidence: 'e', tags: [], filePaths: [] })
  })

  it('turns handler errors into isError results', async () => {
    const client = await connect(
      handlers({
        reportBlocker: async () => {
          throw new Error('no run')
        },
      }),
    )
    const r = await client.callTool({ name: 'report_blocker', arguments: { summary: 's', evidence: 'e' } })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('no run')
  })
})

describe('getAccountInfo', () => {
  it('maps a subscription login and strips keys from the check environment', async () => {
    initResult = {
      account: { subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', organization: 'Org' },
      models: [
        { value: 'sonnet', displayName: 'Sonnet', description: 'd', supportsEffort: true },
        { value: 'haiku', displayName: 'Haiku', description: 'd2' },
      ],
    }
    const rt = runtime()
    const status = await rt.getAccountInfo({ subscriptionMode: true })
    expect(status).toMatchObject({
      state: 'authenticated',
      mode: 'subscription',
      subscriptionType: 'max',
      apiKeyEnvDetected: true,
      apiKeyEnvStripped: true,
    })
    expect(status.warnings).toHaveLength(1)
    const o = firstCreated().options
    expect(o.env?.['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(o.settingSources).toEqual([])
    expect(firstCreated().close).toHaveBeenCalled()

    const caps = await rt.getCapabilities()
    expect(caps.models).toEqual([
      { value: 'sonnet', displayName: 'Sonnet', description: 'd', supportsEffort: true },
      { value: 'haiku', displayName: 'Haiku', description: 'd2', supportsEffort: false },
    ])
    expect(caps.sdkVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(created).toHaveLength(1) // models were cached from the same initialization
  })

  it('reports authentication_required, api_key, third_party', () => {
    const flags = { subscriptionMode: false, apiKeyEnvDetected: false }
    expect(authStatusFromAccount({}, flags)).toMatchObject({ state: 'authentication_required', mode: 'unknown' })
    expect(authStatusFromAccount({ apiKeySource: 'ANTHROPIC_API_KEY' }, flags)).toMatchObject({ state: 'authenticated', mode: 'api_key' })
    expect(authStatusFromAccount({ apiProvider: 'bedrock' }, flags)).toMatchObject({ state: 'authenticated', mode: 'third_party' })
    expect(authStatusFromAccount({ apiKeySource: 'none', subscriptionType: 'pro' }, flags).mode).toBe('subscription')
  })

  it('reports runtime_unavailable and sdk_error without leaking more than the message', async () => {
    initError = new Error('spawn C:\\claude.exe ENOENT')
    expect((await runtime({}).getAccountInfo({ subscriptionMode: false })).state).toBe('runtime_unavailable')
    initError = new Error('protocol mismatch')
    const s = await runtime({}).getAccountInfo({ subscriptionMode: false })
    expect(s).toMatchObject({ state: 'sdk_error', apiKeyEnvDetected: false, warnings: [] })
  })
})
