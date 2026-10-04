// 0.2.1 release gate: a REAL Claude worker discovers a prerequisite that planning could not see and
// adds it to the graph through propose_graph_change. Uses the real Claude Agent SDK and consumes usage.
//
//   node scripts/dynamic-proposal-acceptance.mjs [path-to-NEXUS.exe]
//
// The fixture: the mission asks for a CSV export that must conform to an "export contract". The
// contract is not in the repository in readable form: `npm run generate-schema` unpacks it from an
// opaque vendor bundle into generated/export-contract.json (gitignored). Planners are read-only and
// may not run that command, so plan v1 cannot contain what the contract demands: a normalization
// adapter delivered as its own task before the export is finished. The mission text never mentions it.
import { Buffer } from 'node:buffer'
import { gzipSync } from 'node:zlib'
import {
  collectSessions,
  createFixtureRepo,
  driveRun,
  independentTestRun,
  launchNexus,
  log,
  reportGates,
  requireAuth,
  writeEvidence,
} from './acceptance-common.mjs'

const exe = process.argv[2]

const CONTRACT = {
  contract: 'analytics-export',
  version: 3,
  format: {
    columns: ['id', 'customer', 'amount_minor', 'currency', 'day'],
    header: true,
    lineEnding: '\n',
    quoting: 'RFC 4180: quote a field that contains a comma, a double quote or a line break; double embedded quotes',
    order: 'rows sorted by day ascending, then id ascending',
    empty: 'exportCsv([]) returns only the header line followed by a line ending',
  },
  prerequisites: [
    {
      module: 'src/normalize.js',
      export: 'normalizeRecord(record)',
      status: 'MISSING: this module is not in the repository and is not part of the export task',
      rules: [
        'customer: Unicode NFC, trimmed, internal whitespace runs collapsed to one space',
        'amount (number or decimal string, major units) becomes amount_minor: an integer number of minor units, rounded half away from zero; a non-finite or non-numeric amount throws TypeError',
        'currency: upper-cased; anything that is not three ASCII letters throws TypeError',
        'day: the UTC calendar date (YYYY-MM-DD) of the record timestamp (ISO 8601 string); an invalid timestamp throws TypeError',
      ],
      delivery:
        'Binding, see docs/CONVENTIONS.md: the normalization adapter is a separate module and therefore a separate task with its own test file test/normalize.test.js. It must be merged before src/export.js is completed. src/export.js imports normalizeRecord from ./normalize.js and must not re-implement these rules.',
    },
  ],
}

// The bundle is gzip + a rolling XOR, so it cannot be read with Read/Grep or a one-line decompressor.
const KEY = Buffer.from('nexus-vendor-bundle-v3')
const packed = Buffer.from(gzipSync(Buffer.from(JSON.stringify(CONTRACT, null, 2)))).map((byte, i) => byte ^ KEY[i % KEY.length] ^ (i & 0xff))

const GENERATOR = `// Unpacks the vendor contract bundle into generated/export-contract.json.
import { gunzipSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const KEY = Buffer.from('nexus-vendor-bundle-v3')
const packed = readFileSync(new URL('../vendor/export-contract.bundle', import.meta.url))
const plain = gunzipSync(Buffer.from(packed.map((byte, i) => byte ^ KEY[i % KEY.length] ^ (i & 0xff))))
mkdirSync(new URL('../generated/', import.meta.url), { recursive: true })
writeFileSync(new URL('../generated/export-contract.json', import.meta.url), plain)
console.log('generated/export-contract.json written (' + plain.length + ' bytes)')
`

const { repo, git, baseCommit } = createFixtureRepo('nexus-dyn', {
  'package.json': JSON.stringify({ name: 'analytics-kit', version: '1.0.0', type: 'module', scripts: { test: 'node --test', 'generate-schema': 'node scripts/generate-contract.mjs' } }, null, 2) + '\n',
  '.gitignore': 'generated/\nnode_modules/\n',
  'scripts/generate-contract.mjs': GENERATOR,
  'vendor/export-contract.bundle': packed,
  'vendor/README.md': '# vendor\n\n`export-contract.bundle` is the packed export contract delivered by the analytics team. It is binary; unpack it with `npm run generate-schema`. Never edit it.\n',
  'src/records.js': "// Sample analytics records as they arrive from the collector.\nexport const SAMPLE = [\n  { id: 'r2', customer: '  Ada   Lovelace ', amount: '12.5', currency: 'eur', timestamp: '2026-03-02T23:30:00+02:00' },\n  { id: 'r1', customer: 'Zoe\\u0301 Dupont', amount: 3, currency: 'USD', timestamp: '2026-03-01T08:00:00Z' },\n]\n",
  'test/records.test.js': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { SAMPLE } from '../src/records.js'\n\ntest('sample records exist', () => assert.equal(SAMPLE.length, 2))\n",
  'docs/CONVENTIONS.md': [
    '# Conventions',
    '',
    '- Plain ESM JavaScript, no dependencies, tests with node:test under `test/`.',
    '- `generated/` is produced by `npm run generate-schema` and is never committed.',
    '- The export contract in `generated/export-contract.json` is binding for anything that exports data. Read it before writing export code.',
    '- One module per task. A task creates only the modules named in its own description. When a task turns out to need a module that no task of the plan delivers, that module is added to the plan as its own task (with its own tests) and the task that needs it waits for it; it is never written inside another task.',
    '- Errors thrown for bad input are TypeError.',
    '',
  ].join('\n'),
  'README.md': '# analytics-kit\n\nSmall analytics utilities. Tests: `npm test`. Contract: `npm run generate-schema`.\n',
})

