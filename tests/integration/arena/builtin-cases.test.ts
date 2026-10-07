import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { evaluateTrial, listCaseDirectories, listFilesRecursive, loadCaseDirectory, provisionTrial, registerCases } from '@main/modules/arena'
import { GitService } from '@main/modules/git'
import { runCommandLine } from '@main/modules/process'
import { createRepositories, openDatabase } from '@main/modules/persistence'

/**
 * The suite's self-test, for every built-in case:
 *  (a) the shipped fixture's visible tests pass;
 *  (b) the hidden evaluator FAILS on the unmodified fixture (an assertion failure, not a timeout);
 *  (c) it PASSES on the reference solution (overlay kept outside the case directory);
 *  (d) the visible tests still pass on the solution;
 *  plus identical baseline commits and no evaluator file inside the trial repository.
 */

const ROOT = resolve(import.meta.dirname, '../../..')
const CASES_DIR = join(ROOT, 'arena', 'cases')
const SOLUTIONS_DIR = join(ROOT, 'tests', 'fixtures', 'arena-solutions')
const git = new GitService()
const work = mkdtempSync(join(tmpdir(), 'arena-builtin-'))
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

/** Copies by content: a plain file copy keeps the source's mtime, and Git's stat cache can then miss a same-size edit. */
function overlay(from: string, to: string): void {
  for (const rel of listFilesRecursive(from)) {
    mkdirSync(dirname(join(to, rel)), { recursive: true })
    writeFileSync(join(to, rel), readFileSync(join(from, rel)))
  }
}

const dirs = listCaseDirectories(CASES_DIR)
const EXPECTED_CATEGORIES = ['bugfix', 'feature', 'refactor', 'migration', 'performance', 'security', 'testing', 'ui', 'infrastructure']

