// The real quality campaign: ONE task in ONE arm per invocation, on the REAL Claude runtime. Consumes usage.
//
//   NEXUS_CAMPAIGN_TASK   a task key from tasks.ts
//   NEXUS_CAMPAIGN_ARM    070        the 0.7.0 sources (run from a checkout of v0.7.0)
//                         071        the 0.7.1 sources with their default settings
//                         071-graph  the 0.7.1 sources with the Context Graph in agent context
//   NEXUS_CAMPAIGN_OUT    directory for the evidence file (default docs/acceptance/campaign)
//
// The same file runs against both versions: it uses only what 0.7.0 already had, and it measures through
// its own wrapper around the runtime and through tables both versions write, so the two arms are measured
// by one instrument. The arm is checked against the version of the sources it runs on.
//
// Quality and efficiency are recorded side by side and never combined.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { PROGRAM_POLICY_PRESETS } from '@shared/program'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import type { AgentEvent, AgentRuntime, AgentSessionHandle, SessionSpec } from '@main/modules/agent-runtime/types'
import { EventBus } from '@main/modules/events'
import { GitService, WorktreeManager } from '@main/modules/git'
import { ProjectService } from '@main/modules/ipc/services'
import { Orchestrator } from '@main/modules/orchestrator'
import { createRepositories, openDatabase } from '@main/modules/persistence'
import { ProgramEngine } from '@main/modules/program'
import { WorkspaceEngine } from '@main/modules/workspace'
import { CAMPAIGN_TASKS, type CampaignTask, type Files, type Repo } from './tasks'

