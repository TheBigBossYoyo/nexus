import { describe, expect, it } from 'vitest'
import type { Run } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { LIVE_PROGRAM_STATES, PROGRAM_POLICY_PRESETS, TERMINAL_PROGRAM_STATES, type MilestoneJudgment, type PlannedMilestone, type Program, type ProgramPolicy } from '@shared/program'
import { EventBus } from '@main/modules/events'
import type { GitService } from '@main/modules/git'
import { createRepositories, openDatabase, type Repositories } from '@main/modules/persistence'
import { ProgramEngine, REASONING_MARKERS, type ProgramRunHost } from '@main/modules/program'
import { makeProject, makeTask, runConfig } from '../integration/persistence/fixtures'

/**
 * Seeded stress of the program engine. Git is an in-memory map of refs and commits, the orchestrator is a
 * stub that only moves run rows and emits the events the real one emits, and Claude's answers are drawn at
 * random: valid plans, garbage, rejections, revisions. Every seed draws a policy and a sequence of mission
 * outcomes, usage limits, user actions, clock jumps and restarts, and checks the invariants after every step.
 *
 * NEXUS_PROGRAM_STRESS_RUNS / NEXUS_PROGRAM_STRESS_START select the seeds.
 */
const RUNS = Number(process.env['NEXUS_PROGRAM_STRESS_RUNS'] ?? process.env['NEXUS_STRESS_RUNS'] ?? 300)
const START = Number(process.env['NEXUS_PROGRAM_STRESS_START'] ?? 1)
const MINUTE = 60_000

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

const fence = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
const planned = (key: string, dependsOn: string[] = []): PlannedMilestone => ({ key, title: `M ${key}`, objective: `Deliver ${key}`, acceptanceCriteria: [`${key} works`], workstream: 'core', expertise: 'backend', dependsOn, complexity: 'small', risk: 'low' })

class World {
  readonly db = openDatabase(':memory:')
  readonly repos: Repositories = createRepositories(this.db)
  readonly bus = new EventBus(this.repos.events, this.repos.transaction)
  readonly project = this.repos.projects.insert(makeProject({ rootPath: 'C:\\stress\\repo' }))
  /** In-memory Git: refs to commit ids. A commit id encodes its parent chain length only. */
  readonly refs = new Map<string, string>([['HEAD', 'c0']])
  commits = 1
  offset = 0
  gateOpen = true
  engine: ProgramEngine
  programId = ''
  /** Runs created, in order, with the program state at creation. */
  readonly created: { run: Run; kind: 'plan' | 'replan' | 'verify' | 'mission'; stateAtCreation: Program['state'] }[] = []
  violations: string[] = []

