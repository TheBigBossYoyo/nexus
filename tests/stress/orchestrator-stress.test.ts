import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PlannedTask, Run } from '@shared/domain'
import type { FakeScript, FakeSessionContext } from '@main/modules/agent-runtime/fake-runtime'
import { findCycles, transitiveDependants } from '@main/modules/task-graph'
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
  /** v0.2: the graph change this task's worker proposes in its first session that gets past the injected crash. */
  proposals: Map<string, ProposalKind>
  /** v0.2: plan with three planners, a critic and a synthesizer (one candidate may be invalid). */
  consensus: boolean
  /** The weakest candidate planner returns an invalid plan, so the synthesis works from the other two. */
  badCandidate: boolean
  /** v0.2: every review is dual (second reviewer, deduplication, arbiter). */
  dualReview: boolean
}

/**
 * add_blocking / add_free / split_self apply immediately; add_many and split_unstarted need the user (the
 * campaign approves or denies by seed); cycle, ghost and terminal are invalid and must be rejected.
 */
type ProposalKind = 'add_blocking' | 'add_free' | 'add_many' | 'split_unstarted' | 'split_self' | 'cycle' | 'ghost' | 'terminal'
const PROPOSAL_KINDS: readonly ProposalKind[] = ['add_blocking', 'add_free', 'add_many', 'split_unstarted', 'split_self', 'cycle', 'ghost', 'terminal']

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
  const base = {
    maxParallel: 1 + Math.floor(rng() * 4),
    crashOnce: subset(0.2),
    rejectOnce: subset(0.2),
    verifyFailOnce: subset(0.15),
    messengers: subset(0.3),
    pauseAfterStarts: pick(0.2) ? 1 + Math.floor(rng() * count) : 0,
  }
  // Drawn last so the draws above, and with them every pre-v0.2 injection of a seed, are unchanged.
  const proposals = new Map<string, ProposalKind>()
  for (const key of keys) {
    if (pick(0.4)) proposals.set(key, PROPOSAL_KINDS[Math.floor(rng() * PROPOSAL_KINDS.length)] ?? 'ghost')
  }
  // Drawn after everything else for the same reason.
  const consensus = pick(0.35)
  const badCandidate = pick(0.5)
  const dualReview = pick(0.35)
  return {
    seed,
    tasks,
    ...base,
    cancelTask,
    proposals,
    consensus,
    badCandidate,
    dualReview,
  }
}

interface Observation {
  violations: string[]
  maxActiveWriters: number
  /** Tasks whose injected crash actually fired (a pause can stop the session before it does). */
  crashed: Set<string>
  rejected: Set<string>
  /** Proposals the workers submitted, with what the tool answered (coverage and oracle). */
  proposed: { kind: ProposalKind; by: string; reply: string }[]
}

function newTask(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    title: `Task ${key}`,
    description: `Implement ${key}`,
    role: 'worker',
    dependencies: [],
    suggestedFiles: [`${key}.txt`],
    acceptanceCriteria: [`${key}.txt exists`],
    complexity: 'small',
    risk: 'low',
    ...over,
  }
}

const change = (type: string, changes: Record<string, unknown>): Record<string, unknown> => ({
  type,
  reason: `stress: ${type}`,
  evidence: 'injected by the stress campaign',
  changes,
})

/** Keys, states, priorities and dependency edges: what a rejected proposal must leave untouched. */
function graphState(h: Harness, runId: string): string {
  const tasks = h.repos.tasks.listByRun(runId)
  const key = (id: string): string => tasks.find((t) => t.id === id)?.key ?? id
  return JSON.stringify({
    tasks: tasks.map((t) => [t.key, t.state, t.priority]),
    deps: h.repos.dependencies
      .listByRun(runId)
      .map((d) => `${key(d.taskId)}>${key(d.dependsOnTaskId)}`)
      .sort(),
  })
}

