import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import type { SDKAssistantMessageError, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, TurnOutcome, TurnResult, UsageInfo } from './types'

const PREVIEW_LIMIT = 500

const AUTH_ERRORS: readonly SDKAssistantMessageError[] = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
]

/** Mutable per-session translation state. One instance per SDK query. */
export interface TranslatorState {
  /** True when the caller requested a structured output schema. */
  expectStructuredOutput: boolean
  sessionId: string | null
  startedEmitted: boolean
  // Per-turn flags, reset by each result message.
  authError: boolean
  quotaSignal: boolean
  /** Set by the session handle when interrupt() is called, so the resulting error result reads as aborted. */
  interruptRequested: boolean
  /** API message ids whose usage was already reported: one response can arrive as several assistant messages. */
  reportedRequests: Set<string>
}

export function createTranslatorState(options: { expectStructuredOutput: boolean }): TranslatorState {
  return {
    expectStructuredOutput: options.expectStructuredOutput,
    sessionId: null,
    startedEmitted: false,
    authError: false,
    quotaSignal: false,
    interruptRequested: false,
    reportedRequests: new Set(),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function truncate(text: string): string {
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}...` : text
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as unknown[]) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
    else if (isRecord(block) && block['type'] === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

function looksLikeUsageLimit(text: string): boolean {
  return USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p))
}

function mapUsage(msg: SDKResultMessage): UsageInfo[] {
  return Object.entries(msg.modelUsage).map(([model, u]) => ({
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadInputTokens,
    cacheCreationTokens: u.cacheCreationInputTokens,
    costUsd: u.costUSD,
    contextWindow: u.contextWindow > 0 ? u.contextWindow : null,
    ...(typeof u.thinkingTokens === 'number' ? { thinkingTokens: u.thinkingTokens } : {}),
  }))
}

function classifyResult(msg: SDKResultMessage, state: TranslatorState): TurnOutcome {
  if (msg.subtype === 'error_max_turns') return 'max_turns'
  if (msg.subtype === 'error_max_structured_output_retries') return 'structured_output_failed'
  if (msg.terminal_reason === 'structured_output_retry_exhausted') return 'structured_output_failed'
  if (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools') return 'aborted'

  if (msg.subtype !== 'success' || msg.is_error) {
    if (state.interruptRequested) return 'aborted'
    const text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n')
    if (state.authError) return 'auth'
    if (state.quotaSignal || looksLikeUsageLimit(text)) return 'quota'
    return 'error'
  }
  if (state.expectStructuredOutput && msg.structured_output === undefined) return 'structured_output_failed'
  return 'success'
}

function translateResult(msg: SDKResultMessage, state: TranslatorState): AgentEvent {
  const outcome = classifyResult(msg, state)
  const errors = [...(msg.subtype === 'success' ? [] : msg.errors)]
  if (msg.subtype === 'success' && msg.is_error && msg.result) errors.push(msg.result)
  if (outcome === 'structured_output_failed' && errors.length === 0) {
    errors.push('The session finished without a valid structured output.')
  }
  const result: TurnResult = {
    outcome,
    text: msg.subtype === 'success' && !msg.is_error ? msg.result : '',
    structuredOutput: msg.subtype === 'success' ? (msg.structured_output ?? null) : null,
    numTurns: msg.num_turns,
    durationMs: msg.duration_ms,
    usage: mapUsage(msg),
    totalCostUsd: msg.total_cost_usd,
    errors,
  }
  state.authError = false
  state.quotaSignal = false
  state.interruptRequested = false
  return { type: 'turn.completed', result }
}

/**
 * Pure mapping from one SDK message to zero or more NEXUS events. Thinking blocks and subagent
 * traffic are dropped on purpose: hidden reasoning is never exposed.
 */
export function translateSdkMessage(msg: SDKMessage, state: TranslatorState): AgentEvent[] {
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        state.sessionId = msg.session_id
        if (state.startedEmitted) return []
        state.startedEmitted = true
        return [
          {
            type: 'session.started',
            sessionId: msg.session_id,
            model: msg.model,
            tools: [...msg.tools],
            apiKeySource: msg.apiKeySource ?? null,
          },
        ]
      }
      if (msg.subtype === 'status') {
        return msg.status ? [{ type: 'status', status: msg.status }] : []
      }
      if (msg.subtype === 'compact_boundary') {
        const meta = msg.compact_metadata
        return [
          { type: 'status', status: 'compacted' },
          { type: 'compaction', trigger: meta.trigger, preTokens: Number.isFinite(meta.pre_tokens) ? meta.pre_tokens : null, postTokens: typeof meta.post_tokens === 'number' ? meta.post_tokens : null, durationMs: typeof meta.duration_ms === 'number' ? meta.duration_ms : null },
        ]
      }
      return []
    }

    case 'assistant': {
      if (msg.parent_tool_use_id !== null) return []
      const events: AgentEvent[] = []
      // Per-request usage: counted once per API message id. A message the runtime made up (model "<synthetic>",
      // or no tokens at all) is no request; an error that carries real usage (the output limit) is one.
      const requestId = msg.message.id
      const usage = msg.message.usage as { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined
      const realRequest =
        usage !== undefined &&
        msg.message.model !== '<synthetic>' &&
        (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) > 0
      if (realRequest && typeof requestId === 'string' && requestId !== '' && !state.reportedRequests.has(requestId)) {
        state.reportedRequests.add(requestId)
        events.push({
          type: 'request.usage',
          requestId,
          model: typeof msg.message.model === 'string' ? msg.message.model : null,
          inputTokens: usage?.input_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        })
      }
      if (msg.error) {
        if (AUTH_ERRORS.includes(msg.error)) state.authError = true
        const errorText = msg.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ')
        // A usage limit is billing_error, or a rate_limit that this session's rate_limit_event rejected or whose
        // text is one of the documented usage-limit messages. Any other 429 is a transient throttle.
        const usageLimit = msg.error === 'billing_error' || (msg.error === 'rate_limit' && (state.quotaSignal || looksLikeUsageLimit(errorText)))
        if (usageLimit) {
          state.quotaSignal = true
          events.push({ type: 'rate_limit', status: 'rejected', resetsAt: null, limitType: null })
        } else if (msg.error === 'rate_limit' || msg.error === 'overloaded' || msg.error === 'server_error') {
          events.push({ type: 'throttle', kind: msg.error })
        }
      }
      for (const block of msg.message.content) {
        // Error carriers hold a synthetic explanation; the turn outcome conveys the failure instead.
        if (block.type === 'text' && !msg.error) {
          if (block.text.length > 0) events.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool.started',
            toolUseId: block.id,
            toolName: block.name,
            input: isRecord(block.input) ? block.input : {},
          })
        }
      }
      return events
    }

    case 'user': {
      if (msg.parent_tool_use_id !== null) return []
      const content = msg.message.content
      if (typeof content === 'string') return []
      const events: AgentEvent[] = []
      for (const block of content) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool.completed',
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            outputPreview: truncate(toolResultText(block.content)),
          })
        }
      }
      return events
    }

    case 'stream_event': {
      if (msg.parent_tool_use_id !== null) return []
      const e = msg.event
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && e.delta.text.length > 0) {
        return [{ type: 'text.delta', text: e.delta.text }]
      }
      return []
    }

    case 'rate_limit_event': {
      const info = msg.rate_limit_info
      if (info.status === 'rejected') state.quotaSignal = true
      return [
        {
          type: 'rate_limit',
          status: info.status,
          resetsAt: info.resetsAt ?? null,
          limitType: info.rateLimitType ?? null,
          utilization: info.utilization ?? null,
          overageStatus: info.overageStatus ?? null,
          isUsingOverage: info.isUsingOverage ?? null,
          surpassedThreshold: info.surpassedThreshold ?? null,
        },
      ]
    }

    case 'result':
      return [translateResult(msg, state)]

    default:
      return []
  }
}
