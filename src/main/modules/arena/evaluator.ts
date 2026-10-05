import { cp, lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '@shared/result'
import type { ArenaCaseVersion } from '@shared/v3'
import type { GitService } from '../git'
import { runCommandLine } from '../process'
import { listFilesRecursive, loadVerifiedCase } from './case-format'
import { cleanEnv } from './env'
import { gitGuard, guardedGit } from './fixtures'

export const EVALUATION_OUTPUT_CAP_BYTES = 16 * 1024

export interface EvaluateInput {
  /** The trial repository (its object store holds the result commit). */
  repoPath: string
  /** Integration branch head of the finished run. Null = the run produced nothing to evaluate. */
  resultCommit: string | null
  caseVersion: ArenaCaseVersion
  sourcePath: string
  /** `<data>/arena/<campaign>/<trial>`; the export lives in `<trialDir>/eval` for the duration of the call. */
  trialDir: string
  git: GitService
  /** Why there is no result commit (shown in the evaluation record). */
  skippedReason?: string
}

export interface EvaluationOutcome {
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** Tail of the evaluator output, at most 16 KiB. */
  output: string
  passed: boolean
  /** Set when the evaluator did not run. */
  skippedReason: string | null
  /**
   * Set when the evaluation could not produce a verdict about the strategy (command not found, zero tests ran,
   * the export failed). Such a trial is excluded from comparisons; it is not "hidden acceptance failed".
   */
  infrastructureError: string | null
  /** Set when the result collides with the evaluator's paths: the trial failed by tampering, nothing was run. */
  tampered: string | null
}

/** Number of tests the Node test runner reports (`# tests N` in TAP, `ℹ tests N` in spec); null when absent. */
export function testsReported(output: string): number | null {
  const m = /^(?:#|ℹ)\s+tests\s+(\d+)\s*$/m.exec(output)
  return m ? Number(m[1]) : null
}

/**
 * True when the Node test runner executed nothing (zero tests reported, no summary with a clean exit, or a test
 * file it could not find). Such a run says nothing about the strategy: infrastructure, not "acceptance failed".
 */
export function nothingRan(command: string, output: string, exitCode: number | null, timedOut = false): boolean {
  if (timedOut || !usesNodeTestRunner(command)) return false
  const ran = testsReported(output)
  return ran === 0 || (ran === null && (exitCode === 0 || /Could not find '/.test(output)))
}

const usesNodeTestRunner = (command: string): boolean => /^\S*node(?:\.exe)?["']?\s+(?:\S+\s+)*--test(?:\s|$)/i.test(command)

/** Names at the root of the evaluator that already exist in the agent's export (a planted `hidden-tests/`, a junction...). */
async function findCollision(evalDir: string, evaluatorDir: string): Promise<string | null> {
  const tops = new Set(listFilesRecursive(evaluatorDir).map((f) => f.split('/')[0]!))
  for (const top of tops) {
    if (await lstat(join(evalDir, top)).then(() => true, () => false)) {
      return `The result commit contains "${top}", which collides with the evaluator; refusing to overwrite it`
    }
  }
  return null
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
}

/**
 * Runs the hidden evaluator against one finished trial. A pure function of the result commit: the export is
 * rebuilt from Git every time, the evaluator files exist only in a throw-away directory that is created after
 * the agents are done and removed before this returns, and nothing from the trial's working copies is used.
 */
export async function evaluateTrial(input: EvaluateInput): Promise<EvaluationOutcome> {
  const { repoPath, resultCommit, caseVersion, sourcePath, trialDir, git } = input
  if (!resultCommit) {
    return {
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      output: '',
      passed: false,
      skippedReason: input.skippedReason ?? 'No result commit: acceptance counts as failed',
      infrastructureError: null,
      tampered: null,
    }
  }
  // Refuses an evaluator (or fixture) that changed since the case version was registered.
  const loaded = loadVerifiedCase(sourcePath, caseVersion)
  const evalDir = join(trialDir, 'eval')
  const started = Date.now()
  await removeDir(evalDir)
  try {
    await mkdir(trialDir, { recursive: true })
    const guard = await gitGuard(trialDir)
    // core.symlinks=false: a symlink in the agent's commit becomes a plain file and can never redirect a write.
    await guardedGit(git, guard, trialDir, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--template=', '-c', 'core.symlinks=false', repoPath, evalDir])
    // The commit may not be on a branch the clone fetched; pull it explicitly when needed.
    const present = await guardedGit(git, guard, evalDir, ['cat-file', '-e', `${resultCommit}^{commit}`], { okCodes: [0, 1, 128] })
    if (present.exitCode !== 0) await guardedGit(git, guard, evalDir, ['fetch', '--quiet', repoPath, resultCommit])
    await guardedGit(git, guard, evalDir, ['checkout', '--quiet', '--detach', resultCommit])
    // A pure file export: no history and no link back to the trial repository.
    await removeDir(join(evalDir, '.git'))

    const collision = await findCollision(evalDir, loaded.evaluatorDir)
    if (collision) {
      return { exitCode: null, timedOut: false, durationMs: Date.now() - started, output: '', passed: false, skippedReason: `Tampering: ${collision}`, infrastructureError: null, tampered: collision }
    }
    // Nothing exists at the evaluator's paths (checked above), so this never overwrites and never follows a link.
    for (const top of new Set(listFilesRecursive(loaded.evaluatorDir).map((f) => f.split('/')[0]!))) {
      await cp(join(loaded.evaluatorDir, top), join(evalDir, top), { recursive: true, dereference: false, force: false, errorOnExist: true })
    }

    const { command, timeoutSeconds } = loaded.definition.hiddenEvaluation
    try {
      const result = await runCommandLine(command, {
        cwd: evalDir,
        env: cleanEnv(),
        timeoutMs: timeoutSeconds * 1000,
        maxOutputBytes: EVALUATION_OUTPUT_CAP_BYTES,
        keep: 'tail',
      })
      const output = result.output.slice(-EVALUATION_OUTPUT_CAP_BYTES)
      // A runner that executed nothing says nothing about the strategy.
      const none = nothingRan(command, output, result.exitCode, result.timedOut)
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        output,
        passed: result.exitCode === 0 && !result.timedOut && !none,
        skippedReason: null,
        infrastructureError: none ? 'The evaluator executed no tests' : null,
        tampered: null,
      }
    } catch (e) {
      // The evaluator could not even start (e.g. executable missing): infrastructure, not a verdict.
      return {
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        output: `Evaluator could not run: ${errorMessage(e)}`,
        passed: false,
        skippedReason: null,
        infrastructureError: `Evaluator could not run: ${errorMessage(e)}`,
        tampered: null,
      }
    }
  } finally {
    await removeDir(evalDir)
  }
}
