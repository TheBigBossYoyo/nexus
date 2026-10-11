import { describe, expect, it } from 'vitest'
import type { CapacityPool, ProviderCapacityLease, RoutingCandidate } from '@shared/capacity'
import type { Recommendation } from '@shared/intelligence'
import { CapacityRegistry, CapacityWaitError } from '@main/modules/capacity/registry'
import { CapacityAwareProviderRouter } from '@main/modules/capacity/router'
import { classifyOpenAIError, isRequestRefusal } from '@main/modules/capacity/policy'
import { compileTask, type AdvisoryProvider } from '@main/modules/intelligence/compiler'
import { compilationDepth } from '@main/modules/intelligence/depth'
import { structuredDriftFlags } from '@main/modules/intelligence/drift'
import { DirectorGateway } from '@main/modules/intelligence/gateway'
import { mulberry32 } from '@main/modules/policy'
import { graphHarness } from '../helpers/context-graph'

/**
 * Seeded stress of the 0.7.2 advisory path with scripted providers (no provider is called): the Task Compiler,
 * the Director gateway, the ChatGPT capacity registry and the depth policy. Each seed draws a provider that
 * answers well, badly or not at all, and the invariants below must hold whatever it draws.
 *
 *   NEXUS_INTELLIGENCE_STRESS_RUNS=2000 pnpm stress tests/stress/intelligence-stress.test.ts
 */
const RUNS = Number(process.env['NEXUS_INTELLIGENCE_STRESS_RUNS'] ?? process.env['NEXUS_STRESS_RUNS'] ?? 300)
const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
const SECRET = 'sk-STRESS-SECRET-0123456789abcdef'

const WORDS = ['fix', 'the', 'ordering', 'of', 'laps', 'in', 'src/telemetry/order.js', 'must', 'return', 'refactor', 'security', 'across', 'entire', 'codebase', 'add', 'export', 'improve', 'somehow', 'authentication', 'migrate', 'schema', 'production', 'typo', 'should', 'when', 'tests', 'src/a.js', 'src/b.js', 'deploy', 'credentials']
const sentence = (rand: () => number, n: number): string => Array.from({ length: n }, () => pick(rand, WORDS)).join(' ')
const KINDS: Recommendation['kind'][] = ['REQUIREMENT', 'ACCEPTANCE', 'CONSTRAINT', 'NON_GOAL', 'RISK', 'ASSUMPTION', 'UNKNOWN', 'VERIFICATION']
const PROVENANCE: Recommendation['provenance'][] = ['CONTEXT_DERIVED', 'DIRECTOR_RECOMMENDED', 'TECHNICAL_REQUIREMENT', 'ASSUMPTION']
const ADDITIONS = ['Add a new dependency on a queue library', 'Skip the failing tests for now', 'Log the access token for debugging', 'Force-push the rewritten history to the main branch', 'Rewrite the entire framework', 'Add a test for the wrap case', 'Keep the public API unchanged', 'Do not disable any test']

function recommendations(rand: () => number): Recommendation[] {
  return Array.from({ length: Math.floor(rand() * 6) }, () => ({
    text: rand() < 0.5 ? pick(rand, ADDITIONS) : sentence(rand, 3 + Math.floor(rand() * 8)),
    kind: pick(rand, KINDS),
    provenance: pick(rand, PROVENANCE),
    evidenceRefs: rand() < 0.3 ? [pick(rand, ['n1', 'n2', 'never-supplied'])] : [],
    requiresDecision: rand() < 0.15,
  }))
}

/** A provider that answers as drawn: a valid answer, a wrong shape, something that is not an object, or a throw. */
function scripted(rand: () => number, answer: () => unknown): AdvisoryProvider {
  return {
    complete: async (instructions) => {
      const roll = rand()
      if (roll < 0.08) throw new Error('scripted provider failure')
      if (roll < 0.14) return { unexpected: SECRET }
      if (roll < 0.18) return 'not an object'
      if (instructions.startsWith('INTENT_DRIFT_CHECK'))
        return { changesIntent: rand() < 0.1, expandsScope: rand() < 0.1, conflicts: rand() < 0.1 ? ['a conflict'] : [], unjustifiedRequirements: rand() < 0.1 ? ['an addition'] : [] }
      return answer()
    },
  }
}

