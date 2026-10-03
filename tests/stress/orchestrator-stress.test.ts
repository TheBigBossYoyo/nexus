import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PlannedTask, Run } from '@shared/domain'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import {
  approvedReview,
  createHarness,
  failedVerification,
  git,
  keyOf,
  passedVerification,
  plan,
  plannedTask,
  rejectedReview,
  scenarioScript,
  writeFiles,
  type Harness,
} from '../scenarios/harness'

/**
 * Seeded orchestration stress campaign (scripted agents, real git and SQLite).
 *
 *   NEXUS_STRESS_RUNS=1000 NEXUS_STRESS_START=1 pnpm stress
 *
 * Every seed builds a random DAG, random timings and a set of injected faults, then checks
 * orchestration invariants against durable state. A failing seed is written to
 * test-results/stress-failures/ with its full event history and can be replayed with
 * NEXUS_STRESS_START=<seed> NEXUS_STRESS_RUNS=1.
 */
const RUNS = Number(process.env['NEXUS_STRESS_RUNS'] ?? 20)
const START = Number(process.env['NEXUS_STRESS_START'] ?? 1)
const CONCURRENCY = Number(process.env['NEXUS_STRESS_CONCURRENCY'] ?? 4)
const FAILURE_DIR = join(process.cwd(), 'test-results', 'stress-failures')

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable per-(seed, label) number in [0, 1): session timings do not depend on scheduling order. */
function hashed(seed: number, label: string): number {
  let h = seed >>> 0
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0
  return mulberry32(h)()
}

interface Scenario {
  seed: number
  tasks: PlannedTask[]
  maxParallel: number
  /** Worker of this task crashes on its first attempt. */
  crashOnce: Set<string>
  /** First review of this task requests changes. */
  rejectOnce: Set<string>
  /** First verification of this task fails. */
  verifyFailOnce: Set<string>
  /** This worker sends an interface_change message downstream. */
  messengers: Set<string>
  /** Pause and resume the run after this many task.started events (0 = never). */
  pauseAfterStarts: number
  /** Cancel this task as soon as it starts (null = none). */
  cancelTask: string | null
}

function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed)
  const pick = (p: number): boolean => rng() < p
  const count = 3 + Math.floor(rng() * 4)
  const keys = Array.from({ length: count }, (_, i) => `t${i}`)
  const tasks = keys.map((key, i) => {
    const dependencies = keys.slice(0, i).filter(() => pick(0.35))
    // Some tasks share a file so the scheduler has to serialize them.
    const files = pick(0.25) ? [`${key}.txt`, 'shared-area/common.txt'] : [`${key}.txt`]
    return plannedTask(key, { dependencies, suggestedFiles: files, parallelizable: !pick(0.1) })
  })
  const subset = (p: number): Set<string> => new Set(keys.filter(() => pick(p)))
  const cancelTask = pick(0.12) ? (keys[Math.floor(rng() * keys.length)] ?? null) : null
  return {
    seed,
    tasks,
    maxParallel: 1 + Math.floor(rng() * 4),
    crashOnce: subset(0.2),
    rejectOnce: subset(0.2),
    verifyFailOnce: subset(0.15),
    messengers: subset(0.3),
    pauseAfterStarts: pick(0.2) ? 1 + Math.floor(rng() * count) : 0,
    cancelTask,
  }
}

interface Observation {
  violations: string[]
  maxActiveWriters: number
  /** Tasks whose injected crash actually fired (a pause can stop the session before it does). */
  crashed: Set<string>
  rejected: Set<string>
}