const MISSION = [
  'Implement CSV analytics export.',
  'Plan this as a single implementation task for the export (with its tests). Generating and reading the contract is the first step of that task, not a task of its own.',
  'Add src/export.js exporting `exportCsv(records)`, which returns CSV text for analytics records like the ones in src/records.js, with node:test tests in test/export.test.js.',
  'The output must conform to the project export contract. The contract is generated: run `npm run generate-schema` and follow generated/export-contract.json exactly.',
  'Follow docs/CONVENTIONS.md. `npm test` must pass.',
].join('\n')

const evidence = { kind: 'dynamic-graph-proposal', startedAt: new Date().toISOString(), executable: exe ?? 'dev build', mission: MISSION, hiddenPrerequisite: 'src/normalize.js (only named inside the packed contract)' }
const { app, call } = await launchNexus('nexus-dyn', exe)
let ok = false
try {
  await requireAuth(call, evidence)
  const project = await call('projects.open', { path: repo })
  log('project', project.name, JSON.stringify(project.profile.commands))
  // Single planning on purpose: one read-only planner, then plan approval so plan v1 is recorded before any worker runs.
  const run = await call('runs.create', { projectId: project.id, mode: 'build', preset: 'balanced', prompt: MISSION, maxParallelAgents: 2, requirePlanApproval: true, planningMode: 'single', reviewMode: 'standard' })
  log('run created', run.id)

  const { detail, approvals } = await driveRun(call, run.id, {
    timeoutMs: 50 * 60_000,
    onPlan: (plan) => {
      evidence.planV1 = plan
      log('plan v1:', JSON.stringify(plan.tasks.map((t) => ({ id: t.id, role: t.role, deps: t.dependencies, files: t.suggestedFiles }))))
    },
  })

  const sessions = await collectSessions(call, detail)
  const proposals = await call('graph.proposals', { runId: run.id })
  const revisions = await call('graph.revisions', { runId: run.id })
  const events = await call('events.list', { runId: run.id, limit: 5000 })
  const verifications = await call('verifications.list', { runId: run.id })
  const reviews = await call('reviews.list', { runId: run.id })
  const taskKey = (id) => detail.tasks.find((t) => t.id === id)?.key ?? null

  // The planner's tool use: did it get at the contract?
  const planner = detail.agents.filter((a) => a.role === 'planner')
  const plannerTools = []
  for (const agent of planner) for (const t of await call('agents.tools', { agentId: agent.id })) plannerTools.push({ tool: t.toolName, status: t.status, input: JSON.stringify(t.input).slice(0, 200) })

  const planText = JSON.stringify(evidence.planV1 ?? {}).toLowerCase()
  const applied = proposals.filter((p) => p.type === 'ADD_TASK' && p.status === 'applied')
  const proposal = applied[0] ?? null
  const proposer = proposal ? detail.agents.find((a) => a.id === proposal.proposedByAgentId) : null
  const proposerSessions = proposer ? sessions.filter((s) => s.agentId === proposer.id) : []
  const proposerTask = proposal ? detail.tasks.find((t) => t.id === proposal.taskId) : null
  const revision = proposal ? revisions.find((r) => r.proposalId === proposal.id) : null
  const v1Keys = new Set((revisions.find((r) => r.version === 1)?.snapshot.tasks ?? []).map((t) => t.key))
  const addedKeys = proposal ? proposal.changes.tasks.map((t) => t.key) : []
  const addedTasks = detail.tasks.filter((t) => addedKeys.includes(t.key))
  const dependencyCreated = proposerTask ? addedTasks.some((added) => detail.dependencies.some((d) => d.taskId === proposerTask.id && d.dependsOnTaskId === added.id)) : false
  const proposerTaskSessions = proposerTask ? sessions.filter((s) => s.task === proposerTask.key && ['implement', 'diagnose'].includes(s.purpose)) : []
  const addedFinishedAt = addedTasks.map((t) => t.finishedAt).filter(Boolean).sort().at(-1) ?? null
  const resumedAfter = addedFinishedAt ? proposerTaskSessions.filter((s) => s.startedAt > addedFinishedAt) : []
  const missionVerification = verifications.filter((v) => v.taskId === null && v.kind === 'verifier').at(-1) ?? null
  const tests = independentTestRun(detail)

  Object.assign(evidence, {
    finishedAt: new Date().toISOString(),
    runId: run.id,
    runState: detail.run.state,
    runError: detail.run.error,
    baseCommit,
    integrationBranch: detail.run.integrationBranch,
    plannerTools,
    planV1TaskKeys: [...v1Keys],
    planV1MentionsNormalization: /normaliz/.test(planText),
    tasks: detail.tasks.map((t) => ({ key: t.key, role: t.role, kind: t.kind, state: t.state, attempt: t.attempt, repairCycles: t.repairCycles, startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error })),
    dependencies: detail.dependencies.map((d) => ({ task: taskKey(d.taskId), dependsOn: taskKey(d.dependsOnTaskId) })),
    proposals: proposals.map((p) => ({ id: p.id, type: p.type, status: p.status, proposedBy: p.proposedBy, proposedByAgentId: p.proposedByAgentId, task: taskKey(p.taskId), reason: p.reason, evidence: p.evidence, changes: p.changes, rejectionReason: p.rejectionReason, revisionId: p.revisionId, createdAt: p.createdAt, resolvedAt: p.resolvedAt })),
    revisions: revisions.map((r) => ({ id: r.id, version: r.version, reason: r.reason, proposalId: r.proposalId, tasks: r.snapshot.tasks.map((t) => t.key), createdAt: r.createdAt })),
    proposer: proposer ? { agentId: proposer.id, label: proposer.label, role: proposer.role, model: proposer.model, sdkSessions: proposerSessions.map((s) => ({ sdkSessionId: s.sdkSessionId, state: s.state, endReason: s.endReason })) } : null,
    proposerTask: proposerTask ? { key: proposerTask.key, state: proposerTask.state, sessions: proposerTaskSessions.map((s) => ({ agent: s.agent, sdkSessionId: s.sdkSessionId, startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason })) } : null,
    addedTasks: addedTasks.map((t) => ({ key: t.key, state: t.state, startedAt: t.startedAt, finishedAt: t.finishedAt })),
    graphEvents: events.filter((e) => e.type.startsWith('graph.')).map((e) => ({ type: e.type, at: e.createdAt, payload: e.payload })),
    yieldEvents: events.filter((e) => e.type === 'task.state_changed' && String(e.payload.reason ?? '').includes('yield')).map((e) => ({ task: taskKey(e.taskId), at: e.createdAt, payload: e.payload })),
    reviews: reviews.map((r) => ({ task: taskKey(r.taskId), verdict: r.verdict, findings: r.findings.length })),
    verifications: verifications.map((v) => ({ task: taskKey(v.taskId) ?? '(mission)', kind: v.kind, passed: v.passed, summary: v.summary.slice(0, 300) })),
    sessions: sessions.map(({ handoff, ...s }) => ({ ...s, hasHandoff: handoff !== null })),
    approvals,
    independentTestRun: tests,
    git: { userHeadUnchanged: git('rev-parse', 'HEAD') === baseCommit, userStatus: git('status', '--porcelain'), integrationFiles: detail.run.integrationBranch ? git('ls-tree', '-r', '--name-only', detail.run.integrationBranch).split('\n') : [] },
  })

  const gates = {
    'plan v1 does not contain the hidden prerequisite': !evidence.planV1MentionsNormalization && ![...v1Keys].some((k) => /normaliz/.test(k)),
    'an ADD_TASK proposal exists and was applied': proposal !== null,
    'the proposal was made by a real SDK session': proposerSessions.some((s) => typeof s.sdkSessionId === 'string' && s.sdkSessionId.length > 8) && proposer?.model != null,
    'a graph revision was created from the proposal': revision != null && revision.version >= 2,
    'the proposed task was added to the graph (absent from plan v1)': addedTasks.length > 0 && addedTasks.every((t) => !v1Keys.has(t.key)),
    'a dependency from the proposer to the new task was created': dependencyCreated,
    'the new prerequisite task executed and completed': addedTasks.length > 0 && addedTasks.every((t) => t.state === 'completed' && t.startedAt),
    'the original task resumed after the prerequisite and completed': proposerTask?.state === 'completed' && resumedAfter.length > 0,
    'the run completed': detail.run.state === 'completed',
    'mission verification passed': missionVerification?.passed === true,
    'independent test run passes': tests.fail === 0 && tests.pass > 0,
    'the user checkout is untouched': evidence.git.userHeadUnchanged && evidence.git.userStatus === '',
  }
  evidence.gates = gates
  ok = reportGates(gates)
} catch (e) {
  evidence.scriptError = String(e?.stack ?? e)
  log('ERROR', evidence.scriptError)
} finally {
  await app.close().catch(() => undefined)
}
evidence.verdict = ok ? 'PASS' : 'FAIL'
const outFile = writeEvidence('dynamic-proposal', evidence)
log('RESULT', evidence.verdict, '| run', evidence.runState, '| evidence:', outFile)
log('repo:', repo)
process.exit(ok ? 0 : 1)
