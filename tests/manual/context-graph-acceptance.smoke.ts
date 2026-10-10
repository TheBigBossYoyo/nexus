// Manual acceptance against the REAL Claude runtime: one mission run twice on the same repository, the same
// task, the same models and the same policy, once with the 0.7.0 context (BASELINE) and once with the Context
// Graph in the pack and its tools available (GRAPH). Consumes usage: two BUILD missions.
// Run with `pnpm accept:graph`. Writes evidence to docs/acceptance.
//
// One pair proves that the path works end to end and shows what the two runs cost. It is not a statistical
// comparison: the quality gate needs eight pairs before anything becomes a default on its strength.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Run } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import type { AgentRuntime, SessionSpec } from '@main/modules/agent-runtime/types'
import { ContextGraphService } from '@main/modules/context-graph'
import { EventBus } from '@main/modules/events'
import { GitService, WorktreeManager } from '@main/modules/git'
import { Orchestrator } from '@main/modules/orchestrator'
import { createRepositories, openDatabase } from '@main/modules/persistence'

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'racedeck-lite', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  'README.md': '# RaceDeck Lite\n\nA small telemetry pipeline: packets come in, are ordered, and become race state.\n',
  'src/telemetry/packet.js': "/** A telemetry packet: { seq, clock, lap, car }. `seq` is a 16-bit counter set by the sender. `clock` is the session clock in milliseconds. */\nexport function makePacket(seq, clock, lap, car = 1) {\n  return { seq: seq & 0xffff, clock, lap, car }\n}\n",
  'src/telemetry/order.js': "/** Orders the packets of one batch before they are applied to the race state. */\nexport function orderPackets(packets) {\n  return [...packets].sort((a, b) => a.seq - b.seq)\n}\n",
  'src/telemetry/state.js': "import { orderPackets } from './order.js'\n\n/** Applies a batch of packets and returns the laps of each car in the order they were driven. */\nexport function applyBatch(state, packets) {\n  const next = { laps: { ...state.laps } }\n  for (const p of orderPackets(packets)) {\n    next.laps[p.car] = [...(next.laps[p.car] ?? []), p.lap]\n  }\n  return next\n}\n\nexport const emptyState = () => ({ laps: {} })\n",
  'src/telemetry/order.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { orderPackets } from './order.js'\nimport { makePacket } from './packet.js'\n\ntest('orders packets by sequence number', () => {\n  const out = orderPackets([makePacket(3, 300, 3), makePacket(1, 100, 1), makePacket(2, 200, 2)])\n  assert.deepEqual(out.map((p) => p.lap), [1, 2, 3])\n})\n",
  'src/strategy/pace.js': "/** Average lap delta of a car over its last laps. Unrelated to packet ordering. */\nexport function pace(laps) {\n  if (laps.length < 2) return 0\n  return (laps[laps.length - 1] - laps[0]) / (laps.length - 1)\n}\n",
  'src/strategy/pace.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { pace } from './pace.js'\n\ntest('pace of evenly spaced laps', () => {\n  assert.equal(pace([1, 2, 3]), 1)\n})\n",
}

/** Not in the repository: what the mission is judged by afterwards. */
const HIDDEN_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { applyBatch, emptyState } from './src/telemetry/state.js'\nimport { makePacket } from './src/telemetry/packet.js'\n\ntest('laps stay in driving order when the sequence counter wraps', () => {\n  const batch = [makePacket(65534, 1000, 10), makePacket(65535, 2000, 11), makePacket(65536, 3000, 12), makePacket(65537, 4000, 13)]\n  const shuffled = [batch[2], batch[0], batch[3], batch[1]]\n  assert.deepEqual(applyBatch(emptyState(), shuffled).laps[1], [10, 11, 12, 13])\n})\n\ntest('packets of an ordinary batch are still ordered', () => {\n  const batch = [makePacket(7, 700, 3), makePacket(5, 500, 1), makePacket(6, 600, 2)]\n  assert.deepEqual(applyBatch(emptyState(), batch).laps[1], [1, 2, 3])\n})\n"

const PROMPT = 'In long sessions the race state gets corrupted: after roughly eighteen hours of running, laps of a car appear out of driving order. Find the cause in the telemetry pipeline and fix it, with a test that fails before the fix.'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

interface Outcome {
  variant: 'BASELINE' | 'GRAPH'
  runState: string
  tasks: { key: string; state: string; repairs: number }[]
  hiddenPassed: boolean
  hiddenOutput: string
  sessions: number
  turns: number
  toolCalls: number
  contextToolCalls: { tool: string; input: string }[]
  cache: { requests: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; warmStarts: number; coldStarts: number }
  outputTokens: number
  packsWithGraph: number
  graphNodesInPacks: number
  workerPromptHasMap: boolean
  workerPromptGraphExcerpt: string | null
  reviews: { verdict: string; findings: number }[]
  verifications: { passed: boolean; kind: string }[]
  durationMs: number
  decisions: Record<string, number>
}