describe('built-in Arena suite', () => {
  it('ships twelve valid, distinct cases that register as trusted built-ins', () => {
    expect(dirs).toHaveLength(12)
    const repos = createRepositories(openDatabase(':memory:'))
    const registered = registerCases(repos, CASES_DIR, 'builtin')
    expect(registered).toHaveLength(12)
    expect(registered.every((r) => r.version.trusted && r.case.origin === 'builtin')).toBe(true)
    const categories = new Set(registered.map((r) => r.case.category))
    for (const c of EXPECTED_CATEGORIES) expect(categories.has(c as never)).toBe(true)
    for (const r of registered) {
      const d = r.version.definition
      expect(d.checks.test).toBeTruthy()
      expect(d.allowedStrategies).toHaveLength(5)
      expect(d.visibleAcceptance.length).toBeGreaterThanOrEqual(2)
      expect(d.visibleAcceptance.length).toBeLessThanOrEqual(5)
      expect(existsSync(join(SOLUTIONS_DIR, d.id))).toBe(true)
      // the reference solution is never inside a case directory
      expect(readdirSync(join(CASES_DIR, d.id)).sort()).toEqual(['README.md', 'case.json', 'evaluator', 'fixture'])
    }
  })

  for (const dir of dirs) {
    const id = dir.split(/[\\/]/).pop()!
    it(`${id}: visible tests pass, hidden evaluator fails the fixture and passes the reference solution`, async () => {
      const repos = createRepositories(openDatabase(':memory:'))
      registerCases(repos, CASES_DIR, 'builtin')
      const version = repos.arenaCaseVersions.latest(id)!
      const loaded = loadCaseDirectory(dir)
      const def = loaded.definition

      const a = await provisionTrial({ caseVersion: version, sourcePath: dir, trialDir: join(work, id, 'a'), git })
      const b = await provisionTrial({ caseVersion: version, sourcePath: dir, trialDir: join(work, id, 'b'), git })
      // identical starting state, isolated directories, no evaluator file inside
      expect(a.baselineCommit).toBe(b.baselineCommit)
      expect(a.repoPath).not.toBe(b.repoPath)
      const tracked = (await git.run(a.repoPath, ['ls-files'])).stdout.split('\n')
      expect(tracked.some((f) => f.startsWith('hidden-tests/'))).toBe(false)

      // (a) visible tests on the shipped fixture
      const visible = await runCommandLine(def.checks.test!, { cwd: a.repoPath, timeoutMs: 120_000 })
      expect(visible.exitCode, visible.output.slice(-1500)).toBe(0)

      // (b) hidden evaluator on the unmodified fixture
      const unmodified = await evaluateTrial({ repoPath: a.repoPath, resultCommit: a.baselineCommit, caseVersion: version, sourcePath: dir, trialDir: join(work, id, 'a'), git })
      expect(unmodified.timedOut).toBe(false)
      expect(unmodified.passed, `the evaluator must fail the unmodified fixture: ${unmodified.output.slice(-2500)}`).toBe(false)
      expect(unmodified.exitCode).not.toBe(0)
      expect(existsSync(join(work, id, 'a', 'eval'))).toBe(false)

      // (c) hidden evaluator on the reference solution, committed in the second trial
      overlay(join(SOLUTIONS_DIR, id), b.repoPath)
      await git.run(b.repoPath, ['checkout', '-q', '-b', 'integration'])
      const commit = await git.commitAll(b.repoPath, 'reference solution', { name: 'ref', email: 'ref@example.invalid' })
      expect(commit).not.toBeNull()
      const solved = await evaluateTrial({ repoPath: b.repoPath, resultCommit: commit, caseVersion: version, sourcePath: dir, trialDir: join(work, id, 'b'), git })
      expect(solved.passed, solved.output.slice(-2500)).toBe(true)
      expect(solved.exitCode).toBe(0)
      expect(existsSync(join(work, id, 'b', 'eval'))).toBe(false)

      // (d) visible tests on the solution
      const visibleAfter = await runCommandLine(def.checks.test!, { cwd: b.repoPath, timeoutMs: 120_000 })
      expect(visibleAfter.exitCode, visibleAfter.output.slice(-1500)).toBe(0)
    }, 300_000)
  }

  it('every built-in case has its recorded version and a node-version-independent, glob-free evaluation command', () => {
    // Version 3: the timing evaluator of performance-optimization measures again before it fails (0.6).
    const VERSIONS: Record<string, number> = { 'performance-optimization': 3 }
    const repos = createRepositories(openDatabase(':memory:'))
    for (const r of registerCases(repos, CASES_DIR, 'builtin')) {
      const d = r.version.definition
      expect(d.version, d.id).toBe(VERSIONS[d.id] ?? 2)
      expect(d.hiddenEvaluation.command, d.id).toBe(`node --test hidden-tests/${d.id}.test.mjs`)
      expect(d.budgets.maxAgentsPerTrial, d.id).toBe(8)
    }
  })

  /** Evaluates fixture + overlay for one built-in case; returns whether the hidden evaluator passed. */
  async function evaluateOverlay(id: string, overlayDir: string, tag: string): Promise<{ passed: boolean; output: string }> {
    const dir = join(CASES_DIR, id)
    const repos = createRepositories(openDatabase(':memory:'))
    registerCases(repos, CASES_DIR, 'builtin')
    const version = repos.arenaCaseVersions.latest(id)!
    const trialDir = join(work, 'variants', id, tag)
    const p = await provisionTrial({ caseVersion: version, sourcePath: dir, trialDir, git })
    overlay(overlayDir, p.repoPath)
    await git.run(p.repoPath, ['checkout', '-q', '-b', 'integration'])
    const commit = await git.commitAll(p.repoPath, 'variant', { name: 'v', email: 'v@example.invalid' })
    const out = await evaluateTrial({ repoPath: p.repoPath, resultCommit: commit ?? p.baselineCommit, caseVersion: version, sourcePath: dir, trialDir, git })
    return { passed: out.passed, output: out.output }
  }

  it('performance-optimization: a quadratic dedupe fails, two different linear implementations pass', async () => {
    const base = join(SOLUTIONS_DIR, 'performance-optimization-variants')
    const quadratic = await evaluateOverlay('performance-optimization', join(base, 'quadratic-dedupe'), 'quadratic')
    expect(quadratic.passed, 'a quadratic dedupeEvents must fail the evaluator').toBe(false)
    expect(quadratic.output).toContain('dedupeEvents')
    for (const v of ['linear-a', 'linear-b']) {
      const r = await evaluateOverlay('performance-optimization', join(base, v), v)
      expect(r.passed, `${v}: ${r.output.slice(-1500)}`).toBe(true)
    }
  }, 300_000)

  it('testing-gap: suites that hash or grep the sources fail; the reference suite passes', async () => {
    const base = join(SOLUTIONS_DIR, 'testing-gap-cheats')
    for (const v of ['source-hash', 'normalized-hash']) {
      const r = await evaluateOverlay('testing-gap', join(base, v), v)
      expect(r.passed, `${v} must fail the evaluator`).toBe(false)
      expect(r.output).toContain('behaviour-preserving')
    }
  }, 300_000)
})
