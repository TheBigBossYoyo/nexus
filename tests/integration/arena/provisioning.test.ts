import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoEvaluatorFiles, evaluateTrial, provisionTrial, registerCases } from '@main/modules/arena'
import { GitService } from '@main/modules/git'
import { makeRig, writeDemoCase, type ArenaRig } from './harness'

const git = new GitService()
let rig: ArenaRig | null = null
afterEach(async () => {
  await rig?.cleanup()
  rig = null
})

function setup(): { rig: ArenaRig; version: ReturnType<ArenaRig['repos']['arenaCaseVersions']['latest']> & object; sourcePath: string } {
  rig = makeRig()
  rig.service.syncBuiltinCases()
  const version = rig.repos.arenaCaseVersions.latest('demo-case')!
  return { rig, version, sourcePath: rig.repos.arenaCases.require('demo-case').sourcePath }
}

describe('trial provisioning', () => {
  it('creates identical baselines in isolated directories, with no evaluator file inside', async () => {
    const { rig: r, version, sourcePath } = setup()
    const a = await provisionTrial({ caseVersion: version, sourcePath, trialDir: join(r.dataDir, 'arena', 'c1', 't1'), git })
    const b = await provisionTrial({ caseVersion: version, sourcePath, trialDir: join(r.dataDir, 'arena', 'c1', 't2'), git })
    expect(a.repoPath).not.toBe(b.repoPath)
    // Same tree and, with the fixed baseline date, the same commit id.
    const treeA = (await git.run(a.repoPath, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const treeB = (await git.run(b.repoPath, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    expect(treeA).toBe(treeB)
    expect(a.baselineCommit).toBe(b.baselineCommit)
    expect((await git.log(a.repoPath, 'HEAD'))[0]!.subject).toBe('Arena baseline demo-case@1')
    expect((await git.status(a.repoPath)).clean).toBe(true)

    // Writing into one trial changes nothing in the other, nor in the case.
    writeFileSync(join(a.repoPath, 'index.js'), 'export const x = 99\n')
    expect(readFileSync(join(b.repoPath, 'index.js'), 'utf8')).toBe('export const x = 1\n')
    expect(readFileSync(join(sourcePath, 'fixture', 'index.js'), 'utf8')).toBe('export const x = 1\n')

    // No evaluator file anywhere in the repository, and the evaluator directory is outside every trial.
    expect(existsSync(join(a.repoPath, 'hidden-tests'))).toBe(false)
    await assertNoEvaluatorFiles(a.repoPath, join(sourcePath, 'evaluator'))
    expect(resolve(sourcePath).startsWith(resolve(r.dataDir) + sep)).toBe(false)
    const tracked = (await git.run(a.repoPath, ['ls-files'])).stdout
    expect(tracked).not.toContain('hidden-tests')
  })

  it('re-provisioning wipes an interrupted attempt', async () => {
    const { rig: r, version, sourcePath } = setup()
    const trialDir = join(r.dataDir, 'arena', 'c1', 't1')
    const first = await provisionTrial({ caseVersion: version, sourcePath, trialDir, git })
    writeFileSync(join(first.repoPath, 'leftover.txt'), 'x')
    const second = await provisionTrial({ caseVersion: version, sourcePath, trialDir, git })
    expect(existsSync(join(second.repoPath, 'leftover.txt'))).toBe(false)
    expect(second.baselineCommit).toBe(first.baselineCommit)
  })

  it('detects an evaluator file in the repository by name and by content', async () => {
    const { rig: r, sourcePath } = setup()
    const evaluatorDir = join(sourcePath, 'evaluator')
    const repo = join(r.root, 'leaky')
    mkdirSync(join(repo, 'hidden-tests'), { recursive: true })
    writeFileSync(join(repo, 'hidden-tests', 'demo-case.test.mjs'), 'different')
    await expect(assertNoEvaluatorFiles(repo, evaluatorDir)).rejects.toThrow(/exists in the trial repository/)
    const repo2 = join(r.root, 'leaky2')
    mkdirSync(repo2, { recursive: true })
    cpSync(join(evaluatorDir, 'hidden-tests', 'demo-case.test.mjs'), join(repo2, 'renamed.js'))
    await expect(assertNoEvaluatorFiles(repo2, evaluatorDir)).rejects.toThrow(/content of an evaluator file/)
  })

  it('refuses a case whose evaluator changed after registration', async () => {
    const { rig: r, version, sourcePath } = setup()
    writeFileSync(join(sourcePath, 'evaluator', 'hidden-tests', 'demo-case.test.mjs'), 'tampered')
    await expect(provisionTrial({ caseVersion: version, sourcePath, trialDir: join(r.dataDir, 't'), git })).rejects.toThrow(/evaluator .* changed/)
  })

  it('clones a user repository without touching the original', async () => {
    const { rig: r, version, sourcePath } = setup()
    const user = join(r.root, 'user-repo')
    mkdirSync(user, { recursive: true })
    await git.run(user, ['init', '--initial-branch=main'])
    writeFileSync(join(user, 'a.txt'), 'one\n')
    await git.run(user, ['add', '-A'])
    await git.run(user, ['-c', 'user.name=u', '-c', 'user.email=u@example.invalid', 'commit', '-m', 'first'])
    const first = await git.headCommit(user)
    writeFileSync(join(user, 'a.txt'), 'two\n')
    await git.run(user, ['-c', 'user.name=u', '-c', 'user.email=u@example.invalid', 'commit', '-am', 'second'])
    writeFileSync(join(user, 'dirty.txt'), 'uncommitted\n')
    const headBefore = await git.headCommit(user)
    const statusBefore = await git.status(user)

    const trial = await provisionTrial({
      caseVersion: version,
      sourcePath,
      trialDir: join(r.dataDir, 'arena', 'c1', 'repo-trial'),
      git,
      repository: { path: user, commit: first },
    })
    expect(trial.baselineCommit).toBe(first)
    expect(readFileSync(join(trial.repoPath, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n')
    expect(existsSync(join(trial.repoPath, 'dirty.txt'))).toBe(false)
    // the clone owns its objects and has no way back to the original
    expect((await git.run(trial.repoPath, ['remote'])).stdout.trim()).toBe('')
    writeFileSync(join(trial.repoPath, 'a.txt'), 'changed in trial\n')
    await git.commitAll(trial.repoPath, 'trial work', { name: 't', email: 't@example.invalid' })

    expect(await git.headCommit(user)).toBe(headBefore)
    expect(await git.status(user)).toEqual(statusBefore)
    expect(readFileSync(join(user, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('two\n')
  })
})

describe('hidden evaluator', () => {
  async function trialWith(files: Record<string, string> | null): Promise<{ r: ArenaRig; input: Parameters<typeof evaluateTrial>[0]; trialDir: string }> {
    const { rig: r, version, sourcePath } = setup()
    const trialDir = join(r.dataDir, 'arena', 'c1', 't1')
    const { repoPath, baselineCommit } = await provisionTrial({ caseVersion: version, sourcePath, trialDir, git })
    let commit = baselineCommit
    if (files) {
      await git.run(repoPath, ['checkout', '-q', '-b', 'integration'])
      for (const [n, c] of Object.entries(files)) writeFileSync(join(repoPath, n), c)
      commit = (await git.commitAll(repoPath, 'work', { name: 'a', email: 'a@example.invalid' }))!
      await git.run(repoPath, ['checkout', '-q', 'main'])
    }
    return { r, trialDir, input: { repoPath, resultCommit: commit, caseVersion: version, sourcePath, trialDir, git } }
  }

  it('fails the unmodified fixture and passes a correct result, leaving no eval directory behind', async () => {
    const wrong = await trialWith(null)
    const failing = await evaluateTrial(wrong.input)
    expect(failing.passed).toBe(false)
    expect(failing.exitCode).not.toBe(0)
    expect(failing.timedOut).toBe(false)
    expect(failing.output).toContain('x is 2')
    expect(existsSync(join(wrong.trialDir, 'eval'))).toBe(false)
    await rig!.cleanup()

    const good = await trialWith({ 'index.js': 'export const x = 2\n' })
    const first = await evaluateTrial(good.input)
    expect(first.passed).toBe(true)
    expect(first.exitCode).toBe(0)
    expect(first.skippedReason).toBeNull()
    expect(existsSync(join(good.trialDir, 'eval'))).toBe(false)
    // re-evaluation is a pure function of the commit
    const second = await evaluateTrial(good.input)
    expect(second.passed).toBe(first.passed)
    // the agents' repository never received evaluator files
    expect(readdirSync(join(good.trialDir, 'repo')).includes('hidden-tests')).toBe(false)
    expect((await git.status(good.input.repoPath)).clean).toBe(true)
  })

  it('does not run without a result commit', async () => {
    const t = await trialWith(null)
    const out = await evaluateTrial({ ...t.input, resultCommit: null, skippedReason: 'run failed' })
    expect(out).toMatchObject({ passed: false, exitCode: null, skippedReason: 'run failed' })
  })

  it('reports a timeout as a failed evaluation', async () => {
    rig = makeRig({
      cases: (dir) =>
        writeDemoCase(dir, 'slow-case', { hiddenEvaluation: { command: 'node --test hidden-tests/**/*.test.mjs', timeoutSeconds: 5 } }, "import test from 'node:test'\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 30000)) })\n"),
    })
    rig.service.syncBuiltinCases()
    const version = rig.repos.arenaCaseVersions.latest('slow-case')!
    const sourcePath = rig.repos.arenaCases.require('slow-case').sourcePath
    const trialDir = join(rig.dataDir, 't')
    const { repoPath, baselineCommit } = await provisionTrial({ caseVersion: version, sourcePath, trialDir, git })
    const out = await evaluateTrial({ repoPath, resultCommit: baselineCommit, caseVersion: version, sourcePath, trialDir, git })
    expect(out.timedOut).toBe(true)
    expect(out.passed).toBe(false)
  }, 60_000)

  it('refuses a changed evaluator', async () => {
    const t = await trialWith({ 'index.js': 'export const x = 2\n' })
    writeFileSync(join(t.input.sourcePath, 'evaluator', 'hidden-tests', 'demo-case.test.mjs'), '// always passes')
    await expect(evaluateTrial(t.input)).rejects.toThrow(/evaluator .* changed/)
  })
})

describe('registerCases', () => {
  it('is used by the rig and keeps built-in cases trusted', () => {
    const { rig: r } = setup()
    expect(registerCases(r.repos, r.casesDir, 'builtin')[0]!.version.trusted).toBe(true)
  })
})
