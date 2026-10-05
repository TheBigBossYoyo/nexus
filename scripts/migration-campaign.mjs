// Migration campaign: opens real databases left by earlier NEXUS versions with a newer build and proves that
// nothing was lost and everything old is still readable. Uses no Claude session.
//
//   node scripts/migration-campaign.mjs <path-to-NEXUS.exe | -> <label=dir> [<label=dir> ...]
//
// `-` runs the development build. Each directory holds a `nexus.db` written by the labelled version; the script
// works on a COPY. For each one it checks: the build launches on it, the schema is the newest, the older file
// was kept as a backup, no table lost a row, every run is readable with all its tasks and agents, every
// program, workspace (with its missions) and Arena campaign of the old database is listed and opens, and the
// main pages render.
import { _electron as electron } from '@playwright/test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const [exeArg, ...pairs] = process.argv.slice(2)
if (!exeArg || pairs.length === 0) {
  console.error('usage: node scripts/migration-campaign.mjs <NEXUS.exe | -> <label=dir> [<label=dir> ...]')
  process.exit(2)
}
const exe = exeArg === '-' ? null : exeArg
if (exe && !existsSync(exe)) throw new Error(`No executable at ${exe}`)
const root = resolve(import.meta.dirname, '..')
const VERSION = require(join(root, 'package.json')).version
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
// Tables NEXUS itself writes to when it starts on a database; they may gain rows but must not lose any.
const MAY_GROW = new Set(['arena_cases', 'arena_case_versions', 'schema_migrations', 'settings', 'run_events', 'usage_events', 'policy_versions', 'policy_pointers', 'control_incidents', 'provider_sessions', 'global_work_items', 'checkpoints', 'program_decisions', 'workspace_decisions', 'recoveries'])

function inspect(dbPath) {
  const db = new Database(dbPath, { readonly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
    const counts = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]))
    const ids = (table) => (tables.includes(table) ? db.prepare(`SELECT id FROM "${table}"`).all().map((r) => r.id) : [])
    const perRun = (table) => (tables.includes(table) ? Object.fromEntries(db.prepare(`SELECT run_id AS id, COUNT(*) AS n FROM "${table}" GROUP BY run_id`).all().map((r) => [r.id, r.n])) : {})
    return {
      versions: db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version),
      counts,
      runs: ids('runs'),
      tasksPerRun: perRun('tasks'),
      agentsPerRun: perRun('agents'),
      programs: ids('programs'),
      workspaces: ids('workspaces'),
      workspaceMissions: ids('workspace_missions'),
      campaigns: ids('arena_campaigns'),
    }
  } finally {
    db.close()
  }
}

