// 0.8: the packaged application, started for real. No inference, no mission, no enrollment, no elevation: a
// safe profile of its own under test-results/, the window off-screen. It establishes that what the package
// carries is found and works from where a package puts it: the runtime, the launcher (both containment
// profiles are verified by running them), the sandbox setup scripts, the browser driver, every page, and a
// clean stop.
//
//   node scripts/v08-packaged-check.mjs <unpacked-dir> <expected-version> <expected-full-commit>
import { _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { stopNexus, waitForRuntime } from './acceptance-common.mjs'

const root = resolve(import.meta.dirname, '..')
const [unpacked, expectedVersion, expectedCommit] = process.argv.slice(2)
if (!unpacked || !expectedVersion || !expectedCommit) throw new Error('usage: v08-packaged-check.mjs <unpacked-dir> <version> <commit>')
const exe = join(resolve(unpacked), 'NEXUS.exe')
const output = join(root, 'test-results', 'v08-package')
const dataDir = join(output, 'data')
rmSync(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
mkdirSync(output, { recursive: true })
const Database = createRequire(import.meta.url)('better-sqlite3')
const evidence = { kind: 'v0.8-packaged-check', executable: exe, startedAt: new Date().toISOString(), checks: {}, pages: [], errors: [] }
const env = { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_WINDOW_OFFSCREEN: '1' }
for (const name of ['NEXUS_FAKE_RUNTIME', 'NEXUS_FAKE_POWER', 'NEXUS_FAKE_WORKERS', 'NEXUS_CONTAINMENT', 'NEXUS_ACCEPT_CONFIRM']) delete env[name]

const app = await electron.launch({ executablePath: exe, env })
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => evidence.errors.push(error.message))
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 90_000 })
  await waitForRuntime(page)
  const call = async (channel, input = {}) => {
    const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
    if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
    return result.value
  }
  const info = await call('app.info')
  evidence.app = { version: info.version, isPackaged: info.isPackaged, build: info.build }
  evidence.checks['it is the package of this commit and version'] = info.isPackaged === true && info.version === expectedVersion && info.build?.commit === expectedCommit && info.build?.dirty === false
  const status = await call('runtime.status')
  evidence.checks['the runtime is ready and its endpoint is restricted'] = status.phase === 'READY' && status.endpointAcl === 'restricted'
  const worker = await call('runtime.workerSelfTest')
  evidence.worker = { ok: worker.ok, capabilities: worker.capabilities }
  evidence.checks['a worker process starts and answers'] = worker.ok === true

  // The launcher and the setup scripts, from where the package has them.
  const isolation = await call('isolation.status')
  evidence.isolation = { requested: isolation.requested, effective: isolation.effective, usable: isolation.usable, detail: isolation.detail, isolated: isolation.isolated, restricted: isolation.restricted, sandboxAccount: isolation.sandboxAccount, setupAvailable: isolation.setupAvailable }
  evidence.checks['the packaged launcher runs: RESTRICTED was verified by running it'] = isolation.restricted?.available === true
  evidence.checks['the sandbox setup is offered from the package (its scripts and launcher are there)'] = isolation.setupAvailable === true
  // Where the machine has the sandbox account, the packaged launcher must make ISOLATED work too.
  if (isolation.sandboxAccount) evidence.checks['ISOLATED was verified by running it as the sandbox account'] = isolation.isolated?.available === true
  evidence.checks['a containment is in effect and verified'] = isolation.usable === true && isolation.effective !== 'STANDARD'

  // A repository of this run, in this checkout.
  const repo = join(output, 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# Package walkthrough\n')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  for (const args of [['config', 'user.name', 'Acceptance'], ['config', 'user.email', 'acceptance@example.com'], ['add', '-A'], ['commit', '-q', '-m', 'initial']]) execFileSync('git', ['-C', repo, ...args])
  const project = await call('projects.open', { path: repo })
  evidence.checks['a project opens'] = project.profile?.isGitRepo === true
  const overview = await call('autonomy.overview', { projectId: project.id, considering: 'AUTONOMOUS_PROJECT' })
  evidence.checks['the autonomy overview of a profile is served, with what holds unattended'] = overview.enrollment === null && Array.isArray(overview.unattended?.proceeds) && overview.unattended.proceeds.length > 0
  evidence.checks['nothing waits and nothing was read or launched'] = (await call('autonomy.pending', {})).length === 0 && (await call('research.list', { projectId: project.id })).artifacts.length === 0 && (await call('isolation.apps', {})).length === 0

  await page.reload()
  await page.getByTestId('app-shell').waitFor({ state: 'visible' })
  await waitForRuntime(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const views = ['home', 'projects', 'run', 'programs', 'workspaces', 'agents', 'arena', 'policy', 'usage', 'providers', 'director', 'performance', 'intelligence', 'knowledge', 'control', 'overnight', 'activity', 'memory', 'settings']
  for (const view of views) {
    await page.getByTestId(`nav-${view}`).click()
    await page.getByTestId(`view-${view}`).waitFor({ state: 'visible', timeout: 30_000 })
    if (view === 'projects') await page.getByTestId(`project-${project.id}`).click()
    await page.waitForTimeout(300)
    evidence.pages.push(view)
  }
  evidence.checks['every page renders'] = evidence.pages.length === views.length
  // The 0.8 screens.
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-autonomy').click()
  await page.getByTestId('autonomy-settings').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('isolation-panel').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('isolation-effective').waitFor({ state: 'visible', timeout: 30_000 })
  await page.screenshot({ path: join(output, 'autonomy-settings.png'), fullPage: true })
  evidence.checks['Settings > Autonomy and the isolation panel render'] = true
  evidence.checks['no mission was started'] = (await call('runs.list')).length === 0
  evidence.checks['the window reported no script error'] = evidence.errors.length === 0
} catch (error) {
  evidence.failure = String(error?.stack ?? error).slice(0, 2000)
  console.error(error)
} finally {
  await stopNexus(app, dataDir).catch((e) => evidence.errors.push(`stop: ${String(e)}`))
  evidence.checks['stopped cleanly: the endpoint file is gone'] = !existsSync(join(dataDir, 'runtime', 'endpoint.json'))
  try {
    const db = new Database(join(dataDir, 'nexus.db'), { readonly: true })
    evidence.migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version)
    db.close()
    evidence.checks['the database is at the schema of this version (20 migrations)'] = evidence.migrations.length === 20 && evidence.migrations.at(-1) === 20
  } catch (e) {
    evidence.checks['the database is at the schema of this version (20 migrations)'] = false
    evidence.errors.push(`database: ${String(e)}`)
  }
  evidence.finishedAt = new Date().toISOString()
  evidence.verdict = evidence.failure === undefined && Object.values(evidence.checks).every(Boolean) ? 'PASS' : 'FAIL'
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  for (const [name, ok] of Object.entries(evidence.checks)) console.log(ok ? 'PASS' : 'FAIL', name)
  console.log(evidence.verdict, join(output, 'evidence.json'))
  if (evidence.verdict !== 'PASS') process.exitCode = 1
}