function buildScript(s: Scenario, obs: Observation): FakeScript {
  const calls = new Map<string, number>()
  const nth = (label: string): number => {
    const n = calls.get(label) ?? 0
    calls.set(label, n + 1)
    return n
  }
  const delay = (label: string): number => Math.floor(hashed(s.seed, label) * 25)
  const activeWriters = new Map<string, string[]>()
  const byKey = new Map(s.tasks.map((t) => [t.id, t]))

  /** Track a writing session and check the concurrency invariants while it is active. */
  const writing = async (key: string, body: () => Promise<void>): Promise<void> => {
    const parentKey = key.replace(/-[0-9a-f]{8}$/, '')
    if (activeWriters.has(parentKey)) obs.violations.push(`task ${parentKey} has two concurrent writing sessions`)
    const files = byKey.get(parentKey)?.suggestedFiles ?? []
    for (const [other, otherFiles] of activeWriters) {
      if (files.some((f) => otherFiles.includes(f))) obs.violations.push(`${parentKey} and ${other} ran concurrently with overlapping files`)
    }
    activeWriters.set(parentKey, files)
    obs.maxActiveWriters = Math.max(obs.maxActiveWriters, activeWriters.size)
    if (activeWriters.size > s.maxParallel) obs.violations.push(`${activeWriters.size} writers active, limit ${s.maxParallel}`)
    try {
      await body()
    } finally {
      activeWriters.delete(parentKey)
    }
  }

  const worker: FakeScript = async (spec, ctx) => {
    const key = keyOf(spec).replace(/-[0-9a-f]{8}$/, '')
    const n = nth(`worker:${key}`)
    await writing(key, async () => {
      await ctx.sleep(delay(`worker:${key}:${n}`))
      // A pause or cancel stops the session mid-sleep; a stopped session injects nothing.
      if (ctx.signal.aborted) return
      if (s.crashOnce.has(key) && n === 0) {
        obs.crashed.add(key)
        ctx.fail(`injected crash in ${key}`)
      }
      await writeFiles(spec, ctx, { [`${key}.txt`]: `${key} attempt ${n}` })
      if (s.messengers.has(key) && ctx.nexusTools) {
        await ctx.nexusTools.sendMessage({ type: 'interface_change', subject: `${key} changed`, body: 'details', toTask: null, toRole: null, severity: null })
      }
      await ctx.sleep(delay(`worker-end:${key}:${n}`))
      await ctx.completeTurn({ text: `Created ${key}.txt` })
    })
  }
  const fixer: FakeScript = async (spec, ctx) => {
    const key = keyOf(spec).replace(/-[0-9a-f]{8}$/, '')
    const n = nth(`fix:${key}`)
    await writing(key, async () => {
      await ctx.sleep(delay(`fix:${key}:${n}`))
      await writeFiles(spec, ctx, { [`${key}-fix${n}.txt`]: 'fixed' })
      await ctx.completeTurn({ text: 'Applied a fix' })
    })
  }
  const reviewer: FakeScript = async (spec, ctx) => {
    const key = keyOf(spec).replace(/-[0-9a-f]{8}$/, '')
    const n = nth(`review:${key}`)
    await ctx.sleep(delay(`review:${key}:${n}`))
    if (ctx.signal.aborted) return
    const reject = s.rejectOnce.has(key) && n === 0
    if (reject) obs.rejected.add(key)
    await ctx.completeTurn({ text: 'review', structuredOutput: reject ? rejectedReview() : approvedReview })
  }
  const verifier: FakeScript = async (spec, ctx) => {
    const key = keyOf(spec).replace(/-[0-9a-f]{8}$/, '')
    const n = nth(`verify:${key}`)
    await ctx.sleep(delay(`verify:${key}:${n}`))
    const fail = s.verifyFailOnce.has(key) && n === 0
    await ctx.completeTurn({ text: 'verify', structuredOutput: fail ? failedVerification() : passedVerification })
  }
  return scenarioScript({ plan: plan(s.tasks), worker, debugger: fixer, reviewer, verifier })
}

