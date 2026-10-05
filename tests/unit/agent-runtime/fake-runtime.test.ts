import { describe, expect, it, vi } from 'vitest'
import { FakeAgentRuntime, completeWith, scriptsByRole } from '@main/modules/agent-runtime/fake-runtime'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import type { AgentEvent, SessionSpec, ToolDecision } from '@main/modules/agent-runtime/types'

function makeSpec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    agentId: 'a1',
    role: 'worker',
    cwd: 'C:\\work',
    maxTurns: 5,
    systemPromptAppend: '',
    prompt: 'do it',
    tools: ['Read'],
    authorize: async () => ({ behavior: 'allow' }),
    requestApproval: async () => true,
    loadProjectSettings: false,
    subscriptionMode: true,
    ...over,
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

const types = (events: AgentEvent[]) => events.map((e) => e.type)

describe('FakeAgentRuntime', () => {
  it('emits session.started first and session.ended last around a scripted turn', async () => {
    const rt = new FakeAgentRuntime({ script: completeWith({ text: 'hello', structuredOutput: { a: 1 } }) })
    const h = rt.startSession(makeSpec({ model: 'm1' }))
    const events = await collect(h.events)
    expect(types(events)).toEqual(['session.started', 'text', 'turn.completed', 'session.ended'])
    expect(events[0]).toMatchObject({ sessionId: 'fake-session-1', model: 'm1', tools: ['Read'] })
    expect(events[2]).toMatchObject({ result: { outcome: 'success', text: 'hello', structuredOutput: { a: 1 }, numTurns: 1 } })
    expect(events[3]).toEqual({ type: 'session.ended', reason: 'completed', error: null })
    expect(h.sessionId()).toBe('fake-session-1')
  })

  it('records specs and honours resume ids', async () => {
    const rt = new FakeAgentRuntime({ script: completeWith({ text: 'x' }) })
    await collect(rt.startSession(makeSpec({ prompt: 'one' })).events)
    const h = rt.resumeSession(makeSpec({ prompt: 'two' }), 'sdk-77')
    const events = await collect(h.events)
    expect(rt.sessions.map((s) => s.prompt)).toEqual(['one', 'two'])
    expect(rt.sessions[1]?.resumeSessionId).toBe('sdk-77')
    expect(events[0]).toMatchObject({ type: 'session.started', sessionId: 'sdk-77' })
  })

  it('runs authorize and requestApproval like the real runtime', async () => {
    const authorize = vi.fn(async (r: { toolName: string }): Promise<ToolDecision> => {
      if (r.toolName === 'Read') return { behavior: 'allow' }
      if (r.toolName === 'Bash') return { behavior: 'ask', reason: 'shell', risk: 'medium' }
      return { behavior: 'deny', reason: 'nope' }
    })
    const requestApproval = vi.fn(async () => false)
    const results: boolean[] = []
    const script: FakeScript = async (_s, ctx) => {
      results.push(await ctx.useTool('Read', { file_path: 'a' }, async () => 'contents'))
      results.push(await ctx.useTool('Write', {}))
      results.push(await ctx.useTool('Bash', { command: 'ls' }))
      results.push(await ctx.useTool('mcp__nexus__send_message', {}))
    }
    const events = await collect(new FakeAgentRuntime({ script }).startSession(makeSpec({ authorize, requestApproval })).events)
    expect(results).toEqual([true, false, false, true])
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(requestApproval.mock.calls[0]?.slice(1)).toEqual(['shell', 'medium'])
    expect(authorize).toHaveBeenCalledTimes(3) // nexus tools skip policy
    const denied = events.filter((e) => e.type === 'tool.denied')
    expect(denied.map((e) => e.type === 'tool.denied' && e.reason)).toEqual(['nope', 'Denied by the user'])
    const read = events.find((e) => e.type === 'tool.completed')
    expect(read).toMatchObject({ isError: false, outputPreview: 'contents' })
  })

  it('treats a throwing authorize as a denial and a throwing tool as an error result', async () => {
    const script: FakeScript = async (_s, ctx) => {
      await ctx.useTool('X', {})
      await ctx.useTool('Read', {}, async () => {
        throw new Error('disk')
      })
    }
    const spec = makeSpec({
      authorize: async (r) => {
        if (r.toolName === 'X') throw new Error('policy down')
        return { behavior: 'allow' }
      },
    })
    const events = await collect(new FakeAgentRuntime({ script }).startSession(spec).events)
    expect(events.some((e) => e.type === 'tool.denied')).toBe(true)
    expect(events.filter((e) => e.type === 'tool.completed').map((e) => e.type === 'tool.completed' && e.isError)).toEqual([true, true])
  })

  it('delivers follow-up messages and ends them with null after end()', async () => {
    const seen: (string | null)[] = []
    const script: FakeScript = async (_s, ctx) => {
      for (;;) {
        const m = await ctx.nextMessage()
        seen.push(m)
        if (m === null) return
        await ctx.completeTurn({ text: `re: ${m}` })
      }
    }
    const h = new FakeAgentRuntime({ script }).startSession(makeSpec())
    h.send('a')
    h.send('b')
    h.end()
    const events = await collect(h.events)
    expect(seen).toEqual(['a', 'b', null])
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ reason: 'completed' })
  })

  it('stop() ends the session as stopped and releases a waiting script', async () => {
    const script: FakeScript = async (_s, ctx) => {
      await ctx.nextMessage()
    }
    const rt = new FakeAgentRuntime({ script })
    const h = rt.startSession(makeSpec())
    await rt.stopSession(h)
    await h.stop()
    const events = await collect(h.events)
    expect(types(events)).toEqual(['session.started', 'session.ended'])
    expect(events[1]).toEqual({ type: 'session.ended', reason: 'stopped', error: null })
  })

  it('stop() still ends a script that ignores its signal', async () => {
    vi.useFakeTimers()
    try {
      const script: FakeScript = () => new Promise<void>(() => undefined)
      const h = new FakeAgentRuntime({ script }).startSession(makeSpec())
      const stopping = h.stop()
      await vi.advanceTimersByTimeAsync(2500)
      await stopping
    } finally {
      vi.useRealTimers()
    }
  })

  it('interrupt() aborts the current signal but keeps the session alive', async () => {
    let aborted = false
    let freshSignalLive = false
    const script: FakeScript = async (_s, ctx) => {
      const first = ctx.signal
      await new Promise<void>((r) => first.addEventListener('abort', () => r(), { once: true }))
      aborted = first.aborted
      freshSignalLive = !ctx.signal.aborted
      await ctx.completeTurn({ text: 'after interrupt', outcome: 'aborted' })
    }
    const rt = new FakeAgentRuntime({ script })
    const h = rt.startSession(makeSpec())
    await rt.interruptSession(h)
    const events = await collect(h.events)
    expect(aborted).toBe(true)
    expect(freshSignalLive).toBe(true)
    expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({ result: { outcome: 'aborted', text: '' } })
    expect(events.at(-1)).toMatchObject({ reason: 'completed' })
  })

  it('fail() and thrown errors end the session as crashed without throwing to the caller', async () => {
    const rt = new FakeAgentRuntime({
      script: async (_s, ctx) => {
        await ctx.emitText('before')
        ctx.fail('simulated crash')
      },
    })
    const events = await collect(rt.startSession(makeSpec()).events)
    expect(types(events)).toEqual(['session.started', 'text', 'session.ended'])
    expect(events.at(-1)).toEqual({ type: 'session.ended', reason: 'crashed', error: 'simulated crash' })

    const thrown = new FakeAgentRuntime({
      script: async () => {
        throw new Error('bug in script')
      },
    })
    expect((await collect(thrown.startSession(makeSpec()).events)).at(-1)).toMatchObject({ reason: 'crashed', error: 'bug in script' })
  })

  it('emits rate limit events and applies the artificial delay', async () => {
    const rt = new FakeAgentRuntime({
      delayMs: 15,
      script: async (_s, ctx) => {
        await ctx.rateLimit({ resetsAt: 123, limitType: 'five_hour' })
        await ctx.completeTurn({ text: 'limited', outcome: 'quota' })
      },
    })
    const start = Date.now()
    const events = await collect(rt.startSession(makeSpec()).events)
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
    expect(events[1]).toEqual({ type: 'rate_limit', status: 'rejected', resetsAt: 123, limitType: 'five_hour' })
    // The real SDK follows the rate_limit_event with an error signal that carries no reset.
    expect(events[2]).toEqual({ type: 'rate_limit', status: 'rejected', resetsAt: null, limitType: null })
    expect(events[3]).toMatchObject({ result: { outcome: 'quota', errors: ['limited'] } })
  })

  it('exposes nexus tools to scripts and composes scripts per role', async () => {
    const sendMessage = vi.fn(async () => 'msg-1')
    const script = scriptsByRole({
      worker: async (_s, ctx) => {
        const id = await ctx.nexusTools?.sendMessage({
          type: 'question',
          subject: 's',
          body: 'b',
          toTask: null,
          toRole: null,
          severity: null,
        })
        await ctx.completeTurn({ text: id ?? 'none' })
      },
    })
    const rt = new FakeAgentRuntime({ script })
    const nexusTools = {
      sendMessage,
      reportBlocker: async () => '',
      recordDecision: async () => '',
      proposeMemory: async () => '',
    }
    const worker = await collect(rt.startSession(makeSpec({ nexusTools })).events)
    expect(worker.find((e) => e.type === 'turn.completed')).toMatchObject({ result: { text: 'msg-1' } })
    const reviewer = await collect(rt.startSession(makeSpec({ role: 'reviewer' })).events)
    expect(reviewer.find((e) => e.type === 'turn.completed')).toMatchObject({ result: { text: 'done' } })
  })

  it('returns configurable auth status, capabilities and shuts down live sessions', async () => {
    const rt = new FakeAgentRuntime({
      script: async (_s, ctx) => {
        await ctx.nextMessage()
      },
    })
    const base = await rt.getAccountInfo({ subscriptionMode: true })
    expect(base.state).toBe('authenticated')
    rt.authStatus = (o) => ({ ...base, state: 'authentication_required', apiKeyEnvStripped: o.subscriptionMode })
    expect(await rt.getAccountInfo({ subscriptionMode: true })).toMatchObject({ state: 'authentication_required', apiKeyEnvStripped: true })
    rt.models = [{ value: 'x', displayName: 'X', description: '', supportsEffort: false }]
    expect((await rt.getCapabilities()).models.map((m) => m.value)).toEqual(['x'])

    const a = rt.startSession(makeSpec())
    const b = rt.startSession(makeSpec({ agentId: 'b' }))
    await rt.shutdown()
    expect((await collect(a.events)).at(-1)).toMatchObject({ reason: 'stopped' })
    expect((await collect(b.events)).at(-1)).toMatchObject({ reason: 'stopped' })
  })
})
