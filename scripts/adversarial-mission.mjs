// Adversarial acceptance run: four tasks, a dependant of several, fast-tier workers, and a
// controlled app restart mid-run. Uses the REAL Claude Agent SDK and consumes Claude usage.
//
//   node scripts/adversarial-mission.mjs [path-to-NEXUS.exe]
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
const dataDir = mkdtempSync(join(tmpdir(), 'nexus-adv-data-'))
const repo = mkdtempSync(join(tmpdir(), 'nexus-adv-repo-'))
const TIMEOUT_MS = 60 * 60_000

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
const file = (path, content) => {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), content)
}

execFileSync('git', ['init', '-b', 'main', repo])
git('config', 'user.name', 'Acceptance')
git('config', 'user.email', 'acceptance@example.com')
file('package.json', JSON.stringify({ name: 'worklog-kit', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n')
file('src/index.js', "export const VERSION = '1.0.0'\n")
file('test/index.test.js', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { VERSION } from '../src/index.js'\n\ntest('version', () => assert.equal(VERSION, '1.0.0'))\n")
file('README.md', '# worklog-kit\n\nUtilities for turning a CSV work log into a report. Tests: `npm test` (node:test, no dependencies).\n')
git('add', '-A')
git('commit', '-q', '-m', 'initial')
const baseCommit = git('rev-parse', 'HEAD')

const MISSION = [
  'Build a small work-log reporting library in plain ESM JavaScript with node:test tests and no dependencies.',
  '1. src/duration.js: `parseDuration(text)` returns seconds. Accept "90s", "15m", "2h", combined forms like "1h30m" and "1h 30m 15s", and decimals like "1.5h". Reject empty strings, unknown units, negative values, repeated units ("1h2h") and out-of-order units ("30m1h") with a TypeError. Also `formatDuration(seconds)` producing the shortest canonical form ("1h30m", "45s", "0s").',
  '2. src/csv.js: `parseCsvLine(line)` returns an array of fields following RFC 4180 for a single line: quoted fields, commas inside quotes, doubled quotes as an escaped quote, empty fields, and surrounding whitespace preserved inside quotes but trimmed outside. Throw a SyntaxError on an unterminated quote or on text after a closing quote.',
  '3. src/table.js: `formatTable(rows)` renders an array of string arrays as an aligned plain-text table with a header separator; columns are padded to the widest cell; numbers-only columns are right-aligned.',
  '4. src/report.js: `buildReport(csvText)` takes CSV text with a header "person,task,duration", uses parseCsvLine and parseDuration to total the time per person, and returns the text produced by formatTable with columns person, tasks, total (formatted with formatDuration), sorted by total descending then person. Lines that fail to parse are collected and listed after the table as "skipped line N: reason". This task depends on the duration, csv and table modules.',
  'Each module is a separate task with its own test file under test/. The report task must start only after the modules it uses are finished. Authors of duration, csv and table must tell the report task the exact exported signatures and error behaviour through a message. `npm test` must pass.',
].join('\n')

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const env = { ...process.env, NEXUS_DATA_DIR: dataDir }
delete env.NEXUS_FAKE_RUNTIME
let app = await electron.launch(exe ? { executablePath: exe, env } : { args: ['.'], cwd: root, env })
let page = await app.firstWindow()
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

// Workers on the fast tier; planning, review and verification stay on the strongest tier.
const settings = await call('settings.get')
await call('settings.update', { settings: { ...settings, models: { ...settings.models, rolePolicy: { ...settings.models.rolePolicy, worker: 'fast' } } } })
const project = await call('projects.open', { path: repo })
log('project', project.name, JSON.stringify(project.profile.commands))
let run = await call('runs.create', { projectId: project.id, mode: 'build', preset: 'balanced', prompt: MISSION, maxParallelAgents: 4, requirePlanApproval: true })
log('run created', run.id)

const started = Date.now()
let lastLine = ''
let approved = false
let maxConcurrentImplementers = 0
let restarted = false
const restart = {}
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
  // Controlled restart: once a task is under review or verification, close the app (a clean
  // shutdown that stops every session) and relaunch on the same data directory.
  if (!restarted && approved && detail.tasks.some((t) => t.state === 'review' || t.state === 'verification')) {
    restarted = true
    restart.before = { runState: run.state, tasks: detail.tasks.map((t) => `${t.key}:${t.state}`), activeAgents: detail.agents.filter((a) => ['starting', 'working', 'waiting'].includes(a.state)).map((a) => a.label) }
    log('RESTART: closing app with', JSON.stringify(restart.before))
    await app.close()
    app = await electron.launch(exe ? { executablePath: exe, env } : { args: ['.'], cwd: root, env })
    page = await app.firstWindow()
    await page.waitForSelector('[data-testid="open-project"]', { timeout: 30_000 })
    const recoverable = await call('runs.recoverable')
    const mine = recoverable.find((r) => r.run.id === run.id)
    restart.recoverable = mine ? { state: mine.run.state, pauseReason: mine.run.pauseReason, resumeState: mine.run.resumeState, staleAgents: mine.staleAgents, activeTasks: mine.activeTasks } : null
    log('RESTART: recoverable', JSON.stringify(restart.recoverable))
    if (mine) await call('runs.recover', { runId: run.id, action: 'resume' })
    continue
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
  restart,
  repairTasks: detail.tasks.filter((t) => t.kind === 'repair').map((t) => ({ key: t.key, state: t.state, description: t.description.slice(0, 200) })),
  rejectedReviews: reviews.filter((r) => r.verdict === 'changes_requested').length,
  resumableSessionEnds: sessions.filter((s) => ['shutdown', 'paused', 'app_restart'].includes(s.endReason ?? '')).length,
  taskTimes: detail.tasks.map((t) => ({ key: t.key, startedAt: t.startedAt, finishedAt: t.finishedAt })),
  dependencies: detail.dependencies.map((d) => ({ task: detail.tasks.find((t) => t.id === d.taskId)?.key, dependsOn: detail.tasks.find((t) => t.id === d.dependsOnTaskId)?.key })),
  messageBodies: messages.map((m) => ({ type: m.type, from: m.fromLabel, to: m.toLabel, subject: m.subject, body: m.body.slice(0, 300) })),
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
const outFile = join(outDir, `adversarial-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n')
log('RESULT', evidence.runState, '| evidence:', outFile)
log('repo:', repo, '| data:', dataDir)
process.exit(evidence.runState === 'completed' ? 0 : 1)
