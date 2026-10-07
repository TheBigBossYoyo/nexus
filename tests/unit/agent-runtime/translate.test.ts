import { describe, expect, it } from 'vitest'
import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import { createTranslatorState, translateSdkMessage } from '@main/modules/agent-runtime/translate'
import type { TranslatorState } from '@main/modules/agent-runtime/translate'
import type { AgentEvent } from '@main/modules/agent-runtime/types'

/** Field names and value types are checked against the real SDK declarations; the rest is omitted. */
function msg<T extends SDKMessage['type']>(m: Partial<Extract<SDKMessage, { type: T }>> & { type: T }): SDKMessage {
  return m as unknown as SDKMessage
}

const usage: ModelUsage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 5,
  cacheCreationInputTokens: 7,
  webSearchRequests: 0,
  costUSD: 0.0123,
  contextWindow: 200000,
  maxOutputTokens: 32000,
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}): SDKMessage {
  return msg<'assistant'>({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content } as never,
    ...extra,
  })
}

function result(extra: Record<string, unknown>): SDKMessage {
  return msg<'result'>({
    type: 'result',
    duration_ms: 1234,
    num_turns: 3,
    total_cost_usd: 0.5,
    modelUsage: { 'claude-sonnet-5': usage },
    is_error: false,
    ...extra,
  } as never)
}

function run(messages: SDKMessage[], state: TranslatorState = createTranslatorState({ expectStructuredOutput: false })) {
  return messages.flatMap((m) => translateSdkMessage(m, state))
}

function turn(events: AgentEvent[]) {
  const e = events.find((x) => x.type === 'turn.completed')
  if (e?.type !== 'turn.completed') throw new Error('no turn.completed')
  return e.result
}

