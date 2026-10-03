import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { completeWith } from '@main/modules/agent-runtime/fake-runtime'
import {
  approvedReview,
  createHarness,
  failedVerification,
  keyOf,
  passedVerification,
  plan,
  plannedTask,
  rejectedReview,
  scenarioScript,
  sessionsOf,
  writeFiles,
  type Harness,
} from './harness'

const CHECK_SCRIPT = `const { existsSync } = require('node:fs')
if (existsSync('fixed.txt')) { console.log('all good'); process.exit(0) }
console.error('check failed: fixed.txt is missing')
process.exit(3)
`

describe('scenario: review, verification and check failures are repaired in the same worktree', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('reviewer rejects with a high-severity finding, a debugger repairs it, and the task then completes', async () => {
    let reviews = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feature')]),
        reviewer: async (_spec, ctx) => {
          reviews++
          await ctx.completeTurn({
            text: 'review',
            structuredOutput: reviews === 1 ? rejectedReview({ title: 'Unvalidated input', file: 'feature.txt' }) : approvedReview,
          })
        },
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const parent = h.task(run.id, 'feature')
    expect(parent.state).toBe('completed')
    expect(parent.repairCycles).toBe(1)

    // Two review rows: changes requested, then approved.
    const reviews_ = h.repos.reviews.listByTask(parent.id)
    expect(reviews_.map((r) => r.verdict)).toEqual(['changes_requested', 'approved'])
    expect(reviews_[0]?.findings[0]?.title).toBe('Unvalidated input')

    // The repair task is a debugger child that worked in the parent's own worktree.
    const repair = h.repos.tasks.listByRun(run.id).find((t) => t.parentTaskId === parent.id)
    expect(repair).toMatchObject({ role: 'debugger', kind: 'repair', state: 'completed' })
    const debuggerSession = sessionsOf(h, 'debugger')[0]
    const workerSession = sessionsOf(h, 'worker')[0]
    expect(debuggerSession?.cwd).toBe(workerSession?.cwd)
    expect(debuggerSession?.prompt).toContain('Unvalidated input')

    // Events and messages carry the finding.
    const findings = h.eventsOfType(run.id, 'review.finding')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.payload).toMatchObject({ severity: 'high', title: 'Unvalidated input' })
    const message = h.repos.messages.listByRun(run.id).find((m) => m.type === 'review_finding')
    expect(message).toMatchObject({ subject: 'Unvalidated input', severity: 'high', toTaskId: parent.id })

    // Review and verification ran again after the repair, and the repair reached the integration branch.
    expect(sessionsOf(h, 'reviewer')).toHaveLength(2)
    expect(h.repos.verifications.listByTask(parent.id).filter((v) => v.kind === 'verifier')).toHaveLength(1)
    expect(existsSync(join(h.integration(run.id).path, 'feature-fix.txt'))).toBe(true)
    expect(existsSync(join(h.integration(run.id).path, 'feature.txt'))).toBe(true)
  })

  it('a verifier failure triggers a repair, after which verification passes', async () => {
    let verifications = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feature')]),
        verifier: async (spec, ctx) => {
          const missionLevel = keyOf(spec) === 'integration'
          if (!missionLevel) verifications++
          await ctx.completeTurn({
            text: 'verify',
            structuredOutput: !missionLevel && verifications === 1 ? failedVerification('feature.txt exists') : passedVerification,
          })
        },
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const parent = h.task(run.id, 'feature')
    const rows = h.repos.verifications.listByTask(parent.id).filter((v) => v.kind === 'verifier')
    expect(rows.map((v) => v.passed)).toEqual([false, true])
    expect(rows[0]?.failures[0]?.criterion).toBe('feature.txt exists')
    expect(h.repos.tasks.listByRun(run.id).filter((t) => t.parentTaskId === parent.id)).toHaveLength(1)
    expect(sessionsOf(h, 'debugger')[0]?.prompt).toContain('feature.txt exists')
    expect(h.eventsOfType(run.id, 'verification.failed')).toHaveLength(1)
  })

  it('bounds the repair loop by maxIterations: an always-rejecting reviewer fails the task and pauses the run', async () => {
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('doomed')]),
        reviewer: completeWith({ text: 'review', structuredOutput: rejectedReview() }),
      }),
    })
    const run = await h.startRun({ overrides: { maxIterations: 2 } })
    const paused = await h.waitForState(run.id, 'paused')
    expect(paused.pauseReason).toBe('user')

    const parent = h.task(run.id, 'doomed')
    expect(parent.state).toBe('failed')
    expect(parent.repairCycles).toBe(2)
    expect(parent.error?.what).toContain('still failing after 2 repair cycle')
    const repairs = h.repos.tasks.listByRun(run.id).filter((t) => t.parentTaskId === parent.id)
    expect(repairs).toHaveLength(2)
    // The second repair escalated to the strongest tier.
    expect(repairs.map((r) => r.modelTierOverride)).toEqual([null, 'strongest'])
    expect(sessionsOf(h, 'debugger').map((s) => s.model)).toEqual([
      h.repos.settings.get().models.tiers.strongest,
      h.repos.settings.get().models.tiers.strongest,
    ])
    expect(sessionsOf(h, 'reviewer')).toHaveLength(3)
    expect(h.eventsOfType(run.id, 'run.paused')[0]?.payload.detail).toContain('Intervention required')
    // Nothing from the rejected task reached the integration branch.
    expect(existsSync(join(h.integration(run.id).path, 'doomed.txt'))).toBe(false)
  })

  it('a failing check command triggers repair and every result is stored with command, exit code and output', async () => {
    h = await createHarness({
      files: { 'check.js': CHECK_SCRIPT },
      commands: { lint: 'node -e "process.exit(0)"', test: 'node check.js' },
      script: scenarioScript({
        plan: plan([plannedTask('feature')]),
        debugger: async (spec, ctx) => {
          await writeFiles(spec, ctx, { 'fixed.txt': 'fixed' })
          await ctx.completeTurn({ text: 'Added fixed.txt' })
        },
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const parent = h.task(run.id, 'feature')
    const checks = h.repos.verifications.listByTask(parent.id).filter((v) => v.kind === 'checks')
    expect(checks.map((c) => c.passed)).toEqual([false, true])
    const failed = checks[0]
    expect(failed?.commands.map((c) => c.name)).toEqual(['lint', 'test'])
    expect(failed?.commands[0]).toMatchObject({ command: 'node -e "process.exit(0)"', exitCode: 0 })
    expect(failed?.commands[1]).toMatchObject({ command: 'node check.js', exitCode: 3, timedOut: false })
    expect(failed?.commands[1]?.output).toContain('fixed.txt is missing')
    expect(failed?.failures[0]?.criterion).toContain('test')
    expect(checks[1]?.commands[1]).toMatchObject({ exitCode: 0 })
    expect(checks[1]?.commands[1]?.output).toContain('all good')

    // The failed check results were handed to the debugger, and the cycle is bounded by repairCycles.
    expect(sessionsOf(h, 'debugger')[0]?.prompt).toContain('fixed.txt is missing')
    expect(parent.repairCycles).toBe(1)
    // The reviewer only ran once the checks were green.
    expect(sessionsOf(h, 'reviewer')).toHaveLength(1)
    // Mission-level checks ran on the integration branch too.
    const missionChecks = h.repos.verifications.listByRun(run.id).filter((v) => v.kind === 'checks' && v.taskId === null)
    expect(missionChecks.at(-1)?.passed).toBe(true)
  })

  it('mission verification failure creates a mission-fix task and is bounded by maxIterations', async () => {
    let missionRuns = 0
    const verifier: FakeScript = async (spec, ctx) => {
      const mission = keyOf(spec) === 'integration'
      if (mission) missionRuns++
      await ctx.completeTurn({
        text: 'verify',
        structuredOutput: mission && missionRuns === 1 ? failedVerification('All task files exist') : passedVerification,
      })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('base')]), verifier }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const fix = h.task(run.id, 'mission-fix-1')
    expect(fix).toMatchObject({ role: 'debugger', kind: 'repair', state: 'completed' })
    const missionVerifications = h.repos.verifications.listByRun(run.id).filter((v) => v.kind === 'verifier' && v.taskId === null)
    expect(missionVerifications.map((v) => v.passed)).toEqual([false, true])
    expect(sessionsOf(h, 'debugger')[0]?.prompt).toContain('All task files exist')
    expect(existsSync(join(h.integration(run.id).path, 'mission-fix-1-fix.txt'))).toBe(true)
  })

  it('stops mission-level repair after maxIterations and pauses for intervention', async () => {
    let missionRuns = 0
    const verifier: FakeScript = async (spec, ctx) => {
      const mission = keyOf(spec) === 'integration'
      if (mission) missionRuns++
      await ctx.completeTurn({ text: 'verify', structuredOutput: mission ? failedVerification('Never satisfied') : passedVerification })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('base')]), verifier }) })
    const run = await h.startRun({ overrides: { maxIterations: 2 } })
    const paused = await h.waitForState(run.id, 'paused')
    expect(paused.pauseReason).toBe('user')

    expect(missionRuns).toBe(3)
    expect(h.repos.tasks.listByRun(run.id).filter((t) => t.key.startsWith('mission-fix-'))).toHaveLength(2)
    expect(h.eventsOfType(run.id, 'run.paused')[0]?.payload.detail).toContain('Intervention required')
  })
})
