import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import {
  approvedReview,
  createHarness,
  keyOf,
  passedVerification,
  plan,
  plannedTask,
  scenarioScript,
  sessionsOf,
  writeFiles,
  type Harness,
} from './harness'

const SUBJECT = 'Interface of producer: parse(input) returns a Result'
const CRITERION = 'The dependant task consumer was notified of the interface through a NEXUS message'

/** A task whose acceptance criteria are about coordination, not code: the repository cannot show a message. */
const messagingPlan = plan([
  plannedTask('producer', { acceptanceCriteria: ['producer.txt exists', CRITERION] }),
  plannedTask('consumer', { dependencies: ['producer'] }),
])

const producer: FakeScript = async (spec, ctx) => {
  await writeFiles(spec, ctx)
  if (keyOf(spec) === 'producer') {
    await ctx.nexusTools?.sendMessage({ type: 'interface_change', subject: SUBJECT, body: 'It returns { ok, value }.', toTask: 'consumer', toRole: null, severity: null })
  }
  await ctx.completeTurn({ text: `Created ${keyOf(spec)}.txt and told the dependant about the interface` })
}

describe('scenario: the verifier sees orchestration evidence', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('a criterion about messaging passes because the verifier prompt carries the persisted message, with no repair cycle', async () => {
    const verifier: FakeScript = async (spec, ctx) => {
      if (keyOf(spec) === 'producer') {
        // A verifier that cannot see persisted messages fails the criterion, like the real one did.
        const seen = spec.prompt.includes('Orchestration evidence') && spec.prompt.includes(SUBJECT)
        await ctx.completeTurn({
          text: 'verify',
          structuredOutput: {
            summary: seen ? 'All criteria satisfied.' : 'The notification criterion is not met.',
            criteria: [
              { criterion: 'producer.txt exists', passed: true, evidence: 'present' },
              { criterion: CRITERION, passed: seen, evidence: seen ? 'NEXUS recorded the message' : 'No message is visible in the repository' },
            ],
            failures: seen ? [] : [{ criterion: CRITERION, evidence: 'No message is visible in the repository', likelyCause: '', relevantFiles: [] }],
          },
        })
        return
      }
      await ctx.completeTurn({ text: 'verify', structuredOutput: passedVerification })
    }
    h = await createHarness({ script: scenarioScript({ plan: messagingPlan, worker: producer, verifier }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const parent = h.task(run.id, 'producer')
    expect(parent.repairCycles).toBe(0)
    expect(h.repos.tasks.listByRun(run.id).filter((t) => t.parentTaskId !== null)).toHaveLength(0)
    expect(sessionsOf(h, 'debugger')).toHaveLength(0)
    expect(h.repos.verifications.listByTask(parent.id).filter((v) => v.kind === 'verifier').map((v) => v.passed)).toEqual([true])

    // The section says where the records come from and what they are authoritative for, and lists the message.
    const prompt = sessionsOf(h, 'verifier').find((s) => s.prompt.includes('Task producer'))?.prompt ?? ''
    expect(prompt).toContain('## Orchestration evidence')
    expect(prompt).toContain('come from the NEXUS database')
    expect(prompt).toContain('authoritative for criteria about messaging')
    expect(prompt).toContain('must still be verified in the repository')
    expect(prompt).toContain(`[interface_change] to consumer: ${SUBJECT}`)
    // The consumer's own verifier saw no message of its own.
    const consumerPrompt = sessionsOf(h, 'verifier').find((s) => s.prompt.includes('Task consumer'))?.prompt ?? ''
    expect(consumerPrompt).toContain('Messages sent: none recorded.')
  })

  it('the reviewer gets the sent message subjects but never the worker reasoning', async () => {
    const worker: FakeScript = async (spec, ctx) => {
      await writeFiles(spec, ctx)
      if (keyOf(spec) === 'producer') {
        await ctx.nexusTools?.sendMessage({ type: 'interface_change', subject: SUBJECT, body: 'BODY-NOT-FOR-THE-REVIEWER', toTask: 'consumer', toRole: null, severity: null })
      }
      await ctx.completeTurn({ text: 'WORKER-REASONING-SUMMARY' })
    }
    h = await createHarness({ script: scenarioScript({ plan: messagingPlan, worker }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const prompt = sessionsOf(h, 'reviewer').find((s) => s.prompt.includes('Task producer'))?.prompt ?? ''
    expect(prompt).toContain(SUBJECT)
    expect(prompt).not.toContain('BODY-NOT-FOR-THE-REVIEWER')
    expect(prompt).not.toContain('WORKER-REASONING-SUMMARY')
  })

  it('the mission verifier and a repair prompt carry the evidence too', async () => {
    let verifications = 0
    const verifier: FakeScript = async (spec, ctx) => {
      const mission = keyOf(spec) === 'integration'
      if (!mission && keyOf(spec) === 'producer') verifications++
      const fail = !mission && keyOf(spec) === 'producer' && verifications === 1
      await ctx.completeTurn({
        text: 'verify',
        structuredOutput: fail
          ? { summary: 'Nope.', criteria: [{ criterion: 'producer.txt exists', passed: false, evidence: 'x' }], failures: [{ criterion: 'producer.txt exists', evidence: 'x', likelyCause: '', relevantFiles: [] }] }
          : passedVerification,
      })
    }
    h = await createHarness({ script: scenarioScript({ plan: messagingPlan, worker: producer, verifier, reviewer: async (_s, ctx) => ctx.completeTurn({ text: 'r', structuredOutput: approvedReview }) }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    expect(sessionsOf(h, 'debugger')[0]?.prompt).toContain(`to consumer: ${SUBJECT}`)
    const mission = sessionsOf(h, 'verifier').find((s) => s.prompt.includes('Mission acceptance criteria'))
    expect(mission?.prompt).toContain('## Orchestration evidence')
    expect(mission?.prompt).toContain(SUBJECT)
  })
})
