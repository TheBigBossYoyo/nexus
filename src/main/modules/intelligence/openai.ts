import { z } from 'zod'
import type { AdvisoryProvider } from './compiler'
import { classifyOpenAIError } from '../capacity/policy'
import { readBoundedJSON } from './transport'
import type { ProviderUsageReceipt } from '@shared/capacity'

export const OPENAI_API = 'https://api.openai.com/v1'
export class PlanInferenceError extends Error {
  readonly state
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null,
  ) {
    // Raw provider bodies are deliberately excluded: they can echo prompts or credentials.
    super(`ChatGPT plan request failed (${status}; ${classifyOpenAIError(status, code)})`)
    this.state = classifyOpenAIError(status, code)
  }
}
const ErrorBody = z.object({ error: z.object({ code: z.string().max(160).optional() }).optional() })
const Catalog = z.object({
  models: z
    .array(
      z.object({
        slug: z.string().min(1).max(200),
        display_name: z.string().max(200),
        visibility: z.string(),
      }),
    )
    .max(1000),
})

/** The caller supplies a runtime-owned, consent-checked token; no API-key fallback exists. */
export class OpenAIPlanProvider implements AdvisoryProvider {
  private receipt: ProviderUsageReceipt | null = null
  usage(): ProviderUsageReceipt | null {
    return this.receipt ? structuredClone(this.receipt) : null
  }
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly model: string,
    private readonly transport: typeof fetch = fetch,
    private readonly shutdownSignal?: AbortSignal,
  ) {}
  async models(): Promise<{ slug: string; display_name: string }[]> {
    const response = await this.transport(`${OPENAI_API}/models`, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(this.shutdownSignal ? [this.shutdownSignal] : []),
      ]),
      redirect: 'error',
    })
    if (!response.ok)
      throw new PlanInferenceError(response.status, null, response.headers.get('x-request-id'))
    return Catalog.parse(await readBoundedJSON(response))
      .models.filter((m) => m.visibility === 'list')
      .map(({ slug, display_name }) => ({ slug, display_name }))
  }
  async complete(instructions: string, data: unknown): Promise<unknown> {
    this.receipt = null
    const content = JSON.stringify(data)
    if (content.length > 128000 || instructions.length > 16000 || !this.model.trim())
      throw new Error('Invalid advisory request')
    const response = await this.transport(`${OPENAI_API}/responses`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(180_000),
        ...(this.shutdownSignal ? [this.shutdownSignal] : []),
      ]),
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        instructions,
        input: [{ role: 'user', content }],
        store: false,
        stream: true,
      }),
    })
    if (!response.ok) {
      const parsed = ErrorBody.safeParse(await readBoundedJSON(response, 64000).catch(() => null))
      throw new PlanInferenceError(
        response.status,
        parsed.success ? (parsed.data.error?.code ?? null) : null,
        response.headers.get('x-request-id'),
      )
    }
    if (!response.body) throw new Error('Provider returned no event stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = '',
      output = '',
      received = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += chunk.value.byteLength
        if (received > 4_000_000) throw new Error('Advisory stream exceeded its byte limit')
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n')
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const payload = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n')
          if (!payload || payload === '[DONE]') continue
          let parsed: unknown
          try {
            parsed = JSON.parse(payload)
          } catch {
            throw new Error('Provider event is not valid JSON')
          }
          const event = z
            .object({
              type: z.string(),
              code: z.string().max(160).optional(),
              delta: z.string().optional(),
              response: z
                .object({
                  status: z.string().optional(),
                  model: z.string().max(200).optional(),
                  usage: z
                    .object({
                      input_tokens: z.number().int().nonnegative(),
                      output_tokens: z.number().int().nonnegative(),
                      total_tokens: z.number().int().nonnegative(),
                      input_tokens_details: z
                        .object({
                          cached_tokens: z.number().int().nonnegative().optional(),
                          cache_write_tokens: z.number().int().nonnegative().optional(),
                        })
                        .optional(),
                      output_tokens_details: z
                        .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
                        .optional(),
                    })
                    .nullable()
                    .optional(),
                  error: z
                    .object({ code: z.string().max(160).optional() })
                    .nullable()
                    .optional(),
                })
                .optional(),
            })
            .parse(parsed)
          if (event.type === 'response.output_text.delta') output += event.delta ?? ''
          if (output.length > 128000) throw new Error('Advisory output exceeds artifact limit')
          if (event.type === 'response.failed' || event.type === 'error')
            throw new PlanInferenceError(
              0,
              event.response?.error?.code ?? event.code ?? null,
              response.headers.get('x-request-id'),
            )
          if (event.type === 'response.incomplete') throw new Error('Provider response incomplete')
          if (event.type === 'response.completed') {
            if (event.response?.status && event.response.status !== 'completed')
              throw new Error('Contradictory terminal provider status')
            if (event.response?.usage) {
              const u = event.response.usage
              this.receipt = {
                models: event.response.model ? [event.response.model] : [],
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                totalTokens: u.total_tokens,
                cacheReadTokens: u.input_tokens_details?.cached_tokens ?? null,
                cacheWriteTokens: u.input_tokens_details?.cache_write_tokens ?? null,
                reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? null,
              }
            }
            try {
              return JSON.parse(output) as unknown
            } catch {
              throw new Error('Advisory output is not valid JSON')
            }
          }
        }
      }
      throw new Error('Stream ended without response.completed')
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}