function buildScript(s: Scenario, obs: Observation, harness: () => Harness): FakeScript {
  const calls = new Map<string, number>()
  const nth = (label: string): number => {
    const n = calls.get(label) ?? 0
    calls.set(label, n + 1)
    return n
  }
  const delay = (label: string): number => Math.floor(hashed(s.seed, label) * 25)
  const activeWriters = new Map<string, string[]>()
  const byKey = new Map(s.tasks.map((t) => [t.id, t]))
  /** Files of tasks added by proposals (they write `<key>.txt`). */
  const addedFiles = new Map<string, string[]>()
  const proposedBy = new Set<string>()

  /** Track a writing session and check the concurrency invariants while it is active. */
  const writing = async (key: string, body: () => Promise<void>): Promise<void> => {
    const parentKey = key.replace(/-[0-9a-f]{8}$/, '')
    if (activeWriters.has(parentKey)) obs.violations.push(`task ${parentKey} has two concurrent writing sessions`)
    const files = byKey.get(parentKey)?.suggestedFiles ?? addedFiles.get(parentKey) ?? []
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

  /**
   * Submit this task's injected graph change. Returns 'end' when the agent must end its turn now (it was told
   * to wait or was replaced), 'continue' otherwise. Also checks what the tool answered against what the kind
   * must produce, and that a rejection leaves the graph exactly as it was.
   */
  const inject = async (key: string, ctx: FakeSessionContext): Promise<'end' | 'continue'> => {
    const kind = s.proposals.get(key)
    const tool = ctx.nexusTools?.proposeGraphChange
    if (!kind || !tool || proposedBy.has(key)) return 'continue'
    const h = harness()
    const run = h.repos.runs.listByProject(h.project.id)[0]
    if (!run) return 'continue'
    const tasks = h.repos.tasks.listByRun(run.id)
    const me = tasks.find((t) => t.key === key)
    if (!me) return 'continue'
    const deps = h.repos.dependencies.listByRun(run.id)
    const open = (t: { state: string }): boolean => !['completed', 'failed', 'cancelled'].includes(t.state)

    let effective: ProposalKind = kind
    let input: Record<string, unknown> = {}
    if (kind === 'add_blocking') {
      input = change('ADD_TASK', { tasks: [newTask(`${key}-pre`)], blocksProposer: true })
    } else if (kind === 'add_free') {
      input = change('ADD_TASK', { tasks: [newTask(`${key}-extra`)] })
    } else if (kind === 'add_many') {
      const keys = [1, 2, 3, 4].map((i) => `${key}-m${i}`)
      input = change('ADD_TASK', { tasks: keys.map((k, i) => newTask(k, { dependencies: i === 1 ? [keys[0]] : [] })) })
    } else if (kind === 'split_self') {
      input = change('SPLIT_TASK', {
        targetTask: key,
        tasks: [newTask(`${key}-s1`, { acceptanceCriteria: [`${key}.txt exists`] }), newTask(`${key}-s2`)],
      })
    } else if (kind === 'split_unstarted') {
      const target = tasks.find(
        (t) => t.id !== me.id && t.parentTaskId === null && ['draft', 'ready', 'queued', 'blocked'].includes(t.state) && !t.key.includes('-'),
      )
      if (target) {
        input = change('SPLIT_TASK', {
          targetTask: target.key,
          tasks: [newTask(`${target.key}-p1`, { acceptanceCriteria: target.acceptanceCriteria }), newTask(`${target.key}-p2`)],
        })
      } else effective = 'ghost'
    } else if (kind === 'cycle') {
      const dependant = transitiveDependants(deps, me.id)
        .map((id) => tasks.find((t) => t.id === id))
        .find((t) => t !== undefined && open(t) && t.parentTaskId === null)
      if (dependant) input = change('ADD_DEPENDENCY', { targetTask: key, dependsOn: dependant.key })
      else effective = 'ghost'
    } else if (kind === 'terminal') {
      const done = tasks.find((t) => t.state === 'completed' && t.id !== me.id)
      if (done) input = change('CANCEL_TASK', { targetTask: done.key })
      else effective = 'ghost'
    }
    if (effective === 'ghost') input = change('ADD_DEPENDENCY', { targetTask: key, dependsOn: 'ghost-task' })

    const added = (input['changes'] as { tasks?: { key: string; suggestedFiles: string[] }[] }).tasks ?? []
    for (const t of added) addedFiles.set(t.key, t.suggestedFiles)
    proposedBy.add(key)
    // The tool runs synchronously up to its answer: no other agent can change the graph between these reads.
    const before = graphState(h, run.id)
    const pending = tool(input)
    const after = graphState(h, run.id)
    const reply = await pending
    obs.proposed.push({ kind: effective, by: key, reply })

    if (reply.includes('The run is ')) {
      // A pause raced the proposal and it was rightly refused. Try again in the next session.
      proposedBy.delete(key)
      return 'continue'
    }
    const expectApplied = effective === 'add_blocking' || effective === 'add_free' || effective === 'split_self'
    const expectAwaiting = effective === 'add_many' || effective === 'split_unstarted'
    const verdict = reply.startsWith('Applied') ? 'applied' : reply.startsWith('Awaiting') ? 'awaiting' : reply.startsWith('Rejected') ? 'rejected' : 'unknown'
    if (expectApplied && verdict !== 'applied') obs.violations.push(`${effective} by ${key} should have been applied: ${reply}`)
    if (expectAwaiting && verdict !== 'awaiting') obs.violations.push(`${effective} by ${key} should await approval: ${reply}`)
    if (!expectApplied && !expectAwaiting && verdict !== 'rejected') obs.violations.push(`${effective} by ${key} should have been rejected: ${reply}`)
    if ((verdict === 'rejected' || verdict === 'awaiting') && before !== after) obs.violations.push(`${effective} by ${key} (${verdict}) changed the graph`)
    return verdict === 'applied' && (reply.includes('Finish your turn NOW') || reply.includes('is cancelled')) ? 'end' : 'continue'
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
      if ((await inject(key, ctx)) === 'end') {
        await ctx.completeTurn({ text: `${key} stopped after a graph change` })
        return
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
  /** Second reviewer of a dual review: repeats the first reviewer's finding (a duplicate to merge) or approves. */
  const securityReviewer: FakeScript = async (spec, ctx) => {
    const key = keyOf(spec).replace(/-[0-9a-f]{8}$/, '')
    const n = nth(`review-b:${key}`)
    await ctx.sleep(delay(`review-b:${key}:${n}`))
    if (ctx.signal.aborted) return
    const duplicate = s.rejectOnce.has(key) && n === 0 && hashed(s.seed, `dup:${key}`) < 0.5
    await ctx.completeTurn({ text: 'review', structuredOutput: duplicate ? rejectedReview({ title: 'Input is not validated' }) : approvedReview })
  }
  // A candidate with an unknown dependency passes the schema and fails plan validation.
  const brokenPlan = plan(s.tasks.map((t, i) => (i === 0 ? { ...t, dependencies: ['ghost-task'] } : t)))
  return scenarioScript({
    plan: plan(s.tasks),
    worker,
    debugger: fixer,
    reviewer,
    securityReviewer,
    verifier,
    candidate: (label) => (s.badCandidate && label.startsWith('Planner C') ? brokenPlan : plan(s.tasks)),
  })
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

  // v0.2 graph history. Every applied proposal has exactly one revision, versions are 1..n without gaps, and
  // a task other than the user's injected cancellation can only be cancelled by an applied proposal.
  const revisions = h.repos.graphRevisions.listByRun(run.id)
  const proposals = h.repos.graphProposals.listByRun(run.id)
  if (revisions.map((r) => r.version).join() !== revisions.map((_, i) => i + 1).join()) problems.push(`revision versions are not 1..${revisions.length}: ${revisions.map((r) => r.version).join()}`)
  for (const p of proposals) {
    const own = revisions.filter((r) => r.proposalId === p.id)
    if (p.status === 'applied' && (own.length !== 1 || p.revisionId !== own[0]?.id)) problems.push(`applied proposal ${p.id} has ${own.length} revision(s)`)
    if (p.status !== 'applied' && own.length > 0) problems.push(`${p.status} proposal ${p.id} has a revision`)
    if (p.status === 'rejected' && (p.rejectionReason === null || p.revisionId !== null)) problems.push(`rejected proposal ${p.id} lacks a reason or links a revision`)
    if (p.status === 'applied' && p.rejectionReason !== null) problems.push(`applied proposal ${p.id} carries a rejection reason`)
    if (p.status === 'proposed' || (p.status === 'awaiting_approval' && run.state !== 'paused')) problems.push(`proposal ${p.id} left ${p.status}`)
  }
  const interventions = revisions.filter((r) => r.proposalId === null && r.version > 1)
  if (interventions.length > (s.cancelTask ? 1 : 0)) problems.push(`unexpected user-intervention revisions: ${interventions.length}`)
  const graphEvents = events.filter((e) => e.type === 'graph.revised').length
  if (graphEvents !== revisions.length) problems.push(`${graphEvents} graph.revised events for ${revisions.length} revisions`)
  const edges = new Map<string, string[]>()
  for (const t of tasks) edges.set(t.id, [])
  for (const d of h.repos.dependencies.listByRun(run.id)) edges.get(d.taskId)?.push(d.dependsOnTaskId)
  if (findCycles(edges).length > 0) problems.push('the final dependency graph has a cycle')
  const cancelledByProposal = planned.filter((t) => t.state === 'cancelled' && t.key !== s.cancelTask)
  for (const t of cancelledByProposal) {
    const explained = revisions.some((r) => r.proposalId !== null && r.snapshot.tasks.some((x) => x.id === t.id && x.state === 'cancelled'))
    if (!explained) problems.push(`task ${t.key} was cancelled without an applied proposal`)
    // A cancelled task never continues through checks, review, verification or merge.
    const cancelSeq = firstSeq('task.cancelled', t.id)
    for (const e of events) {
      if (e.taskId === t.id && e.seq > cancelSeq && ['review.started', 'verification.started', 'git.merged', 'task.completed'].includes(e.type)) {
        problems.push(`cancelled task ${t.key} still produced ${e.type}`)
      }
    }
  }

  // Outcome: without an effective cancellation every bounded fault must be absorbed.
  const live = planned.filter((t) => !cancelledByProposal.includes(t))
  if (!cancelTookEffect) {
    if (run.state !== 'completed') problems.push(`run ended ${run.state} (expected completed)`)
    for (const t of live) if (t.state !== 'completed') problems.push(`task ${t.key} ended ${t.state}`)
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

  // Every start of a task (a yielded task starts again after its new prerequisite merged) needs every
  // dependency the graph had AT THAT MOMENT to have completed: the latest revision before the start says which.
  const revisedAt = events.filter((e) => e.type === 'graph.revised').map((e) => ({ seq: e.seq, id: 'revisionId' in e.payload ? e.payload.revisionId : '' }))
  const revisionById = new Map(revisions.map((r) => [r.id, r]))
  for (const t of planned) {
    for (const start of events.filter((e) => e.type === 'task.started' && e.taskId === t.id)) {
      const latest = revisedAt.filter((r) => r.seq < start.seq).at(-1)
      const snapshot = latest ? revisionById.get(latest.id)?.snapshot : undefined
      if (!snapshot) {
        problems.push(`task ${t.key} started before any graph revision existed`)
        continue
      }
      for (const d of snapshot.dependencies.filter((x) => x.taskId === t.id)) {
        const dep = byId.get(d.dependsOnTaskId)
        // A cancelled dependency never completes, so it can never satisfy one.
        const depDone = firstSeq('task.completed', d.dependsOnTaskId)
        if (depDone === -1 || depDone > start.seq) problems.push(`task ${t.key} started (seq ${start.seq}) before dependency ${dep?.key} completed`)
        if (dep?.state === 'cancelled') problems.push(`task ${t.key} ran although dependency ${dep.key} was cancelled`)
      }
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

  // v0.2 routing and context: every agent has exactly one routing decision, every session that works on a task a pack.
  const decisions = h.repos.routingDecisions.listByRun(run.id)
  for (const agent of h.repos.agents.listByRun(run.id)) {
    const own = decisions.filter((d) => d.agentId === agent.id)
    if (own.length !== 1) problems.push(`agent ${agent.label} has ${own.length} routing decisions`)
    else if (own[0]?.role !== agent.role || own[0]?.purpose !== agent.purpose) problems.push(`routing decision of ${agent.label} disagrees with the agent`)
    const works = ['implement', 'diagnose', 'research', 'audit', 'ask', 'synthesis'].includes(agent.purpose)
    if (works && h.repos.contextPacks.listByAgent(agent.id).length === 0) problems.push(`${agent.purpose} agent ${agent.label} has no context pack`)
  }
  if (decisions.length !== h.repos.agents.listByRun(run.id).length) problems.push('routing decisions and agents differ in number')
  for (const pack of h.repos.contextPacks.listByRun(run.id)) {
    if (pack.entries.filter((e) => !e.included).length > 30) problems.push(`pack ${pack.id} records more than 30 excluded entries`)
    if (pack.entries.some((e) => e.reason.trim() === '')) problems.push(`pack ${pack.id} has an entry without a reason`)
  }
  // Consensus planning leaves its candidates; with a bad candidate exactly one of three is invalid.
  const candidates = h.repos.planningCandidates.listByRun(run.id)
  if (s.consensus) {
    if (candidates.length !== 3) problems.push(`consensus planning persisted ${candidates.length} candidates`)
    if (candidates.filter((c) => !c.valid).length !== (s.badCandidate ? 1 : 0)) problems.push('unexpected number of invalid candidates')
    if (events.filter((e) => e.type === 'planning.synthesized').length !== 1) problems.push('consensus planning did not announce exactly one synthesis')
  } else if (candidates.length > 0) problems.push('single planning left candidates')
  // Dual review: a significant, accepted finding leaves an arbiter row whose arbitration is retrievable.
  const reviewRows = h.repos.reviews.listByRun(run.id)
  const arbiterRows = h.repos.artifacts.listByRun(run.id).filter((a) => a.kind === 'arbitration')
  for (const a of arbiterRows) if (!reviewRows.some((r) => r.id === a.title)) problems.push('arbitration artifact without its review row')
  if (!s.dualReview && arbiterRows.length > 0) problems.push('arbiter ran without dual review')

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
  const obs: Observation = { violations: [], maxActiveWriters: 0, crashed: new Set(), rejected: new Set(), proposed: [] }
  const holder: { h?: Harness } = {}
  const h = await createHarness({ script: buildScript(s, obs, () => holder.h as Harness) })
  holder.h = h
  try {
    const headBefore = await git(h.repoDir, 'rev-parse', 'HEAD')
    let starts = 0
    let paused = false
    let cancelRequested = false
    // The user answers graph approvals, approving or denying by seed (after a beat, never inside the emitting call).
    let approvals = 0
    h.bus.subscribe((e) => {
      if (e.type !== 'approval.requested') return
      const approvalId = (e.payload as { approvalId: string }).approvalId
      const approval = h.repos.approvals.get(approvalId)
      if (approval?.kind !== 'graph') return
      const approve = hashed(seed, `approval:${approvals++}`) < 0.7
      setTimeout(() => {
        try {
          h.orchestrator.resolveApproval(approvalId, approve, approve ? undefined : 'denied by the stress campaign')
        } catch {
          // Already expired (the run ended or was cancelled).
        }
      }, 5)
    })
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

    const run = await h.startRun({
      overrides: { maxParallelAgents: s.maxParallel, ...(s.consensus ? { planningMode: 'consensus' as const } : {}), ...(s.dualReview ? { reviewMode: 'dual' as const } : {}) },
    })
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
            scenario: { ...s, crashOnce: [...s.crashOnce], rejectOnce: [...s.rejectOnce], verifyFailOnce: [...s.verifyFailOnce], messengers: [...s.messengers], proposals: [...s.proposals] },
            proposalsSeen: obs.proposed,
            revisions: h.repos.graphRevisions.listByRun(run.id).map((r) => ({ version: r.version, reason: r.reason, proposalId: r.proposalId, tasks: r.snapshot.tasks.map((t) => `${t.key}:${t.state}`), deps: r.snapshot.dependencies.length })),
            proposals: h.repos.graphProposals.listByRun(run.id),
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
    coverage.push(...obs.proposed.map((p) => `${p.kind}:${p.reply.split(' ')[0]}`))
    return problems
  } finally {
    await h.dispose()
  }
}

/** What the campaign actually exercised: proposal kinds and the answer each got. */
const coverage: string[] = []

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
    const tally = new Map<string, number>()
    for (const c of coverage) tally.set(c, (tally.get(c) ?? 0) + 1)
    console.warn(`[stress] proposals: ${[...tally].sort().map(([k, v]) => `${k}=${v}`).join(' ')}`)
    console.warn(`[stress] finished ${done}/${RUNS}; failing seeds: ${failures.map((f) => f.seed).join(', ') || 'none'}`)
    expect(failures).toEqual([])
  }, 6 * 60 * 60 * 1000)
})