describe('the advisory path under seeded providers', () => {
  it(`Task Compiler: ${RUNS} seeds keep the request, the provenance and the scope`, async () => {
    const context = [{ id: 'n1', version: '1', text: 'A note' }, { id: 'n2', version: '1', text: 'Another note' }]
    const counts: Record<string, number> = {}
    for (let seed = 1; seed <= RUNS; seed++) {
      const rand = mulberry32(seed)
      const raw = `${rand() < 0.2 ? '  ' : ''}${sentence(rand, 2 + Math.floor(rand() * 30))}${rand() < 0.2 ? '\n' : ''}`
      const mode = pick(rand, ['AUTO', 'EXACT', 'LIGHT', 'STANDARD', 'TECHNICAL', 'COUNCIL'] as const)
      const proposed = recommendations(rand)
      const provider = (): AdvisoryProvider => scripted(rand, () => ({ recommendations: proposed, scopeChanged: rand() < 0.1, ambiguities: rand() < 0.2 ? ['Which unit?'] : [] }))
      const withStrategic = rand() < 0.85, withTechnical = rand() < 0.85
      const outcome = await compileTask({
        raw, projectId: 'p', mode, context, policyVersion: '1', strategy: 'stress',
        ...(withStrategic ? { strategic: provider() } : {}),
        ...(withTechnical ? { technical: scripted(rand, () => ({ agreements: [], disagreements: [], missingEvidence: [], proposedChanges: [], evidenceRefs: [] })) } : {}),
      }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
      const tag = `seed ${seed} mode ${mode}`
      if (outcome instanceof Error) {
        // A provider's own failure passes through; an answer of the wrong shape is refused by position and kind,
        // never by what the provider wrote in it.
        expect(outcome.message, tag).not.toContain(SECRET)
        counts['error'] = (counts['error'] ?? 0) + 1
        continue
      }
      counts[outcome.status] = (counts[outcome.status] ?? 0) + 1
      // The request is the root of the specification, byte for byte.
      expect(outcome.rawIntent, tag).toBe(raw)
      expect(outcome.requestedMode, tag).toBe(mode)
      expect(['READY', 'USER_DECISION_REQUIRED', 'WAITING_FOR_PROVIDER'], tag).toContain(outcome.status)
      expect(outcome.mode, tag).not.toBe('AUTO')
      if (mode !== 'AUTO') expect(outcome.mode, tag).toBe(mode)
      else expect(outcome.mode, tag).not.toBe('EXACT')
      // No downgrade: a depth that needs a provider it does not have waits, with nothing added.
      const needs = outcome.mode === 'STANDARD' ? !withStrategic : outcome.mode === 'TECHNICAL' || outcome.mode === 'COUNCIL' ? !withStrategic || !withTechnical : false
      if (needs) {
        expect(outcome.status, tag).toBe('WAITING_FOR_PROVIDER')
        expect(outcome.recommendations, tag).toEqual([])
      }
      if (outcome.mode === 'EXACT') expect(outcome.recommendations, tag).toEqual([])
      // Nothing stored cites evidence that was not supplied, and nothing claims to be the user's.
      for (const r of outcome.recommendations) {
        for (const ref of r.evidenceRefs) expect(['n1', 'n2'], tag).toContain(ref)
        expect(PROVENANCE, tag).toContain(r.provenance)
      }
      // An addition of consequence the model made is never READY without the user.
      if (outcome.status === 'READY' && outcome.recommendations.length > 0) expect(structuredDriftFlags(raw, outcome.recommendations), tag).toEqual([])
      expect(JSON.stringify(outcome), tag).not.toContain(SECRET)
    }
    // The draw reached every outcome: the invariants above were exercised, not skipped.
    for (const status of ['READY', 'USER_DECISION_REQUIRED', 'WAITING_FOR_PROVIDER', 'error']) expect(counts[status] ?? 0, status).toBeGreaterThan(0)
  })

  it(`Director gateway: ${RUNS} seeds end in a saved terminal state that authorizes nothing`, async () => {
    const h = graphHarness()
    try {
      const gateway = new DirectorGateway(h.repos.intelligenceArtifacts)
      const states: Record<string, number> = {}
      for (let seed = 1; seed <= RUNS; seed++) {
        const rand = mulberry32(seed * 7919)
        const level = pick(rand, [1, 2, 3] as const)
        const memo = () => ({ objective: 'Scope', recommendation: sentence(rand, 6), rationale: [sentence(rand, 4)], alternatives: [], risks: [], unknowns: [], requestedExperiments: [], evidenceRefs: rand() < 0.3 ? ['never-supplied'] : [], confidence: pick(rand, ['LOW', 'MEDIUM', 'HIGH']) })
        const strategic = scripted(rand, () => (rand() < 0.5 ? memo() : { decision: 'Proceed', acceptedClaims: [], rejectedClaims: [], unresolvedUnknowns: [], nextActions: [], evidenceRefs: [] }))
        const strategicByStage: AdvisoryProvider = { complete: async (instructions, data, shape) => {
          const answer = await strategic.complete(instructions, data, shape)
          if (typeof answer !== 'object' || answer === null || 'unexpected' in answer) return answer
          return instructions.includes('acceptedClaims') ? { decision: 'Proceed', acceptedClaims: [], rejectedClaims: [], unresolvedUnknowns: [], nextActions: [], evidenceRefs: [] } : memo()
        } }
        const technical = scripted(rand, () => (level === 1 ? memo() : { agreements: [], disagreements: rand() < 0.5 ? ['A disagreement'] : [], missingEvidence: [], proposedChanges: [], evidenceRefs: [] }))
        const objective = `Objective ${seed}: ${sentence(rand, 5)}`
        const result = await gateway.invoke({ projectId: h.project.id, objective, level, reasons: [], context: [], provider: level === 1 ? 'claude' : 'openai', model: 'test', strategic: strategicByStage, technical })
        const tag = `seed ${seed} level ${level}`
        states[result.state] = (states[result.state] ?? 0) + 1
        expect(result.state, tag).not.toBe('PENDING')
        expect(result.objective, tag).toBe(objective)
        // What was returned is what is saved, and nothing a provider threw or wrote out of shape is in it.
        // (Looked up by id: two invocations of one millisecond are listed in no particular order.)
        const saved = h.repos.intelligenceArtifacts.listDirectors(h.project.id).find((d) => d.id === result.id)
        expect(saved, tag).toEqual(result)
        expect(JSON.stringify(result), tag).not.toContain(SECRET)
        for (const stage of [result.memo, result.challenge, result.synthesis]) if (stage) expect(stage.evidenceRefs, tag).toEqual([])
        // Advice never authorizes execution, whatever it says.
        expect(JSON.stringify(result), tag).not.toContain('"executionAuthorized":true')
        // Nothing is left for a restart to find half done.
        expect(h.repos.intelligenceArtifacts.reconcileInterrupted(), tag).toBe(0)
      }
      expect(Object.keys(states).length).toBeGreaterThan(1)
    } finally {
      h.close()
    }
  }, 600_000)

  it(`ChatGPT capacity registry: ${RUNS} seeds never admit against the evidence`, () => {
    const registration = { issuer: 'https://auth.openai.com', clientId: 'app', subject: 'account' }
    for (let seed = 1; seed <= RUNS; seed++) {
      const rand = mulberry32(seed * 104729)
      let now = 1_000_000
      const registry = new CapacityRegistry(undefined, () => now)
      const binding = registry.binding(registration)
      for (let step = 0; step < 60; step++) {
        const tag = `seed ${seed} step ${step}`
        now += Math.floor(rand() * 20 * 60_000)
        const before = registry.pool(binding)
        let admitted = false
        try {
          const pool = registry.admit(binding)
          admitted = true
          // Admitted only with capacity not known to be gone, or as a probe that was due.
          if (['AVAILABLE', 'LIMIT_APPROACHING', 'USAGE_UNKNOWN'].includes(before.state)) expect(pool.state, tag).toBe(before.state)
          else {
            expect(pool.state, tag).toBe('PROBING')
            expect(before.state, tag).not.toBe('AUTH_REQUIRED')
            expect(before.nextProbeAt, tag).not.toBeNull()
            expect(now, tag).toBeGreaterThanOrEqual(before.nextProbeAt!)
          }
        } catch (error) {
          expect(error, tag).toBeInstanceOf(CapacityWaitError)
          expect(['AVAILABLE', 'LIMIT_APPROACHING', 'USAGE_UNKNOWN'], tag).not.toContain(before.state)
          expect(registry.pool(binding), tag).toEqual(before)
        }
        if (!admitted) {
          if (before.state === 'AUTH_REQUIRED' && rand() < 0.3) registry.reconnect(binding)
          continue
        }
        const roll = rand()
        if (roll < 0.35) {
          registry.success(binding)
          expect(registry.pool(binding).state, tag).toBe('AVAILABLE')
        } else if (roll < 0.55) {
          // A request that ended without an answer about capacity plans no wait and counts as no attempt.
          const after = registry.inconclusive(binding)
          expect(after.probeAttempts, tag).toBe(registry.pool(binding).probeAttempts)
          if (after.state !== 'PROBING') expect(after.state, tag).toBe(before.state)
          expect(() => registry.admit(binding), tag).not.toThrow()
        } else {
          const [status, code] = pick(rand, [[429, 'subscription_sharing_usage_limit_exceeded'], [429, null], [401, null], [500, null], [0, 'rate_limit_exceeded'], [429, 'insufficient_quota'], [404, 'model_not_found'], [400, null]] as const)
          if (isRequestRefusal(status, code)) registry.inconclusive(binding)
          else {
            const pool = registry.failure(binding, status, code)
            expect(pool.state, tag).toBe(classifyOpenAIError(status, code))
            // No reset time is ever invented, and a pause is never open-ended unless it needs a sign-in.
            expect(pool.resetAt.value, tag).toBeNull()
            if (pool.state === 'AUTH_REQUIRED') expect(pool.nextProbeAt, tag).toBeNull()
            else expect(pool.nextProbeAt!, tag).toBeGreaterThan(now)
            expect(() => registry.admit(binding), tag).toThrow(CapacityWaitError)
          }
        }
      }
    }
  })

  it(`depth policy: ${RUNS * 10} drawn requests get a depth, the same each time, and nothing sensitive is LIGHT`, () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= RUNS * 10; seed++) {
      const rand = mulberry32(seed * 31)
      const text = sentence(rand, 1 + Math.floor(rand() * 60))
      const a = compilationDepth(text, { workspace: rand() < 0.1 })
      seen.add(a.mode)
      expect(['LIGHT', 'STANDARD', 'TECHNICAL', 'COUNCIL'], text).toContain(a.mode)
      expect(compilationDepth(text).mode, text).toBe(compilationDepth(text).mode)
      if (/\b(security|authentication|credentials|production)\b/.test(text)) expect(compilationDepth(text).mode, text).not.toBe('LIGHT')
    }
    expect([...seen].sort()).toEqual(['COUNCIL', 'LIGHT', 'STANDARD', 'TECHNICAL'])
  })
  it(`capacity kernel: ${RUNS} seeds never hold more sessions than the limit, and never dispatch a decision twice`, () => {
    const h = graphHarness()
    try {
      for (let seed = 1; seed <= RUNS; seed++) {
        const rand = mulberry32(seed * 65537)
        const maxConcurrent = 1 + Math.floor(rand() * 4)
        const policy = { version: `stress-${seed}`, maxConcurrent, advisorySlots: Math.min(1, maxConcurrent - 1) }
        const poolId = `stress-pool:${seed}`
        const unknown = { value: null, source: 'UNKNOWN', confidence: 'UNKNOWN', observedAt: 1 } as const
        const pool: CapacityPool = { id: poolId, binding: `b:${seed}`, consumers: ['claude'], state: 'USAGE_UNKNOWN', scope: 'UNKNOWN', resetAt: unknown, utilization: unknown, nextProbeAt: null, probeAttempts: 0 }
        const router = new CapacityAwareProviderRouter(h.repos.intelligenceArtifacts, `boot-${seed}`)
        const open: { leases: ProviderCapacityLease[]; quarantined: boolean }[] = []
        const held = (): { role: string; state: string }[] =>
          ((h.repos.intelligenceArtifacts.readCheckpoint(`capacity-leases:${poolId}`)?.body as { leases: { role: string; state: string }[] } | undefined)?.leases ?? []).filter((l) => l.state === 'HELD' || l.state === 'QUARANTINED')
        for (let step = 0; step < 50; step++) {
          const tag = `seed ${seed} step ${step}`
          const roll = rand()
          if (roll < 0.55) {
            const role = pick(rand, ['worker', 'worker', 'reviewer', 'technical'] as const)
            const candidate: RoutingCandidate = { provider: 'claude', model: 'm', roles: [role], poolIds: [poolId], available: true, qualityApproved: true, qualityEvidence: ['stress'], paid: false, reserve: 'NONE' }
            const record = router.decide({ projectId: h.project.id, operationId: `op-${seed}-${step}`, stage: 'stress', role, candidates: [candidate], pools: [pool], policy, coherentBoundary: true })
            const before = held().length
            if (record.action === 'ROUTE') {
              const leases = router.claim(record, policy)
              open.push({ leases, quarantined: false })
              // One decision is one dispatch: the same record cannot be claimed again.
              expect(() => router.claim(record, policy), tag).toThrow()
              expect(held().length, tag).toBe(before + 1)
            } else {
              // A wait is given only when the pool has no slot for this role.
              expect(router.slotFree(poolId, role, policy), tag).toBe(false)
              expect(held().length, tag).toBe(before)
            }
          } else if (open.length > 0) {
            const index = Math.floor(rand() * open.length)
            const entry = open[index]!
            if (!entry.quarantined && roll < 0.7) {
              // The stop of the session was not confirmed: its slot stays taken.
              const before = held().length
              router.release(entry.leases, true)
              entry.quarantined = true
              expect(held().length, tag).toBe(before)
            } else {
              const before = held().length
              if (entry.quarantined) router.settle(entry.leases)
              else router.release(entry.leases)
              open.splice(index, 1)
              expect(held().length, tag).toBe(before - 1)
            }
          }
          const now = held()
          expect(now.length, tag).toBeLessThanOrEqual(maxConcurrent)
          expect(now.length, tag).toBe(open.length)
          // Workers and reviewers never take the slots kept for advice.
          expect(now.filter((l) => l.role === 'worker' || l.role === 'reviewer').length, tag).toBeLessThanOrEqual(Math.max(0, maxConcurrent - policy.advisorySlots))
        }
      }
    } finally {
      h.close()
    }
  }, 600_000)
})
