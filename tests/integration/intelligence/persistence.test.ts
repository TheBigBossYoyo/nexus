import { describe, expect, it } from 'vitest'
import { graphHarness } from '../../helpers/context-graph'
import { compileTask } from '@main/modules/intelligence/compiler'
import { IntelligenceStore } from '@main/modules/persistence/repositories/intelligence'

describe('intelligence persistence', () => {
  it('preserves intent before a failed provider call and rejects a mismatched artifact', async () => {
    const h = graphHarness()
    try {
      const raw = '  A request that must survive provider failure\n'
      const store = h.repos.intelligenceArtifacts
      const intentId = store.saveIntent(h.project.id, raw)
      await expect(
        compileTask({
          raw,
          projectId: h.project.id,
          mode: 'STANDARD',
          context: [],
          policyVersion: '1',
          strategy: 'test',
          strategic: {
            complete: async () => {
              throw new Error('offline')
            },
          },
        }),
      ).rejects.toThrow('offline')
      expect(
        h.db.prepare('SELECT raw_text FROM raw_user_intents WHERE id=?').get(intentId),
      ).toEqual({ raw_text: raw })
      const spec = await compileTask({
        raw: 'Different',
        projectId: h.project.id,
        mode: 'EXACT',
        context: [],
        policyVersion: '1',
        strategy: 'test',
      })
      expect(() => store.saveCompilation(spec, intentId)).toThrow('does not match')
    } finally {
      h.close()
    }
  })
  it('preserves exact raw input, scopes reads, deduplicates completed specs and rejects mutation', async () => {
    const h = graphHarness()
    try {
      const raw = '  Fix typo\n'
      const spec = await compileTask({
        raw,
        projectId: h.project.id,
        mode: 'EXACT',
        context: [],
        policyVersion: '1',
        strategy: 'test',
      })
      const store = h.repos.intelligenceArtifacts
      store.saveCompilation(spec)
      store.saveCompilation({ ...spec, id: 'duplicate' })
      expect(store.listCompilations(h.project.id)).toHaveLength(1)
      expect(store.compilation('other-project', spec.id)).toBeNull()
      expect(h.db.prepare('SELECT raw_text FROM raw_user_intents').get()).toEqual({ raw_text: raw })
      expect(() => h.db.prepare("UPDATE raw_user_intents SET raw_text='changed'").run()).toThrow(
        'immutable',
      )
      expect(new IntelligenceStore(h.db).compilation(h.project.id, spec.id)?.rawIntent).toBe(raw)
    } finally {
      h.close()
    }
  })
  it('allows provider recovery without a permanently cached wait', async () => {
    const h = graphHarness()
    try {
      const input = {
        raw: 'Feature request',
        projectId: h.project.id,
        mode: 'STANDARD' as const,
        context: [],
        policyVersion: '1',
        strategy: 'test',
      }
      h.repos.intelligenceArtifacts.saveCompilation(await compileTask(input))
      const ready = await compileTask({
        ...input,
        strategic: {
          complete: async (instructions) =>
            instructions.startsWith('INTENT_DRIFT_CHECK')
              ? {
                  changesIntent: false,
                  expandsScope: false,
                  conflicts: [],
                  unjustifiedRequirements: [],
                }
              : { recommendations: [], scopeChanged: false, ambiguities: [] },
        },
      })
      expect(h.repos.intelligenceArtifacts.saveCompilation(ready).status).toBe('READY')
      expect(h.repos.intelligenceArtifacts.listCompilations(h.project.id)).toHaveLength(2)
    } finally {
      h.close()
    }
  })
  it('only one recovery controller claims a checkpoint revision', () => {
    const h = graphHarness()
    try {
      const a = h.repos.intelligenceArtifacts,
        b = new IntelligenceStore(h.db)
      expect(a.checkpoint('wait', null, { state: 'WAITING' })).toBe(true)
      expect(b.checkpoint('wait', null, {})).toBe(false)
      expect(a.checkpoint('wait', 0, { state: 'PROBING' })).toBe(true)
      expect(b.checkpoint('wait', 0, {})).toBe(false)
      expect(b.readCheckpoint('wait')).toEqual({ body: { state: 'PROBING' }, revision: 1 })
    } finally {
      h.close()
    }
  })
})

describe('what the advisory roles used', () => {
  // Finding 9.5: what the compiler and the Directors used was kept as receipts on routing records and shown nowhere.
  it('is summed per provider from the receipts, and says what was sent without a report', async () => {
    const { graphHarness } = await import('../../helpers/context-graph')
    const h = graphHarness()
    try {
      const store = h.repos.intelligenceArtifacts
      const base = { projectId: h.project.id, operationId: 'op', stage: 'STRATEGIC', poolIds: [], policyVersion: 'p', reasons: [], qualityEvidence: [], action: 'ROUTE' as const, model: 'm', endedAt: null, failure: null }
      const receipt = (inputTokens: number, outputTokens: number) => ({ models: ['m'], inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null })
      store.saveRouting({ ...base, id: 'r1', provider: 'openai', role: 'compiler', state: 'COMPLETED', createdAt: '2026-10-10T10:00:00.000Z', consumption: 'PROVIDER_REPORTED', usage: receipt(800, 200) })
      store.saveRouting({ ...base, id: 'r2', provider: 'openai', role: 'strategic', state: 'COMPLETED', createdAt: '2026-10-10T11:00:00.000Z', consumption: 'PROVIDER_REPORTED', usage: receipt(1000, 500) })
      store.saveRouting({ ...base, id: 'r3', provider: 'openai', role: 'compiler', state: 'FAILED', createdAt: '2026-10-10T12:00:00.000Z', consumption: 'UNKNOWN', usage: null })
      store.saveRouting({ ...base, id: 'r4', provider: 'claude', role: 'technical', state: 'FAILED', createdAt: '2026-10-10T12:30:00.000Z', consumption: 'NOT_SENT', usage: null })
      // Not advisory, not routed, or before the period: none of these is counted.
      store.saveRouting({ ...base, id: 'r5', provider: 'claude', role: 'worker', state: 'COMPLETED', createdAt: '2026-10-10T13:00:00.000Z', usage: receipt(9, 9) })
      store.saveRouting({ ...base, id: 'r6', provider: null, model: null, action: 'WAIT', role: 'compiler', state: 'WAITING_FOR_CAPACITY', createdAt: '2026-10-10T13:00:00.000Z' })
      store.saveRouting({ ...base, id: 'r7', provider: 'openai', role: 'compiler', state: 'COMPLETED', createdAt: '2026-10-01T00:00:00.000Z', usage: receipt(7, 7) })
      expect(store.advisoryUsage('2026-10-09T00:00:00.000Z')).toEqual({
        since: '2026-10-09T00:00:00.000Z',
        providers: [
          { provider: 'claude', requests: 1, reported: 0, unreported: 0, notSent: 1, inputTokens: 0, outputTokens: 0 },
          { provider: 'openai', requests: 3, reported: 2, unreported: 1, notSent: 0, inputTokens: 1800, outputTokens: 700 },
        ],
      })
    } finally {
      h.close()
    }
  })
})