async function mission(variant: 'BASELINE' | 'GRAPH'): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), `nexus-graph-accept-${variant.toLowerCase()}-`))
  const repoDir = join(dir, 'repo')
  execFileSync('git', ['init', '-b', 'main', repoDir])
  git(repoDir, 'config', 'user.name', 'Acceptance')
  git(repoDir, 'config', 'user.email', 'acceptance@example.com')
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(join(repoDir, path, '..'), { recursive: true })
    writeFileSync(join(repoDir, path), content)
  }
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-q', '-m', 'initial')

  const db = openDatabase(join(dir, 'nexus.db'))
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const gitService = new GitService()
  const real = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })
  const prompts: { role: string; prompt: string }[] = []
  const runtime: AgentRuntime = {
    startSession: (spec: SessionSpec) => {
      prompts.push({ role: spec.role, prompt: spec.prompt })
      return real.startSession(spec)
    },
    resumeSession: (spec, id) => real.resumeSession(spec, id),
    sendMessage: (h, t) => real.sendMessage(h, t),
    interruptSession: (h) => real.interruptSession(h),
    stopSession: (h) => real.stopSession(h),
    getCapabilities: () => real.getCapabilities(),
    getAccountInfo: (o) => real.getAccountInfo(o),
    shutdown: () => real.shutdown(),
  }
  const orchestrator = new Orchestrator({ repos, bus, runtime, git: gitService, worktrees: new WorktreeManager(gitService, join(dir, 'worktrees')), push: () => undefined })
  repos.settings.set({
    ...DEFAULT_SETTINGS,
    execution: { ...DEFAULT_SETTINGS.execution, requirePlanApproval: false, maxParallelAgents: 1 },
    permissions: { ...DEFAULT_SETTINGS.permissions, safeCommandPrefixes: ['node --test', 'npm test'] },
    tokens: { ...DEFAULT_SETTINGS.tokens, contextGraph: variant === 'GRAPH' ? 'on' : 'off' },
  })
  // A tool call that needs a person is refused: the run must not wait for one, and nothing is approved unseen.
  bus.subscribe((e) => {
    if (e.type !== 'approval.requested') return
    const approvalId = (e.payload as { approvalId: string }).approvalId
    setTimeout(() => {
      try {
        orchestrator.resolveApproval(approvalId, false, 'Unattended acceptance run: not approved.')
      } catch {
        // already resolved
      }
    }, 50)
  })
  const project = repos.projects.insert({
    id: newId(), name: 'racedeck-lite', rootPath: repoDir,
    profile: { repoRoot: repoDir, isGitRepo: true, currentBranch: 'main', headCommit: git(repoDir, 'rev-parse', 'HEAD'), dirty: false, packageManagers: ['npm'], languages: ['JavaScript'], frameworks: [], scripts: { test: 'node --test' }, commands: { build: null, test: 'node --test', lint: null, typecheck: null }, docs: ['README.md'], hasClaudeMd: false, fileCount: 8, sizeBytes: 2000, generatedPaths: [], profiledAt: nowIso() },
    respectProjectClaudeConfig: false, createdAt: nowIso(), lastOpenedAt: nowIso(),
  })
  // Knowledge that exists only in NEXUS, written by the user after an earlier incident. Both runs have it in
  // the database; only the GRAPH run puts it in front of the agents.
  const graph = new ContextGraphService({ repos })
  await graph.syncProject(project.id)
  graph.writeNote({ space: { kind: 'project', id: project.id }, title: 'Packet sequence numbers wrap at 65535', body: 'The sender uses a 16-bit sequence counter, so seq wraps from 65535 to 0 about every 18 hours at one packet per second. Ordering by seq alone is wrong across a wrap; the session clock is monotonic and is the reliable order.', evidence: 'src/telemetry/packet.js: seq & 0xffff', about: 'src/telemetry/order.js', author: { source: 'user' } })

  const started = Date.now()
  const run = await orchestrator.createRun({ projectId: project.id, mode: 'build', preset: 'balanced', prompt: PROMPT })
  const deadline = Date.now() + 25 * 60_000
  let state: Run = repos.runs.require(run.id)
  while (!['completed', 'failed', 'paused', 'cancelled'].includes(state.state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    state = repos.runs.require(run.id)
  }
  const durationMs = Date.now() - started

  // Hidden evaluation on the integration branch, in a scratch checkout.
  let hiddenPassed = false
  let hiddenOutput: string
  try {
    const integration = repos.worktrees.listByRun(run.id).find((w) => w.taskId === null)
    const checkout = join(dir, 'hidden')
    execFileSync('git', ['clone', '-q', repoDir, checkout])
    if (integration?.branch) git(checkout, 'checkout', '-q', integration.branch)
    writeFileSync(join(checkout, 'hidden.test.js'), HIDDEN_TEST)
    try {
      hiddenOutput = execFileSync('node', ['--test', 'hidden.test.js'], { cwd: checkout, encoding: 'utf8', timeout: 60_000 })
      hiddenPassed = true
    } catch (e) {
      hiddenOutput = String((e as { stdout?: string }).stdout ?? e)
    }
  } catch (e) {
    hiddenOutput = `hidden evaluation could not run: ${String(e)}`
  }

  const agents = repos.agents.listByRun(run.id)
  const tools = agents.flatMap((a) => repos.toolEvents.listByAgent(a.id))
  const totals = repos.cacheEvents.totals('1970-01-01T00:00:00.000Z', run.id)
  const packs = repos.contextPacks.listByRun(run.id)
  const worker = prompts.find((p) => p.role === 'worker')?.prompt ?? ''
  const at = worker.indexOf('## Project knowledge')
  const decisions: Record<string, number> = {}
  for (const d of repos.optimizationDecisions.listByRun(run.id)) decisions[d.action] = (decisions[d.action] ?? 0) + 1
  const outcome: Outcome = {
    variant,
    runState: state.state,
    tasks: repos.tasks.listByRun(run.id).map((t) => ({ key: t.key, state: t.state, repairs: t.attempt - 1 })),
    hiddenPassed,
    hiddenOutput: hiddenOutput.slice(-1200),
    sessions: repos.agents.listByRun(run.id).length,
    turns: agents.reduce((n, a) => n + a.metrics.turns, 0),
    toolCalls: tools.length,
    contextToolCalls: tools.filter((t) => t.toolName.startsWith('mcp__nexus__context_')).map((t) => ({ tool: t.toolName, input: JSON.stringify(t.input).slice(0, 200) })),
    cache: { requests: totals.requests, inputTokens: totals.inputTokens, cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens, warmStarts: totals.warmStarts, coldStarts: totals.coldStarts },
    outputTokens: agents.reduce((n, a) => n + (a.metrics.outputTokens ?? 0), 0),
    packsWithGraph: packs.filter((p) => p.entries.some((e) => e.sourceKind === 'context_node' && e.included)).length,
    graphNodesInPacks: packs.reduce((n, p) => n + p.entries.filter((e) => e.sourceKind === 'context_node' && e.included).length, 0),
    workerPromptHasMap: at >= 0,
    workerPromptGraphExcerpt: at >= 0 ? worker.slice(at, at + 1800) : null,
    reviews: repos.reviews.listByRun(run.id).map((r) => ({ verdict: r.verdict, findings: r.findings.length })),
    verifications: repos.verifications.listByRun(run.id).map((v) => ({ passed: v.passed, kind: v.kind })),
    durationMs,
    decisions,
  }
  console.log(`${variant}: run ${outcome.runState}, hidden ${hiddenPassed ? 'passed' : 'FAILED'}, sessions ${outcome.sessions}, turns ${outcome.turns}, tools ${outcome.toolCalls} (context ${outcome.contextToolCalls.length}), read ${totals.cacheReadTokens}, write ${totals.cacheWriteTokens}, uncached ${totals.inputTokens}, out ${outcome.outputTokens}, ${Math.round(durationMs / 1000)} s`)
  await orchestrator.shutdown().catch(() => undefined)
  await real.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  return outcome
}

describe('real Claude runtime: one mission with and without the Context Graph', () => {
  it('runs both and records what happened', async () => {
    const startedAt = new Date().toISOString()
    const order: ('BASELINE' | 'GRAPH')[] = process.env['NEXUS_GRAPH_ACCEPT_ORDER'] === 'graph-first' ? ['GRAPH', 'BASELINE'] : ['BASELINE', 'GRAPH']
    const outcomes: Outcome[] = []
    for (const variant of order) outcomes.push(await mission(variant))
    const evidence = { kind: 'context-graph-acceptance', startedAt, finishedAt: new Date().toISOString(), prompt: PROMPT, order, note: 'One pair on one task. Same repository, task, models, effort, permissions and policy; the only difference is the contextGraph setting. Token figures are runtime-reported.', outcomes }
    const dir = resolve(import.meta.dirname, '../../docs/acceptance')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `context-graph-acceptance-${startedAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`evidence: ${file}`)
    expect(outcomes).toHaveLength(2)
  })
})
