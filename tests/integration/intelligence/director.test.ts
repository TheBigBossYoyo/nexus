import { describe, expect, it, vi } from 'vitest'
import { DirectorGateway } from '@main/modules/intelligence/gateway'
import { graphHarness } from '../../helpers/context-graph'

const memo = {
  objective: 'Scope',
  recommendation: 'Verify the evidence',
  rationale: ['Evidence matters'],
  alternatives: [],
  risks: [],
  unknowns: [],
  requestedExperiments: [],
  evidenceRefs: [],
  confidence: 'MEDIUM',
}
describe('durable Director gateway', () => {
  it('saves council stages before later calls and retains independent disagreement after failure', async () => {
    const h = graphHarness()
    try {
      let calls = 0
      const result = await new DirectorGateway(h.repos.intelligenceArtifacts).invoke({
        projectId: h.project.id,
        objective: 'Scope',
        level: 3,
        reasons: [],
        context: [],
        provider: 'openai',
        model: 'test',
        strategic: {
          complete: async () => {
            if (++calls === 1) return memo
            const checkpoint = h.repos.intelligenceArtifacts.listDirectors(h.project.id)[0]!
            expect(checkpoint.state).toBe('PENDING')
            expect(checkpoint.unresolvedDisagreements).toEqual([
              'Evidence is insufficient',
              'Need a test result',
            ])
            throw new Error('secret-provider-body')
          },
        },
        technical: {
          complete: async () => {
            expect(h.repos.intelligenceArtifacts.listDirectors(h.project.id)[0]?.memo).toEqual(memo)
            return {
              agreements: [],
              disagreements: ['Evidence is insufficient'],
              missingEvidence: ['Need a test result'],
              proposedChanges: [],
              evidenceRefs: [],
            }
          },
        },
      })
      expect(result.state).toBe('FAILED')
      expect(result.memo).toEqual(memo)
      expect(result.challenge?.disagreements).toEqual(['Evidence is insufficient'])
      expect(result.synthesis).toBeNull()
      expect(JSON.stringify(result)).not.toContain('secret-provider-body')
      expect(h.repos.intelligenceArtifacts.listDirectors(h.project.id)[0]).toEqual(result)
    } finally {
      h.close()
    }
  })
  it('records waiting council without spending strategic capacity or downgrading', async () => {
    const h = graphHarness()
    try {
      const complete = vi.fn()
      const gateway = new DirectorGateway(h.repos.intelligenceArtifacts)
      const result = await gateway.invoke({
        projectId: h.project.id,
        objective: '  Review security\n',
        level: 3,
        reasons: ['SECURITY_HIGH'],
        context: [],
        strategic: { complete },
        provider: 'openai',
        model: 'test',
      })
      expect(result.state).toBe('WAITING_FOR_PROVIDER')
      expect(result.executionAuthorized).toBe(false)
      expect(complete).not.toHaveBeenCalled()
      expect(h.repos.intelligenceArtifacts.listDirectors(h.project.id)[0]?.objective).toBe(
        '  Review security\n',
      )
      expect(h.repos.intelligenceArtifacts.listDirectors('other')).toEqual([])
    } finally {
      h.close()
    }
  })
  it('persists pending before inference, rejects concurrent requests, then saves the memo', async () => {
    const h = graphHarness()
    try {
      let finish!: (value: unknown) => void
      const gateway = new DirectorGateway(h.repos.intelligenceArtifacts)
      const input = {
        projectId: h.project.id,
        objective: 'Scope',
        level: 2 as const,
        reasons: ['PRODUCT_DECISION'],
        context: [],
        strategic: {
          complete: () =>
            new Promise((resolve) => {
              finish = resolve
            }),
        },
        provider: 'openai',
        model: 'test',
      }
      const pending = gateway.invoke(input)
      expect(h.repos.intelligenceArtifacts.listDirectors(h.project.id)[0]?.state).toBe('PENDING')
      expect(h.repos.intelligenceArtifacts.reconcileInterrupted()).toBe(1)
      expect(h.repos.intelligenceArtifacts.listDirectors(h.project.id)[0]?.message).toContain(
        'not replayed automatically',
      )
      expect(h.repos.intelligenceArtifacts.reconcileInterrupted()).toBe(0)
      await expect(gateway.invoke(input)).rejects.toThrow('already in progress')
      finish(memo)
      expect((await pending).memo).toEqual(memo)
      expect(h.repos.intelligenceArtifacts.listDirectors(h.project.id)).toHaveLength(1)
      expect(h.repos.intelligenceArtifacts.listDirectors(h.project.id)[0]?.state).toBe('COMPLETED')
    } finally {
      h.close()
    }
  })
  it('stores a safe failure without provider secrets and preserves the original objective', async () => {
    const h = graphHarness()
    try {
      const result = await new DirectorGateway(h.repos.intelligenceArtifacts).invoke({
        projectId: h.project.id,
        objective: 'Original',
        level: 2,
        reasons: [],
        context: [],
        strategic: {
          complete: async () => {
            throw new Error('secret-provider-body')
          },
        },
        provider: 'openai',
        model: 'test',
      })
      expect(result.state).toBe('FAILED')
      expect(JSON.stringify(result)).not.toContain('secret-provider-body')
      expect(h.db.prepare('SELECT raw_text FROM raw_user_intents').get()).toEqual({
        raw_text: 'Original',
      })
    } finally {
      h.close()
    }
  })
})
