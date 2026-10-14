// NEXUS on itself, measured: a real mission on a clone of this repository, through the same path as the composer
// (compilation.preview, the planning recommendation, runs.create), driven to its end with no help, and judged.
//
//   node scripts/self-mission.mjs --task <file.md> [--mode standard|enrolled] [--name <label>] [--timeout-min 90] [--chatgpt]
//   node scripts/self-mission.mjs --chatgpt-signin   (once: the tests' own ChatGPT connection)
//
// Everything it makes is under test-results/self-missions/<label>-<time>/ (the project folder the owner excluded
// from the antivirus): the clone, NEXUS's data folder, report.json and report.md. The owner's NEXUS, its data and
// the owner's branches are not touched. The window is off-screen; confirmations are answered through it.
//
// What is measured, and what counts as a failure of the harness (not of the task):
//   - interventions: a plan, tool or boundary approval anyone had to give, a pause for attention;
//   - false failures: a repair after a check or verification failure (each one's evidence is kept for reading);
//   - the estimate: at each sample, whether the time that really remained fell in the range shown;
//   - time: compile, plan, tasks, final verification, total.
// It uses the real Claude (the owner's subscription) and needs `pnpm build` first.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { waitForRuntime, stopNexus } from './acceptance-common.mjs'

const root = resolve(import.meta.dirname, '..')
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []))
// --chatgpt-signin: opens NEXUS on the screen with the tests' own data folder, for the owner to connect ChatGPT
// once (Settings); it ends when that window is closed. Nothing else is done.
if (args['chatgpt-signin'] === 'true') {
  const home = join(root, 'test-results', 'self-missions', '.chatgpt')
  mkdirSync(home, { recursive: true })
  const signin = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NEXUS_DATA_DIR: home } })
  await new Promise((done) => signin.on('close', done))
  console.log(existsSync(join(home, 'chatgpt-credentials.protected')) ? 'The tests have their ChatGPT connection.' : 'No ChatGPT connection was saved.')
  process.exit(0)
}
if (!args.task) throw new Error('--task <file> is required')
if (args['chatgpt-from'] !== undefined) throw new Error("--chatgpt-from is withdrawn: sharing the owner's sign-in revokes it. Use --chatgpt (sign in once with --chatgpt-signin).")
const mode = args.mode ?? 'standard'
const name = args.name ?? args.task.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '')
const timeoutMs = Number(args['timeout-min'] ?? 90) * 60_000
const prompt = readFileSync(resolve(args.task), 'utf8').trim()
const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
const dir = join(root, 'test-results', 'self-missions', `${name}-${mode}-${stamp}`)
const repo = join(dir, 'repo')
const dataDir = join(dir, 'data')
mkdirSync(dataDir, { recursive: true })
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

// A clone of the committed branch, as the owner's repository would be: its own branches, the same history.
execFileSync('git', ['clone', '-q', '--branch', branch, root, repo])
execFileSync('git', ['-C', repo, 'config', 'user.name', 'NEXUS self-mission'])
execFileSync('git', ['-C', repo, 'config', 'user.email', 'self-mission@nexus.local'])
log(`clone of ${branch} at ${base.slice(0, 8)} in ${repo}`)

