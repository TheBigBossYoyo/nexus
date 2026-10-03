// Manual MVP acceptance run. Uses the REAL Claude Agent SDK and consumes Claude usage.
//
//   node scripts/acceptance-mission.mjs [path-to-NEXUS.exe]
//
// Without an argument it launches the dev build (run `pnpm build` first). It creates a disposable
// Git repository, submits a mission that needs two parallel worker tasks, approves the plan, and
// records what durable state says happened. Evidence is written to docs/acceptance/.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exe = process.argv[2]
const root = resolve(import.meta.dirname, '..')
const dataDir = mkdtempSync(join(tmpdir(), 'nexus-accept-data-'))
const repo = mkdtempSync(join(tmpdir(), 'nexus-accept-repo-'))
const TIMEOUT_MS = 45 * 60_000

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
const file = (path, content) => {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), content)
}

execFileSync('git', ['init', '-b', 'main', repo])
git('config', 'user.name', 'Acceptance')
git('config', 'user.email', 'acceptance@example.com')
file('package.json', JSON.stringify({ name: 'acceptance-kit', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n')
file('src/math.js', 'export function add(a, b) {\n  return a + b\n}\n')
file('src/strings.js', 'export function capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1)\n}\n')
file('test/math.test.js', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/math.js'\n\ntest('add', () => assert.equal(add(2, 3), 5))\n")
file('test/strings.test.js', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { capitalize } from '../src/strings.js'\n\ntest('capitalize', () => assert.equal(capitalize('abc'), 'Abc'))\n")
file('README.md', '# acceptance-kit\n\nSmall utility library. Tests: `npm test`.\n')
git('add', '-A')
git('commit', '-q', '-m', 'initial')
const baseCommit = git('rev-parse', 'HEAD')

const MISSION = [
  'Add two independent utilities to this library, each with unit tests:',
  '1. In src/math.js add `clamp(value, min, max)` which returns value limited to the inclusive range and throws a RangeError when min > max. Add tests to test/math.test.js.',
  '2. In src/strings.js add `slugify(text)` which lowercases, trims, replaces runs of non-alphanumeric characters with a single hyphen and strips leading/trailing hyphens. Add tests to test/strings.test.js.',
  'The two utilities touch different files and must be implemented as separate parallel tasks. `npm test` must pass with no regressions.',
].join('\n')

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const env = { ...process.env, NEXUS_DATA_DIR: dataDir }
delete env.NEXUS_FAKE_RUNTIME
const app = await electron.launch(exe ? { executablePath: exe, env } : { args: ['.'], cwd: root, env })
const page = await app.firstWindow()
await page.waitForSelector('[data-testid="open-project"]', { timeout: 30_000 })
const call = async (channel, input = {}) => {
  const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
  if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
  return result.value
}

const evidence = { startedAt: new Date().toISOString(), executable: exe ?? 'dev build', mission: MISSION }
const info = await call('app.info')
evidence.app = { version: info.version, isPackaged: info.isPackaged, sdkVersion: info.sdkVersion, gitVersion: info.gitVersion, platform: info.platform }
const auth = await call('auth.status', { refresh: true })
evidence.auth = { state: auth.state, mode: auth.mode, subscriptionType: auth.subscriptionType, apiKeyEnvDetected: auth.apiKeyEnvDetected }
log('auth', JSON.stringify(evidence.auth))
if (auth.state !== 'authenticated') throw new Error('Claude is not authenticated; run `claude auth login`.')

const project = await call('projects.open', { path: repo })
log('project', project.name, JSON.stringify(project.profile.commands))
let run = await call('runs.create', { projectId: project.id, mode: 'build', preset: 'balanced', prompt: MISSION, maxParallelAgents: 4, requirePlanApproval: true })
log('run created', run.id)

const started = Date.now()
let lastLine = ''
let approved = false
let maxConcurrentImplementers = 0
const approvalLog = []
for (;;) {
  if (Date.now() - started > TIMEOUT_MS) {
    log('timeout: cancelling run')
    await call('runs.cancel', { runId: run.id })
    break
  }
  const detail = await call('runs.get', { runId: run.id })
  run = detail.run
  const working = detail.agents.filter((a) => ['implement', 'diagnose'].includes(a.purpose) && ['starting', 'working', 'waiting'].includes(a.state))
  maxConcurrentImplementers = Math.max(maxConcurrentImplementers, working.length)
  const line = `${run.state} | ${detail.tasks.map((t) => `${t.key}:${t.state}`).join(' ')} | active agents: ${detail.agents.filter((a) => ['starting', 'working', 'waiting'].includes(a.state)).map((a) => a.label).join(', ')}`
  if (line !== lastLine) {
    log(line)
    lastLine = line
  }
  if (run.state === 'awaiting_approval' && !approved) {
    evidence.plan = run.plan
    log('plan:', JSON.stringify(run.plan.tasks.map((t) => ({ id: t.id, role: t.role, deps: t.dependencies, files: t.suggestedFiles }))))
    await page.screenshot({ path: join(root, 'test-results', 'acceptance-plan.png') }).catch(() => undefined)
    await call('runs.approvePlan', { runId: run.id })
    approved = true
  }
  for (const approval of detail.pendingApprovals.filter((a) => a.kind !== 'plan')) {
    // Low-risk requests (e.g. a local dependency install) are approved; everything else is denied.
    const approve = approval.risk === 'low'
    approvalLog.push({ action: approval.action, command: approval.command, risk: approval.risk, approved: approve })
    log('approval', approve ? 'APPROVE' : 'DENY', approval.risk, approval.action, approval.command ?? '')
    await call('approvals.resolve', { approvalId: approval.id, approve, note: 'acceptance script' })
  }
  if (['completed', 'failed', 'cancelled'].includes(run.state)) break
  if (run.state === 'paused') {
    const events = await call('events.list', { runId: run.id, limit: 5000 })
    log('paused:', JSON.stringify(events.filter((e) => e.type === 'run.paused').at(-1)?.payload))
    break
  }
  await new Promise((r) => setTimeout(r, 4000))
}

const detail = await call('runs.get', { runId: run.id })
const summary = await call('runs.summary', { runId: run.id })
const reviews = await call('reviews.list', { runId: run.id })
const verifications = await call('verifications.list', { runId: run.id })
const messages = await call('messages.list', { runId: run.id })
const events = await call('events.list', { runId: run.id, limit: 5000 })
const sessions = []
for (const agent of detail.agents) {
  const d = await call('agents.get', { agentId: agent.id })
  for (const s of d.sessions) sessions.push({ agent: agent.label, role: agent.role, model: s.model, sdkSessionId: s.sdkSessionId, state: s.state, endReason: s.endReason })
}
await page.screenshot({ path: join(root, 'test-results', 'acceptance-final.png') }).catch(() => undefined)

Object.assign(evidence, {
  finishedAt: new Date().toISOString(),
  runState: detail.run.state,
  runError: detail.run.error,
  baseCommit,
  integrationBranch: detail.run.integrationBranch,
  tasks: detail.tasks.map((t) => ({ key: t.key, role: t.role, kind: t.kind, state: t.state, attempt: t.attempt, repairCycles: t.repairCycles, branch: t.branch, error: t.error })),
  worktrees: detail.worktrees.map((w) => ({ task: detail.tasks.find((t) => t.id === w.taskId)?.key ?? '(integration)', branch: w.branch, state: w.state })),
  maxConcurrentImplementers,
  sessions,
  distinctSdkSessions: new Set(sessions.map((s) => s.sdkSessionId).filter(Boolean)).size,
  agents: detail.agents.map((a) => ({ label: a.label, model: a.model, state: a.state, turns: a.metrics.turns, toolCalls: a.metrics.toolCalls, inputTokens: a.metrics.inputTokens, outputTokens: a.metrics.outputTokens, costUsd: a.metrics.costUsd })),
  summary,
  reviews: reviews.map((r) => ({ task: detail.tasks.find((t) => t.id === r.taskId)?.key, verdict: r.verdict, findings: r.findings.map((f) => ({ severity: f.severity, title: f.title })) })),
  verifications: verifications.map((v) => ({ task: detail.tasks.find((t) => t.id === v.taskId)?.key ?? '(mission)', kind: v.kind, passed: v.passed, summary: v.summary.slice(0, 300), commands: v.commands.map((c) => ({ command: c.command, exitCode: c.exitCode })) })),
  criteria: detail.criteria.map((c) => ({ task: detail.tasks.find((t) => t.id === c.taskId)?.key ?? '(mission)', text: c.text, status: c.status })),
  messages: messages.map((m) => ({ type: m.type, from: m.fromLabel, to: m.toLabel, subject: m.subject })),
  approvals: approvalLog,
  eventCounts: events.reduce((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {}),
})

// Independent check with plain git and node, outside NEXUS.
try {
  evidence.git = {
    userHeadUnchanged: git('rev-parse', 'HEAD') === baseCommit,
    userBranch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    userStatus: git('status', '--porcelain'),
    integrationLog: detail.run.integrationBranch ? git('log', '--oneline', `${baseCommit}..${detail.run.integrationBranch}`).split('\n') : [],
    changedFiles: detail.run.integrationBranch ? git('diff', '--stat', baseCommit, detail.run.integrationBranch).split('\n') : [],
  }
  const integration = detail.worktrees.find((w) => w.taskId === null)
  if (integration) {
    const out = execFileSync(process.execPath, ['--test'], { cwd: integration.path, encoding: 'utf8' })
    evidence.independentTestRun = out.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l))
  }
} catch (e) {
  evidence.independentCheckError = String(e.stdout ?? e.message ?? e).slice(-2000)
}

await app.close()
const outDir = join(root, 'docs', 'acceptance')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `mission-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n')
log('RESULT', evidence.runState, '| evidence:', outFile)
log('repo:', repo, '| data:', dataDir)
process.exit(evidence.runState === 'completed' ? 0 : 1)