type Arm = '070' | '071' | '071-graph'
const ARMS: Record<Arm, { version: string; what: string }> = {
  '070': { version: '0.7.0', what: 'NEXUS 0.7.0 sources, default settings' },
  '071': { version: '0.7.1', what: 'NEXUS 0.7.1 sources, default settings (Context Graph off for agents)' },
  '071-graph': { version: '0.7.1', what: 'NEXUS 0.7.1 sources, Context Graph in agent context' },
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function write(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function initRepo(root: string, repo: Repo): string {
  const dir = join(root, repo.name)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  git(dir, 'config', 'user.name', 'Campaign')
  git(dir, 'config', 'user.email', 'campaign@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  write(dir, repo.files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'initial')
  return dir
}

function nodeTest(dir: string, args: string[]): { ok: boolean; pass: number | null; fail: number | null; output: string } {
  let ok = true
  let output: string
  try {
    output = execFileSync('node', ['--test', ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    ok = false
    const err = e as { stdout?: string; stderr?: string }
    output = `${err.stdout ?? ''}${err.stderr ?? ''}` || String(e)
  }
  const count = (word: string): number | null => {
    const m = new RegExp(`^\\D*${word} (\\d+)\\s*$`, 'm').exec(output)
    return m ? Number(m[1]) : null
  }
  return { ok, pass: count('pass'), fail: count('fail'), output: output.slice(-1500) }
}

/** The hidden evaluation of one repository at one ref, in a scratch clone: the hidden files, then every test the result carries. */
function evaluate(scratch: string, repoDir: string, repo: Repo, ref: string | null) {
  if (!ref) return { repository: repo.name, ref: null, hiddenPassed: false, hidden: null, suitePassed: false, suite: null, note: 'no result to evaluate' }
  const checkout = join(scratch, `eval-${repo.name}`)
  try {
    execFileSync('git', ['clone', '-q', repoDir, checkout])
    git(checkout, 'checkout', '-q', ref)
    // The result's own tests first, as delivered: a regression of what existed shows here.
    const suite = nodeTest(checkout, [])
    write(checkout, repo.hidden)
    const hidden = nodeTest(checkout, Object.keys(repo.hidden))
    return { repository: repo.name, ref, hiddenPassed: hidden.ok, hidden, suitePassed: suite.ok, suite, note: null }
  } catch (e) {
    return { repository: repo.name, ref, hiddenPassed: false, hidden: null, suitePassed: false, suite: null, note: `evaluation could not run: ${String(e).slice(0, 400)}` }
  }
}

interface SessionTap {
  agentId: string
  role: string
  model: string | null
  resumed: boolean
  tools: Record<string, number>
  contextTools: string[]
  deniedTools: number
  denials: string[]
  lastText: string
  compactions: number
  turnResults: number
  outcomes: string[]
  startedAt: number
  endedAt: number | null
}

/** Wraps the real runtime: every session's events are counted as they pass. The same instrument for every arm. */
function instrument(real: ClaudeSdkRuntime): { runtime: AgentRuntime; sessions: SessionTap[] } {
  const sessions: SessionTap[] = []
  const tap = (spec: SessionSpec, inner: AgentSessionHandle, resumed: boolean): AgentSessionHandle => {
    const s: SessionTap = { agentId: spec.agentId, role: spec.role, model: null, resumed, tools: {}, contextTools: [], deniedTools: 0, denials: [], lastText: '', compactions: 0, turnResults: 0, outcomes: [], startedAt: Date.now(), endedAt: null }
    sessions.push(s)
    async function* events(): AsyncGenerator<AgentEvent> {
      for await (const event of inner.events) {
        const e = event as { type: string; model?: string; toolName?: string; input?: unknown; reason?: string; text?: string; result?: { outcome: string } }
        if (e.type === 'session.started') s.model = e.model ?? null
        else if (e.type === 'tool.started' && e.toolName) {
          s.tools[e.toolName] = (s.tools[e.toolName] ?? 0) + 1
          if (e.toolName.startsWith('mcp__nexus__context_')) s.contextTools.push(`${e.toolName.replace('mcp__nexus__', '')} ${JSON.stringify(e.input ?? {}).slice(0, 160)}`)
        } else if (e.type === 'tool.denied') {
          s.deniedTools++
          if (s.denials.length < 12) s.denials.push(`${e.toolName ?? '?'}: ${String(e.reason ?? '').slice(0, 300)}`)
        } else if (e.type === 'text' && e.text) s.lastText = e.text.slice(-700)
        else if (e.type === 'compaction') s.compactions++
        else if (e.type === 'turn.completed') {
          s.turnResults++
          if (e.result) s.outcomes.push(e.result.outcome)
        } else if (e.type === 'session.ended') s.endedAt = Date.now()
        yield event
      }
    }
    // Every member of the handle is forwarded; only the event stream is replaced.
    const stream = events()
    return new Proxy(inner, {
      get: (target, key) => {
        if (key === 'events') return stream
        const value = (target as never)[key] as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
  }
  const runtime = new Proxy(real as unknown as AgentRuntime, {
    get: (target, key) => {
      if (key === 'startSession') return (spec: SessionSpec) => tap(spec, real.startSession(spec), spec.resumeSessionId !== undefined)
      const value = (target as never)[key] as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
  return { runtime, sessions }
}

async function usageWindows(real: ClaudeSdkRuntime): Promise<{ limitType: string; utilizationPercent: number | null }[] | null> {
  try {
    const report = await (real as unknown as { getUsageReport?: (o: { subscriptionMode: boolean }) => Promise<{ windows: { limitType: string; utilizationPercent: number | null }[] } | null> }).getUsageReport?.({ subscriptionMode: true })
    return report ? report.windows.map((w) => ({ limitType: w.limitType, utilizationPercent: w.utilizationPercent })) : null
  } catch {
    return null
  }
}

async function runTask(task: CampaignTask, arm: Arm) {
  const root = mkdtempSync(join(tmpdir(), `nexus-campaign-${task.key}-${arm}-`))
  const repoDirs = task.repos.map((r) => initRepo(root, r))
  const db = openDatabase(join(root, 'nexus.db'))
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const gitService = new GitService()
  const real = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })
  const { runtime, sessions } = instrument(real)
  const orchestrator = new Orchestrator({ repos, bus, runtime, git: gitService, worktrees: new WorktreeManager(gitService, join(root, 'worktrees')), push: () => undefined })

  const base = DEFAULT_SETTINGS as typeof DEFAULT_SETTINGS & { tokens?: Record<string, unknown> }
  repos.settings.set({
    ...base,
    execution: { ...base.execution, requirePlanApproval: false, maxParallelAgents: 1 },
    permissions: { ...base.permissions, safeCommandPrefixes: ['node --test', 'npm test'] },
    ...(arm === '071-graph' ? { tokens: { ...base.tokens, contextGraph: 'on' } } : {}),
  } as typeof DEFAULT_SETTINGS)

  // A tool call that needs a person is refused: nothing is approved unseen, and the refusal is counted.
  let approvalsRefused = 0
  const approvals: string[] = []
  const pauses: string[] = []
  bus.subscribe((e) => {
    if (e.type === 'run.paused') pauses.push(String((e.payload as { detail?: string; reason?: string }).detail ?? (e.payload as { reason?: string }).reason ?? ''))
    if (e.type !== 'approval.requested') return
    approvalsRefused++
    if (approvals.length < 20) approvals.push(JSON.stringify(e.payload).slice(0, 400))
    const approvalId = (e.payload as { approvalId: string }).approvalId
    setTimeout(() => {
      try {
        orchestrator.resolveApproval(approvalId, false, 'Unattended campaign run: not approved.')
      } catch {
        // already resolved
      }
    }, 50)
  })

  const seed = (project: Project, repo: Repo): void => {
    for (const k of repo.knowledge) {
      repos.memory.insert({ id: newId(), scope: 'project', projectId: project.id, runId: null, taskId: null, agentId: null, kind: 'fact', title: k.title, content: k.content, tags: [], filePaths: k.filePaths, source: k.source, evidence: 'Recorded by the project owner before this campaign.', status: 'approved', createdAt: nowIso() })
    }
  }
  const projectService = new ProjectService(repos, gitService)

  const windowsBefore = await usageWindows(real)
  const started = Date.now()
  const deadline = started + task.budgetMinutes * 60_000
  let finalState: string
  let timedOut = false
  let detail: Record<string, unknown> = {}
  const refs: (string | null)[] = task.repos.map(() => null)
  let disposeEngine: (() => Promise<void>) | null = null

  try {
    if (task.kind === 'mission') {
      const project = await projectService.open(repoDirs[0] as string)
      seed(project, task.repos[0] as Repo)
      const run = await orchestrator.createRun({ projectId: project.id, mode: task.mode, preset: 'balanced', prompt: task.prompt })
      for (;;) {
        const state = repos.runs.require(run.id).state
        finalState = state
        if (['completed', 'failed', 'paused', 'cancelled'].includes(state)) break
        if (Date.now() > deadline) {
          timedOut = true
          break
        }
        await sleep(1000)
      }
      refs[0] = repos.worktrees.listByRun(run.id).find((w) => w.taskId === null)?.branch ?? null
    } else if (task.kind === 'program') {
      const project = await projectService.open(repoDirs[0] as string)
      seed(project, task.repos[0] as Repo)
      const engine = new ProgramEngine({ repos, bus, git: gitService, host: orchestrator })
      disposeEngine = async () => {
        engine.dispose()
        await engine.idle()
      }
      const created = await engine.create({
        projectId: project.id,
        name: 'Campaign program',
        goal: task.prompt,
        successCriteria: task.successCriteria ?? [],
        policy: { ...PROGRAM_POLICY_PRESETS.autonomous, missionStrategy: 'BUILD', maxAgents: 1, maxMissionsPerMilestone: 2, maxTotalMissions: 5, maxReplans: 2, speculation: false, arenaExploration: false, respectWorkWindows: false },
        start: true,
      })
      for (;;) {
        const p = repos.programs.require(created.id)
        finalState = p.state
        if (['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(p.state)) break
        if (Date.now() > deadline) {
          timedOut = true
          break
        }
        await engine.tick()
        await sleep(2000)
      }
      const p = repos.programs.require(created.id)
      refs[0] = p.branch
      detail = {
        blockedReason: p.blockedReason,
        outcome: p.outcome,
        replans: p.replans,
        milestones: repos.milestones.listByProgram(p.id).map((m) => ({ key: m.key, state: m.state, attempts: m.attempts })),
        missions: repos.programMissions.listByProgram(p.id).map((m) => ({ outcome: m.outcome, strategy: m.strategy })),
        decisions: repos.programDecisions.listByProgram(p.id).map((d) => `${d.kind}: ${String(d.summary).slice(0, 160)}`),
      }
    } else {
      const engine = new WorkspaceEngine({ repos, bus, git: gitService, host: orchestrator, projects: projectService })
      disposeEngine = async () => {
        engine.dispose()
        await engine.idle()
      }
      const ws = engine.createWorkspace({ name: 'Campaign workspace' })
      const [provider, consumer] = task.repos as [Repo, Repo]
      await engine.enroll(ws.id, { path: repoDirs[0] as string, role: 'library' })
      await engine.enroll(ws.id, { path: repoDirs[1] as string, role: 'service' })
      for (const [i, repo] of task.repos.entries()) {
        const project = repos.projects.list().find((p) => resolve(p.rootPath).toLowerCase() === resolve(repoDirs[i] as string).toLowerCase())
        if (project) seed(project, repo)
      }
      const contract = await engine.registerContract(ws.id, { key: task.contract!.key, name: task.contract!.name, kind: 'json_schema', provider: provider.name, path: task.contract!.path })
      engine.addConsumer(contract.id, { repository: consumer.name, copyPath: task.contract!.copyPath })
      const mission = await engine.createMission(ws.id, { goal: task.prompt, start: true })
      let approved = false
      for (;;) {
        const m = repos.workspaceMissions.require(mission.id)
        finalState = m.state
        if (m.state === 'AWAITING_APPROVAL' && !approved) {
          approved = true
          // The plan is the engine's own (repositories in dependency order); it is accepted as a user would.
          await engine.decidePlan(mission.id, true)
          continue
        }
        if (['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(m.state)) break
        if (Date.now() > deadline) {
          timedOut = true
          break
        }
        await engine.tick()
        await sleep(2000)
      }
      const m = repos.workspaceMissions.require(mission.id)
      const tasks = repos.workspaceTasks.listByMission(mission.id)
      for (const [i, repo] of task.repos.entries()) refs[i] = tasks.filter((t) => t.repository === repo.name && t.resultCommit).at(-1)?.resultCommit ?? null
      detail = {
        blockedReason: m.blockedReason,
        plan: m.plan?.tasks.map((t) => ({ key: t.key, repository: t.repository, dependsOn: t.dependsOn })) ?? null,
        tasks: tasks.map((t) => ({ key: t.key, repository: t.repository, state: t.state })),
        verification: m.verification ? { passed: m.verification.passed, contracts: m.verification.contracts.map((c) => ({ contract: c.contract, level: c.result?.level ?? null, consumersInSync: c.consumersInSync })) } : null,
        decisions: repos.workspaceDecisions.listByMission(mission.id).map((d) => `${d.kind}: ${String(d.summary).slice(0, 160)}`),
      }
    }
  } catch (e) {
    finalState = `harness error: ${String(e).slice(0, 600)}`
  }
  const durationMs = Date.now() - started

  // ── quality ──
  const evaluations = task.repos.map((repo, i) => evaluate(root, repoDirs[i] as string, repo, refs[i] ?? null))
  let contractInSync: boolean | null = null
  if (task.kind === 'workspace' && refs[0] && refs[1]) {
    try {
      contractInSync = git(repoDirs[0] as string, 'show', `${refs[0]}:${task.contract!.path}`) === git(repoDirs[1] as string, 'show', `${refs[1]}:${task.contract!.copyPath}`)
    } catch {
      contractInSync = false
    }
  }
  const runs = repos.projects.list().flatMap((p) => repos.runs.listByProject(p.id))
  const agents = runs.flatMap((r) => repos.agents.listByRun(r.id))
  const tasksRows = runs.flatMap((r) => repos.tasks.listByRun(r.id))
  const reviews = runs.flatMap((r) => repos.reviews.listByRun(r.id))
  const verifications = runs.flatMap((r) => repos.verifications.listByRun(r.id))
  const severities: Record<string, number> = {}
  for (const r of reviews) for (const f of r.findings) severities[f.severity] = (severities[f.severity] ?? 0) + 1
  // First pass: for each task, the first record of each kind of verification.
  const firstOf = new Map<string, boolean>()
  for (const v of verifications) {
    const key = `${v.taskId ?? 'mission'}:${v.kind}`
    if (!firstOf.has(key)) firstOf.set(key, v.passed)
  }
  const hiddenPassed = evaluations.every((e) => e.hiddenPassed) && (contractInSync ?? true)
  const completed = ['completed', 'COMPLETED'].includes(finalState)

  // ── efficiency ──
  const usageRows = runs.flatMap((r) => repos.usage.listByRun(r.id))
  const sum = (f: (u: (typeof usageRows)[number]) => number): number => usageRows.reduce((n, u) => n + (f(u) || 0), 0)
  const byRole: Record<string, { sessions: number; turns: number; toolCalls: number; contextToolCalls: number }> = {}
  for (const a of agents) {
    const row = (byRole[a.role] ??= { sessions: 0, turns: 0, toolCalls: 0, contextToolCalls: 0 })
    row.sessions++
    row.turns += a.metrics.turns
  }
  const toolTotals: Record<string, number> = {}
  for (const s of sessions) {
    const row = (byRole[s.role] ??= { sessions: 0, turns: 0, toolCalls: 0, contextToolCalls: 0 })
    for (const [name, n] of Object.entries(s.tools)) {
      toolTotals[name] = (toolTotals[name] ?? 0) + n
      row.toolCalls += n
    }
    row.contextToolCalls += s.contextTools.length
  }
  const events = runs.flatMap((r) => repos.events.listByRun(r.id, 0, 100_000))
  const windowsAfter = await usageWindows(real)

  const result = {
    kind: 'campaign-run',
    task: task.key,
    category: task.category,
    arm,
    armIs: ARMS[arm].what,
    nexusVersion: (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version,
    nexusCommit: git(process.cwd(), 'rev-parse', 'HEAD'),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    held: { repository: 'identical starting commit content per task', models: 'default role policy and tiers of both versions (unchanged between them)', preset: 'balanced', maxParallelAgents: 1, permissions: 'default plus safe prefixes node --test, npm test; every approval request refused', budgetMinutes: task.budgetMinutes, evaluator: 'hidden node --test files, the same for every arm' },
    quality: {
      completed,
      finalState,
      timedOut,
      hiddenPassed,
      evaluations,
      contractInSync,
      firstPassVerification: [...firstOf.entries()].map(([key, passed]) => ({ key: key.replace(/^[0-9a-f-]{36}:/, 'task:'), passed })),
      firstPassAllPassed: firstOf.size > 0 && [...firstOf.values()].every(Boolean),
      reviews: reviews.map((r) => ({ verdict: r.verdict, findings: r.findings.length })),
      reviewerFindings: reviews.reduce((n, r) => n + r.findings.length, 0),
      findingsBySeverity: severities,
      repairs: tasksRows.reduce((n, t) => n + Math.max(0, t.attempt - 1), 0),
      tasks: tasksRows.map((t) => ({ key: t.key, state: t.state, attempts: t.attempt })),
      regressions: evaluations.filter((e) => e.suite && !e.suitePassed).map((e) => e.repository),
      humanIntervention: { approvalsRequestedAndRefused: approvalsRefused, pauses },
      diagnostics: {
        approvals,
        denials: sessions.flatMap((s) => s.denials.map((d) => `${s.role}: ${d}`)),
        taskErrors: tasksRows.filter((t) => t.error).map((t) => `${t.key}: ${JSON.stringify(t.error).slice(0, 500)}`),
        verificationFailures: verifications.filter((v) => !v.passed).map((v) => JSON.stringify(v).slice(0, 900)),
        lastMessages: sessions.map((s) => `${s.role}: ${s.lastText}`),
        approvalDetails: runs.flatMap((r) => repos.approvals.listByRun(r.id)).map((x) => `${x.requestedBy} [${x.risk}] ${x.action}: ${String(x.command ?? '').slice(0, 300)} | ${String(x.reason).slice(0, 200)}`),
        blocked: events.filter((e) => e.type === 'task.blocked').map((e) => String((e.payload as { reason?: string }).reason ?? '').slice(0, 500)),
        keptAt: process.env['NEXUS_CAMPAIGN_KEEP'] === '1' ? root : null,
      },
      detail,
    },
    efficiency: {
      runs: runs.length,
      sessions: agents.length,
      turns: agents.reduce((n, a) => n + a.metrics.turns, 0),
      inputTokensUncached: sum((u) => u.inputTokens),
      outputTokens: sum((u) => u.outputTokens),
      cacheCreationTokens: sum((u) => u.cacheCreationTokens),
      cacheReadTokens: sum((u) => u.cacheReadTokens),
      costUsdReported: Math.round(sum((u) => u.costUsd) * 10_000) / 10_000,
      toolCalls: Object.values(toolTotals).reduce((n, v) => n + v, 0),
      // What NEXUS recorded per agent (file edits included); the wrapper's count above is of tool.started events.
      toolCallsRecorded: agents.reduce((n, x) => n + x.metrics.toolCalls, 0),
      filesChangedRecorded: agents.reduce((n, x) => n + x.metrics.filesChanged, 0),
      toolCallsByName: toolTotals,
      contextToolCalls: sessions.flatMap((s) => s.contextTools.map((c) => `${s.role}: ${c}`)),
      deniedToolCalls: sessions.reduce((n, s) => n + s.deniedTools, 0),
      byRole,
      models: [...new Set(sessions.map((s) => s.model).filter(Boolean))],
      sessionRotations: events.filter((e) => e.type === 'agent.rotated').length,
      compactions: sessions.reduce((n, s) => n + s.compactions, 0),
      compactionNote: arm === '070' ? 'The 0.7.0 runtime adapter does not report compaction events; 0 here means not observable.' : 'Reported by the runtime adapter.',
      wallMs: durationMs,
      usageWindowsBefore: windowsBefore,
      usageWindowsAfter: windowsAfter,
    },
  }

  await disposeEngine?.().catch(() => undefined)
  await orchestrator.shutdown().catch(() => undefined)
  await real.shutdown().catch(() => undefined)
  db.close()
  if (process.env['NEXUS_CAMPAIGN_KEEP'] !== '1') rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  return result
}

describe('real quality campaign: one task, one arm', () => {
  it('runs it and records quality and efficiency separately', async () => {
    const arm = process.env['NEXUS_CAMPAIGN_ARM'] as Arm
    const task = CAMPAIGN_TASKS.find((t) => t.key === process.env['NEXUS_CAMPAIGN_TASK'])
    if (!task || !ARMS[arm]) throw new Error(`Set NEXUS_CAMPAIGN_TASK (${CAMPAIGN_TASKS.map((t) => t.key).join(', ')}) and NEXUS_CAMPAIGN_ARM (${Object.keys(ARMS).join(', ')}).`)
    const version = (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version
    // An arm measured on the wrong sources is worse than no measurement.
    expect(version, `arm ${arm} must run on NEXUS ${ARMS[arm].version}`).toBe(ARMS[arm].version)

    const result = await runTask(task, arm)
    const out = resolve(process.env['NEXUS_CAMPAIGN_OUT'] ?? join(process.cwd(), 'docs/acceptance/campaign'))
    mkdirSync(out, { recursive: true })
    const file = join(out, `${task.key}__${arm}__${result.startedAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`)
    const q = result.quality
    const e = result.efficiency
    console.log(`${task.key} [${arm}] ${q.finalState}${q.timedOut ? ' (TIMED OUT)' : ''}: hidden ${q.hiddenPassed ? 'passed' : 'FAILED'}, first pass ${q.firstPassAllPassed ? 'passed' : 'not all passed'}, findings ${q.reviewerFindings}, repairs ${q.repairs} | sessions ${e.sessions}, turns ${e.turns}, tools ${e.toolCalls} (context ${e.contextToolCalls.length}), read ${e.cacheReadTokens}, write ${e.cacheCreationTokens}, uncached ${e.inputTokensUncached}, out ${e.outputTokens}, ${Math.round(e.wallMs / 1000)} s\nevidence: ${file}`)
    expect(result.kind).toBe('campaign-run')
  })
})