const evidence = { kind: 'migration-campaign', executable: exe ?? 'dev build', version: VERSION, startedAt: new Date().toISOString(), databases: [] }
let ok = true
for (const pair of pairs) {
  const at = pair.indexOf('=')
  const label = pair.slice(0, at)
  const source = pair.slice(at + 1)
  const entry = { label, source, checks: {} }
  evidence.databases.push(entry)
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-mig-data-'))
  for (const name of readdirSync(source)) if (name.startsWith('nexus.db') && !name.includes('.bak')) cpSync(join(source, name), join(dataDir, name))
  const before = inspect(join(dataDir, 'nexus.db'))
  const oldSchema = Math.max(...before.versions)
  entry.before = { schema: oldSchema, rows: Object.values(before.counts).reduce((a, b) => a + b, 0), tables: Object.keys(before.counts).length, runs: before.runs.length, programs: before.programs.length, workspaces: before.workspaces.length, workspaceMissions: before.workspaceMissions.length, campaigns: before.campaigns.length }
  log(label, JSON.stringify(entry.before))

  const env = { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_WINDOW_OFFSCREEN: '1' }
  delete env.NEXUS_FAKE_RUNTIME
  delete env.NEXUS_FAKE_POWER
  const app = await electron.launch(exe ? { executablePath: exe, env } : { args: ['.'], cwd: root, env })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 })
    const call = async (channel, input = {}) => {
      const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
      if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
      return result.value
    }
    const info = await call('app.info')
    entry.app = { version: info.version, isPackaged: info.isPackaged }
    entry.checks[`launches as ${VERSION} on a database of ${label}`] = info.version === VERSION

    // Every run of the old database, with all its tasks and agents.
    let runsReadable = 0
    const runProblems = []
    for (const runId of before.runs) {
      try {
        const detail = await call('runs.get', { runId })
        if (detail.tasks.length === (before.tasksPerRun[runId] ?? 0) && detail.agents.length === (before.agentsPerRun[runId] ?? 0)) runsReadable++
        else runProblems.push(`${runId}: ${detail.tasks.length}/${before.tasksPerRun[runId] ?? 0} tasks, ${detail.agents.length}/${before.agentsPerRun[runId] ?? 0} agents`)
      } catch (e) {
        runProblems.push(`${runId}: ${String(e.message ?? e).slice(0, 120)}`)
      }
    }
    entry.runProblems = runProblems
    entry.checks[`every run is readable with all its tasks and agents (${before.runs.length})`] = runsReadable === before.runs.length

    const programs = (await call('program.list', { limit: 200 })).programs.map((p) => p.program.id)
    let programsOpen = 0
    for (const programId of before.programs) if ((await call('program.get', { programId }).catch(() => null))?.program.id === programId) programsOpen++
    entry.checks[`every program is listed and opens (${before.programs.length})`] = before.programs.every((id) => programs.includes(id)) && programsOpen === before.programs.length

    const workspaces = (await call('workspace.list')).map((w) => w.workspace.id)
    let workspacesOpen = 0
    let missionsOpen = 0
    for (const workspaceId of before.workspaces) {
      const detail = await call('workspace.get', { workspaceId }).catch(() => null)
      if (detail?.workspace.id === workspaceId) workspacesOpen++
    }
    for (const missionId of before.workspaceMissions) if ((await call('workspace.mission', { missionId }).catch(() => null))?.mission.id === missionId) missionsOpen++
    entry.checks[`every workspace and workspace mission is listed and opens (${before.workspaces.length}, ${before.workspaceMissions.length})`] = before.workspaces.every((id) => workspaces.includes(id)) && workspacesOpen === before.workspaces.length && missionsOpen === before.workspaceMissions.length

    const campaigns = before.campaigns.length > 0 ? (await call('arena.campaigns', { limit: 100 })).campaigns.map((c) => c.campaign?.id ?? c.id) : []
    let campaignsOpen = 0
    for (const campaignId of before.campaigns) if ((await call('arena.campaign', { campaignId }).catch(() => null)) !== null) campaignsOpen++
    entry.checks[`every Arena campaign is listed and opens (${before.campaigns.length})`] = before.campaigns.every((id) => campaigns.includes(id)) && campaignsOpen === before.campaigns.length

    const pages = {}
    mkdirSync(join(root, 'test-results', 'screenshots'), { recursive: true })
    for (const view of ['home', 'run', 'programs', 'workspaces', 'arena', 'usage', 'providers', 'control', 'overnight', 'settings']) {
      const nav = await page.$(`[data-testid="nav-${view}"]`)
      if (!nav) continue // A page this build does not have.
      await nav.click()
      pages[view] = await page.waitForSelector(`[data-testid="view-${view}"]`, { timeout: 15_000 }).then(() => true, () => false)
      await page.waitForTimeout(300)
    }
    await page.screenshot({ path: join(root, 'test-results', 'screenshots', `migration-${label.replace(/[^a-z0-9.]/gi, '-')}.png`) }).catch(() => undefined)
    entry.pages = pages
    entry.checks[`the pages render (${Object.keys(pages).join(', ')})`] = Object.keys(pages).length >= 6 && Object.values(pages).every(Boolean)
  } catch (e) {
    entry.error = String(e?.stack ?? e)
    entry.checks['the session ran to its end'] = false
    log('ERROR', entry.error)
  } finally {
    await app.close().catch(() => undefined)
  }

  const after = inspect(join(dataDir, 'nexus.db'))
  const newest = Math.max(...after.versions)
  entry.after = { schema: newest, rows: Object.values(after.counts).reduce((a, b) => a + b, 0), tables: Object.keys(after.counts).length }
  entry.checks[`the schema was upgraded from ${oldSchema} to the newest (${newest}), every version in order`] = JSON.stringify(after.versions) === JSON.stringify(Array.from({ length: newest }, (_, i) => i + 1)) && newest >= oldSchema
  entry.checks['the database as the older version left it was kept as a backup copy'] = oldSchema >= newest || existsSync(join(dataDir, `nexus.db.v${oldSchema}.bak`))
  const lost = Object.entries(before.counts).filter(([table, n]) => !(table in after.counts) || (MAY_GROW.has(table) ? after.counts[table] < n : after.counts[table] !== n))
  entry.rowChanges = lost.map(([table, n]) => `${table}: ${n} -> ${after.counts[table] ?? 'missing'}`)
  entry.checks[`no table lost or changed its number of rows (${Object.keys(before.counts).length} tables)`] = lost.length === 0
  for (const [name, pass] of Object.entries(entry.checks)) {
    log(pass ? 'PASS' : 'FAIL', label, name)
    if (!pass) ok = false
  }
  if (entry.rowChanges.length > 0) log(label, 'row changes:', entry.rowChanges.join('; '))
  if (entry.runProblems?.length) log(label, 'run problems:', entry.runProblems.slice(0, 5).join('; '))
}
evidence.passed = ok
const outDir = join(root, 'docs', 'acceptance')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `migration-campaign-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n')
log('RESULT', ok ? 'PASS' : 'FAIL', '| evidence:', outFile)
process.exit(ok ? 0 : 1)
