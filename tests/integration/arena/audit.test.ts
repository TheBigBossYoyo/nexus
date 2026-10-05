import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newId } from '@shared/ids'
import { evaluateTrial, provisionTrial, checkNode, MIN_NODE_MAJOR } from '@main/modules/arena'
import { GitService } from '@main/modules/git'
import { makeRig, waitFor, writeDemoCase, type ArenaRig } from './harness'

const git = new GitService()
let rig: ArenaRig | null = null
afterEach(async () => {
  await rig?.cleanup()
  rig = null
})
const input = { name: 't', caseIds: ['demo-case'], strategies: ['SINGLE' as const], repetitions: 1, modelPreset: 'balanced' as const, budgetPreset: 'eco' as const }

async function trialWithCommit(files: Record<string, string>, link?: { name: string; target: string }) {
  rig = makeRig()
  rig.service.syncBuiltinCases()
  const version = rig.repos.arenaCaseVersions.latest('demo-case')!
  const sourcePath = rig.repos.arenaCases.require('demo-case').sourcePath
  const trialDir = join(rig.dataDir, 'arena', 'c', 't')
  const { repoPath } = await provisionTrial({ caseVersion: version, sourcePath, trialDir, git })
  await git.run(repoPath, ['checkout', '-q', '-b', 'integration'])
  for (const [n, c] of Object.entries(files)) {
    mkdirSync(join(repoPath, n, '..'), { recursive: true })
    writeFileSync(join(repoPath, n), c)
  }
  await git.run(repoPath, ['add', '-A'])
  if (link) {
    const blob = (await git.run(repoPath, ['hash-object', '-w', '--stdin'], { input: link.target })).stdout.trim()
    await git.run(repoPath, ['update-index', '--add', '--cacheinfo', `120000,${blob},${link.name}`])
  }
  await git.run(repoPath, ['-c', 'user.name=a', '-c', 'user.email=a@e.i', 'commit', '-q', '-m', 'work'])
  const commit = await git.headCommit(repoPath)
  const linked = commit
  return { r: rig, repoPath, version, sourcePath, trialDir, commit: linked }
}

describe('evaluation integrity', () => {
  it('a planted hidden-tests directory is tampering, not silently overwritten', async () => {
    const t = await trialWithCommit({ 'hidden-tests/demo-case.test.mjs': "import test from 'node:test'\ntest('always', () => {})\n" })
    const out = await evaluateTrial({ repoPath: t.repoPath, resultCommit: t.commit, caseVersion: t.version, sourcePath: t.sourcePath, trialDir: t.trialDir, git })
    expect(out.tampered).toContain('hidden-tests')
    expect(out.passed).toBe(false)
    expect(out.skippedReason).toContain('Tampering')
    expect(existsSync(join(t.trialDir, 'eval'))).toBe(false)
  })

  it('a symlink at an evaluator path never redirects the evaluator copy outside the export', async () => {
    const t = await trialWithCommit({ 'index.js': 'export const x = 2\n' }, { name: 'hidden-tests', target: '../../../outside-dir' })
    mkdirSync(join(t.r.root, 'outside-dir'), { recursive: true })
    const out = await evaluateTrial({ repoPath: t.repoPath, resultCommit: t.commit, caseVersion: t.version, sourcePath: t.sourcePath, trialDir: t.trialDir, git })
    expect(out.tampered).not.toBeNull()
    expect(out.passed).toBe(false)
    expect(existsSync(join(t.r.root, 'outside-dir', 'demo-case.test.mjs'))).toBe(false)
  })

  it('an evaluator that executed zero tests is infrastructure, never "acceptance failed"', async () => {
    rig = makeRig({
      cases: (dir) => writeDemoCase(dir, 'demo-case', { hiddenEvaluation: { command: 'node --test hidden-tests/missing.test.mjs', timeoutSeconds: 30 } }),
    })
    rig.service.syncBuiltinCases()
    const c2 = await rig.service.createCampaign({ ...input })
    await rig.service.start(c2.id)
    await waitFor(() => rig!.repos.arenaCampaigns.require(c2.id).state === 'completed', 'completion')
    const t = rig.repos.arenaTrials.listByCampaign(c2.id)[0]!
    expect(t.state).toBe('blocked')
    expect(t.blockKind).toBe('infrastructure')
    expect(t.detail).toContain('no tests')
    expect(rig.service.campaignDetail(c2.id).comparison[0]).toMatchObject({ n: 0, excludedInfrastructure: 1 })
  })
})