describe('translateSdkMessage', () => {
  it('maps system init to a single session.started', () => {
    const state = createTranslatorState({ expectStructuredOutput: false })
    const init = msg<'system'>({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-sonnet-5',
      tools: ['Read', 'Grep'],
      apiKeySource: 'none',
    } as never)
    expect(translateSdkMessage(init, state)).toEqual([
      { type: 'session.started', sessionId: 'sess-1', model: 'claude-sonnet-5', tools: ['Read', 'Grep'], apiKeySource: 'none' },
    ])
    expect(state.sessionId).toBe('sess-1')
    // Init repeats at the start of every turn but the session only starts once.
    expect(translateSdkMessage(init, state)).toEqual([])
  })

  it('maps text and tool_use blocks and never exposes thinking', () => {
    const events = run([
      assistant([
        { type: 'thinking', thinking: 'secret reasoning', signature: 'x' },
        { type: 'redacted_thinking', data: 'abc' },
        { type: 'text', text: 'Looking at it' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } },
      ]),
    ])
    expect(events).toEqual([
      { type: 'text', text: 'Looking at it' },
      { type: 'tool.started', toolUseId: 'tu1', toolName: 'Read', input: { file_path: 'a.ts' } },
    ])
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  it('ignores subagent traffic', () => {
    const events = run([
      assistant([{ type: 'text', text: 'sub' }], { parent_tool_use_id: 'tu0' }),
      msg<'stream_event'>({
        type: 'stream_event',
        parent_tool_use_id: 'tu0',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } as never,
      }),
      msg<'user'>({
        type: 'user',
        parent_tool_use_id: 'tu0',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
      }),
    ])
    expect(events).toEqual([])
  })

  it('maps tool results with a bounded preview', () => {
    const long = 'x'.repeat(5000)
    const events = run([
      msg<'user'>({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' },
            { type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'boom' }] },
            { type: 'tool_result', tool_use_id: 'tu3', content: long },
          ],
        },
      }),
      msg<'user'>({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'plain prompt' } }),
    ])
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ type: 'tool.completed', toolUseId: 'tu1', isError: false, outputPreview: 'file contents' })
    expect(events[1]).toEqual({ type: 'tool.completed', toolUseId: 'tu2', isError: true, outputPreview: 'boom' })
    const third = events[2]
    expect(third?.type === 'tool.completed' && third.outputPreview.length).toBeLessThan(600)
  })

  it('maps text deltas only', () => {
    const delta = (d: unknown) =>
      msg<'stream_event'>({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: d } as never,
      })
    expect(run([delta({ type: 'text_delta', text: 'he' }), delta({ type: 'input_json_delta', partial_json: '{' })])).toEqual([
      { type: 'text.delta', text: 'he' },
    ])
  })

  it('maps rate limit events and status messages', () => {
    const events = run([
      msg<'rate_limit_event'>({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', resetsAt: 1700000000, rateLimitType: 'five_hour', utilization: 0.91, overageStatus: 'allowed', isUsingOverage: false, surpassedThreshold: 0.9 },
      }),
      msg<'system'>({ type: 'system', subtype: 'status', status: 'compacting' } as never),
      msg<'system'>({ type: 'system', subtype: 'status', status: null } as never),
      msg<'system'>({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } } as never),
    ])
    expect(events).toEqual([
      {
        type: 'rate_limit',
        status: 'allowed_warning',
        resetsAt: 1700000000,
        limitType: 'five_hour',
        utilization: 0.91,
        overageStatus: 'allowed',
        isUsingOverage: false,
        surpassedThreshold: 0.9,
      },
      { type: 'status', status: 'compacting' },
      { type: 'status', status: 'compacted' },
      { type: 'compaction', trigger: 'auto', preTokens: 1, postTokens: null, durationMs: null },
    ])
  })

  it('keeps absent rate-limit fields as null', () => {
    const events = run([msg<'rate_limit_event'>({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })])
    expect(events).toEqual([
      { type: 'rate_limit', status: 'rejected', resetsAt: null, limitType: null, utilization: null, overageStatus: null, isUsingOverage: null, surpassedThreshold: null },
    ])
  })

  it('emits a throttle (not a rate_limit) for overloaded and server errors', () => {
    expect(run([assistant([{ type: 'text', text: 'busy' }], { error: 'overloaded' })])).toEqual([{ type: 'throttle', kind: 'overloaded' }])
    expect(run([assistant([{ type: 'text', text: 'oops' }], { error: 'server_error' })])).toEqual([{ type: 'throttle', kind: 'server_error' }])
  })

  it('billing_error is a usage limit and its synthetic text is suppressed', () => {
    const events = run([assistant([{ type: 'text', text: 'Credit balance is too low' }], { error: 'billing_error' })])
    expect(events).toEqual([{ type: 'rate_limit', status: 'rejected', resetsAt: null, limitType: null }])
  })

  it('an assistant rate_limit error after a rejected rate_limit_event is the same usage limit', () => {
    const state = createTranslatorState({ expectStructuredOutput: false })
    const events = run(
      [
        msg<'rate_limit_event'>({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1700000000, rateLimitType: 'five_hour' } }),
        assistant([{ type: 'text', text: 'Limit reached' }], { error: 'rate_limit' }),
      ],
      state,
    )
    expect(events.map((e) => e.type)).toEqual(['rate_limit', 'rate_limit'])
    expect(events[1]).toMatchObject({ status: 'rejected', resetsAt: null })
    expect(state.quotaSignal).toBe(true)
  })

  it("an assistant rate_limit error whose text is a documented usage-limit message is a usage limit", () => {
    const events = run([assistant([{ type: 'text', text: "You've hit your limit. Resets 3pm" }], { error: 'rate_limit' })])
    expect(events).toEqual([{ type: 'rate_limit', status: 'rejected', resetsAt: null, limitType: null }])
  })

  it('a bare 429 (rate_limit error with no usage-limit evidence) is a transient throttle, not a quota outcome', () => {
    const state = createTranslatorState({ expectStructuredOutput: false })
    const events = run(
      [
        assistant([{ type: 'text', text: 'API Error: 429 too many requests' }], { error: 'rate_limit' }),
        result({ subtype: 'error_during_execution', errors: ['429'] }),
      ],
      state,
    )
    expect(events[0]).toEqual({ type: 'throttle', kind: 'rate_limit' })
    expect(state.quotaSignal).toBe(false)
    expect(turn(events).outcome).toBe('error')
  })
});

