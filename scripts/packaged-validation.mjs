// Validates a packaged or installed NEXUS build without using Claude:
//
//   node scripts/packaged-validation.mjs <path-to-NEXUS.exe> <dir-with-v0.1-nexus.db> <dir-with-v0.2.0-nexus.db>
//
// For each database directory it works on a COPY: launches the build on it, checks the schema upgrade,
// that the old run is still readable, Claude auth status, opening a project and the Overnight Mode UI.
// No overnight run is started: a packaged build always uses the real Windows power controller.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const [exe, ...sources] = process.argv.slice(2)
if (!exe || !existsSync(exe) || sources.length === 0) {
  console.error('usage: node scripts/packaged-validation.mjs <NEXUS.exe> <db-dir> [<db-dir> ...]')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '..')
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function schemaOf(dbPath) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return {
      versions: db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version),
      runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,
      tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
      agents: db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
      events: db.prepare('SELECT COUNT(*) AS n FROM run_events').get().n,
    }
  } finally {
    db.close()
  }
}

const repo = mkdtempSync(join(tmpdir(), 'nexus-pkg-repo-'))
execFileSync('git', ['init', '-b', 'main', repo])
writeFileSync(join(repo, 'README.md'), '# scratch\n')
execFileSync('git', ['-C', repo, 'add', '-A'])
execFileSync('git', ['-C', repo, '-c', 'user.name=Validation', '-c', 'user.email=validation@example.com', 'commit', '-q', '-m', 'initial'])

const evidence = { executable: exe, startedAt: new Date().toISOString(), databases: [] }
let ok = true
for (const source of sources) {
  const entry = { source, checks: {} }
  evidence.databases.push(entry)
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-pkg-data-'))
  for (const name of readdirSync(source)) if (name.startsWith('nexus.db')) cpSync(join(source, name), join(dataDir, name))
  entry.before = schemaOf(join(dataDir, 'nexus.db'))
  log('database', source, JSON.stringify(entry.before))

  const env = { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_WINDOW_OFFSCREEN: '1' }
  delete env.NEXUS_FAKE_RUNTIME
  delete env.NEXUS_FAKE_POWER
  const app = await electron.launch({ executablePath: exe, env })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 })
    const call = async (channel, input = {}) => {
      const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
      if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
      return result.value
    }
    const info = await call('app.info')
    entry.app = { version: info.version, isPackaged: info.isPackaged, sdkVersion: info.sdkVersion, gitVersion: info.gitVersion, dataDir: info.dataDir }
    entry.checks['launches as packaged 0.2.1'] = info.isPackaged === true && info.version === '0.2.1'

    const runs = await call('runs.list', {})
    const old = runs[0] ? await call('runs.get', { runId: runs[0].id }) : null
    entry.oldRun = old ? { state: old.run.state, tasks: old.tasks.length, agents: old.agents.length } : null
    entry.checks['the old run is readable with all its tasks and agents'] = old !== null && old.tasks.length === entry.before.tasks && old.agents.length === entry.before.agents
    entry.checks['an old run is not an overnight run'] = old !== null && (await call('overnight.get', { runId: old.run.id })) === null
    entry.checks['no overnight run is active'] = (await call('overnight.active')).length === 0

    const auth = await call('auth.status', { refresh: true })
    entry.auth = { state: auth.state, mode: auth.mode, subscriptionType: auth.subscriptionType }
    entry.checks['Claude status is reported'] = typeof auth.state === 'string'

    const project = await call('projects.open', { path: repo })
    entry.checks['a project opens'] = project.profile?.isGitRepo === true

    // The Overnight Mode UI in the packaged renderer.
    await page.click('[data-testid="nav-projects"]')
    await page.click(`text=${project.name}`).catch(() => undefined)
    await page.waitForSelector('[data-testid="mission-composer"]', { timeout: 20_000 })
    await page.selectOption('[data-testid="mode-select"]', 'overnight')
    await page.waitForSelector('[data-testid="overnight-panel"]', { timeout: 10_000 })
    const startDisabled = await page.isDisabled('[data-testid="overnight-start"]')
    const authorized = await page.isChecked('[data-testid="overnight-authorize"]')
    const force = await page.isChecked('[data-testid="overnight-force-close"]')
    entry.checks['Overnight panel renders; start is disabled until authorized; force close is off'] = startDisabled && !authorized && !force
    mkdirSync(join(root, 'test-results', 'screenshots'), { recursive: true })
    await page.screenshot({ path: join(root, 'test-results', 'screenshots', `packaged-overnight-${evidence.databases.length}.png`) }).catch(() => undefined)
    // A packaged build must refuse the test-only switches.
    entry.checks['no fake power log is written by a packaged build'] = !existsSync(join(dataDir, 'fake-power.log'))
  } catch (e) {
    entry.error = String(e?.stack ?? e)
    log('ERROR', entry.error)
  } finally {
    await app.close().catch(() => undefined)
  }
  entry.after = schemaOf(join(dataDir, 'nexus.db'))
  entry.checks['schema upgraded to version 3'] = JSON.stringify(entry.after.versions) === '[1,2,3]'
  entry.checks['no row was lost in the upgrade'] = entry.after.runs === entry.before.runs && entry.after.tasks === entry.before.tasks && entry.after.agents === entry.before.agents && entry.after.events >= entry.before.events
  for (const [name, pass] of Object.entries(entry.checks)) {
    log(pass ? 'PASS' : 'FAIL', name)
    if (!pass) ok = false
  }
  if (entry.error) ok = false
}
evidence.verdict = ok ? 'PASS' : 'FAIL'
const outDir = join(root, 'docs', 'acceptance')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `packaged-validation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n')
log('RESULT', evidence.verdict, '| evidence:', outFile)
process.exit(ok ? 0 : 1)
