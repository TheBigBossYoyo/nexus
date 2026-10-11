import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserIntentMetadataSchema, type UserIntentMetadata } from '@shared/intelligence'
import { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { createV72Handlers } from '@main/modules/ipc/v72-handlers'
import { graphHarness } from '../../helpers/context-graph'

/**
 * Finding 13.4. The rule that nothing is sent to ChatGPT until the user has confirmed that paid credits are off
 * was tested as a refusal for a mission only. It holds for every way a request enters and for every depth that
 * would ask the provider, and for the Directors: with the confirmation off, the transport is never called.
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function connectionWith(confirmed: boolean, transport: typeof fetch): ChatGPTConnection {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-consent-test-'))
  dirs.push(dir)
  const credentials = { clientId: 'oaiapp_test', issuer: 'https://auth.openai.com', subject: 'subject', email: null, accessToken: 'test-access', refreshToken: 'test-refresh', idToken: 'test-id', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3_600_000 }
  writeFileSync(join(dir, 'chatgpt-credentials.protected'), JSON.stringify({
    hostId: 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    active: 'one',
    profiles: [{ id: 'one', registration: { ...credentials, accessToken: '', refreshToken: null, idToken: '' }, credentials, model: 'model-test', includedOnlyConfirmed: confirmed }],
  }))
  return new ChatGPTConnection(dir, { available: () => true, encrypt: (v) => Buffer.from(v), decrypt: (v) => v.toString() }, undefined, transport)
}

const ENTRY_POINTS = UserIntentMetadataSchema.shape.entryPoint.options
const DEPTHS = ['AUTO', 'STANDARD', 'TECHNICAL', 'COUNCIL'] as const

describe('nothing is sent to ChatGPT while the paid-credit confirmation is off', () => {
  it('for every way a request enters and every depth that would ask the provider', async () => {
    const h = graphHarness()
    const transport = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    const connection = connectionWith(false, transport)
    try {
      expect(connection.status().state).toBe('SIGNED_IN_PLAN_USAGE')
      expect(connection.provider()).toBeUndefined()
      const handlers = createV72Handlers(h.repos, connection)
      for (const entryPoint of ENTRY_POINTS) {
        for (const mode of DEPTHS) {
          const raw = `Add a leaderboard (${entryPoint}, ${mode})`
          const metadata: UserIntentMetadata = { entryPoint, goals: [raw], constraints: [], acceptanceCriteria: [] }
          const spec = await handlers['compilation.preview']({ projectId: h.project.id, raw, mode, metadata })
          expect(spec.status, `${entryPoint} ${mode}`).toBe('WAITING_FOR_PROVIDER')
          expect(spec.recommendations, `${entryPoint} ${mode}`).toEqual([])
          await expect(handlers['compilation.validate']({ projectId: h.project.id, raw, mode, metadata, specId: spec.id }), `${entryPoint} ${mode}`).rejects.toThrow()
        }
      }
      // The depths that ask no provider still work: the rule does not stop a request, it stops the sending.
      for (const mode of ['EXACT', 'LIGHT'] as const) {
        const spec = await handlers['compilation.preview']({ projectId: h.project.id, raw: 'Fix the typo in the heading', mode })
        expect(spec.status, mode).toBe('READY')
      }
      // The Directors: a strategic request and a council wait or fail, and say nothing to the provider.
      for (const level of [2, 3] as const) {
        const invocation = await handlers['director.invoke']({ projectId: h.project.id, objective: 'Should the store be rewritten?', level })
        expect(invocation.memo, `level ${level}`).toBeNull()
        expect(['WAITING_FOR_PROVIDER', 'FAILED'], `level ${level}`).toContain(invocation.state)
      }
      expect(transport).not.toHaveBeenCalled()
    } finally {
      connection.dispose()
      h.close()
    }
  })
})
