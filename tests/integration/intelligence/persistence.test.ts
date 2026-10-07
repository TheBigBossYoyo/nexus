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