describe('node preflight', () => {
  it('reports the node that will run, and a fake missing node refuses to start with one clear error', async () => {
    const real = await checkNode()
    expect(real.ok).toBe(true)
    expect(Number(real.nodeVersion!.slice(1).split('.')[0])).toBeGreaterThanOrEqual(MIN_NODE_MAJOR)

    let status = { nodeFound: false, nodeVersion: null as string | null, ok: false, message: 'Arena cases run with Node.js; `node` was not found on PATH', path: null as string | null }
    rig = makeRig({ overrides: { preflight: async () => status } })
    rig.service.syncBuiltinCases()
    expect(await rig.service.arenaStatus()).toMatchObject({ nodeFound: false, ok: false })
    await expect(rig.service.createCampaign({ ...input, start: true })).rejects.toThrow(/`node` was not found on PATH/)
    expect(rig.repos.arenaCampaigns.count()).toBe(0)

    const draft = await rig.service.createCampaign({ ...input })
    expect(draft.environment.nodeVersion).toBe('unavailable')
    await expect(rig.service.start(draft.id)).rejects.toThrow(/not found on PATH/)
    expect(rig.repos.arenaCampaigns.require(draft.id).state).toBe('draft')

    status = { nodeFound: true, nodeVersion: 'v18.1.0', ok: false, message: 'Arena cases need Node.js 20 or newer; found v18.1.0', path: 'x' }
    await expect(rig.service.start(draft.id)).rejects.toThrow(/found v18\.1\.0/)

    status = { nodeFound: true, nodeVersion: 'v22.3.0', ok: true, message: 'Node.js v22.3.0', path: 'x' }
    const started = await rig.service.start(draft.id)
    expect(started.environment.nodeVersion).toBe('v22.3.0')
    await waitFor(() => rig!.repos.arenaCampaigns.require(draft.id).state === 'completed', 'completion')
  })

  it('a campaign created with start is started exactly once', async () => {
    rig = makeRig()
    rig.service.syncBuiltinCases()
    const c = await rig.service.createCampaign({ ...input, start: true })
    expect(c.state).toBe('running')
    await expect(rig.service.start(c.id)).rejects.toThrow(/only a draft/)
    await waitFor(() => rig!.repos.arenaCampaigns.require(c.id).state === 'completed', 'completion')
    expect(rig.host.created).toHaveLength(1)
  })
})

describe('blocking semantics', () => {
  it('classifies blocked trials: run intervention and timeout are strategy failures, an outside cancel is infrastructure', async () => {
    rig = makeRig()
    rig.service.syncBuiltinCases()
    const c = await rig.service.createCampaign({ ...input, strategies: ['SINGLE', 'BUILD', 'SWARM'] })
    rig.host.behavior = () => 'hang'
    await rig.service.start(c.id)
    await waitFor(() => rig!.host.created.length === 1, 'first run')
    // run 1 needs an intervention
    const runs = () => rig!.repos.arenaTrials.listByCampaign(c.id)
    rig.repos.runs.update(runs()[0]!.runId!, { state: 'paused', pauseReason: 'user', error: 'needs a human' })
    rig.bus.emit({ runId: runs()[0]!.runId!, type: 'run.paused', payload: { reason: 'user' } })
    await waitFor(() => runs()[0]!.state === 'blocked', 'blocked by intervention')
    expect(runs()[0]).toMatchObject({ state: 'blocked', blockKind: 'run' })
    // run 2 is cancelled by someone else
    await waitFor(() => rig!.host.created.length === 2, 'second run')
    await rig.host.cancelRun(runs()[1]!.runId!)
    await waitFor(() => runs()[1]!.state === 'blocked', 'blocked by outside cancel')
    expect(runs()[1]).toMatchObject({ blockKind: 'infrastructure' })
    await waitFor(() => rig!.host.created.length === 3, 'third run')
    rig.service.cancel(c.id)
    await rig.service.idle()
    const rows = rig.service.campaignDetail(c.id).comparison
    expect(rows.find((r) => r.strategy === 'SINGLE')).toMatchObject({ n: 1, passed: 0, excludedInfrastructure: 0 })
    expect(rows.find((r) => r.strategy === 'BUILD')).toMatchObject({ n: 0, excludedInfrastructure: 1 })
    // the policy-facing results agree with the campaign view
    expect(rig.service.results({ campaignId: c.id }).comparison).toEqual(rows)
  })
})