// --chatgpt: a ChatGPT connection of the tests' own (the strategic Director, needed by the specification step),
// kept in test-results/self-missions/.chatgpt and signed in once with --chatgpt-signin. Never the owner's: NEXUS
// holds its credential in memory and the provider rotates refresh tokens, so two instances sharing one sign-in end
// with one of them presenting a token already used, and the provider then revokes the sign-in. That is what
// happened to the owner's connection with the earlier --chatgpt-from (2026-10-14); it is refused now.
const chatgptHome = join(root, 'test-results', 'self-missions', '.chatgpt')
const chatgptFiles = ['chatgpt-credentials.protected', join('runtime-profile', 'Local State')]
const chatgptLock = join(chatgptHome, 'in-use')
const useChatgpt = args.chatgpt === 'true'
if (useChatgpt) {
  if (!existsSync(join(chatgptHome, chatgptFiles[0]))) throw new Error('The tests have no ChatGPT connection yet: run with --chatgpt-signin once.')
  // One run at a time: two would share the sign-in, as above.
  writeFileSync(chatgptLock, String(process.pid), { flag: 'wx' })
  mkdirSync(join(dataDir, 'runtime-profile'), { recursive: true })
  for (const f of chatgptFiles) copyFileSync(join(chatgptHome, f), join(dataDir, f))
}
// The test's own connection goes back whatever its state (renewed, or cleared by a refusal: then it says so).
const returnChatgpt = () => {
  if (!useChatgpt) return
  try {
    for (const f of chatgptFiles) if (existsSync(join(dataDir, f))) copyFileSync(join(dataDir, f), join(chatgptHome, f))
  } finally {
    for (const f of chatgptFiles) rmSync(join(dataDir, f), { force: true })
    rmSync(chatgptLock, { force: true })
  }
}