  readonly git = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        switch (prop) {
          case 'isRepository':
            return async () => true
          case 'headCommit':
            return async () => this.refs.get('HEAD')
          case 'createBranch':
            return async (_repo: string, name: string, start: string) => {
              this.refs.set(name, this.refs.get(start) ?? start)
              return this.refs.get(name)
            }
          case 'resolveCommit':
            return async (_repo: string, rev: string) => {
              const found = this.refs.get(rev) ?? (rev.startsWith('c') ? rev : null)
              if (!found) throw new Error(`unknown revision ${rev}`)
              return found
            }
          case 'changedFiles':
            return async (_repo: string, base: string, head: string) => (base === head ? [] : ['src/file.ts'])
          case 'diff':
            return async () => ({ files: [{ path: 'src/file.ts' }], patch: '+ work', truncated: false })
          case 'run':
            return async (_repo: string, args: string[]) => {
              if (args[0] === 'update-ref' && args[1] && args[2]) this.refs.set(args[1].replace('refs/heads/', ''), args[2])
              return { exitCode: 0, output: '', stdout: '', stderr: '' }
            }
          default:
            return async () => {
              throw new Error(`git.${prop} is not available in the stress`)
            }
        }
      },
    },
  ) as unknown as GitService

  readonly host: ProgramRunHost = {
    createRun: async (input) => {
      const kind = input.mode !== 'ask' ? 'mission' : input.prompt.startsWith(REASONING_MARKERS.plan) ? 'plan' : input.prompt.startsWith(REASONING_MARKERS.replan) ? 'replan' : 'verify'
      const state = this.repos.programs.require(this.programId).state
      if (!LIVE_PROGRAM_STATES.includes(state) || state === 'WAITING_FOR_QUOTA') this.violations.push(`a ${kind} run was created while the program was ${state}`)
      const open = this.created.filter((c) => !['completed', 'failed', 'cancelled'].includes(this.repos.runs.require(c.run.id).state))
      if (open.length > 0) this.violations.push(`a ${kind} run was created while ${open.length} run(s) of the program were still open`)
      const baseCommit = this.refs.get(input.baseRef ?? 'HEAD') ?? input.baseRef ?? 'c0'
      const run = this.repos.runs.insert({
        id: newId(),
        projectId: input.projectId,
        mode: input.mode === 'ask' ? 'ask' : 'mission',
        preset: 'balanced',
        state: 'executing',
        resumeState: null,
        pauseReason: null,
        prompt: input.prompt,
        plan: null,
        baseBranch: input.baseRef ?? 'main',
        baseCommit,
        integrationBranch: null,
        config: { ...runConfig(), ...(kind === 'mission' ? { strategy: { requested: input.strategy ?? 'BUILD', resolved: 'BUILD' } } : {}) } as Run['config'],
        error: null,
        createdAt: nowIso(),
        startedAt: nowIso(),
        finishedAt: null,
      })
      this.created.push({ run, kind, stateAtCreation: state })
      return run
    },
    pauseRun: async (runId) => {
      const run = this.repos.runs.require(runId)
      if (run.state === 'executing') {
        this.repos.runs.update(runId, { state: 'paused', resumeState: 'executing', pauseReason: 'user' })
        this.bus.emit({ runId, type: 'run.paused', payload: { reason: 'user', cause: 'user' } })
      }
    },
    resumeRun: async (runId) => {
      const run = this.repos.runs.require(runId)
      if (run.state === 'paused') {
        this.repos.runs.update(runId, { state: 'executing', resumeState: null, pauseReason: null })
        this.bus.emit({ runId, type: 'run.resumed', payload: {} })
      }
    },
    cancelRun: async (runId) => {
      const run = this.repos.runs.require(runId)
      if (!['completed', 'failed', 'cancelled'].includes(run.state)) {
        this.repos.runs.update(runId, { state: 'cancelled', finishedAt: nowIso() })
        this.bus.emit({ runId, type: 'run.cancelled', payload: {} })
      }
    },
    recover: async (runId) => {
      await this.host.resumeRun(runId)
    },
  }

  constructor() {
    this.engine = this.build()
  }

  now(): number {
    return Date.now() + this.offset
  }

  build(): ProgramEngine {
    return new ProgramEngine({ repos: this.repos, bus: this.bus, git: this.git, host: this.host, usage: { canDispatch: () => this.gateOpen, onChange: () => () => undefined }, now: () => this.now(), tickIntervalMs: 0 })
  }

  program(): Program {
    return this.repos.programs.require(this.programId)
  }

  /** The run the engine is waiting on, when it is still working. */
  current(): { run: Run; kind: 'plan' | 'replan' | 'verify' | 'mission' } | null {
    const id = this.program().currentRunId
    const entry = id ? this.created.find((c) => c.run.id === id) : null
    if (!entry) return null
    const run = this.repos.runs.require(entry.run.id)
    return run.state === 'executing' ? { run, kind: entry.kind } : null
  }

  answer(runId: string, text: string): void {
    this.repos.tasks.insert(makeTask(runId, 'ask', { state: 'completed', resultSummary: text }))
    this.repos.runs.update(runId, { state: 'completed', finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.completed', payload: { summary: 'answered' } })
  }

  finishMission(runId: string, how: 'complete' | 'fail' | 'checks_fail'): void {
    const run = this.repos.runs.require(runId)
    if (how === 'fail') {
      this.repos.runs.update(runId, { state: 'failed', error: 'boom', finishedAt: nowIso() })
      this.bus.emit({ runId, type: 'run.failed', payload: { error: 'boom' } })
      return
    }
    const branch = `nexus/integration-${runId.slice(0, 8)}`
    const commit = `c${this.commits++}`
    this.refs.set(branch, commit)
    this.refs.set(commit, commit)
    void run
    this.repos.verifications.insert({ id: newId(), runId, taskId: null, agentId: null, attempt: 1, kind: 'checks', passed: how === 'complete', summary: how, criteria: [], commands: [], failures: [], createdAt: nowIso() })
    this.repos.runs.update(runId, { state: 'completed', integrationBranch: branch, finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.completed', payload: { summary: 'done' } })
  }

  quota(runId: string): void {
    this.repos.runs.update(runId, { state: 'paused', resumeState: 'executing', pauseReason: 'quota' })
    this.bus.emit({ runId, type: 'run.paused', payload: { reason: 'quota', cause: 'quota' } })
  }

  async restart(): Promise<void> {
    await this.engine.idle()
    this.engine.dispose()
    for (const c of this.created) {
      if (this.repos.runs.require(c.run.id).state === 'executing') this.repos.runs.update(c.run.id, { state: 'paused', resumeState: 'executing', pauseReason: 'recovery' })
    }
    this.engine = this.build()
    await this.engine.recover()
  }

  close(): void {
    this.engine.dispose()
    this.db.close()
  }
}

async function runSeed(seed: number): Promise<void> {
  const rand = mulberry32(seed)
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
  const world = new World()
  const log: string[] = []
  let completedBefore = 0
  let decisionsBefore = 0
  const fail = (message: string): never => {
    const p = world.repos.programs.get(world.programId)
    throw new Error(
      `seed ${seed}: ${message}\n  ops: ${log.join(' | ')}\n  program: ${JSON.stringify(p ? { state: p.state, pause: p.pauseReason, blocked: p.blockedReason, run: p.currentRunKind, missions: p.missions, replans: p.replans, plan: p.planVersion } : null)}\n  milestones: ${world.repos.milestones.listByProgram(world.programId).map((m) => `${m.key}:${m.state}:${m.attempts}`).join(', ')}\n  runs: ${world.created.map((c) => `${c.kind}:${world.repos.runs.require(c.run.id).state}`).join(', ')}`,
    )
  }

  const policy: ProgramPolicy = {
    ...PROGRAM_POLICY_PRESETS.autonomous,
    approvalPolicy: pick(['none', 'none', 'initial', 'plan'] as const),
    usageBehavior: pick(['wait', 'wait', 'stop'] as const),
    maxMissionsPerMilestone: pick([1, 2, 3]),
    maxTotalMissions: pick([3, 6, 20]),
    maxReplans: pick([0, 2, 10]),
    quotaWaitMaxMinutes: pick([30, 600]),
  }

  const goodPlan = (): string => {
    const n = 1 + Math.floor(rand() * 4)
    const keys = Array.from({ length: n }, (_, i) => `m${i}`)
    return fence({ goal: 'g', successCriteria: ['s'], milestones: keys.map((k, i) => planned(k, i > 0 && rand() < 0.5 ? [keys[Math.floor(rand() * i)] as string] : [])), risks: [], constraints: [] })
  }
  const judgment = (accepted: boolean): string => {
    const j: MilestoneJudgment = {
      verdict: accepted ? 'accepted' : 'rejected',
      criteria: [{ criterion: 'c', met: accepted, evidence: 'e' }],
      gaps: accepted ? [] : ['gap'],
      backlog: rand() < 0.3 ? [{ title: `Finding ${Math.floor(rand() * 5)}`, description: 'd', category: 'debt', severity: 'low', evidence: 'src/a.ts:1', complexity: 'small', dependencies: [], recommendedMilestone: null }] : [],
      memory: rand() < 0.3 ? [{ kind: 'hazard', title: `Fact ${Math.floor(rand() * 5)}`, content: 'A durable fact about the module layout.', evidence: 'src/a.ts:1 shows the layout', tags: [] }] : [],
    }
    return fence(j)
  }
  const replan = (): string => {
    const remaining = world.repos.milestones.listByProgram(world.programId).filter((m) => !['COMPLETED', 'CANCELLED', 'DEFERRED'].includes(m.state))
    const roll = rand()
    if (roll < 0.5 || remaining.length === 0) return fence({ action: 'keep', reason: 'fine', milestones: [], defer: [], strategyNote: null })
    if (roll < 0.6) return 'I would rather not say.'
    const kept = remaining.filter(() => rand() < 0.8).map((m) => planned(m.key, []))
    const extra = rand() < 0.5 ? [planned(`x${world.commits}-${Math.floor(rand() * 1000)}`)] : []
    const defer = remaining.filter((m) => !kept.some((k) => k.key === m.key) && rand() < 0.5).map((m) => m.key)
    return fence({ action: 'revise', reason: 'changed', milestones: [...kept, ...extra], defer, strategyNote: rand() < 0.3 ? 'smaller steps' : null })
  }

  const check = (): void => {
    if (world.violations.length > 0) fail(world.violations.join('; '))
    const p = world.program()
    const milestones = world.repos.milestones.listByProgram(world.programId)
    const terminal = TERMINAL_PROGRAM_STATES.includes(p.state)
    if (terminal && (p.currentRunId !== null || p.outcome === null || p.finishedAt === null)) fail(`terminal program ${p.state} with a current run or without an outcome`)
    if (!terminal && p.outcome !== null) fail('a live program has an outcome')
    if ((p.currentRunId === null) !== (p.currentRunKind === null)) fail('current run and its kind disagree')
    // Completed milestones are final and carry accepted evidence.
    const completed = milestones.filter((m) => m.state === 'COMPLETED')
    if (completed.length < completedBefore) fail('a completed milestone stopped being completed')
    completedBefore = completed.length
    for (const m of completed) if (m.evidence?.verdict !== 'accepted' || m.evidence.judgment === null) fail(`milestone ${m.key} is completed without an accepted judgment`)
    // The program branch is exactly the accepted work.
    if (p.branch) {
      const accepted = completed.map((m) => m.evidence?.resultCommit).filter((c): c is string => Boolean(c))
      const head = world.refs.get(p.branch)
      const expected = accepted.length > 0 ? accepted : [p.baseCommit]
      if (!expected.includes(head ?? null)) fail(`the program branch points at ${String(head)}, which is not accepted work (${expected.join(', ')})`)
    }
    // Budgets hold.
    const missions = world.created.filter((c) => c.kind === 'mission').length
    if (missions !== p.missions) fail(`${missions} mission runs but the program counts ${p.missions}`)
    if (missions > p.policy.maxTotalMissions) fail(`${missions} missions exceed the budget of ${p.policy.maxTotalMissions}`)
    const replans = world.created.filter((c) => c.kind === 'replan').length
    if (replans > p.policy.maxReplans) fail(`${replans} reassessments exceed the budget of ${p.policy.maxReplans}`)
    for (const m of milestones) if (m.attempts > p.policy.maxMissionsPerMilestone) fail(`milestone ${m.key} had ${m.attempts} missions (limit ${p.policy.maxMissionsPerMilestone})`)
    // One milestone at a time.
    if (milestones.filter((m) => m.state === 'ACTIVE' || m.state === 'VERIFYING').length > 1) fail('more than one milestone is being worked on')
    // The decision trail only grows.
    const decisions = world.repos.programDecisions.listByProgram(world.programId, 5000).length
    if (decisions < decisionsBefore) fail('the decision trail shrank')
    decisionsBefore = decisions
    // Nothing waits for approval without a proposal, and no proposal is pending in a terminal program.
    const pending = world.repos.planRevisions.pending(world.programId)
    if (p.state === 'PAUSED' && p.pauseReason === 'approval' && !pending) fail('paused for approval without a pending plan')
    if (terminal && pending && p.state !== 'COMPLETED' && p.state !== 'FAILED') fail('a plan is still pending in a cancelled program')
  }

  try {
    const created = await world.engine.create({ projectId: world.project.id, name: 'stress', goal: 'A goal', policy, start: false })
    world.programId = created.id
    await world.engine.start(created.id)
    await world.engine.idle()
    check()

    const act = async (op: string): Promise<void> => {
      const current = world.current()
      const quiet = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined)
      switch (op) {
        case 'tick':
          await world.engine.tick()
          break
        case 'answer':
          if (current?.kind === 'plan') world.answer(current.run.id, rand() < 0.75 ? goodPlan() : pick(['nonsense', fence({ goal: 'g', milestones: [] }), '']))
          else if (current?.kind === 'verify') world.answer(current.run.id, rand() < 0.1 ? 'LGTM' : judgment(rand() < 0.65))
          else if (current?.kind === 'replan') world.answer(current.run.id, replan())
          break
        case 'mission':
          if (current?.kind === 'mission') world.finishMission(current.run.id, pick(['complete', 'complete', 'complete', 'fail', 'checks_fail'] as const))
          break
        case 'runFails':
          if (current && current.kind !== 'mission') {
            world.repos.runs.update(current.run.id, { state: 'failed', error: 'session crashed', finishedAt: nowIso() })
            world.bus.emit({ runId: current.run.id, type: 'run.failed', payload: { error: 'session crashed' } })
          }
          break
        case 'quota':
          if (current) world.quota(current.run.id)
          break
        case 'quotaClear': {
          const id = world.program().currentRunId
          const run = id ? world.repos.runs.get(id) : null
          if (run?.state === 'paused' && run.pauseReason === 'quota') await world.host.resumeRun(run.id)
          break
        }
        case 'gate':
          world.gateOpen = !world.gateOpen
          await world.engine.tick()
          break
        case 'advance':
          world.offset += pick([MINUTE, 20 * MINUTE, 3 * 60 * MINUTE, 26 * 60 * MINUTE])
          await world.engine.tick()
          break
        case 'pause':
          await quiet(world.engine.pause(world.programId))
          break
        case 'resume':
          await quiet(world.engine.resume(world.programId))
          break
        case 'approve': {
          const pending = world.repos.planRevisions.pending(world.programId)
          if (pending) await quiet(world.engine.decidePlan(world.programId, pending.id, rand() < 0.8))
          break
        }
        case 'restart':
          await world.restart()
          break
        case 'cancel':
          await quiet(world.engine.cancel(world.programId))
          break
      }
      await world.engine.idle()
      await new Promise((resolve) => setImmediate(resolve))
      await world.engine.idle()
      check()
    }

    const steps = 10 + Math.floor(rand() * 40)
    for (let i = 0; i < steps; i++) {
      const op = pick(['tick', 'answer', 'answer', 'answer', 'mission', 'mission', 'mission', 'runFails', 'quota', 'quotaClear', 'gate', 'advance', 'pause', 'resume', 'approve', 'approve', 'restart', rand() < 0.03 ? 'cancel' : 'tick'])
      log.push(op)
      await act(op)
    }

    // With Claude available, every answer valid and a user who keeps resuming, the program must reach an end:
    // completed, failed, cancelled, or blocked on a budget. It can never be left waiting on nothing.
    log.push('drain')
    world.gateOpen = true
    let resumes = 0
    for (let i = 0; i < 400; i++) {
      const p = world.program()
      if (TERMINAL_PROGRAM_STATES.includes(p.state)) break
      if (p.state === 'BLOCKED' && /Budget|No milestone can be worked on|did not reset/.test(p.blockedReason ?? '') && resumes >= 3) break
      const pending = world.repos.planRevisions.pending(world.programId)
      const run = p.currentRunId ? world.repos.runs.get(p.currentRunId) : null
      if (pending && p.state === 'PAUSED') await world.engine.decidePlan(world.programId, pending.id, true).catch(() => undefined)
      else if (run?.state === 'paused' && run.pauseReason === 'quota') await world.host.resumeRun(run.id) // the limit reset
      else if (p.state === 'PAUSED' || p.state === 'BLOCKED') {
        resumes++
        await world.engine.resume(world.programId).catch(() => undefined)
      } else if (run?.state === 'paused') await world.host.resumeRun(run.id)
      else {
        const current = world.current()
        if (current?.kind === 'plan') world.answer(current.run.id, goodPlan())
        else if (current?.kind === 'verify') world.answer(current.run.id, judgment(true))
        else if (current?.kind === 'replan') world.answer(current.run.id, fence({ action: 'keep', reason: 'fine', milestones: [], defer: [], strategyNote: null }))
        else if (current?.kind === 'mission') world.finishMission(current.run.id, 'complete')
        else await world.engine.tick()
      }
      await world.engine.idle()
      await new Promise((resolve) => setImmediate(resolve))
      await world.engine.idle()
      check()
    }
    const end = world.program()
    if (!TERMINAL_PROGRAM_STATES.includes(end.state) && end.state !== 'BLOCKED') fail(`the program is still ${end.state} after the drain`)
    if (end.state === 'COMPLETED' && world.repos.milestones.listByProgram(world.programId).some((m) => !['COMPLETED', 'DEFERRED', 'CANCELLED'].includes(m.state))) fail('completed with an open milestone')
  } finally {
    world.close()
  }
}

describe('program engine stress', () => {
  it(`keeps its invariants over ${RUNS} seeded histories`, async () => {
    const failures: string[] = []
    for (let seed = START; seed < START + RUNS; seed++) {
      try {
        await runSeed(seed)
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e))
        if (failures.length >= 5) break
      }
    }
    expect(failures, failures.join('\n\n')).toEqual([])
  })
})