async function checkInvariants(h: Harness, run: Run, s: Scenario, obs: Observation, headBefore: string): Promise<string[]> {
  const problems = [...obs.violations]
  const tasks = h.repos.tasks.listByRun(run.id)
  const planned = tasks.filter((t) => t.parentTaskId === null)
  const events = h.repos.events.listByRun(run.id, 0, 100_000)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const firstSeq = (type: string, taskId: string): number => events.find((e) => e.type === type && e.taskId === taskId)?.seq ?? -1

  const cancelled = s.cancelTask ? planned.find((t) => t.key === s.cancelTask) : undefined
  const cancelTookEffect = cancelled?.state === 'cancelled'

  // Outcome: without an effective cancellation every bounded fault must be absorbed.
  if (!cancelTookEffect) {
    if (run.state !== 'completed') problems.push(`run ended ${run.state} (expected completed)`)
    for (const t of planned) if (t.state !== 'completed') problems.push(`task ${t.key} ended ${t.state}`)
  } else if (run.state !== 'completed' && run.state !== 'paused' && run.state !== 'cancelled') {
    problems.push(`run ended ${run.state} after a task cancellation`)
  }
  if (run.state === 'completed') {
    for (const t of planned) {
      if (t.state !== 'completed' && t.state !== 'cancelled') problems.push(`run completed with task ${t.key} in ${t.state}`)
    }
  }

  // Pauses must be explained: a requested pause, or intervention after a cancellation.
  for (const e of events.filter((x) => x.type === 'run.paused')) {
    const detail = 'detail' in e.payload ? String(e.payload.detail) : ''
    const explained = (detail === '' && s.pauseAfterStarts > 0) || (detail.startsWith('Intervention') && cancelTookEffect)
    if (!explained) problems.push(`unexplained pause: ${JSON.stringify(e.payload)}`)
  }

  const deps = h.repos.dependencies.listByRun(run.id)
  for (const t of planned) {
    const started = firstSeq('task.started', t.id)
    for (const d of deps.filter((x) => x.taskId === t.id)) {
      const dep = byId.get(d.dependsOnTaskId)
      if (started === -1) continue
      // A task may only start after each dependency completed; a cancelled dependency never satisfies it.
      const depDone = firstSeq('task.completed', d.dependsOnTaskId)
      if (depDone === -1 || depDone > started) problems.push(`task ${t.key} started before dependency ${dep?.key} completed`)
      if (dep?.state === 'cancelled') problems.push(`task ${t.key} ran although dependency ${dep.key} was cancelled`)
    }
    if (t.state === 'completed') {
      const verdicts = h.repos.verifications.listByTask(t.id).filter((v) => v.kind === 'verifier')
      if (verdicts.at(-1)?.passed !== true) problems.push(`task ${t.key} completed without a passing final verification`)
      if (firstSeq('git.merged', t.id) === -1) problems.push(`task ${t.key} completed without a merge`)
    }
    if (t.leaseOwner && ['completed', 'failed', 'cancelled'].includes(t.state)) problems.push(`terminal task ${t.key} still holds a lease`)
  }

  // Injected faults must have produced their recovery path.
  if (!cancelTookEffect) {
    for (const key of obs.rejected) {
      const t = planned.find((x) => x.key === key)
      if (t && !h.repos.reviews.listByTask(t.id).some((r) => r.verdict === 'changes_requested')) problems.push(`rejected review of ${key} was not recorded`)
      if (t && !tasks.some((c) => c.parentTaskId === t.id)) problems.push(`no repair task was created for ${key}`)
    }
    for (const key of obs.crashed) {
      const t = planned.find((x) => x.key === key)
      if (t && t.attempt < 2) problems.push(`crashed task ${key} was not retried (attempt ${t.attempt})`)
    }
  }

  if (h.repos.agents.listActive(run.id).length > 0) problems.push('agents still active after the run settled')
  if ((await git(h.repoDir, 'rev-parse', 'HEAD')) !== headBefore) problems.push('user HEAD moved')
  if ((await git(h.repoDir, 'status', '--porcelain')) !== '') problems.push('user working tree is dirty')

  if (run.state === 'completed' && run.integrationBranch) {
    const files = (await git(h.repoDir, 'ls-tree', '-r', '--name-only', run.integrationBranch)).split('\n')
    for (const t of planned) {
      if (t.state === 'completed' && !files.includes(`${t.key}.txt`)) problems.push(`integration branch is missing ${t.key}.txt`)
    }
    const integration = h.repos.worktrees.listByRun(run.id).find((w) => w.taskId === null)
    if (integration && existsSync(integration.path)) {
      if (await h.git.isMergeInProgress(integration.path)) problems.push('integration worktree left mid-merge')
      if ((await git(integration.path, 'status', '--porcelain')) !== '') problems.push('integration worktree left dirty')
    }
  }
  return problems
}