describe('turn results', () => {
  it('maps success with usage and cost', () => {
    const r = turn(run([result({ subtype: 'success', result: 'All done', stop_reason: 'end_turn' })]))
    expect(r).toMatchObject({
      outcome: 'success',
      text: 'All done',
      structuredOutput: null,
      numTurns: 3,
      durationMs: 1234,
      totalCostUsd: 0.5,
      errors: [],
    })
    expect(r.usage).toEqual([
      {
        model: 'claude-sonnet-5',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 7,
        costUsd: 0.0123,
        contextWindow: 200000,
      },
    ])
  })

  it('passes structured output through', () => {
    const state = createTranslatorState({ expectStructuredOutput: true })
    const r = turn(run([result({ subtype: 'success', result: '', structured_output: { ok: true } })], state))
    expect(r.outcome).toBe('success')
    expect(r.structuredOutput).toEqual({ ok: true })
  })

  it('treats a missing structured output as structured_output_failed when a schema was requested', () => {
    const state = createTranslatorState({ expectStructuredOutput: true })
    const r = turn(run([result({ subtype: 'success', result: 'free text' })], state))
    expect(r.outcome).toBe('structured_output_failed')
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('maps max turns and structured output retry exhaustion', () => {
    expect(turn(run([result({ subtype: 'error_max_turns', errors: [] })])).outcome).toBe('max_turns')
    const so = turn(run([result({ subtype: 'error_max_structured_output_retries', errors: ['bad json'] })]))
    expect(so.outcome).toBe('structured_output_failed')
    expect(so.errors).toEqual(['bad json'])
  })

  it('maps usage-limit text and rate limit rejection to quota', () => {
    const prefix = USAGE_LIMIT_ERROR_PREFIXES[0]
    const byText = turn(run([result({ subtype: 'success', is_error: true, result: `${prefix} limit` })]))
    expect(byText.outcome).toBe('quota')
    expect(byText.text).toBe('')

    const state = createTranslatorState({ expectStructuredOutput: false })
    const events = run(
      [
        msg<'rate_limit_event'>({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }),
        result({ subtype: 'error_during_execution', errors: ['rejected'] }),
      ],
      state,
    )
    expect(turn(events).outcome).toBe('quota')
    // Flags reset after each turn.
    expect(turn(run([result({ subtype: 'error_during_execution', errors: ['x'] })], state)).outcome).toBe('error')
  })

  it('maps authentication errors to auth', () => {
    const events = run([
      assistant([{ type: 'text', text: 'Please run /login' }], { error: 'authentication_failed' }),
      result({ subtype: 'success', is_error: true, result: 'Invalid API key' }),
    ])
    expect(turn(events).outcome).toBe('auth')
  })

  it('maps aborts and interrupts to aborted', () => {
    expect(turn(run([result({ subtype: 'error_during_execution', errors: [], terminal_reason: 'aborted_tools' })])).outcome).toBe('aborted')
    const state = createTranslatorState({ expectStructuredOutput: false })
    state.interruptRequested = true
    expect(turn(run([result({ subtype: 'error_during_execution', errors: ['interrupted'] })], state)).outcome).toBe('aborted')
    expect(state.interruptRequested).toBe(false)
  })

  it('maps other failures to error and keeps the message', () => {
    const r = turn(run([result({ subtype: 'error_during_execution', errors: ['kaboom'] })]))
    expect(r.outcome).toBe('error')
    expect(r.errors).toEqual(['kaboom'])
    expect(r.text).toBe('')
  })

  it('reports a null context window when the SDK sends zero', () => {
    const r = turn(
      run([result({ subtype: 'success', result: 'ok', modelUsage: { m: { ...usage, contextWindow: 0 } } })]),
    )
    expect(r.usage[0]?.contextWindow).toBeNull()
  })
})
