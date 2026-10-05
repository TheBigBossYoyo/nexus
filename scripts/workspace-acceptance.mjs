// 0.5 acceptance: one real CROSS-REPOSITORY MISSION with REAL Claude Agent SDK sessions on three disposable
// repositories that share a contract. Consumes usage.
//
//   node scripts/workspace-acceptance.mjs [path-to-NEXUS.exe]
//
// The provider owns a JSON Schema; two consumers keep a copy of it. The mission changes the contract, updates
// the provider and both consumers with tests, and must end with a passed global verification, a prepared
// (never published) release train, and with every original checkout untouched.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixtureRepo, launchNexus, log, reportGates, requireAuth, writeEvidence } from './acceptance-common.mjs'

const exe = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : undefined
const TIMEOUT_MS = 70 * 60_000

const SCHEMA = JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Order', type: 'object', required: ['id', 'total'], properties: { id: { type: 'string' }, total: { type: 'number', minimum: 0 } }, additionalProperties: false }, null, 2) + '\n'
const pkg = (name) => JSON.stringify({ name, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n'

const contract = createFixtureRepo('nexus-ws-contract', {
  'package.json': pkg('orders-contract'),
  'contracts/order.schema.json': SCHEMA,
  'src/validate.js': [
    "import { readFileSync } from 'node:fs'",
    '',
    "const schema = JSON.parse(readFileSync(new URL('../contracts/order.schema.json', import.meta.url), 'utf8'))",
    '',
    '/** Returns the list of problems of an order against the contract; empty when it is valid. */',
    'export function validateOrder(order) {',
    '  const problems = []',
    "  if (order === null || typeof order !== 'object') return ['not an object']",
    '  for (const key of schema.required) if (!(key in order)) problems.push(`missing ${key}`)',
    '  for (const key of Object.keys(order)) if (!(key in schema.properties)) problems.push(`unknown ${key}`)',
    "  if ('id' in order && typeof order.id !== 'string') problems.push('id must be a string')",
    "  if ('total' in order && (typeof order.total !== 'number' || order.total < 0)) problems.push('total must be a non-negative number')",
    '  return problems',
    '}',
    '',
  ].join('\n'),
  'test/validate.test.js': [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { validateOrder } from '../src/validate.js'",
    '',
    "test('a valid order has no problems', () => assert.deepEqual(validateOrder({ id: 'o1', total: 12.5 }), []))",
    "test('a missing field is a problem', () => assert.deepEqual(validateOrder({ id: 'o1' }), ['missing total']))",
    "test('an unknown field is a problem', () => assert.deepEqual(validateOrder({ id: 'o1', total: 1, note: 'x' }), ['unknown note']))",
    '',
  ].join('\n'),
  'README.md': '# orders-contract\n\nOwns the order contract (`contracts/order.schema.json`) and a small validator. Plain ESM JavaScript, no dependencies. Tests: `npm test`.\n',
})

const api = createFixtureRepo('nexus-ws-api', {
  'package.json': pkg('orders-api'),
  'contracts/order.schema.json': SCHEMA,
  'src/create-order.js': [
    '/** Builds an order as the contract in contracts/order.schema.json describes it. */',
    'export function createOrder(id, lines) {',
    '  const total = lines.reduce((sum, line) => sum + line.price * line.quantity, 0)',
    '  return { id, total }',
    '}',
    '',
  ].join('\n'),
  'test/create-order.test.js': [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { readFileSync } from 'node:fs'",
    "import { createOrder } from '../src/create-order.js'",
    '',
    "const schema = JSON.parse(readFileSync(new URL('../contracts/order.schema.json', import.meta.url), 'utf8'))",
    '',
    "test('an order has every field the contract requires and no other', () => {",
    "  const order = createOrder('o1', [{ price: 2, quantity: 3 }])",
    '  assert.deepEqual(Object.keys(order).sort(), [...schema.required].sort())',
    '  assert.equal(order.total, 6)',
    '})',
    '',
  ].join('\n'),
  'README.md': '# orders-api\n\nCreates orders. It keeps a copy of the order contract at `contracts/order.schema.json`; the owner of the contract is the orders-contract repository. Plain ESM JavaScript. Tests: `npm test`.\n',
})

const cli = createFixtureRepo('nexus-ws-cli', {
  'package.json': pkg('orders-cli'),
  'vendor/order.schema.json': SCHEMA,
  'src/format-order.js': [
    '/** One line of text for an order as the contract in vendor/order.schema.json describes it. */',
    'export function formatOrder(order) {',
    '  return `${order.id}: ${order.total.toFixed(2)}`',
    '}',
    '',
  ].join('\n'),
  'test/format-order.test.js': [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { formatOrder } from '../src/format-order.js'",
    '',
    "test('formats id and total', () => assert.equal(formatOrder({ id: 'o1', total: 6 }), 'o1: 6.00'))",
    '',
  ].join('\n'),
  'README.md': '# orders-cli\n\nPrints orders. It keeps a copy of the order contract at `vendor/order.schema.json`; the owner of the contract is the orders-contract repository. Plain ESM JavaScript. Tests: `npm test`.\n',
})

const GOAL = [
  'Orders must carry their currency.',
  'Change the order contract: add a required string property `currency` that is an ISO 4217 code of exactly three upper-case letters (pattern ^[A-Z]{3}$).',
  'In the repository that owns the contract, update the schema file and the validator (a missing currency and a currency that is not three upper-case letters are problems), with tests.',
  'In orders-api, make the copy of the contract equal to the new contract and make createOrder take the currency as a third argument and put it on the order, with tests.',
  'In orders-cli, make the copy of the contract equal to the new contract and make formatOrder print the currency after the total (for example "o1: 6.00 EUR"), with tests.',
  '`npm test` must pass in every repository.',
].join('\n')

const repos = { 'orders-contract': contract, 'orders-api': api, 'orders-cli': cli }
const evidence = { kind: 'workspace-mission', startedAt: new Date().toISOString(), executable: exe ?? 'dev build', goal: GOAL, baseCommits: Object.fromEntries(Object.entries(repos).map(([k, r]) => [k, r.baseCommit])) }
const { app, call } = await launchNexus('nexus-workspace', exe)
let ok = false
try {
  await requireAuth(call, evidence)
  const workspace = await call('workspace.create', { name: 'Orders', description: 'The order contract and its two consumers.' })
  await call('workspace.enroll', { workspaceId: workspace.id, path: contract.repo, key: 'orders-contract', role: 'library' })
  await call('workspace.enroll', { workspaceId: workspace.id, path: api.repo, key: 'orders-api', role: 'service' })
  await call('workspace.enroll', { workspaceId: workspace.id, path: cli.repo, key: 'orders-cli', role: 'application' })
  await call('workspace.addDependency', { workspaceId: workspace.id, from: 'orders-api', to: 'orders-contract', kind: 'schema', detail: 'orders-api builds orders that must satisfy the contract' })
  await call('workspace.addDependency', { workspaceId: workspace.id, from: 'orders-cli', to: 'orders-api', kind: 'api_provider_consumer', detail: 'orders-cli prints the orders that orders-api creates' })
  const registered = await call('workspace.registerContract', { workspaceId: workspace.id, key: 'order', name: 'Order', kind: 'json_schema', provider: 'orders-contract', path: 'contracts/order.schema.json' })
  await call('workspace.addConsumer', { contractId: registered.id, repository: 'orders-api', copyPath: 'contracts/order.schema.json' })
  await call('workspace.addConsumer', { contractId: registered.id, repository: 'orders-cli', copyPath: 'vendor/order.schema.json' })
  await call('workspace.captureContract', { contractId: registered.id })
  // A single-agent strategy and the economical preset keep the usage of an acceptance run small.
  const current = (await call('workspace.get', { workspaceId: workspace.id })).workspace.policy
  await call('workspace.setPolicy', { workspaceId: workspace.id, policy: { ...current, missionStrategy: 'SINGLE', missionPreset: 'eco', reviewMode: 'standard' } })
  const before = await call('workspace.get', { workspaceId: workspace.id })
  evidence.workspace = { order: before.order, dependencies: before.dependencies.map((d) => `${d.from} -> ${d.to} (${d.kind}, ${d.source ?? 'declared'})`), contractVersions: before.contracts[0]?.versions.map((v) => v.version) }

  const mission = await call('workspace.createMission', { workspaceId: workspace.id, goal: GOAL, start: true })
  evidence.missionId = mission.id
  log('mission', mission.id)

  const started = Date.now()
  const approvals = []
  let last = ''
  let decided = false
  let detail
  for (;;) {
    if (Date.now() - started > TIMEOUT_MS) {
      log('timeout: cancelling the mission')
      await call('workspace.cancelMission', { missionId: mission.id })
      break
    }
    detail = await call('workspace.mission', { missionId: mission.id })
    const line = `${detail.mission.state} | ${detail.tasks.map((t) => `${t.key}@${t.repository}:${t.state}`).join(' ')}`
    if (line !== last) {
      log(line)
      last = line
    }
    if (detail.mission.state === 'AWAITING_APPROVAL' && !decided) {
      evidence.plan = detail.mission.plan
      log('plan:', JSON.stringify(detail.mission.plan?.tasks.map((t) => ({ key: t.key, repository: t.repository, dependsOn: t.dependsOn, contracts: t.contracts }))))
      await call('workspace.decidePlan', { missionId: mission.id, accept: true })
      decided = true
      continue
    }
    // Nobody else is there to answer the agents of the task runs: low-risk requests are approved, the rest denied.
    for (const task of detail.tasks.filter((t) => t.runId && t.state === 'RUNNING')) {
      const run = await call('runs.get', { runId: task.runId })
      for (const approval of run.pendingApprovals.filter((a) => a.kind !== 'plan')) {
        const approve = approval.kind === 'graph' || approval.kind === 'task' || approval.risk === 'low'
        approvals.push({ task: task.key, kind: approval.kind, action: approval.action, command: approval.command, risk: approval.risk, approved: approve })
        log('approval', approve ? 'APPROVE' : 'DENY', task.key, approval.kind, approval.risk, approval.action, approval.command ?? '')
        await call('approvals.resolve', { approvalId: approval.id, approve, note: 'acceptance script' })
      }
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(detail.mission.state)) break
    if (detail.mission.state === 'BLOCKED') {
      log('blocked:', detail.mission.blockedReason)
      break
    }
    if (detail.mission.state === 'WAITING_FOR_QUOTA') {
      evidence.quotaWaitObserved = true
      await new Promise((r) => setTimeout(r, 30_000))
      continue
    }
    await new Promise((r) => setTimeout(r, 5000))
  }

  detail = await call('workspace.mission', { missionId: mission.id })
  const after = await call('workspace.get', { workspaceId: workspace.id })
  const usage = await call('usage.overview').catch(() => null)
  const tasks = detail.tasks
  const taskOf = (repository) => tasks.find((t) => t.repository === repository)
  const runs = {}
  for (const t of tasks.filter((x) => x.runId)) {
    const run = await call('runs.get', { runId: t.runId })
    runs[t.key] = { state: run.run.state, prompt: run.run.prompt, baseCommit: run.run.baseCommit, agents: run.agents.map((a) => ({ role: a.role, model: a.model, state: a.state })), worktrees: [...new Set(run.worktrees.map((w) => w.path))] }
  }
  // What each repository contains at its task's result, and its own tests there, checked outside NEXUS.
  const results = {}
  for (const [key, r] of Object.entries(repos)) {
    const task = taskOf(key)
    const entry = { resultCommit: task?.resultCommit ?? null, resultBranch: task?.resultBranch ?? null }
    if (task?.resultCommit) {
      const copyPath = key === 'orders-cli' ? 'vendor/order.schema.json' : 'contracts/order.schema.json'
      try {
        entry.contract = r.git('show', `${task.resultCommit}:${copyPath}`)
      } catch (e) {
        entry.contractError = String(e.message ?? e).slice(0, 300)
      }
      const wt = mkdtempSync(join(tmpdir(), 'nexus-ws-check-'))
      try {
        r.git('worktree', 'add', '--detach', '-f', wt, task.resultCommit)
        const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: wt, encoding: 'utf8' })
        entry.tests = { pass: Number(/# pass (\d+)/.exec(out)?.[1] ?? 0), fail: Number(/# fail (\d+)/.exec(out)?.[1] ?? -1) }
      } catch (e) {
        entry.tests = { error: String(e.stdout ?? e.message ?? e).slice(-1500) }
      } finally {
        try {
          r.git('worktree', 'remove', '--force', wt)
        } catch {
          // Left for the operating system's temp cleanup.
        }
      }
    }
    entry.userCheckout = { head: r.git('rev-parse', 'HEAD'), branch: r.git('rev-parse', '--abbrev-ref', 'HEAD'), status: r.git('status', '--porcelain'), branches: r.git('branch', '--format=%(refname:short)').split('\n') }
    results[key] = entry
  }
  const train = after.releaseTrains.find((t) => t.missionId === mission.id) ?? null
  let publishRefused = null
  if (train) {
    try {
      await call('workspace.publishRelease', { trainId: train.id })
      publishRefused = false
    } catch (e) {
      publishRefused = String(e.message ?? e)
    }
  }
  const verification = detail.mission.verification
  const orderCheck = verification?.contracts.find((c) => c.contract === 'order') ?? null
  const provided = (() => {
    try {
      return JSON.parse(results['orders-contract'].contract ?? 'null')
    } catch {
      return null
    }
  })()
  const norm = (text) => {
    try {
      return JSON.stringify(JSON.parse(text))
    } catch {
      return null
    }
  }

  Object.assign(evidence, {
    finishedAt: new Date().toISOString(),
    mission: { state: detail.mission.state, blockedReason: detail.mission.blockedReason, error: detail.mission.error, minutes: Math.round((Date.now() - started) / 60_000) },
    tasks: tasks.map((t) => ({ key: t.key, repository: t.repository, dependsOn: t.dependsOn, contracts: t.contracts, state: t.state, baseCommit: t.baseCommit, resultCommit: t.resultCommit, resultBranch: t.resultBranch, startedAt: t.startedAt, finishedAt: t.finishedAt, summary: t.summary, error: t.error })),
    runs: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { ...r, prompt: r.prompt.slice(0, 6000) }])),
    verification,
    releaseTrain: train ? { state: train.state, publishAuthorized: train.publishAuthorized, steps: train.plan.steps, problems: train.plan.problems } : null,
    publishRefused,
    contractVersions: after.contracts.find((c) => c.key === 'order')?.versions.map((v) => ({ version: v.version, hash: v.hash })),
    memory: after.memory.map((m) => ({ kind: m.kind, title: m.title, content: m.content })),
    decisions: after.decisions.map((d) => ({ at: d.createdAt, kind: d.kind, summary: d.summary })).reverse(),
    approvals,
    results,
    usage: usage ? { status: usage.status, session: usage.session } : null,
  })

  const contractTask = taskOf('orders-contract')
  const apiTask = taskOf('orders-api')
  const cliTask = taskOf('orders-cli')
  const allRuns = Object.values(runs)
  ok = reportGates({
    'the mission completed': detail.mission.state === 'COMPLETED',
    'the plan has one task for each of the three repositories': tasks.length === 3 && Boolean(contractTask && apiTask && cliTask),
    'dependency order in the plan: the consumers depend on the provider (directly or through each other)': Boolean(apiTask?.dependsOn.includes(contractTask?.key ?? '-')) && (Boolean(cliTask?.dependsOn.includes(apiTask?.key ?? '-')) || Boolean(cliTask?.dependsOn.includes(contractTask?.key ?? '-'))),
    'dependency order in time: no consumer started before the provider had finished': [apiTask, cliTask].every((t) => t?.startedAt && contractTask?.finishedAt && Date.parse(t.startedAt) >= Date.parse(contractTask.finishedAt)),
    'every task was its own mission run with real Claude sessions': allRuns.length === 3 && new Set(tasks.map((t) => t.runId)).size === 3 && allRuns.every((r) => r.state === 'completed' && r.agents.length >= 1),
    'independent worktrees: every task worked in worktrees of its own repository, on a NEXUS branch': allRuns.every((r) => r.worktrees.length >= 1) && new Set(allRuns.flatMap((r) => r.worktrees)).size === allRuns.flatMap((r) => r.worktrees).length && tasks.every((t) => (t.resultBranch ?? '').startsWith('nexus/')),
    "messaging: each consumer was given the provider's new contract and what the task before it reported": [apiTask, cliTask].every((t) => (runs[t?.key ?? '']?.prompt ?? '').includes('currency') && (runs[t?.key ?? '']?.prompt ?? '').includes('What the tasks this one depends on reported')),
    'global verification passed': verification?.passed === true && (verification?.checks.length ?? 0) >= 8,
    'the contract change was compared and both consumers are in step with it': orderCheck !== null && orderCheck.result.level !== 'identical' && orderCheck.result.level !== 'unknown' && orderCheck.consumersInSync.length === 2 && orderCheck.consumersInSync.every((c) => c.inSync),
    'a new contract version was recorded for the verified work': (evidence.contractVersions?.length ?? 0) === 2,
    'the contract requires a three-letter currency at the provider result': Boolean(provided?.required?.includes('currency')) && provided?.properties?.currency?.type === 'string',
    "both consumers' copies equal the provider's contract at their results": norm(results['orders-contract'].contract ?? '') !== null && norm(results['orders-api'].contract ?? '') === norm(results['orders-contract'].contract ?? '') && norm(results['orders-cli'].contract ?? '') === norm(results['orders-contract'].contract ?? ''),
    "each repository's own tests pass at its result (independent run), with more tests than before": Object.values(results).every((r) => r.tests?.fail === 0) && results['orders-contract'].tests?.pass >= 4 && results['orders-api'].tests?.pass >= 1 && results['orders-cli'].tests?.pass >= 1,
    'a release train was prepared in dependency order and nothing was published': train !== null && train.state === 'PREPARED' && train.publishAuthorized === false && train.plan.steps.map((s) => s.repository).join(' ') === 'orders-contract orders-api orders-cli' && typeof publishRefused === 'string',
    'the original checkouts are untouched (same commit, on main, clean)': Object.entries(results).every(([key, r]) => r.userCheckout.head === repos[key].baseCommit && r.userCheckout.branch === 'main' && r.userCheckout.status === ''),
  })
  evidence.gatesPassed = ok
} catch (e) {
  evidence.error = String(e?.stack ?? e)
  log('ERROR', evidence.error)
} finally {
  const file = writeEvidence('workspace-mission', evidence)
  log('evidence:', file)
  await app.close().catch(() => undefined)
}
process.exit(ok ? 0 : 1)