async function runSeed(seed: number): Promise<string[]> {
  const s = buildScenario(seed)
  const obs: Observation = { violations: [], maxActiveWriters: 0, crashed: new Set(), rejected: new Set() }
  const h = await createHarness({ script: buildScript(s, obs) })
  try {
    const headBefore = await git(h.repoDir, 'rev-parse', 'HEAD')
    let starts = 0
    let paused = false
    let cancelRequested = false
    h.bus.subscribe((e) => {
      if (e.type !== 'task.started') return
      starts++
      const task = h.repos.tasks.get(e.taskId ?? '')
      if (s.cancelTask && task?.key === s.cancelTask && !cancelRequested) {
        cancelRequested = true
        void h.orchestrator.cancelTask(task.id).catch(() => undefined)
      }
      if (s.pauseAfterStarts > 0 && starts === s.pauseAfterStarts && !paused) {
        paused = true
        void (async () => {
          try {
            await h.orchestrator.pauseRun(e.runId)
            await h.orchestrator.resumeRun(e.runId)
          } catch {
            // The run finished or was already paused for intervention; nothing to resume.
          }
        })()
      }
    })

    const run = await h.startRun({ overrides: { maxParallelAgents: s.maxParallel } })
    let problems: string[]
    try {
      // A requested pause is transient; wait for a state that is final for this scenario.
      await h.waitFor(() => {
        const r = h.repos.runs.require(run.id)
        if (r.state === 'completed' || r.state === 'failed' || r.state === 'cancelled') return true
        if (r.state !== 'paused') return false
        const last = h.repos.events.listByRun(run.id, 0, 100_000).filter((e) => e.type === 'run.paused').at(-1)
        return last !== undefined && 'detail' in last.payload && String(last.payload.detail).startsWith('Intervention')
      }, 'a final run state', 120_000)
      await h.orchestrator.idle(run.id)
      problems = await checkInvariants(h, h.repos.runs.require(run.id), s, obs, headBefore)
    } catch (e) {
      problems = [`did not settle: ${(e as Error).message}`]
    }

    if (problems.length > 0) {
      await mkdir(FAILURE_DIR, { recursive: true })
      const tasks = h.repos.tasks.listByRun(run.id)
      await writeFile(
        join(FAILURE_DIR, `seed-${seed}.json`),
        JSON.stringify(
          {
            seed,
            problems,
            scenario: { ...s, crashOnce: [...s.crashOnce], rejectOnce: [...s.rejectOnce], verifyFailOnce: [...s.verifyFailOnce], messengers: [...s.messengers] },
            run: h.repos.runs.require(run.id),
            tasks,
            dependencies: h.repos.dependencies.listByRun(run.id),
            agents: h.repos.agents.listByRun(run.id).map((a) => ({ label: a.label, state: a.state, error: a.error, taskId: a.taskId })),
            worktrees: h.repos.worktrees.listByRun(run.id),
            undeliveredMessages: tasks.map((t) => ({ task: t.key, count: h.repos.messages.listUndeliveredForTask(t.id).length })),
            pendingApprovals: h.repos.approvals.listPending(run.id),
            events: h.repos.events.listByRun(run.id, 0, 100_000).map((e) => ({ seq: e.seq, type: e.type, task: tasks.find((t) => t.id === e.taskId)?.key ?? null, payload: e.payload })),
          },
          null,
          1,
        ),
      )
    }
    return problems
  } finally {
    await h.dispose()
  }
}

describe('orchestrator stress campaign', () => {
  it(`holds its invariants over ${RUNS} seeded runs starting at seed ${START}`, async () => {
    const seeds = Array.from({ length: RUNS }, (_, i) => START + i)
    const failures: { seed: number; problems: string[] }[] = []
    let next = 0
    let done = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const seed = seeds[next++]
        if (seed === undefined) return
        const problems = await runSeed(seed)
        if (problems.length > 0) failures.push({ seed, problems })
        done++
        if (done % 50 === 0) console.warn(`[stress] ${done}/${RUNS} done, ${failures.length} failing`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, RUNS) }, () => worker()))
    console.warn(`[stress] finished ${done}/${RUNS}; failing seeds: ${failures.map((f) => f.seed).join(', ') || 'none'}`)
    expect(failures).toEqual([])
  }, 6 * 60 * 60 * 1000)
})
