// Real acceptance of NEXUS 0.7.2 on the user's own ChatGPT connection and the real Claude runtime. BOUNDED:
// one STANDARD compilation, one TECHNICAL compilation, one Strategic Director request (level 2) and one Council
// (level 3). Run with `node scripts/v72-live-acceptance.mjs <data directory of the signed-in profile>`.
//
// It sends NOTHING unless the application itself reports that the connection is signed in with plan usage, a
// model is chosen and the user has switched on the paid-credit confirmation. The script never changes that
// switch: only the user does, on the Providers page. Evidence goes to docs/acceptance; no account identity,
// token or address is written to it.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dataDir = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !existsSync(join(dataDir, 'chatgpt-credentials.protected'))) {
  console.error('Give the data directory of the profile that is signed in to ChatGPT.')
  process.exit(2)
}
const only = new Set((process.env.NEXUS_LIVE_STEPS ?? 'standard,technical,strategic,council').split(','))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const startedAt = new Date().toISOString()
const evidence = { kind: 'v72-live-acceptance', startedAt, verdict: 'NOT VERIFIED', steps: {} }

// A small repository to ask about. Built inside the checkout's ignored results folder.
const repo = join(root, 'test-results', 'accept-live-repo')
rmSync(repo, { recursive: true, force: true })
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'uploader', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`)
writeFileSync(join(repo, 'README.md'), '# uploader\n\nUploads telemetry batches. A failed upload is retried five times with a fixed delay of two seconds.\n')
writeFileSync(join(repo, 'src', 'retry.js'), "export async function withRetry(send, sleep) {\n  for (let attempt = 1; attempt <= 5; attempt++) {\n    try {\n      return await send()\n    } catch (error) {\n      if (attempt === 5) throw error\n      await sleep(2000)\n    }\n  }\n}\n")
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
execFileSync('git', ['init', '-q', '-b', 'main', repo])
git('config', 'user.name', 'Acceptance')
git('config', 'user.email', 'acceptance@example.com')
git('add', '-A')
git('commit', '-q', '-m', 'initial')

const REQUEST = 'Replace the fixed two second delay of the upload retry with an exponential backoff with jitter, keep the limit of five attempts, and add a test that does not sleep.'
const TECHNICAL_REQUEST = 'Refactor the retry of the uploader so that the delay policy can be replaced without touching the upload code. Keep five attempts and the current behaviour by default.'
const OBJECTIVE = 'Should the uploader move from a fixed retry delay to exponential backoff with jitter now, or first add the tests it lacks? Give a recommendation and what must be verified.'

const env = { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_WINDOW_OFFSCREEN: '1' }
delete env.NEXUS_FAKE_RUNTIME
delete env.NEXUS_FAKE_POWER
// A runtime left by an earlier window may run an older build: it is asked to stop (its own stop, nothing is
// killed), so that what is accepted here is the build in this checkout.
const runtimePid = () => {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'runtime', 'endpoint.json'), 'utf8')).pid
  } catch {
    return null
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const stopRuntime = async (running) => {
  const pid = runtimePid()
  const page = running.windows()[0] ?? (await running.firstWindow())
  await page.evaluate(() => globalThis.nexus.invoke('runtime.stop', {})).catch(() => undefined)
  for (let i = 0; i < 120 && pid && alive(pid); i++) await new Promise((r) => setTimeout(r, 500))
  await running.close().catch(() => undefined)
  if (pid && alive(pid)) throw new Error('The runtime did not stop')
}
if (runtimePid() && alive(runtimePid())) {
  log('an earlier runtime is running: asking it to stop')
  const earlier = await electron.launch({ args: ['.'], cwd: root, env })
  await (await earlier.firstWindow()).waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 })
  await stopRuntime(earlier)
}
const app = await electron.launch({ args: ['.'], cwd: root, env })
let exit = 1
try {
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 })
  for (const began = Date.now(); ; ) {
    const state = await page.evaluate(() => globalThis.nexus.invoke('desktop.connection', {}))
    if (state.ok && state.value.phase === 'READY') break
    if (Date.now() - began > 120_000) throw new Error('The runtime did not become ready')
    await new Promise((r) => setTimeout(r, 250))
  }
  const call = async (channel, input = {}) => {
    const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
    if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
    return result.value
  }
  const connection = async () => {
    const s = await call('chatgpt.status')
    // No identity: only what kind of connection the application says it is.
    return { state: s.state, model: s.model, includedOnlyConfirmed: s.includedOnlyConfirmed, capacity: s.capacity ? { state: s.capacity.state, nextProbeAt: s.capacity.nextProbeAt ?? null } : null, error: s.error ?? null }
  }

  // The gate. The application's own report, read before anything is sent.
  const before = await connection()
  evidence.connectionBefore = before
  log('connection', JSON.stringify(before))
  if (before.state !== 'SIGNED_IN_PLAN_USAGE' || !before.model || before.includedOnlyConfirmed !== true) {
    evidence.verdict = 'NOT RUN: the application does not report a signed-in connection with a model and the paid-credit confirmation switched on by the user'
    throw new Error(evidence.verdict)
  }

  const project = await call('projects.open', { path: repo })
  // The provider discovery of a fresh runtime takes a few seconds: a request sent before it has finished finds
  // no technical provider and waits (recorded as a finding). The acceptance starts once Claude is listed.
  for (const began = Date.now(); ; ) {
    const claude = (await call('providers.overview')).statuses.find((x) => x.id === 'claude')
    if (claude && claude.auth === 'authenticated') break
    if (Date.now() - began > 60_000) throw new Error(`Claude was not discovered: ${JSON.stringify(claude ?? null).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  const routes = async (operationId) =>
    (await call('director.routing', { projectId: project.id, operationId })).map((r) => ({ stage: r.stage, role: r.role, provider: r.provider, model: r.model, action: r.action, state: r.state, consumption: r.consumption, reasons: r.reasons, failure: r.failure ?? null, usage: r.usage ?? null }))
  const specOf = (spec) => ({
    id: spec.id, intentId: spec.intentId ?? null, requestedMode: spec.requestedMode, mode: spec.mode, status: spec.status, reasons: spec.reasons,
    rawIntentPreserved: spec.rawIntent, recommendations: spec.recommendations, ambiguities: spec.ambiguities,
    dependencies: spec.dependencies.length, waitUntil: spec.waitUntil ?? null,
  })
  const timed = async (fn) => {
    const began = Date.now()
    const value = await fn()
    return { value, ms: Date.now() - began }
  }

  if (only.has('standard')) {
    log('STANDARD compilation…')
    const { value: spec, ms } = await timed(() => call('compilation.preview', { projectId: project.id, raw: REQUEST, mode: 'STANDARD' }))
    evidence.steps.standard = { ms, request: REQUEST, spec: specOf(spec), routing: await routes(spec.intentId ?? spec.id).catch(() => []), intentUnchanged: spec.rawIntent === REQUEST }
    log('STANDARD', spec.status, `${spec.recommendations.length} recommendations`, `${ms} ms`)
  }
  if (only.has('technical')) {
    log('TECHNICAL compilation…')
    const { value: spec, ms } = await timed(() => call('compilation.preview', { projectId: project.id, raw: TECHNICAL_REQUEST, mode: 'TECHNICAL' }))
    evidence.steps.technical = { ms, request: TECHNICAL_REQUEST, spec: specOf(spec), routing: await routes(spec.intentId ?? spec.id).catch(() => []), intentUnchanged: spec.rawIntent === TECHNICAL_REQUEST }
    log('TECHNICAL', spec.status, `${spec.recommendations.length} recommendations`, `${ms} ms`)
  }
  const director = async (level) => {
    const { value: r, ms } = await timed(() => call('director.invoke', { projectId: project.id, objective: OBJECTIVE, level }))
    return {
      ms, level, state: r.state, message: r.message, provider: r.provider, model: r.model, executionAuthorized: r.executionAuthorized,
      memo: r.memo, challenge: r.challenge, synthesis: r.synthesis, unresolvedDisagreements: r.unresolvedDisagreements,
      routing: await routes(r.id), records: (await call('director.records', { projectId: project.id })).filter((x) => x.invocationId === r.id),
    }
  }
  if (only.has('strategic')) {
    log('Strategic Director (level 2)…')
    evidence.steps.strategic = await director(2)
    log('level 2', evidence.steps.strategic.state, `${evidence.steps.strategic.ms} ms`)
  }
  if (only.has('council')) {
    log('Council (level 3)…')
    evidence.steps.council = await director(3)
    log('level 3', evidence.steps.council.state, `${evidence.steps.council.ms} ms`)
  }
  evidence.connectionAfter = await connection()

  // The verdict: every step that ran reached its end state with the request untouched and no authority granted.
  const s = evidence.steps
  const failures = []
  for (const key of ['standard', 'technical']) {
    if (!s[key]) continue
    if (!['READY', 'USER_DECISION_REQUIRED'].includes(s[key].spec.status)) failures.push(`${key}: status ${s[key].spec.status}`)
    if (!s[key].intentUnchanged) failures.push(`${key}: the request was changed`)
  }
  if (s.technical && !s.technical.routing.some((r) => r.provider === 'claude' && r.state === 'COMPLETED')) failures.push('technical: no completed Claude stage on record')
  for (const key of ['strategic', 'council']) {
    if (!s[key]) continue
    if (s[key].state !== 'COMPLETED') failures.push(`${key}: state ${s[key].state}`)
    if (s[key].executionAuthorized !== false) failures.push(`${key}: execution authorized`)
  }
  if (s.council && s.council.state === 'COMPLETED' && !(s.council.memo && s.council.challenge && s.council.synthesis)) failures.push('council: a stage is missing')
  evidence.failures = failures
  evidence.verdict = failures.length === 0 ? 'PASS' : 'FAIL'
  exit = failures.length === 0 ? 0 : 1
} catch (e) {
  evidence.error = e instanceof Error ? e.message.slice(0, 2000) : String(e)
  if (evidence.verdict === 'NOT VERIFIED') evidence.verdict = 'FAIL'
  log('error', evidence.error)
} finally {
  const dir = join(root, 'docs', 'acceptance')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `v72-live-${startedAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
  log('evidence', file, evidence.verdict)
  // The runtime this run used is stopped with it, so nothing keeps running on the user's connection.
  await stopRuntime(app).catch(() => app.close().catch(() => undefined))
}
process.exit(exit)
