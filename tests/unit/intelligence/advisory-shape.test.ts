import { describe, expect, it } from 'vitest'
import { CompilerOutputSchema, DirectorChallengeSchema, DirectorMemoSchema, DirectorSynthesisSchema, IntentDriftSchema } from '@shared/intelligence'
import { advisoryShape } from '@main/modules/intelligence/artifact-validation'
import { OpenAIPlanProvider } from '@main/modules/intelligence/openai'

/** Every object of a schema, however deep. */
function objects(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) for (const item of node) objects(item, found)
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    if (o['type'] === 'object') found.push(o)
    for (const value of Object.values(o)) objects(value, found)
  }
  return found
}

describe('the shape a provider is asked to enforce', () => {
  const shapes = [
    advisoryShape('compiled_specification', CompilerOutputSchema),
    advisoryShape('intent_drift_check', IntentDriftSchema),
    advisoryShape('director_memo', DirectorMemoSchema),
    advisoryShape('technical_challenge', DirectorChallengeSchema),
    advisoryShape('council_synthesis', DirectorSynthesisSchema),
  ]

  it.each(shapes)('$name is a closed object whose every field is required, with no keyword strict mode refuses', (shape) => {
    const all = objects(shape.schema)
    expect(all.length).toBeGreaterThan(0)
    for (const o of all) {
      expect(o['additionalProperties']).toBe(false)
      expect([...(o['required'] as string[])].sort()).toEqual(Object.keys(o['properties'] as object).sort())
    }
    expect(JSON.stringify(shape.schema)).not.toMatch(/"(\$schema|maxLength|minLength|maxItems|minItems|pattern|format)"/)
  })

  it('says an ambiguity is a string: the first real answer gave objects there', () => {
    const properties = shapes[0]!.schema['properties'] as Record<string, { items?: { type?: string } }>
    expect(properties['ambiguities']!.items!.type).toBe('string')
  })

  it('is sent to the Responses API as a strict JSON schema', async () => {
    let body: Record<string, unknown> = {}
    const transport = (async (_url: string | URL | Request, options?: RequestInit) => {
      body = JSON.parse(String(options?.body)) as Record<string, unknown>
      return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{}' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`, { status: 200 })
    }) as typeof fetch
    await new OpenAIPlanProvider(async () => 'token', 'model-test', transport).complete('Return JSON', {}, shapes[0])
    expect(body['text']).toEqual({ format: { type: 'json_schema', name: 'compiled_specification', schema: shapes[0]!.schema, strict: true } })
    // Without a shape nothing is added to the request.
    await new OpenAIPlanProvider(async () => 'token', 'model-test', transport).complete('Return JSON', {})
    expect(body['text']).toBeUndefined()
  })
})