const report = { name, mode, branch, base, prompt, startedAt: new Date().toISOString(), samples: [], interventions: [], repairs: [], phases: {}, result: null }
const env = { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_WINDOW_OFFSCREEN: '1', NEXUS_ACCEPT_CONFIRM: 'window' }
for (const k of ['NEXUS_FAKE_RUNTIME', 'NEXUS_FAKE_POWER', 'NEXUS_FAKE_WORKERS', 'NEXUS_CONTAINMENT']) delete env[k]
const app = await electron.launch({ args: ['.'], cwd: root, env })
const save = () => {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2))
}
try {
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 })
  await waitForRuntime(page)
  const call = async (channel, input = {}) => {
    const r = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
    if (!r.ok) throw new Error(`${channel}: ${r.error.code} ${r.error.message}`)
    return r.value
  }
  // A native dialog of the window's process (an enrollment) is answered here and kept: none reaches the screen.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = []
    dialog.showMessageBox = async (...a) => {
      const o = a.length > 1 ? a[1] : a[0]
      globalThis.__dialogs.push(String(o?.message ?? ''))
      return { response: 0, checkboxChecked: false }
    }
  })
  const auth = await call('auth.status', { refresh: true })
  if (auth.state !== 'authenticated') throw new Error('Claude is not authenticated.')

  const project = await call('projects.open', { path: repo })
  if (mode === 'enrolled') {
    const e = await call('autonomy.enroll', { projectId: project.id, profile: 'AUTONOMOUS_PROJECT' })
    log('enrolled', e.profile)
  }

  // The composer's path: the specification, the planning recommendation, the mission.
  let t = Date.now()
  // --compile exact: no specification step (it needs the strategic Director, the owner's ChatGPT connection, which
  // a test instance does not have). Everything after it is the same.
  const compileMode = (args.compile ?? 'auto').toUpperCase()
  const spec = await call('compilation.preview', { projectId: project.id, raw: prompt, mode: compileMode })
  report.phases.compileSeconds = Math.round((Date.now() - t) / 1000)
  report.compilation = { status: spec.status, mode: spec.mode ?? spec.depth ?? compileMode, reasons: spec.reasons ?? [] }
  log(`compiled in ${report.phases.compileSeconds}s: ${spec.status}`)
  if (spec.status !== 'READY') {
    report.interventions.push({ at: new Date().toISOString(), kind: 'specification', detail: `compilation ${spec.status}: the owner would have had to decide` })
    throw new Error(`The specification is ${spec.status}`)
  }
  const recommendation = await call('planning.recommend', { projectId: project.id, prompt })
  report.planning = recommendation
  const run = await call('runs.create', { projectId: project.id, mode: 'build', preset: 'balanced', prompt, compilationMode: compileMode, compiledTaskSpecId: spec.id, requirePlanApproval: false, planningMode: recommendation.mode })
  log(`mission ${run.id} started (planning ${recommendation.mode})`)
  const started = Date.now()
  let last = ''
  let detail
  const seenPending = new Set()
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      report.result = 'TIMEOUT'
      await call('runs.cancel', { runId: run.id }).catch(() => undefined)
      break
    }
    detail = await call('runs.get', { runId: run.id })
    const progress = await call('progress.get', { runId: run.id }).catch(() => null)
    const state = detail.run.state
    report.samples.push({ at: Date.now(), state, stage: progress?.stage ?? null, percent: progress?.percent ?? null, low: progress?.eta?.lowSeconds ?? null, high: progress?.eta?.highSeconds ?? null, text: progress?.eta?.text ?? null, tasks: detail.tasks.map((x) => `${x.key}:${x.state}`).join(' ') })
    const line = `${state} | ${progress?.stage ?? ''} | eta ${progress?.eta?.text ?? '-'} | ${detail.tasks.map((x) => `${x.key}:${x.state}`).join(' ')}`
    if (line !== last) {
      log(line)
      last = line
    }
    for (const a of detail.pendingApprovals) {
      report.interventions.push({ at: new Date().toISOString(), kind: `approval:${a.kind}`, detail: `${a.action ?? ''} ${a.command ?? ''}`.trim().slice(0, 300) })
      // Answered as an owner would answer the safe ones, so that the run goes on and the rest can be measured.
      const yes = a.kind === 'plan' || a.kind === 'graph' || a.kind === 'task' || a.risk === 'low'
      await call('approvals.resolve', { approvalId: a.id, approve: yes, note: 'self-mission' })
    }
    for (const b of await call('autonomy.pending', { projectId: project.id }).catch(() => [])) {
      if (seenPending.has(b.id)) continue
      seenPending.add(b.id)
      report.interventions.push({ at: new Date().toISOString(), kind: `boundary:${b.capability}`, detail: String(b.action ?? b.summary ?? '').slice(0, 300) })
      log('BOUNDARY', b.capability, String(b.action ?? '').slice(0, 120))
    }
    for (const x of detail.tasks) {
      if ((x.kind === 'repair' || x.parentTaskId !== null || /^mission-fix/.test(x.key)) && !report.repairs.some((r) => r.key === x.key)) {
        report.repairs.push({ key: x.key, title: x.title, at: new Date().toISOString() })
        log('REPAIR', x.key, x.title)
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(state)) {
      report.result = state.toUpperCase()
      break
    }
    if (state === 'paused' && detail.run.pauseReason !== 'quota' && detail.run.pauseReason !== 'capacity') {
      const events = await call('events.list', { runId: run.id, limit: 5000 })
      const paused = events.filter((e) => e.type === 'run.paused').at(-1)?.payload
      report.interventions.push({ at: new Date().toISOString(), kind: 'pause', detail: JSON.stringify(paused).slice(0, 500) })
      report.result = 'PAUSED'
      log('PAUSED', JSON.stringify(paused).slice(0, 300))
      break
    }
    await new Promise((r) => setTimeout(r, 20_000))
  }
  const finishedAt = Date.now()
  report.phases.totalSeconds = Math.round((finishedAt - started) / 1000) + report.phases.compileSeconds
  // Phases from the run's events: planning, tasks, final verification.
  const events = await call('events.list', { runId: run.id, limit: 5000 })
  const firstOf = (type, pred = () => true) => events.find((e) => e.type === type && pred(e))?.createdAt ?? null
  const lastOf = (type, pred = () => true) => [...events].reverse().find((e) => e.type === type && pred(e))?.createdAt ?? null
  const span = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null)
  const workStart = firstOf('run.started') ?? firstOf('plan.approved')
  const finaleStart = firstOf('checks.started', (e) => e.taskId === null)
  report.phases.planningSeconds = span(detail.run.createdAt, workStart)
  report.phases.tasksSeconds = span(workStart, finaleStart ?? lastOf('task.completed'))
  report.phases.finaleSeconds = span(finaleStart, new Date(finishedAt).toISOString())
  // The checks of every task and of the integration: what ran and how long.
  const verifications = await call('verifications.list', { runId: run.id }).catch(() => [])
  report.checks = verifications.filter((v) => v.kind === 'checks').map((v) => ({ task: detail.tasks.find((x) => x.id === v.taskId)?.key ?? 'INTEGRATION', passed: v.passed, summary: v.summary, commands: (v.commands ?? []).map((c) => ({ name: c.name, command: c.command.slice(0, 160), exit: c.exitCode, timedOut: c.timedOut, seconds: Math.round((c.durationMs ?? 0) / 1000) })), failures: (v.failures ?? []).map((f) => ({ criterion: f.criterion, cause: f.likelyCause, evidence: String(f.evidence ?? '').slice(-2500) })) }))
  // The estimate: did the time that really remained fall in the range shown, at each sample with a range.
  const ranged = report.samples.filter((s) => s.low !== null && s.high !== null && s.high > 0)
  const inRange = ranged.filter((s) => {
    const actual = (finishedAt - s.at) / 1000
    return actual >= s.low && actual <= s.high
  })
  report.estimate = { samples: ranged.length, inRange: inRange.length, coverage: ranged.length ? Math.round((inRange.length / ranged.length) * 100) : null }
  report.endedAt = new Date().toISOString()
  report.dialogs = await app.evaluate(() => globalThis.__dialogs ?? [])
  const verdict = report.result === 'COMPLETED' && report.interventions.length === 0 && report.repairs.length === 0
  report.verdict = verdict ? 'PASS' : 'FAIL'
  save()
  const md = [
    `# Self-mission ${name} (${mode}): ${report.verdict}`,
    '',
    `- Result: ${report.result}; started ${report.startedAt}, ended ${report.endedAt}`,
    `- Base: ${branch} at ${base.slice(0, 8)}; compilation ${report.compilation?.status} (${report.compilation?.mode ?? '?'}), planning ${report.planning?.mode}`,
    `- Time: total ${Math.round(report.phases.totalSeconds / 60)} min; compile ${report.phases.compileSeconds}s, planning ${report.phases.planningSeconds}s, tasks ${report.phases.tasksSeconds}s, final verification ${report.phases.finaleSeconds}s`,
    `- Interventions: ${report.interventions.length}${report.interventions.map((i) => `\n  - ${i.kind}: ${i.detail}`).join('')}`,
    `- Repairs: ${report.repairs.length}${report.repairs.map((r) => `\n  - ${r.key}: ${r.title}`).join('')}`,
    `- Estimate within range: ${report.estimate.inRange}/${report.estimate.samples} samples (${report.estimate.coverage ?? '-'}%)`,
    '',
    '## Checks',
    ...report.checks.map((c) => `- ${c.task}: ${c.passed ? 'passed' : 'FAILED'} - ${c.commands.map((x) => `${x.name} ${x.seconds}s${x.timedOut ? ' TIMEOUT' : x.exit !== 0 ? ` exit ${x.exit}` : ''}`).join(', ')}`),
  ].join('\n')
  writeFileSync(join(dir, 'report.md'), md)
  log('\n' + md)
} catch (e) {
  report.error = String(e?.stack ?? e).slice(0, 4000)
  report.verdict = 'FAIL'
  save()
  log('ERROR', e?.message ?? e)
  if (/AUTH_REQUIRES_RECONNECT/.test(String(e?.message ?? e))) log("The tests' ChatGPT connection was refused by the provider: sign it in again with --chatgpt-signin.")
} finally {
  await stopNexus(app, dataDir).catch(() => undefined)
  returnChatgpt()
}
