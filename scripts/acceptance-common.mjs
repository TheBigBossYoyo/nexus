// Shared plumbing of the real-runtime acceptance scripts (dynamic graph proposal, session rotation).
// They drive the real app through its preload bridge with the REAL Claude Agent SDK and consume usage.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

/** A disposable Git repository with the given files committed on `main`. */
export function createFixtureRepo(prefix, files) {
  const repo = mkdtempSync(join(tmpdir(), `${prefix}-repo-`))
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-b', 'main', repo])
  git('config', 'user.name', 'Acceptance')
  git('config', 'user.email', 'acceptance@example.com')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  return { repo, git, baseCommit: git('rev-parse', 'HEAD') }
}

/** Launch NEXUS (the given executable, or the dev build) on a fresh data directory with the real runtime. */
export async function launchNexus(prefix, exe) {
  const dataDir = mkdtempSync(join(tmpdir(), `${prefix}-data-`))
  // Off-screen unless asked otherwise: an acceptance run takes many minutes and must not sit in front of the user.
  const env = { ...process.env, NEXUS_DATA_DIR: dataDir, ...(process.env.NEXUS_ACCEPT_SHOW === '1' ? {} : { NEXUS_WINDOW_OFFSCREEN: '1' }) }
  delete env.NEXUS_FAKE_RUNTIME
  delete env.NEXUS_FAKE_POWER
  const app = await electron.launch(exe ? { executablePath: exe, env } : { args: ['.'], cwd: root, env })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="open-project"]', { timeout: 30_000 })
  const call = async (channel, input = {}) => {
    const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
    if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
    return result.value
  }
  return { app, page, call, dataDir }
}

export async function requireAuth(call, evidence) {
  const info = await call('app.info')
  evidence.app = { version: info.version, isPackaged: info.isPackaged, sdkVersion: info.sdkVersion, gitVersion: info.gitVersion, platform: info.platform }
  const auth = await call('auth.status', { refresh: true })
  evidence.auth = { state: auth.state, mode: auth.mode, subscriptionType: auth.subscriptionType, apiKeyEnvDetected: auth.apiKeyEnvDetected }
  log('auth', JSON.stringify(evidence.auth))
  if (auth.state !== 'authenticated') throw new Error('Claude is not authenticated; run `claude auth login`.')
}

/**
 * Poll the run until it ends. Plan approvals are granted once (`onPlan` sees the plan first); graph
 * approvals are granted and logged; low-risk tool approvals are granted, everything else denied.
 */
export async function driveRun(call, runId, { timeoutMs, onPlan, onTick } = {}) {
  const started = Date.now()
  let lastLine = ''
  let approved = false
  const approvals = []
  let detail
  for (;;) {
    if (Date.now() - started > (timeoutMs ?? 45 * 60_000)) {
      log('timeout: cancelling run')
      await call('runs.cancel', { runId })
      break
    }
    detail = await call('runs.get', { runId })
    const run = detail.run
    const active = detail.agents.filter((a) => ['starting', 'working', 'waiting'].includes(a.state)).map((a) => a.label)
    const line = `${run.state} | ${detail.tasks.map((t) => `${t.key}:${t.state}`).join(' ')} | active: ${active.join(', ')}`
    if (line !== lastLine) {
      log(line)
      lastLine = line
    }
    if (run.state === 'awaiting_approval' && !approved) {
      await onPlan?.(run.plan, detail)
      await call('runs.approvePlan', { runId })
      approved = true
    }
    for (const approval of detail.pendingApprovals.filter((a) => a.kind !== 'plan')) {
      const approve = approval.kind === 'graph' || approval.kind === 'task' || approval.risk === 'low'
      approvals.push({ kind: approval.kind, action: approval.action, command: approval.command, risk: approval.risk, approved: approve })
      log('approval', approve ? 'APPROVE' : 'DENY', approval.kind, approval.risk, approval.action, approval.command ?? '')
      await call('approvals.resolve', { approvalId: approval.id, approve, note: 'acceptance script' })
    }
    await onTick?.(detail)
    if (['completed', 'failed', 'cancelled'].includes(run.state)) break
    if (run.state === 'paused') {
      const events = await call('events.list', { runId, limit: 5000 })
      log('paused:', JSON.stringify(events.filter((e) => e.type === 'run.paused').at(-1)?.payload))
      break
    }
    await new Promise((r) => setTimeout(r, 4000))
  }
  return { detail: await call('runs.get', { runId }), approvals }
}

/** Every SDK session of every agent of the run, with the handoff recorded at rotation. */
export async function collectSessions(call, detail) {
  const sessions = []
  for (const agent of detail.agents) {
    const d = await call('agents.get', { agentId: agent.id })
    for (const s of d.sessions) {
      sessions.push({
        agentId: agent.id,
        agent: agent.label,
        role: agent.role,
        purpose: agent.purpose,
        task: detail.tasks.find((t) => t.id === agent.taskId)?.key ?? null,
        model: s.model,
        sdkSessionId: s.sdkSessionId,
        state: s.state,
        endReason: s.endReason,
        handoff: s.handoff,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      })
    }
  }
  return sessions
}

/** Run the fixture's own tests with plain node in the integration worktree, outside NEXUS. */
export function independentTestRun(detail) {
  const integration = detail.worktrees.find((w) => w.taskId === null)
  if (!integration) return { error: 'no integration worktree' }
  try {
    const out = execFileSync(process.execPath, ['--test'], { cwd: integration.path, encoding: 'utf8' })
    const lines = out.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l))
    return { lines, pass: Number(/# pass (\d+)/.exec(out)?.[1] ?? 0), fail: Number(/# fail (\d+)/.exec(out)?.[1] ?? -1) }
  } catch (e) {
    return { error: String(e.stdout ?? e.message ?? e).slice(-2000) }
  }
}

export function writeEvidence(name, evidence) {
  const outDir = join(root, 'docs', 'acceptance')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n')
  return outFile
}

/** Evaluate named gates; returns true when all hold. */
export function reportGates(gates) {
  let ok = true
  for (const [name, pass] of Object.entries(gates)) {
    log(pass ? 'PASS' : 'FAIL', name)
    if (!pass) ok = false
  }
  return ok
}
