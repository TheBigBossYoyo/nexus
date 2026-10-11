import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { waitForRuntime, stopNexus, createFixtureRepo } from './acceptance-common.mjs'

// node scripts/v72-packaged-check.mjs <expected-full-commit>
// Uses an isolated profile and no inference, engineering workload, or power action.
const root = resolve(import.meta.dirname, '..')
const output = join(root, 'test-results/v72-package')
mkdirSync(output, { recursive: true })
mkdirSync(join(root, '.nexus-data'), { recursive: true })
const dataDir = mkdtempSync(join(root, '.nexus-data/v72-packaged-'))
const exe = join(root, process.env.NEXUS_PACKAGED_DIR ?? 'release/v72-development', 'win-unpacked/NEXUS.exe')
const expectedCommit = process.argv[2]
if (!expectedCommit) throw new Error('Supply the committed candidate identity')
const Database = createRequire(import.meta.url)('better-sqlite3')
const evidence = {
  executable: exe,
  startedAt: new Date().toISOString(),
  checks: {},
  pages: [],
  errors: [],
}
const env = { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_WINDOW_OFFSCREEN: '1' }
delete env.NEXUS_FAKE_RUNTIME
delete env.NEXUS_FAKE_POWER
const app = await electron.launch({ executablePath: exe, env })
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => evidence.errors.push(error.message))
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 })
  await waitForRuntime(page)
  const call = async (channel, input = {}) => {
    const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
    if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
    return result.value
  }
  const info = await call('app.info')
  evidence.app = {
    version: info.version,
    isPackaged: info.isPackaged,
    build: info.build,
    platform: info.platform,
  }
  evidence.checks.identity =
    info.isPackaged &&
    info.version === '0.7.2' &&
    info.build?.commit === expectedCommit &&
    info.build?.dirty === false &&
    info.build?.databaseSchema === 16 &&
    info.build?.runtimeProtocol === 1
  const status = await call('runtime.status')
  evidence.checks.runtime = status.phase === 'READY' && status.endpointAcl === 'restricted'
  const worker = await call('runtime.workerSelfTest')
  evidence.worker = { ok: worker.ok, capabilities: worker.capabilities }
  evidence.checks.worker = worker.ok && worker.capabilities.includes('claude')
  const fixture = createFixtureRepo('nexus-v72-packaged', {
    'README.md': '# Package walkthrough\n',
  })
  const project = await call('projects.open', { path: fixture.repo })
  evidence.checks.project = project.profile?.isGitRepo === true
  // Direct IPC does not run the renderer mutation's query invalidation.
  await page.reload()
  await page.getByTestId('app-shell').waitFor({ state: 'visible' })
  await waitForRuntime(page)
  const views = [
    'home',
    'projects',
    'run',
    'programs',
    'workspaces',
    'agents',
    'arena',
    'policy',
    'usage',
    'providers',
    'director',
    'performance',
    'intelligence',
    'knowledge',
    'control',
    'overnight',
    'activity',
    'memory',
    'settings',
  ]
  await page.setViewportSize({ width: 1440, height: 1000 })
  for (const view of views) {
    await page.getByTestId(`nav-${view}`).click()
    await page.getByTestId(`view-${view}`).waitFor({ state: 'visible', timeout: 30_000 })
    if (view === 'projects') await page.getByTestId(`project-${project.id}`).click()
    if (view === 'providers')
      await page.getByTestId('providers-list').waitFor({ state: 'visible', timeout: 60_000 })
    await page.waitForTimeout(350)
    await page.screenshot({ path: join(output, `${view}.png`) })
    evidence.pages.push({ view, rendered: true })
  }
  evidence.checks.allPages = evidence.pages.length === views.length
  for (const view of ['director', 'providers', 'usage', 'projects']) {
    await page.getByTestId(`nav-${view}`).click()
    await page.setViewportSize({ width: 950, height: 700 })
    await page.screenshot({ path: join(output, `${view}-narrow.png`) })
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  const settings = await call('settings.get')
  await call('settings.update', {
    settings: { ...settings, appearance: { ...settings.appearance, theme: 'dark' } },
  })
  await page.reload()
  await page.getByTestId('app-shell').waitFor({ state: 'visible' })
  await waitForRuntime(page)
  for (const view of ['director', 'providers', 'usage', 'projects']) {
    await page.getByTestId(`nav-${view}`).click()
    await page.getByTestId(`view-${view}`).waitFor({ state: 'visible' })
    await page.waitForTimeout(350)
    await page.screenshot({ path: join(output, `${view}-dark.png`) })
    await page.setViewportSize({ width: 950, height: 700 })
    await page.screenshot({ path: join(output, `${view}-dark-narrow.png`) })
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  evidence.checks.noMissions = (await call('runs.list')).length === 0
  evidence.checks.noOvernight = (await call('overnight.active')).length === 0
  evidence.checks.signedOut = (await call('chatgpt.status')).state === 'SIGNED_OUT'
  evidence.checks.noRendererErrors = evidence.errors.length === 0
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  evidence.failure = error.message
  console.error(error)
  process.exitCode = 1
} finally {
  await stopNexus(app, dataDir)
  evidence.checks.endpointRemoved = !existsSync(join(dataDir, 'runtime', 'endpoint.json'))
  const db = new Database(join(dataDir, 'nexus.db'), { readonly: true })
  try {
    evidence.migrations = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version)
    evidence.checks.schema = evidence.migrations.length === 16 && evidence.migrations.at(-1) === 16
  } finally {
    db.close()
  }
  evidence.finishedAt = new Date().toISOString()
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  if (!Object.values(evidence.checks).every(Boolean)) process.exitCode = 1
}