describe('evaluation history and budgets across a restart', () => {
  it('keeps the previous evaluation when a trial is evaluated again', async () => {
    let calls = 0
    const never = new Promise<never>(() => undefined)
    const real = await import('@main/modules/arena')
    rig = makeRig({ overrides: { evaluate: (i) => (calls++ === 0 ? never : real.evaluateTrial(i)) } })
    rig.service.syncBuiltinCases()
    const c = await rig.service.createCampaign({ ...input })
    await rig.service.start(c.id)
    await waitFor(() => rig!.repos.arenaTrials.listByCampaign(c.id)[0]!.state === 'evaluating', 'evaluating')
    const trial = rig.repos.arenaTrials.listByCampaign(c.id)[0]!
    // a first evaluation row from before the "crash"
    rig.repos.arenaEvaluations.insert({ id: newId(), trialId: trial.id, kind: 'hidden', command: 'old', exitCode: 1, timedOut: false, durationMs: 1, output: '', passed: false, skippedReason: null, evaluatorHash: 'h', scoreVersion: 'score-v1', score: 0, scoreBreakdown: {}, createdAt: '2000-01-01T00:00:00.000Z' })
    rig.service.dispose()
    const second = rig.restart({ evaluate: real.evaluateTrial })
    second.recover()
    await waitFor(() => rig!.repos.arenaCampaigns.require(c.id).state === 'completed', 'completion')
    const all = rig.repos.arenaEvaluations.listByCampaign(c.id)
    expect(all).toHaveLength(2)
    expect(rig.repos.arenaEvaluations.latestForTrial(trial.id)!.passed).toBe(true)
  })

  it('persists elapsed budget time: a restart neither resets nor inflates it', async () => {
    rig = makeRig({ overrides: { minuteMs: 1000 } })
    rig.service.syncBuiltinCases()
    rig.host.behavior = () => 'hang'
    const c = await rig.service.createCampaign({ ...input, maxWallClockMinutes: 5 })
    await rig.service.start(c.id)
    await waitFor(() => rig!.host.created.length === 1, 'run')
    const trial = rig.repos.arenaTrials.listByCampaign(c.id)[0]!
    rig.service.dispose()
    // pretend 3 s of active time were already used, then restart
    rig.repos.settings.setValue(`arena.clock.campaign.${c.id}`, 3000)
    rig.repos.settings.setValue(`arena.clock.trial.${trial.id}`, 1500)
    // closed-app time does not count: the campaign was started long ago in wall-clock terms
    rig.repos.arenaCampaigns.update(c.id, { startedAt: '2001-01-01T00:00:00.000Z' })
    const second = rig.restart()
    second.recover()
    await new Promise((r) => setTimeout(r, 300))
    expect(rig.repos.arenaCampaigns.require(c.id).state).toBe('running')
    expect(rig.repos.arenaCampaigns.require(c.id).error).toBeNull()
    // the stored 3 s + about 0.3 s are far below the 5 s budget; the remaining ~1.7 s then do exhaust it
    await waitFor(() => rig!.repos.arenaCampaigns.require(c.id).error?.includes('maxWallClockMinutes') === true, 'budget exhaustion', 15_000)
  })
})

describe('cleanup and bounded reads', () => {
  it('removes trial directories of a finished campaign only, keeps rows, asks the host to clean runs', async () => {
    rig = makeRig()
    rig.service.syncBuiltinCases()
    const cleaned: string[] = []
    rig.host.cleanupRun = async (id: string) => {
      cleaned.push(id)
    }
    const c = await rig.service.createCampaign({ ...input })
    await rig.service.start(c.id)
    await expect(rig.service.cleanupCampaign(c.id)).rejects.toThrow(/only a finished campaign/)
    await waitFor(() => rig!.repos.arenaCampaigns.require(c.id).state === 'completed', 'completion')
    const trial = rig.repos.arenaTrials.listByCampaign(c.id)[0]!
    expect(existsSync(trial.repoPath!)).toBe(true)
    const res = await rig.service.cleanupCampaign(c.id)
    expect(res.removed).toBe(1)
    expect(existsSync(trial.repoPath!)).toBe(false)
    expect(cleaned).toEqual([trial.runId])
    expect(rig.repos.arenaTrials.require(trial.id).state).toBe('passed')
    expect(rig.repos.arenaEvaluations.latestForTrial(trial.id)).not.toBeNull()
  })
})
